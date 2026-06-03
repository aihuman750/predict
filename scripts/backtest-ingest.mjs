#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import https from "node:https";
import process from "node:process";
import { gzipSync } from "node:zlib";

import {
  BACKTEST_INTERVAL_MINUTES,
  buildBacktestMatrix,
  normalizePerspective,
  normalizeQuoteType,
  priceToMicros,
  serializeBacktestMatrix,
  sharesToMicros,
} from "./backtest-matrix-core.mjs";

setDefaultResultOrder("ipv4first");

const API_BASE = "https://api.predict.fun";
const D1_API_BASE = "https://api.cloudflare.com/client/v4";
const DAY_MS = 24 * 60 * 60 * 1000;
const D1_MAX_ATTEMPTS = 6;
const D1_MATCH_BATCH_SIZE = 10;
const FETCH_TIMEOUT_MS = 30_000;
const CUT_OFFS_BY_INTERVAL = {
  "1h": Array.from({ length: 60 }, (_, index) => index + 1),
  "15m": Array.from({ length: 15 }, (_, index) => index + 1),
  "5m": Array.from({ length: 5 }, (_, index) => index + 1),
};

function usage() {
  return [
    "Usage: node scripts/backtest-ingest.mjs [options]",
    "",
    "Required env:",
    "  PREDICT_BOT_API_KEY or PREDICT_API_KEY",
    "  CLOUDFLARE_ACCOUNT_ID",
    "  CLOUDFLARE_API_TOKEN",
    "  BACKTEST_D1_DATABASE_ID",
    "",
    "Options:",
    "  --days 60",
    "  --start 2026-05-01 --end 2026-05-31",
    "  --day 2026-06-01",
    "  --intervals 1h,15m,5m",
    "  --api-base https://api.predict.fun",
    "  --store-matches",
    "  --dry-run",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    apiBase: process.env.PREDICT_BOT_API_BASE || API_BASE,
    dryRun: false,
    end: null,
    intervals: ["1h", "15m", "5m"],
    maxPagesPerMarket: 30,
    mode: "backfill",
    sharesPerMarket: 100,
    start: null,
    storeMatches: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--api-base") {
      options.apiBase = argv[++index];
    } else if (arg === "--day") {
      options.start = argv[++index];
      options.end = options.start;
      options.mode = "daily";
    } else if (arg === "--days") {
      const days = Number(argv[++index]);
      if (!Number.isFinite(days) || days <= 0) throw new Error("invalid_days");
      const today = utcDayString(new Date());
      options.end = addDays(today, -1);
      options.start = addDays(options.end, -(Math.floor(days) - 1));
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--end") {
      options.end = argv[++index];
    } else if (arg === "--intervals") {
      options.intervals = String(argv[++index]).split(",").map((value) => value.trim()).filter(Boolean);
    } else if (arg === "--max-pages-per-market") {
      options.maxPagesPerMarket = Number(argv[++index]);
    } else if (arg === "--shares") {
      options.sharesPerMarket = Number(argv[++index]);
    } else if (arg === "--start") {
      options.start = argv[++index];
    } else if (arg === "--store-matches") {
      options.storeMatches = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown_arg:${arg}`);
    }
  }

  if (!options.start || !options.end) {
    const today = utcDayString(new Date());
    options.end = addDays(today, -1);
    options.start = addDays(options.end, -59);
  }

  if (!isUtcDay(options.start) || !isUtcDay(options.end)) throw new Error("invalid_date_range");
  if (options.start > options.end) throw new Error("start_after_end");
  if (!options.intervals.every((interval) => BACKTEST_INTERVAL_MINUTES[interval])) throw new Error("invalid_intervals");
  if (!Number.isFinite(options.maxPagesPerMarket) || options.maxPagesPerMarket <= 0) throw new Error("invalid_max_pages");
  if (!Number.isFinite(options.sharesPerMarket) || options.sharesPerMarket <= 0) throw new Error("invalid_shares");
  return options;
}

function isUtcDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function utcDayString(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(day, delta) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return utcDayString(date);
}

function enumerateDays(start, end) {
  const days = [];
  for (let day = start; day <= end; day = addDays(day, 1)) days.push(day);
  return days;
}

export function categorySlugForStart(interval, startMs) {
  if (interval === "5m") return `btc-updown-5m-${Math.floor(startMs / 1000)}`;
  if (interval === "15m") return `btc-updown-15m-${Math.floor(startMs / 1000)}`;
  if (interval === "1h") return hourlyCategorySlug(startMs);
  throw new Error(`unsupported_interval:${interval}`);
}

export function hourlyCategorySlug(startMs) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    hour12: true,
    month: "long",
    timeZone: "America/New_York",
    year: "numeric",
  }).formatToParts(new Date(startMs));
  const value = (type) => parts.find((part) => part.type === type)?.value;
  const month = String(value("month") || "").toLowerCase();
  const day = value("day");
  const year = value("year");
  const hour = String(value("hour") || "").toLowerCase();
  const dayPeriod = String(value("dayPeriod") || "").toLowerCase();
  return `bitcoin-up-or-down-${month}-${day}-${year}-${hour}${dayPeriod}-et`;
}

export function candidateStartsForDay(day, interval) {
  const stepMs = BACKTEST_INTERVAL_MINUTES[interval] * 60 * 1000;
  const startMs = Date.parse(`${day}T00:00:00.000Z`);
  const starts = [];
  for (let value = startMs; value < startMs + DAY_MS; value += stepMs) starts.push(value);
  return starts;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

export function fetchWithTimeout(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  return fetch(url, { ...init, signal: init.signal || timeoutSignal(timeoutMs) });
}

function postJsonHttps(url, body, env) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const request = https.request({
      family: 4,
      headers: {
        "authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json",
      },
      hostname: parsedUrl.hostname,
      method: "POST",
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      timeout: FETCH_TIMEOUT_MS,
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => {
        let payload = null;
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
        resolve({ payload, status: response.statusCode || 0 });
      });
    });
    request.on("timeout", () => request.destroy(new Error("https_timeout")));
    request.on("error", reject);
    request.end(body);
  });
}

async function fetchJson(url, apiKey, attempt = 1) {
  let response;
  try {
    response = await fetchWithTimeout(url, { headers: { "x-api-key": apiKey } });
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

function primaryMarket(category = {}) {
  const safeCategory = category || {};
  return Array.isArray(safeCategory.markets) ? safeCategory.markets[0] : safeCategory.market;
}

function winningOutcome(category = {}) {
  const market = primaryMarket(category);
  if (market?.resolution?.status === "WON" && market.resolution.name) return market.resolution.name;
  const won = (Array.isArray(market?.outcomes) ? market.outcomes : []).find((outcome) => outcome?.status === "WON");
  return won?.name || null;
}

export function parseCategoryMarket(category = {}, { interval, sourceDay } = {}) {
  const market = primaryMarket(category);
  if (!market?.id) return null;
  const startsAt = category.startsAt || market.startsAt;
  const endsAt = category.endsAt || market.endsAt;
  if (!startsAt || !endsAt) return null;
  return {
    endsAt,
    interval,
    marketId: String(market.id),
    rawJson: JSON.stringify(category),
    slug: category.slug || market.slug || "",
    sourceDay,
    startsAt,
    winner: normalizePerspective(winningOutcome(category)),
  };
}

function amountFromWei(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  if (!/^\d+$/.test(raw)) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const padded = raw.padStart(19, "0");
  const whole = padded.slice(0, -18) || "0";
  const fraction = padded.slice(-18).replace(/0+$/g, "");
  const parsed = Number(fraction ? `${whole}.${fraction}` : whole);
  return Number.isFinite(parsed) ? parsed : 0;
}

function matchOutcome(match = {}) {
  return match.taker?.outcome?.name
    ?? match.makers?.find((maker) => maker?.outcome?.name)?.outcome?.name
    ?? null;
}

export function parseMatchRow(match = {}, market = {}) {
  const executedAt = match.executedAt;
  const executedMs = Date.parse(executedAt);
  const startMs = Date.parse(market.startsAt);
  if (!Number.isFinite(executedMs) || !Number.isFinite(startMs)) return null;
  const quoteType = normalizeQuoteType(match.taker?.quoteType);
  const outcome = normalizePerspective(matchOutcome(match));
  if (!["ask", "bid"].includes(quoteType) || !["yes", "no"].includes(outcome)) return null;
  const priceMicros = priceToMicros(amountFromWei(match.priceExecuted));
  const sharesMicros = sharesToMicros(amountFromWei(match.amountFilled));
  if (priceMicros <= 0 || sharesMicros <= 0) return null;
  const dedupeHash = createHash("sha256")
    .update([
      market.marketId,
      executedAt,
      outcome,
      quoteType,
      priceMicros,
      sharesMicros,
      match.id || match.hash || "",
    ].join("|"))
    .digest("hex");
  return {
    dedupeHash,
    elapsedSeconds: Math.floor((executedMs - startMs) / 1000),
    executedAt,
    marketId: market.marketId,
    outcome,
    priceMicros,
    quoteType,
    sharesMicros,
  };
}

async function fetchCategory(apiBase, apiKey, slug) {
  const payload = await fetchJson(new URL(`/v1/categories/${slug}`, apiBase), apiKey);
  return payload?.data ?? payload;
}

async function fetchMatchesForMarket({ apiBase, apiKey, market, maxPagesPerMarket }) {
  const rows = [];
  let cursor = null;
  let pages = 0;
  let reachedStart = false;
  const startMs = Date.parse(market.startsAt);

  while (pages < maxPagesPerMarket) {
    const url = new URL("/v1/orders/matches", apiBase);
    url.searchParams.set("marketId", market.marketId);
    url.searchParams.set("first", "100");
    if (cursor) url.searchParams.set("after", cursor);

    const payload = await fetchJson(url, apiKey);
    const pageRows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
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

  return { pages, rows, truncated: Boolean(cursor && !reachedStart) };
}

function matrixBlobBase64(matrix) {
  return gzipSync(Buffer.from(serializeBacktestMatrix(matrix), "utf8")).toString("base64");
}

function d1Endpoint(env = process.env) {
  return `${D1_API_BASE}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.BACKTEST_D1_DATABASE_ID}/query`;
}

function optionsEnv(options = {}) {
  return options.env || process.env;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function executeD1(sql, params = [], env = process.env, attempt = 1) {
  const body = JSON.stringify({ params, sql });
  let payload;
  let status;
  try {
    if (env.BACKTEST_D1_TRANSPORT === "fetch") {
      const response = await fetchWithTimeout(d1Endpoint(env), {
        body,
        headers: {
          "authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      status = response.status;
      payload = await response.json().catch(() => null);
    } else {
      ({ payload, status } = await postJsonHttps(d1Endpoint(env), body, env));
    }
  } catch (error) {
    if (attempt < D1_MAX_ATTEMPTS) {
      await sleep(750 * attempt);
      return executeD1(sql, params, env, attempt + 1);
    }
    throw new Error(`d1_fetch_failed:${error?.message || error}`);
  }
  if ((status === 429 || status >= 500) && attempt < D1_MAX_ATTEMPTS) {
    await sleep(750 * attempt);
    return executeD1(sql, params, env, attempt + 1);
  }
  if (status < 200 || status >= 300 || payload?.success === false) {
    throw new Error(`d1_query_failed:${status}:${JSON.stringify(payload)}`);
  }
  return payload;
}

async function putMarket(market, options) {
  if (options.dryRun) return;
  await executeD1(
    `INSERT INTO backtest_markets
      (market_id, interval, slug, starts_at, ends_at, winner, source_day, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(market_id) DO UPDATE SET
      interval = excluded.interval,
      slug = excluded.slug,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      winner = excluded.winner,
      source_day = excluded.source_day,
      updated_at = CURRENT_TIMESTAMP`,
    [market.marketId, market.interval, market.slug, market.startsAt, market.endsAt, market.winner, market.sourceDay],
    optionsEnv(options),
  );
}

export async function putMatches(matches, options) {
  if (options.dryRun) return;
  for (let index = 0; index < matches.length; index += D1_MATCH_BATCH_SIZE) {
    const batch = matches.slice(index, index + D1_MATCH_BATCH_SIZE);
    if (batch.length === 0) continue;
    const values = batch.map((row) => `(${
      [
        row.dedupeHash,
        row.marketId,
        row.outcome,
        row.quoteType,
        row.executedAt,
        row.elapsedSeconds,
        row.priceMicros,
        row.sharesMicros,
      ].map(sqlLiteral).join(", ")
    })`).join(", ");
    await executeD1(
      `INSERT OR IGNORE INTO backtest_matches
        (dedupe_hash, market_id, outcome, quote_type, executed_at, elapsed_seconds, price_micros, shares_micros)
       VALUES ${values}`,
      [],
      optionsEnv(options),
    );
  }
}

async function putMatrix({ cutoffMinutes, day, interval, marketCount, matchCount, matrix, perspective }, options) {
  if (options.dryRun) return;
  const base64 = matrixBlobBase64(matrix);
  await executeD1(
    `INSERT INTO backtest_daily_matrices
      (day, interval, cutoff_minutes, perspective, compression, matrix_blob, market_count, match_count, updated_at)
     VALUES (?, ?, ?, ?, 'gzip-base64', ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(day, interval, cutoff_minutes, perspective) DO UPDATE SET
      compression = excluded.compression,
      matrix_blob = excluded.matrix_blob,
      market_count = excluded.market_count,
      match_count = excluded.match_count,
      updated_at = CURRENT_TIMESTAMP`,
    [day, interval, cutoffMinutes, perspective, base64, marketCount, matchCount],
    optionsEnv(options),
  );
}

async function startRun(options) {
  const id = randomUUID();
  if (!options.dryRun) {
    await executeD1(
      `INSERT INTO backtest_ingestion_runs (id, mode, started_at, start_day, end_day, status)
       VALUES (?, ?, ?, ?, ?, 'running')`,
      [id, options.mode, new Date().toISOString(), options.start, options.end],
      optionsEnv(options),
    );
  }
  return id;
}

async function finishRun(id, status, stats, options, error = null) {
  if (options.dryRun) return;
  await executeD1(
    `UPDATE backtest_ingestion_runs
     SET finished_at = ?, status = ?, error = ?, market_count = ?, match_count = ?, matrix_count = ?, stats_json = ?
     WHERE id = ?`,
    [
      new Date().toISOString(),
      status,
      error,
      stats.marketCount,
      stats.matchCount,
      stats.matrixCount,
      JSON.stringify(stats),
      id,
    ],
    optionsEnv(options),
  );
}

async function ingestDay({ apiKey, day, interval, options }) {
  const markets = [];
  let matchCount = 0;
  const starts = candidateStartsForDay(day, interval);
  const progressEvery = interval === "5m" ? 72 : 24;
  for (let index = 0; index < starts.length; index += 1) {
    const startMs = starts[index];
    const slug = categorySlugForStart(interval, startMs);
    const category = await fetchCategory(options.apiBase, apiKey, slug);
    const market = parseCategoryMarket(category, { interval, sourceDay: day });
    if (!market || !market.winner) {
      if ((index + 1) % progressEvery === 0 || index + 1 === starts.length) {
        console.log(`${day} ${interval}: processed=${index + 1}/${starts.length} markets=${markets.length} matches=${matchCount}`);
      }
      continue;
    }

    console.log(`${day} ${interval}: fetching=${index + 1}/${starts.length} market=${market.marketId}`);
    const { pages, rows, truncated } = await fetchMatchesForMarket({
      apiBase: options.apiBase,
      apiKey,
      market,
      maxPagesPerMarket: options.maxPagesPerMarket,
    });
    const matches = rows.map((row) => parseMatchRow(row, market)).filter(Boolean);
    matchCount += matches.length;
    console.log(`${day} ${interval}: market=${market.marketId} pages=${pages} rawMatches=${rows.length} parsedMatches=${matches.length} truncated=${truncated}`);
    await putMarket(market, options);
    if (options.storeMatches) await putMatches(matches, options);
    markets.push({ market, matches });
    if ((index + 1) % progressEvery === 0 || index + 1 === starts.length) {
      console.log(`${day} ${interval}: processed=${index + 1}/${starts.length} markets=${markets.length} matches=${matchCount}`);
    }
  }

  let matrixCount = 0;
  for (const cutoffMinutes of CUT_OFFS_BY_INTERVAL[interval]) {
    for (const perspective of ["yes", "no"]) {
      const matrix = buildBacktestMatrix({
        cutoffMinutes,
        interval,
        markets,
        perspective,
        sharesPerMarket: options.sharesPerMarket,
      });
      console.log(`${day} ${interval}: writing matrix cutoff=${cutoffMinutes} perspective=${perspective}`);
      await putMatrix({
        cutoffMinutes,
        day,
        interval,
        marketCount: markets.length,
        matchCount,
        matrix,
        perspective,
      }, options);
      console.log(`${day} ${interval}: wrote matrix cutoff=${cutoffMinutes} perspective=${perspective}`);
      matrixCount += 1;
    }
  }

  return { marketCount: markets.length, matchCount, matrixCount };
}

export async function runIngestion(options) {
  const apiKey = process.env.PREDICT_BOT_API_KEY || process.env.PREDICT_API_KEY;
  if (!apiKey) throw new Error("missing_predict_api_key");
  if (!options.dryRun) {
    for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "BACKTEST_D1_DATABASE_ID"]) {
      if (!process.env[name]) throw new Error(`missing_${name}`);
    }
  }

  const runId = await startRun(options);
  const stats = { marketCount: 0, matchCount: 0, matrixCount: 0 };
  try {
    for (const day of enumerateDays(options.start, options.end)) {
      for (const interval of options.intervals) {
        const dayStats = await ingestDay({ apiKey, day, interval, options });
        stats.marketCount += dayStats.marketCount;
        stats.matchCount += dayStats.matchCount;
        stats.matrixCount += dayStats.matrixCount;
        console.log(`${day} ${interval}: markets=${dayStats.marketCount} matches=${dayStats.matchCount} matrices=${dayStats.matrixCount}`);
      }
    }
    await finishRun(runId, "succeeded", stats, options);
    return stats;
  } catch (error) {
    await finishRun(runId, "failed", stats, options, error?.message || String(error));
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      const stats = await runIngestion(options);
      console.log(JSON.stringify(stats, null, 2));
    }
  } catch (error) {
    console.error(error?.message || error);
    console.error(usage());
    process.exitCode = 1;
  }
}
