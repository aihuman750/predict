#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  buildBacktestSummary,
  buildRoundTripBacktestSummary,
  compareBacktestPrices,
  simulateMarketRoundTripStrategy,
  simulateMarketStrategy,
} from "./predict-bot-backtest-core.mjs";

const API_BASE = "https://api.predict.fun";
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const options = {
    apiBase: process.env.PREDICT_BOT_API_BASE || API_BASE,
    buyPrice: 0.01,
    buyPrices: null,
    buyWindowMinutes: 10,
    concurrency: 4,
    days: 7,
    maxPagesPerMarket: 25,
    outputDir: "output",
    sellPrice: null,
    sharesPerOutcome: 101,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--days") {
      options.days = Number(argv[++index]);
    } else if (arg === "--buy-price") {
      options.buyPrice = Number(argv[++index]);
    } else if (arg === "--buy-prices") {
      options.buyPrices = String(argv[++index])
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value));
    } else if (arg === "--buy-window-minutes") {
      options.buyWindowMinutes = Number(argv[++index]);
    } else if (arg === "--sell-price") {
      options.sellPrice = Number(argv[++index]);
    } else if (arg === "--shares") {
      options.sharesPerOutcome = Number(argv[++index]);
    } else if (arg === "--concurrency") {
      options.concurrency = Number(argv[++index]);
    } else if (arg === "--max-pages-per-market") {
      options.maxPagesPerMarket = Number(argv[++index]);
    } else if (arg === "--output-dir") {
      options.outputDir = argv[++index];
    } else if (arg === "--api-base") {
      options.apiBase = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown_arg:${arg}`);
    }
  }

  for (const [key, value] of Object.entries({
    buyWindowMinutes: options.buyWindowMinutes,
    concurrency: options.concurrency,
    days: options.days,
    maxPagesPerMarket: options.maxPagesPerMarket,
    sharesPerOutcome: options.sharesPerOutcome,
  })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid_${key}`);
  }
  const buyPrices = options.buyPrices || [options.buyPrice];
  if (!buyPrices.length) throw new Error("invalid_buy_prices");
  for (const price of buyPrices) {
    if (!Number.isFinite(price) || price <= 0 || price >= 1) throw new Error("invalid_buy_price");
  }
  if (options.sellPrice != null && (!Number.isFinite(options.sellPrice) || options.sellPrice <= 0 || options.sellPrice >= 1)) {
    throw new Error("invalid_sell_price");
  }
  options.buyPrices = [...new Set(buyPrices)].sort((a, b) => a - b);
  options.buyPrice = options.buyPrices[0];

  return options;
}

function usage() {
  return [
    "Usage: node scripts/backtest-btc15m-001.mjs [options]",
    "",
    "Required env:",
    "  PREDICT_BOT_API_KEY or PREDICT_API_KEY",
    "",
    "Options:",
    "  --days 7",
    "  --buy-price 0.01",
    "  --buy-prices 0.02,0.03,0.04,0.05",
    "  --buy-window-minutes 10",
    "  --sell-price 0.10",
    "  --shares 101",
    "  --concurrency 4",
    "  --output-dir output",
  ].join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, apiKey, attempt = 1) {
  let response;
  try {
    response = await fetch(url, {
      headers: { "x-api-key": apiKey },
    });
  } catch (error) {
    if (attempt < 6) {
      await sleep(750 * attempt);
      return fetchJson(url, apiKey, attempt + 1);
    }
    throw new Error(`predict_fetch_failed:${url}:${error?.message || error}`);
  }
  const payload = await response.json().catch(() => null);

  if ((response.status === 429 || response.status >= 500) && attempt < 6) {
    await sleep(750 * attempt);
    return fetchJson(url, apiKey, attempt + 1);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`predict_http_${response.status}:${url}`);
  if (payload?.success === false) throw new Error(`predict_api_failed:${url}`);
  return payload;
}

function categorySlugForStartMs(startMs) {
  return `btc-updown-15m-${Math.floor(startMs / 1000)}`;
}

