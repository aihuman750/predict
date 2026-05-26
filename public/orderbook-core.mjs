const MAX_POINTS_LEVELS = 5;
const EPSILON = 1e-9;

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function decimalsFromTick(tick) {
  const number = Number(tick);
  if (!Number.isFinite(number) || number <= 0) return 2;
  const text = String(number);
  if (text.includes("e-")) return Number(text.split("e-")[1]) || 2;
  const decimal = text.split(".")[1] || "";
  return decimal.length;
}

function decimalsForMarket(market = {}) {
  const precision = Number(market.decimalPrecision);
  if (Number.isInteger(precision) && precision >= 0) return precision;
  return decimalsFromTick(market.tick);
}

function complementPrice(price, market) {
  const number = toNumber(price);
  if (number == null) return null;
  return Number((1 - number).toFixed(decimalsForMarket(market)));
}

function normalizeLevels(levels, side, market, shareThreshold) {
  return (Array.isArray(levels) ? levels : [])
    .slice(0, MAX_POINTS_LEVELS)
    .map((level, index) => {
      const yesPrice = toNumber(Array.isArray(level) ? level[0] : level?.price);
      const quantity = toNumber(Array.isArray(level) ? level[1] : level?.quantity);
      const meetsShareThreshold = quantity != null && quantity + EPSILON >= shareThreshold;
      return {
        active: false,
        meetsShareThreshold,
        noPrice: complementPrice(yesPrice, market),
        quantity,
        rank: index + 1,
        side,
        yesPrice,
      };
    })
    .filter((level) => level.yesPrice != null && level.quantity != null);
}

export function buildActivateOrderbook({ market = {}, orderbook = {} } = {}) {
  const shareThreshold = Math.max(0, Number(market.shareThreshold ?? 0));
  const spreadThreshold = toNumber(market.spreadThreshold);
  const bids = normalizeLevels(orderbook.bids, "bid", market, shareThreshold);
  const asks = normalizeLevels(orderbook.asks, "ask", market, shareThreshold);
  const bestBid = bids[0]?.yesPrice ?? null;
  const bestAsk = asks[0]?.yesPrice ?? null;
  const spread = bestBid != null && bestAsk != null ? Number((bestAsk - bestBid).toFixed(decimalsForMarket(market))) : null;
  const spreadEligible = spread != null && spreadThreshold != null && spread <= spreadThreshold + EPSILON;

  for (const level of [...bids, ...asks]) {
    level.active = spreadEligible && level.meetsShareThreshold;
  }

  const activeLevels = [...bids, ...asks].filter((level) => level.active);

  return {
    activeLevels,
    asks,
    bestAsk,
    bestBid,
    bids,
    marketId: orderbook.marketId ?? market.id ?? null,
    shareThreshold,
    spread,
    spreadEligible,
    spreadThreshold,
    updateTimestampMs: orderbook.updateTimestampMs ?? null,
    validOrderCount: activeLevels.length,
  };
}
