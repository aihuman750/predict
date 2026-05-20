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

export function marketToFavoriteMarket(market) {
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

export function positionToFavoriteMarket(position) {
  return marketToFavoriteMarket(positionMarket(position));
}

export function orderToFavoriteMarket(_order, market) {
  return marketToFavoriteMarket(market);
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

function orderTokenId(order) {
  return String(order?.order?.tokenId || order?.tokenId || "");
}

function findOutcome(order, market) {
  const tokenId = orderTokenId(order);
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : [];
  return outcomes.find((outcome) =>
    [
      outcome?.tokenId,
      outcome?.onChainId,
      outcome?.onchainId,
      outcome?.tokenID,
      outcome?.id,
    ].some((value) => value != null && String(value) === tokenId),
  );
}

function fromWei(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return raw || "-";

  const padded = raw.padStart(19, "0");
  const whole = padded.slice(0, -18) || "0";
  const fraction = padded.slice(-18).replace(/0+$/g, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function numericDisplay(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "-";
  if (/^\d{16,}$/.test(raw)) return trimNumber(Number(fromWei(raw)), 6);
  return raw;
}

function trimNumber(value, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return number.toFixed(digits).replace(/\.?0+$/g, "");
}

function orderQuantity(order) {
  const side = Number(order?.order?.side ?? order?.side);
  const makerAmount = order?.order?.makerAmount;
  const takerAmount = order?.order?.takerAmount;
  if (side === 0 && takerAmount != null) return numericDisplay(takerAmount);
  if (side === 1 && makerAmount != null) return numericDisplay(makerAmount);
  return numericDisplay(order?.amount);
}

function orderPrice(order) {
  const side = Number(order?.order?.side ?? order?.side);
  const makerAmount = Number(fromWei(order?.order?.makerAmount));
  const takerAmount = Number(fromWei(order?.order?.takerAmount));
  if (!Number.isFinite(makerAmount) || !Number.isFinite(takerAmount) || makerAmount <= 0 || takerAmount <= 0) return "-";
  return trimNumber(side === 1 ? takerAmount / makerAmount : makerAmount / takerAmount, 6);
}

function remainingQuantity(quantity, amountFilled) {
  const quantityNumber = Number(quantity);
  const filledNumber = Number(numericDisplay(amountFilled));
  if (!Number.isFinite(quantityNumber) || !Number.isFinite(filledNumber)) return "-";
  return trimNumber(Math.max(0, quantityNumber - filledNumber), 6);
}

function formatOrderExpiration(value) {
  if (value == null || value === "") return "-";
  const raw = String(value);
  const parsed = Number(raw);
  const date = Number.isFinite(parsed)
    ? new Date((parsed > 10_000_000_000 ? parsed : parsed * 1000))
    : new Date(raw);
  if (!Number.isFinite(date.getTime())) return raw;

  const parts = new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  const hour = pick("hour") === "24" ? "00" : pick("hour");
  return `${pick("year")}-${pick("month")}-${pick("day")} ${hour}:${pick("minute")}`;
}

export function summarizeOrder(order, market = null) {
  const favorite = orderToFavoriteMarket(order, market);
  const outcome = findOutcome(order, market);
  const quantity = orderQuantity(order);
  const amountFilled = numericDisplay(order?.amountFilled);

  return {
    id: order?.id != null ? String(order.id) : "",
    hash: order?.order?.hash || order?.hash || "",
    marketId: order?.marketId != null ? String(order.marketId) : market?.id != null ? String(market.id) : "",
    title: marketTitle(market) || favorite?.title || "-",
    outcome: outcome?.name || String((outcome?.indexSet ?? orderTokenId(order)) || "-"),
    side: Number(order?.order?.side ?? order?.side) === 1 ? "卖出" : "买入",
    price: orderPrice(order),
    quantity,
    remainingQuantity: remainingQuantity(quantity, amountFilled),
    amountFilled,
    rewardEarningRate: String(order?.rewardEarningRate ?? "-"),
    status: String(order?.status ?? "-"),
    strategy: String(order?.strategy ?? "-"),
    expiration: formatOrderExpiration(order?.order?.expiration ?? order?.expiration),
    url: favorite?.url || null,
  };
}