function candidateStartTimes({ days, nowMs }) {
  const windowStartMs = nowMs - days * DAY_MS;
  const firstStartMs = Math.floor((windowStartMs - FIFTEEN_MINUTES_MS + 1) / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
  const lastStartMs = Math.floor((nowMs - FIFTEEN_MINUTES_MS) / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
  const starts = [];
  for (let startMs = firstStartMs; startMs <= lastStartMs; startMs += FIFTEEN_MINUTES_MS) {
    starts.push(startMs);
  }
  return { starts, windowStartMs };
}

function primaryMarket(category = {}) {
  return Array.isArray(category.markets) ? category.markets[0] : category.market;
}

function hasWinner(category = {}) {
  const market = primaryMarket(category);
  return market?.resolution?.status === "WON"
    || (Array.isArray(market?.outcomes) && market.outcomes.some((outcome) => outcome?.status === "WON"));
}

function isTargetCategory(category, { nowMs, windowStartMs }) {
  if (!category?.slug?.startsWith("btc-updown-15m-")) return false;
  const startMs = Date.parse(category.startsAt);
  const endMs = Date.parse(category.endsAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  if (Math.abs((endMs - startMs) - FIFTEEN_MINUTES_MS) > 60 * 1000) return false;
  if (endMs <= windowStartMs || endMs > nowMs) return false;
  return Boolean(primaryMarket(category)?.id);
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchCategory(apiBase, apiKey, startMs) {
  const slug = categorySlugForStartMs(startMs);
  const payload = await fetchJson(new URL(`/v1/categories/${slug}`, apiBase), apiKey);
  return payload?.data ?? payload;
}

async function fetchMatchesForMarket({
  apiBase,
  apiKey,
  marketId,
  maxPagesPerMarket,
  startsAt,
}) {
  const rows = [];
  let cursor = null;
  let pages = 0;
  let truncated = false;
  let reachedStart = false;
  const startMs = Date.parse(startsAt);

  while (pages < maxPagesPerMarket) {
    const url = new URL("/v1/orders/matches", apiBase);
    url.searchParams.set("marketId", String(marketId));
    url.searchParams.set("first", "100");
    if (cursor) url.searchParams.set("after", cursor);

    const payload = await fetchJson(url, apiKey);
    const pageRows = Array.isArray(payload?.data) ? payload.data : [];
    rows.push(...pageRows);
    pages += 1;

    const oldestMs = pageRows.reduce((oldest, row) => {
      const executedAtMs = Date.parse(row?.executedAt);
      return Number.isFinite(executedAtMs) ? Math.min(oldest, executedAtMs) : oldest;
    }, Number.POSITIVE_INFINITY);

    cursor = payload?.cursor || null;
    if (!cursor || pageRows.length === 0) break;
    if (oldestMs < startMs) {
      reachedStart = true;
      break;
    }
  }

  if (cursor && !reachedStart) truncated = true;
  return { rows, pages, truncated };
}

function renderMarkdown({
  generatedAt,
  options,
  resultRows,
  skipped,
  summary,
  truncatedMarkets,
  windowEnd,
  windowStart,
}) {
  const filledRows = resultRows.filter((row) => row.filledOrders > 0);
  const fillLines = filledRows.length > 0
    ? filledRows.map((row) => {
      const fills = row.fills
        .map((fill) => `${fill.outcome} ${fill.shares} shares ${fill.won ? "WIN" : "LOSE"}`)
        .join("; ");
      return `| ${row.startsAt} | ${row.marketId} | ${row.winningOutcome} | ${fills} | ${row.candidateFillVolume.toFixed(2)} | ${row.pnl.toFixed(4)} |`;
    })
    : ["| - | - | - | - | - | - |"];

  return [
    "# BTC 15m 0.01 Passive-Buy Backtest",
    "",
    `Generated: ${generatedAt}`,
    `Window: ${windowStart} to ${windowEnd}`,
    "",
    "## Assumptions",
    "",
    `- Place one passive buy bid on each outcome at ${options.buyPrice.toFixed(2)} during the first ${options.buyWindowMinutes} minutes of each BTC 15m market.`,
    `- Max size is ${options.sharesPerOutcome} shares per outcome.`,
    "- A hypothetical fill is counted only when a seller-side match (`taker.quoteType = Ask`) executed at or below the bid price inside the buy window.",
    "- Filled shares are held to resolution. Fees, gas, queue priority, and earlier same-price orders are not modeled.",
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Markets tested | ${summary.marketCount} |`,
    `| Attempted orders | ${summary.attemptedOrders} |`,
    `| Filled markets | ${summary.filledMarkets} |`,
    `| Filled orders | ${summary.filledOrders} |`,
    `| Filled shares | ${summary.filledShares.toFixed(4)} |`,
    `| Win shares | ${summary.winShares.toFixed(4)} |`,
    `| Loss shares | ${summary.lossShares.toFixed(4)} |`,
    `| Cost | ${summary.cost.toFixed(4)} USDT |`,
    `| Payout | ${summary.payout.toFixed(4)} USDT |`,
    `| PnL | ${summary.pnl.toFixed(4)} USDT |`,
    `| ROI on filled cost | ${summary.roiPct.toFixed(2)}% |`,
    `| Win share rate | ${summary.winRateByFilledOrderPct.toFixed(2)}% |`,
    `| Candidate fill volume | ${summary.candidateFillVolume.toFixed(4)} shares |`,
    "",
    "## Coverage",
    "",
    `- Missing/unavailable generated categories: ${skipped.missingCategories}`,
    `- Completed but unresolved categories skipped: ${skipped.unresolvedCategories}`,
    `- Non-target categories skipped: ${skipped.nonTargetCategories}`,
    `- Markets with match pagination truncated: ${truncatedMarkets}`,
    "",
    "## Filled Markets",
    "",
    "| Start | Market ID | Winner | Fills | Candidate volume | PnL USDT |",
    "| --- | ---: | --- | --- | ---: | ---: |",
    ...fillLines,
    "",
  ].join("\n");
}

function renderComparisonMarkdown({
  comparison,
  generatedAt,
  options,
  skipped,
  truncatedMarkets,
  windowEnd,
  windowStart,
}) {
  const summaryLines = comparison.map(({ buyPrice, summary }) => [
    `| ${buyPrice.toFixed(2)}`,
    summary.marketCount,
    summary.filledMarkets,
    summary.filledOrders,
    summary.filledShares.toFixed(4),
    `${summary.cost.toFixed(4)} USDT`,
    `${summary.payout.toFixed(4)} USDT`,
    `${summary.pnl.toFixed(4)} USDT`,
    `${summary.roiPct.toFixed(2)}%`,
    `${summary.winRateByFilledOrderPct.toFixed(2)}% |`,
  ].join(" | "));

  return [
    "# BTC 15m Passive-Buy Price Grid Backtest",
    "",
    `Generated: ${generatedAt}`,
    `Window: ${windowStart} to ${windowEnd}`,
    "",
    "## Assumptions",
    "",
    `- Place one passive buy bid on each outcome during the first ${options.buyWindowMinutes} minutes of each BTC 15m market.`,
    `- Tested buy prices: ${options.buyPrices.map((price) => price.toFixed(2)).join(", ")}.`,
    `- Max size is ${options.sharesPerOutcome} shares per outcome.`,
    "- A hypothetical fill is counted only when a seller-side match (`taker.quoteType = Ask`) executed at or below the bid price inside the buy window.",
    "- Filled shares are held to resolution. Fees, gas, queue priority, and earlier same-price orders are not modeled.",
    "",
    "## Price Comparison",
    "",
    "| Buy price | Markets | Filled markets | Filled orders | Filled shares | Cost | Payout | PnL | ROI | Win share rate |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summaryLines,
    "",
    "## Coverage",
    "",
    `- Missing/unavailable generated categories: ${skipped.missingCategories}`,
    `- Completed but unresolved categories skipped: ${skipped.unresolvedCategories}`,
    `- Non-target categories skipped: ${skipped.nonTargetCategories}`,
    `- Markets with match pagination truncated: ${truncatedMarkets}`,
    "",
  ].join("\n");
}

function renderRoundTripMarkdown({
  generatedAt,
  options,
  resultRows,
  skipped,
  summary,
  truncatedMarkets,
  windowEnd,
  windowStart,
}) {
  const filledRows = resultRows.filter((row) => row.filledOrders > 0);
  const fillLines = filledRows.length > 0
    ? filledRows.map((row) => {
      const fills = row.fills
        .map((fill) => [
          `${fill.outcome}`,
          `buy ${fill.boughtShares}`,
          `sell ${fill.soldShares}`,
          `unsold ${fill.unsoldShares}`,
          fill.won ? "WIN" : "LOSE",
        ].join(" "))
        .join("; ");
      return `| ${row.startsAt} | ${row.marketId} | ${row.winningOutcome} | ${fills} | ${row.cost.toFixed(4)} | ${row.sellProceeds.toFixed(4)} | ${row.settlementPayout.toFixed(4)} | ${row.pnl.toFixed(4)} |`;
    })
    : ["| - | - | - | - | - | - | - | - |"];

  return [
    "# BTC 15m Buy-Then-Sell Backtest",
    "",
    `Generated: ${generatedAt}`,
    `Window: ${windowStart} to ${windowEnd}`,
    "",
    "## Assumptions",
    "",
    `- Place one passive buy bid on each outcome at ${options.buyPrice.toFixed(2)} during the first ${options.buyWindowMinutes} minutes of each BTC 15m market.`,
    `- Max size is ${options.sharesPerOutcome} shares per outcome.`,
    `- Immediately after any buy fill, place a passive sell ask at ${options.sellPrice.toFixed(2)} for the filled shares.`,
    "- A hypothetical buy fill is counted only when a seller-side match (`taker.quoteType = Ask`) executed at or below the bid price inside the buy window.",
    "- A hypothetical sell fill is counted only when a later buyer-side match (`taker.quoteType = Bid`) executed at or above the sell price while inventory was available.",
    "- Unsold filled shares are valued at market resolution. Fees, gas, queue priority, and earlier same-price orders are not modeled.",
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Markets tested | ${summary.marketCount} |`,
    `| Attempted buy orders | ${summary.attemptedOrders} |`,
    `| Buy-filled markets | ${summary.filledMarkets} |`,
    `| Buy-filled orders | ${summary.filledOrders} |`,
    `| Bought shares | ${summary.boughtShares.toFixed(4)} |`,
    `| Sold shares | ${summary.soldShares.toFixed(4)} |`,
    `| Unsold shares | ${summary.unsoldShares.toFixed(4)} |`,
    `| Buy cost | ${summary.cost.toFixed(4)} USDT |`,
    `| Sell proceeds | ${summary.sellProceeds.toFixed(4)} USDT |`,
    `| Settlement payout | ${summary.settlementPayout.toFixed(4)} USDT |`,
    `| Total exit value | ${summary.payout.toFixed(4)} USDT |`,
    `| PnL | ${summary.pnl.toFixed(4)} USDT |`,
    `| ROI on buy cost | ${summary.roiPct.toFixed(2)}% |`,
    `| Buy candidate fill volume | ${summary.buyCandidateFillVolume.toFixed(4)} shares |`,
    `| Sell candidate fill volume | ${summary.sellCandidateFillVolume.toFixed(4)} shares |`,
    "",
    "## Coverage",
    "",
    `- Missing/unavailable generated categories: ${skipped.missingCategories}`,
    `- Completed but unresolved categories skipped: ${skipped.unresolvedCategories}`,
    `- Non-target categories skipped: ${skipped.nonTargetCategories}`,
    `- Markets with match pagination truncated: ${truncatedMarkets}`,
    "",
    "## Filled Markets",
    "",
    "| Start | Market ID | Winner | Fills | Cost | Sell proceeds | Settlement | PnL USDT |",
    "| --- | ---: | --- | --- | ---: | ---: | ---: | ---: |",
    ...fillLines,
    "",
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const apiKey = process.env.PREDICT_BOT_API_KEY || process.env.PREDICT_API_KEY;
  if (!apiKey) throw new Error("missing_predict_api_key");

  const now = new Date();
  const nowMs = now.getTime();
  const { starts, windowStartMs } = candidateStartTimes({ days: options.days, nowMs });
  const windowStart = new Date(windowStartMs).toISOString();
  const windowEnd = now.toISOString();

  console.error(`Fetching ${starts.length} generated BTC 15m categories...`);
  const categories = await mapLimit(starts, options.concurrency, (startMs) => fetchCategory(options.apiBase, apiKey, startMs));
  const skipped = {
    missingCategories: categories.filter((category) => !category).length,
    nonTargetCategories: 0,
    unresolvedCategories: 0,
  };
  const targetCategories = [];
  for (const category of categories.filter(Boolean)) {
    if (!isTargetCategory(category, { nowMs, windowStartMs })) {
      skipped.nonTargetCategories += 1;
      continue;
    }
    if (!hasWinner(category)) {
      skipped.unresolvedCategories += 1;
      continue;
    }
    targetCategories.push(category);
  }

  console.error(`Fetching matches for ${targetCategories.length} resolved BTC 15m markets...`);
  let completed = 0;
  let truncatedMarkets = 0;
  const marketRuns = await mapLimit(targetCategories, options.concurrency, async (category) => {
    const market = primaryMarket(category);
    const fetched = await fetchMatchesForMarket({
      apiBase: options.apiBase,
      apiKey,
      marketId: market.id,
      maxPagesPerMarket: options.maxPagesPerMarket,
      startsAt: category.startsAt,
    });
    if (fetched.truncated) truncatedMarkets += 1;
    completed += 1;
    if (completed % 25 === 0 || completed === targetCategories.length) {
      console.error(`Processed ${completed}/${targetCategories.length} markets...`);
    }
    return {
      market: category,
      matches: fetched.rows,
      matchPages: fetched.pages,
      matchRows: fetched.rows.length,
    };
  });

  if (options.sellPrice != null && options.buyPrices.length !== 1) {
    throw new Error("sell_price_backtest_requires_single_buy_price");
  }

  const comparison = options.sellPrice == null
    ? compareBacktestPrices({
      buyPrices: options.buyPrices,
      buyWindowMinutes: options.buyWindowMinutes,
      marketRuns,
      sharesPerOutcome: options.sharesPerOutcome,
    })
    : null;
  const resultRows = options.sellPrice == null
    ? comparison[0].resultRows
    : marketRuns.map((run) => ({
      ...simulateMarketRoundTripStrategy({
        buyPrice: options.buyPrice,
        buyWindowMinutes: options.buyWindowMinutes,
        market: run.market,
        matches: run.matches,
        sellPrice: options.sellPrice,
        sharesPerOutcome: options.sharesPerOutcome,
      }),
      matchPages: run.matchPages,
      matchRows: run.matchRows,
    }));
  const summary = options.sellPrice == null
    ? buildBacktestSummary(resultRows)
    : buildRoundTripBacktestSummary(resultRows);
  const generatedAt = now.toISOString().replace(/[:.]/g, "-");
  const baseName = options.sellPrice != null
    ? `btc15m_buy${String(options.buyPrice).replace(".", "")}_sell${String(options.sellPrice).replace(".", "")}_backtest_${options.days}d_${generatedAt}`
    : options.buyPrices.length === 1
    ? `btc15m_${String(options.buyPrice).replace(".", "")}_backtest_${options.days}d_${generatedAt}`
    : `btc15m_price_grid_backtest_${options.days}d_${generatedAt}`;
  await fs.mkdir(options.outputDir, { recursive: true });

  const jsonPath = path.join(options.outputDir, `${baseName}.json`);
  const mdPath = path.join(options.outputDir, `${baseName}.md`);
  const payload = {
    comparison,
    generatedAt: now.toISOString(),
    options,
    resultRows,
    skipped,
    summary,
    truncatedMarkets,
    windowEnd,
    windowStart,
  };
  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  await fs.writeFile(mdPath, options.sellPrice != null
    ? renderRoundTripMarkdown(payload)
    : options.buyPrices.length === 1
      ? renderMarkdown(payload)
      : renderComparisonMarkdown(payload));

  console.log(JSON.stringify({
    comparison: comparison?.map(({ buyPrice, summary }) => ({ buyPrice, summary })) ?? null,
    jsonPath,
    mdPath,
    skipped,
    summary,
    truncatedMarkets,
    windowEnd,
    windowStart,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
