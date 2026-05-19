import { favoriteKey } from "../public/rewards-core.mjs";

function formatCents(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${(number * 100).toFixed(1).replace(/\.0$/, "")}¢`;
}

export function formatPriceDelta(current, previous) {
  const currentNumber = Number(current);
  const previousNumber = Number(previous);
  if (!Number.isFinite(currentNumber)) return "-";
  if (!Number.isFinite(previousNumber)) return "新增";

  const diff = currentNumber - previousNumber;
  if (Math.abs(diff) < 0.0005) return "持平";

  const cents = (diff * 100).toFixed(1).replace(/\.0$/, "");
  return `${diff > 0 ? "+" : ""}${cents}¢`;
}

function normalizeQuestion(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function findCurrentMarket(favorite, currentMarkets) {
  const key = favorite.key || favoriteKey(favorite);
  const preferred = currentMarkets.find((market) => favoriteKey(market) === key);
  if (preferred) return preferred;

  const category = favorite.categorySlug || favorite.category;
  if (category) {
    const byCategory = currentMarkets.find((market) => market.categorySlug === category || market.category === category);
    if (byCategory) return byCategory;
  }

  const question = normalizeQuestion(favorite.question || favorite.title);
  if (!question) return null;
  return currentMarkets.find((market) => normalizeQuestion(market.question || market.title) === question) || null;
}

export function buildPriceRows({ favorites, currentMarkets, previousSnapshot = {} }) {
  const previousMarkets = previousSnapshot.markets || {};

  return favorites.map((favorite) => {
    const key = favorite.key || favoriteKey(favorite);
    const current = findCurrentMarket(favorite, currentMarkets);
    const previous = previousMarkets[key] || {};

    return {
      key,
      title: favorite.title || favorite.question || key,
      url: favorite.url || null,
      yes: current ? formatCents(current.yesBid) : "-",
      yesDelta: current ? formatPriceDelta(current.yesBid, previous.yesBid) : "-",
      no: current ? formatCents(current.noBid) : "-",
      noDelta: current ? formatPriceDelta(current.noBid, previous.noBid) : "-",
      status: current ? "active" : "missing",
    };
  });
}

export function snapshotMarkets({ favorites, currentMarkets, generatedAt = new Date().toISOString() }) {
  const markets = {};
  for (const favorite of favorites) {
    const key = favorite.key || favoriteKey(favorite);
    const current = findCurrentMarket(favorite, currentMarkets);
    if (!key || !current) continue;
    markets[key] = {
      yesBid: current.yesBid ?? null,
      noBid: current.noBid ?? null,
    };
  }

  return { generatedAt, markets };
}

function tableCell(value) {
  return String(value ?? "-").replaceAll("\n", " ").replaceAll("|", "\\|");
}

export function buildReportMarkdown({ dateLabel, priceRows, progressRows }) {
  const priceTable = priceRows.length
    ? [
        "| 市场 | Yes 最新 | Yes 变化 | No 最新 | No 变化 |",
        "| --- | ---: | ---: | ---: | ---: |",
        ...priceRows.map((row) => {
          const title = row.url ? `[${row.title}](${row.url})` : row.title;
          return `| ${tableCell(title)} | ${tableCell(row.yes)} | ${tableCell(row.yesDelta)} | ${tableCell(row.no)} | ${tableCell(row.noDelta)} |`;
        }),
      ].join("\n")
    : "暂无收藏市场。";

  const progressTable = progressRows.length
    ? [
        "| 市场 | 事件进度 |",
        "| --- | --- |",
        ...progressRows.map((row) => `| ${tableCell(row.title)} | ${tableCell(row.progress || "无进展")} |`),
      ].join("\n")
    : "暂无收藏市场。";

  return [
    `**Predict 收藏市场日报**`,
    `时间：${dateLabel}`,
    "",
    "### 1. 价格变动",
    priceTable,
    "",
    "### 2. 事件进度",
    progressTable,
  ].join("\n");
}
