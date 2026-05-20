import { buildPredictMarketUrl, favoriteKey } from "./rewards-core.mjs";

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function normalizeWalletAddress(value) {
  const address = String(value || "").trim();
  return EVM_ADDRESS_RE.test(address) ? address.toLowerCase() : null;
}

function positionMarket(position) {
  return position?.market && typeof position.market === "object" ? position.market : null;
}

function marketTitle(market) {
  return market?.question || market?.title || (market?.id != null ? String(market.id) : "");
}

export function positionToFavoriteMarket(position) {
  const market = positionMarket(position);
  if (!market) return null;

  const key = favoriteKey(market);
  const title = marketTitle(market);
  if (!key || !title) return null;

  return {
    id: market.id != null ? String(market.id) : undefined,
    key,
    title,
    question: market.question || market.title || "",
    categorySlug: market.categorySlug || market.category || market.slug || "",
    yesBid: null,
    noBid: null,
    expiresAtSec: null,
    url: buildPredictMarketUrl(market),
  };
}

export function mergeFavoriteMarkets(existingFavorites = [], candidateFavorites = []) {
  const seen = new Set((Array.isArray(existingFavorites) ? existingFavorites : []).map((item) => item?.key).filter(Boolean));
  const additions = [];

  for (const favorite of Array.isArray(candidateFavorites) ? candidateFavorites : []) {
    if (!favorite?.key || seen.has(favorite.key)) continue;
    seen.add(favorite.key);
    additions.push(favorite);
  }

  return [...additions, ...(Array.isArray(existingFavorites) ? existingFavorites : [])];
}

export function summarizePosition(position) {
  const market = positionMarket(position) || {};
  const favorite = positionToFavoriteMarket(position);

  return {
    id: position?.id != null ? String(position.id) : "",
    marketId: market.id != null ? String(market.id) : "",
    title: marketTitle(market) || favorite?.title || "-",
    outcome: position?.outcome?.name || String(position?.outcome?.indexSet ?? "-"),
    amount: String(position?.amount ?? "-"),
    valueUsd: String(position?.valueUsd ?? "-"),
    averageBuyPriceUsd: String(position?.averageBuyPriceUsd ?? "-"),
    pnlUsd: String(position?.pnlUsd ?? "-"),
    url: favorite?.url || null,
  };
}
