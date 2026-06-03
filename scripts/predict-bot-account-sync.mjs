const WEI_DECIMALS = 18;

function cloneState(state) {
  return JSON.parse(JSON.stringify(state && typeof state === "object" ? state : {}));
}

function decimalFromWeiString(raw) {
  const padded = raw.padStart(WEI_DECIMALS + 1, "0");
  const whole = padded.slice(0, -WEI_DECIMALS) || "0";
  const fraction = padded.slice(-WEI_DECIMALS).replace(/0+$/g, "");
  return Number(fraction ? `${whole}.${fraction}` : whole);
}

export function parseShareAmount(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw) && raw.length >= WEI_DECIMALS - 1) {
    const parsedWei = decimalFromWeiString(raw);
    return Number.isFinite(parsedWei) ? parsedWei : 0;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function marketKey(value) {
  return value == null ? "" : String(value);
}

function ensureMarketState(state, market) {
  state.markets ??= {};
  state.markets[market.marketId] ??= {
    asset: market.asset,
    buyOrders: {},
    positions: {},
    sellOrders: {},
  };
  state.markets[market.marketId].asset ??= market.asset;
  state.markets[market.marketId].buyOrders ??= {};
  state.markets[market.marketId].positions ??= {};
  state.markets[market.marketId].sellOrders ??= {};
  return state.markets[market.marketId];
}

function orderTokenId(order) {
  return String(order?.order?.tokenId ?? order?.tokenId ?? order?.outcomeTokenId ?? "");
}

function positionTokenId(position) {
  return String(position?.outcome?.tokenId
    ?? position?.outcome?.onChainId
    ?? position?.tokenId
    ?? position?.outcomeTokenId
    ?? "");
}

function findOutcomeByTokenOrIndex(market, tokenId, indexSet) {
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : [];
  return outcomes.find((outcome) => {
    const tokenValues = [
      outcome?.onChainId,
      outcome?.tokenId,
      outcome?.outcomeTokenId,
      outcome?.id,
    ].map((value) => value == null ? "" : String(value));
    return (tokenId && tokenValues.includes(String(tokenId)))
      || (indexSet != null && Number(outcome?.indexSet) === Number(indexSet));
  }) ?? null;
}

function orderSide(order) {
  const side = Number(order?.order?.side ?? order?.side);
  if (side === 0 || side === 1) return side;
  return null;
}

function isOpenOrderState(order) {
  return ["OPEN", "PARTIALLY_FILLED"].includes(String(order?.status || "").toUpperCase());
}

function orderQuantityShares(order, side) {
  const orderBody = order?.order ?? {};
  if (order?.amount != null) return parseShareAmount(order.amount);
  if (side === 0) return parseShareAmount(orderBody.takerAmount);
  if (side === 1) return parseShareAmount(orderBody.makerAmount);
  return 0;
}

function orderPrice(order, side) {
  const orderBody = order?.order ?? {};
  const makerAmount = parseShareAmount(orderBody.makerAmount);
  const takerAmount = parseShareAmount(orderBody.takerAmount);
  if (makerAmount <= 0 || takerAmount <= 0) return null;
  const price = side === 1 ? takerAmount / makerAmount : makerAmount / takerAmount;
  return Number(price.toFixed(6));
}

function applyOpenOrder(state, marketsById, order, nowIso) {
  const market = marketsById.get(marketKey(order?.marketId));
  if (!market) return;
  const side = orderSide(order);
  if (side == null) return;
  const outcome = findOutcomeByTokenOrIndex(market, orderTokenId(order), order?.outcome?.indexSet ?? order?.indexSet);
  if (!outcome?.key) return;

  const shares = orderQuantityShares(order, side);
  const filledShares = parseShareAmount(order?.amountFilled);
  const remainingShares = Math.max(0, shares - filledShares);
  const orderState = {
    filledShares,
    hash: order?.order?.hash ?? order?.hash ?? null,
    id: String(order?.id ?? order?.orderId ?? order?.order?.hash ?? order?.hash ?? ""),
    outcomeName: outcome.name,
    price: orderPrice(order, side),
    remainingShares,
    shares,
    status: String(order?.status ?? "OPEN"),
    syncedAt: nowIso,
  };
  const marketState = ensureMarketState(state, market);
  if (side === 0) {
    marketState.buyOrders[outcome.key] = orderState;
  } else {
    marketState.sellOrders[outcome.key] = orderState;
  }
}

function positionMarketId(position) {
  return position?.market?.id ?? position?.marketId;
}

function applyPosition(state, marketsById, position, nowIso) {
  const market = marketsById.get(marketKey(positionMarketId(position)));
  if (!market) return;
  const outcome = findOutcomeByTokenOrIndex(
    market,
    positionTokenId(position),
    position?.outcome?.indexSet ?? position?.indexSet,
  );
  if (!outcome?.key) return;

  const marketState = ensureMarketState(state, market);
  const previous = marketState.positions[outcome.key] ?? {};
  marketState.positions[outcome.key] = {
    shares: parseShareAmount(position?.amount ?? position?.shares),
    soldShares: parseShareAmount(previous.soldShares),
    syncedAt: nowIso,
  };
}

function markMissingOpenOrdersClosed(state, markets, nowIso) {
  for (const market of markets) {
    const marketState = state.markets?.[market.marketId];
    if (!marketState) continue;
    for (const orders of [marketState.buyOrders, marketState.sellOrders]) {
      for (const order of Object.values(orders ?? {})) {
        if (!isOpenOrderState(order)) continue;
        order.remainingShares = 0;
        order.status = "SYNC_MISSING";
        order.syncedAt = nowIso;
      }
    }
  }
}

export function applyAccountSnapshotToState(state, markets = [], snapshot = {}, now = new Date()) {
  const next = cloneState(state);
  const marketsById = new Map(markets.map((market) => [marketKey(market.marketId), market]));
  const nowIso = new Date(now).toISOString();

  markMissingOpenOrdersClosed(next, markets, nowIso);

  for (const order of Array.isArray(snapshot.openOrders) ? snapshot.openOrders : []) {
    applyOpenOrder(next, marketsById, order, nowIso);
  }

  for (const position of Array.isArray(snapshot.positions) ? snapshot.positions : []) {
    applyPosition(next, marketsById, position, nowIso);
  }

  if (marketsById.size > 0) next.updatedAt = nowIso;
  return next;
}

export function summarizeFilledOrderPnl({
  assets = [],
  filledOrders = [],
  markets = [],
  pnlBaselineAt = null,
  state = {},
} = {}) {
  const allowedAssets = new Set((Array.isArray(assets) ? assets : [])
    .map((asset) => String(asset || "").toUpperCase())
    .filter(Boolean));
  const marketIds = new Set();
  const baselineMs = Date.parse(pnlBaselineAt);
  const hasBaseline = Number.isFinite(baselineMs);

  for (const [marketId, market] of Object.entries(state.markets ?? {})) {
    const asset = String(market?.asset || "").toUpperCase();
    if (allowedAssets.size === 0 || allowedAssets.has(asset)) {
      const buyOrders = Object.values(market.buyOrders ?? {});
      const hasNewStrategyBuy = buyOrders.some((order) => {
        const submittedMs = Date.parse(order?.submittedAt);
        return Number.isFinite(submittedMs) && submittedMs >= baselineMs;
      });
      if (!hasBaseline || hasNewStrategyBuy) marketIds.add(marketKey(marketId));
    }
  }

  if (!hasBaseline) {
    for (const market of markets) {
      const asset = String(market?.asset || "").toUpperCase();
      if (allowedAssets.size === 0 || allowedAssets.has(asset)) {
        marketIds.add(marketKey(market?.marketId));
      }
    }
  }

  let pnl = 0;
  for (const order of Array.isArray(filledOrders) ? filledOrders : []) {
    if (!marketIds.has(marketKey(order?.marketId))) continue;
    const side = orderSide(order);
    if (side == null) continue;
    const shares = orderQuantityShares(order, side);
    const price = orderPrice(order, side);
    if (!Number.isFinite(shares) || !Number.isFinite(price)) continue;
    const value = shares * price;
    pnl += side === 1 ? value : -value;
  }

  return Number(pnl.toFixed(6));
}
