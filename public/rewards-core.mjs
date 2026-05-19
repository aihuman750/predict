const ACRONYMS = new Set([
  "AI",
  "AM",
  "API",
  "ATP",
  "BNB",
  "BTC",
  "CEO",
  "COP",
  "CPI",
  "EOY",
  "EPL",
  "ETH",
  "EU",
  "F1",
  "GDP",
  "IPO",
  "MLB",
  "NBA",
  "NCAA",
  "NFL",
  "NHL",
  "PM",
  "PT",
  "Q1",
  "Q2",
  "Q3",
  "Q4",
  "SOL",
  "TVL",
  "UAE",
  "UCL",
  "UFC",
  "UK",
  "US",
  "USDC",
  "USDT",
  "UTC",
  "WC",
  "WNBA",
  "WTA",
  "WWDC",
]);

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "did",
  "do",
  "does",
  "for",
  "has",
  "have",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "will",
  "with",
]);

const TIER_LIMITS = [500, 2_000, 10_000, 30_000, 100_000];

export function titleCaseSlug(slug) {
  if (!slug) return "";
  return slug
    .split("-")
    .map((part) => {
      if (!part) return "";
      const upper = part.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      if (/^\d+$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function tokenSet(value) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((part) => part.length >= 2 && !STOP_WORDS.has(part)),
  );
}

function categoryIsAlreadyInQuestion(categoryName, question) {
  const questionTokens = tokenSet(question);
  if (questionTokens.size >= 5) return true;

  const categoryTokens = tokenSet(categoryName);
  if (!categoryTokens.size) return true;

  for (const token of categoryTokens) {
    if (!questionTokens.has(token)) return false;
  }

  return true;
}

export function buildDuplicateCategorySet(markets) {
  const counts = new Map();
  for (const market of markets) {
    if (!market?.categorySlug) continue;
    counts.set(market.categorySlug, (counts.get(market.categorySlug) || 0) + 1);
  }

  const duplicates = new Set();
  for (const [category, count] of counts) {
    if (count > 1) duplicates.add(category);
  }
  return duplicates;
}

export function buildMarketTitle(market, duplicateCategories = new Set()) {
  if (!market) return "";
  const label = market.question || market.title || "";
  if (!market.categorySlug || !duplicateCategories.has(market.categorySlug)) return label;

  const categoryName = titleCaseSlug(market.categorySlug);
  return categoryIsAlreadyInQuestion(categoryName, label) ? label : `${categoryName} | ${label}`;
}

export function buildPredictMarketUrl(market) {
  const slug = market?.slug || market?.categorySlug || market?.category;
  if (!slug) return null;
  return `https://predict.fun/market/${encodeURIComponent(String(slug))}`;
}

export function summarizeMarkets(markets) {
  const totalHourly = markets.reduce((sum, market) => sum + Number(market.hourlyRate || 0), 0);
  const top10Hourly = [...markets]
    .sort((a, b) => Number(b.hourlyRate || 0) - Number(a.hourlyRate || 0))
    .slice(0, 10)
    .reduce((sum, market) => sum + Number(market.hourlyRate || 0), 0);
  const lowCompetition = markets.filter((market) => Number(market.score ?? 0) < 2_000).length;

  return {
    activeCount: markets.length,
    lowCompetition,
    top10Hourly,
    totalHourly,
  };
}

function hasBothQuoteSides(market) {
  return market.yesBid != null && market.noBid != null;
}

export function filterAndSortMarkets(
  markets,
  { query = "", maxExpireHrs = null, sortKey = "hourlyRate", sortDir = "desc", nowSec = Date.now() / 1000 } = {},
) {
  let rows = Array.isArray(markets) ? markets : [];

  const trimmed = query.trim().toLowerCase();
  if (trimmed) {
    rows = rows.filter((market) =>
      `${market.question || ""} ${market.title || ""}`.toLowerCase().includes(trimmed),
    );
  }

  if (maxExpireHrs != null) {
    const cutoff = Math.floor(nowSec) + Number(maxExpireHrs) * 3600;
    rows = rows.filter((market) => market.expiresAtSec != null && market.expiresAtSec <= cutoff);
  }

  return [...rows].sort((a, b) => {
    const aHasQuotes = hasBothQuoteSides(a);
    const bHasQuotes = hasBothQuoteSides(b);
    if (aHasQuotes !== bHasQuotes) return aHasQuotes ? -1 : 1;

    const aValue = Number(a[sortKey] ?? 0);
    const bValue = Number(b[sortKey] ?? 0);
    return sortDir === "desc" ? bValue - aValue : aValue - bValue;
  });
}

export function competitionTier(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 1;

  for (let index = 0; index < TIER_LIMITS.length; index += 1) {
    if (value < TIER_LIMITS[index]) return index + 1;
  }
  return 6;
}
