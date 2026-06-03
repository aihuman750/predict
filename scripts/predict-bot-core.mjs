const HOUR_MS = 60 * 60 * 1000;
const FIFTEEN_MINUTE_MS = 15 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const EPSILON = 1e-9;

export const DEFAULT_BOT_CONFIG = Object.freeze({
  assets: ["BTC", "ETH", "BNB"],
  buyPrice: 0.05,
  sellPriceWhenBidExists: 0.1,
  sellPriceFallback: 0.1,
  sharesPerOutcome: 101,
  maxSharesPerOutcome: 101,
  maxCumulativeLossUsdt: 20,
  cancelUnfilledMsBeforeEnd: 10 * MINUTE_MS,
  startOrderWindowMs: 30 * MINUTE_MS,
  maxActionsPerRun: 24,
  liveTrading: false,
  killSwitch: false,
});

export function normalizeBotAssets(value = DEFAULT_BOT_CONFIG.assets) {
  const rawAssets = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  const assets = rawAssets
    .map((asset) => String(asset || "").trim().toUpperCase())
    .filter(Boolean);
  return assets.length > 0 ? assets : [...DEFAULT_BOT_CONFIG.assets];
}

const ASSET_RULES = Object.freeze({
  BTC: {
    titlePrefix: "Bitcoin Up or Down -",
    slugPrefix: "bitcoin-up-or-down-",
    fifteenMinuteSlugPrefix: "btc-updown-15m-",
  },
  ETH: {
    titlePrefix: "Ethereum Up or Down -",
    slugPrefix: "ethereum-up-or-down-",
  },
  BNB: {
    titlePrefix: "BNB Up or Down -",
    slugPrefix: "bnb-up-or-down-",
  },
});

function toDateMs(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid_date:${value}`);
  return ms;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundPrice(value) {
  return Number(value.toFixed(2));
}

function normalizeConfig(config = {}) {
  return {
    ...DEFAULT_BOT_CONFIG,
    ...config,
    assets: normalizeBotAssets(config.assets ?? DEFAULT_BOT_CONFIG.assets),
  };
}

function assertValidConfig(config) {
  const allowed = new Set(DEFAULT_BOT_CONFIG.assets);
  if (config.assets.length > DEFAULT_BOT_CONFIG.assets.length) throw new Error("too_many_assets");
  for (const asset of config.assets) {
    if (!allowed.has(asset)) throw new Error(`asset_not_allowed:${asset}`);
  }
  if (config.sharesPerOutcome > config.maxSharesPerOutcome) throw new Error("shares_per_outcome_exceeds_limit");
  if (config.maxSharesPerOutcome > DEFAULT_BOT_CONFIG.maxSharesPerOutcome) throw new Error("max_shares_exceeds_hard_limit");
  for (const [name, price] of [
    ["buyPrice", config.buyPrice],
    ["sellPriceWhenBidExists", config.sellPriceWhenBidExists],
    ["sellPriceFallback", config.sellPriceFallback],
  ]) {
    if (!Number.isFinite(Number(price)) || Number(price) <= 0 || Number(price) >= 1) {
      throw new Error(`invalid_price:${name}`);
    }
  }
}

function levelPrice(level) {
  return toNumber(Array.isArray(level) ? level[0] : level?.price);
}

function levelShares(level) {
  return toNumber(Array.isArray(level) ? level[1] : level?.quantity ?? level?.shares);
}

function firstPositiveLevel(levels) {
  for (const level of Array.isArray(levels) ? levels : []) {
    const price = levelPrice(level);
    const shares = levelShares(level);
    if (price != null && shares != null && shares > EPSILON) return { price, shares };
  }
  return null;
}

export function bestBidForOutcome(orderbook = {}, outcomeKey) {
  if (outcomeKey === "yes") {
    const bid = firstPositiveLevel(orderbook.bids);
    return bid ? { price: roundPrice(bid.price), shares: bid.shares } : null;
  }
  if (outcomeKey === "no") {
    const ask = firstPositiveLevel(orderbook.asks);
    return ask ? { price: roundPrice(1 - ask.price), shares: ask.shares } : null;
  }
  throw new Error(`invalid_outcome:${outcomeKey}`);
}

function isOpenOrder(order) {
  return order && ["OPEN", "PARTIALLY_FILLED"].includes(String(order.status || "").toUpperCase());
}

function remainingShares(order) {
  const remaining = toNumber(order?.remainingShares);
  if (remaining != null) return Math.max(0, remaining);
  const shares = toNumber(order?.shares);
  const filled = toNumber(order?.filledShares) ?? 0;
  return shares != null ? Math.max(0, shares - filled) : 0;
}

function positionShares(position) {
  const shares = toNumber(position?.shares) ?? 0;
  return Math.max(0, shares);
}

function sellOrderAttemptShares(order) {
  const remaining = toNumber(order?.remainingShares);
  if (remaining != null) return Math.max(0, remaining);
  const shares = toNumber(order?.shares);
  return shares != null ? Math.max(0, shares) : 0;
}

function openSellShares(marketState, outcomeKey) {
  const order = marketState?.sellOrders?.[outcomeKey];
  return isOpenOrder(order) ? sellOrderAttemptShares(order) : 0;
}

function isSubmitFailedOrder(order) {
  return String(order?.status || "").toUpperCase() === "SUBMIT_FAILED";
}

function isMinimumSellFailure(order) {
  return /minimum|min(?:imum)? order|min(?:imum)? amount|too small/i.test(String(order?.lastError || ""));
}

function sellSharesToPlace(marketState, outcomeKey) {
  const shares = positionShares(marketState?.positions?.[outcomeKey]);
  if (shares <= EPSILON) return 0;

  const alreadyOpen = openSellShares(marketState, outcomeKey);
  if (alreadyOpen > EPSILON) return Math.max(0, shares - alreadyOpen);

  const previousSell = marketState?.sellOrders?.[outcomeKey];
  if (isSubmitFailedOrder(previousSell) && isMinimumSellFailure(previousSell)) {
    const previousAttempt = sellOrderAttemptShares(previousSell);
    if (shares <= previousAttempt + EPSILON) return 0;
  }

  return shares;
}

function hasAnyPosition(marketState) {
  return Object.values(marketState?.positions ?? {})
    .some((position) => (toNumber(position?.shares) ?? 0) > EPSILON);
}

function normalizeOutcome(outcome, index) {
  return {
    ...outcome,
    key: index === 0 ? "yes" : "no",
  };
}

function signingMetadata(market, outcome) {
  return {
    conditionId: market.conditionId,
    feeRateBps: toNumber(market.feeRateBps) ?? 0,
    indexSet: outcome.indexSet,
    isNegRisk: Boolean(market.isNegRisk),
    isYieldBearing: Boolean(market.isYieldBearing),
    outcomeTokenId: outcome.onChainId ?? outcome.tokenId ?? outcome.outcomeTokenId,
  };
}

function isDurationCandidate(category, rule, nowMs, durationMs, slugPrefix = rule.slugPrefix) {
  const startsAtMs = Date.parse(category.startsAt);
  const endsAtMs = Date.parse(category.endsAt);
  if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs)) return false;
  const duration = endsAtMs - startsAtMs;
  if (Math.abs(duration - durationMs) > MINUTE_MS) return false;
  if (nowMs < startsAtMs || nowMs >= endsAtMs) return false;
  if (!String(category.title || "").startsWith(rule.titlePrefix)) return false;
  if (!String(category.slug || "").startsWith(slugPrefix)) return false;
  return true;
}

function selectCurrentMarket({
  asset,
  durationMs,
  interval,
  searchPayload = {},
  slugPrefix,
  startOrderWindowMs,
  now = new Date(),
}) {
  const normalizedAsset = String(asset || "").toUpperCase();
  const rule = ASSET_RULES[normalizedAsset];
  if (!rule) throw new Error(`asset_not_allowed:${asset}`);
  const nowMs = toDateMs(now);
  const categories = searchPayload.data?.categories ?? searchPayload.categories ?? [];
  const candidates = categories
    .filter((category) => isDurationCandidate(category, rule, nowMs, durationMs, slugPrefix))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const category = candidates[0];
  const market = category?.markets?.[0];
  if (!category || !market) return null;
  const outcomes = (Array.isArray(market.outcomes) && market.outcomes.length >= 2
    ? market.outcomes.slice(0, 2)
    : [{ name: "Up", indexSet: 1 }, { name: "Down", indexSet: 2 }])
    .map(normalizeOutcome);

  return {
    asset: normalizedAsset,
    conditionId: market.conditionId,
    endsAt: category.endsAt,
    feeRateBps: toNumber(market.feeRateBps ?? category.feeRateBps) ?? 0,
    isNegRisk: Boolean(market.isNegRisk ?? category.isNegRisk),
    isYieldBearing: Boolean(market.isYieldBearing ?? category.isYieldBearing),
    marketId: market.id,
    interval,
    outcomes,
    slug: category.slug,
    startOrderWindowMs,
    startsAt: category.startsAt,
    title: market.title || category.title,
  };
}

export function selectCurrentOneHourMarket(asset, searchPayload = {}, now = new Date()) {
  return selectCurrentMarket({
    asset,
    durationMs: HOUR_MS,
    interval: "1h",
    searchPayload,
    slugPrefix: ASSET_RULES[String(asset || "").toUpperCase()]?.slugPrefix,
    startOrderWindowMs: DEFAULT_BOT_CONFIG.startOrderWindowMs,
    now,
  });
}

export function selectCurrentFifteenMinuteMarket(asset, searchPayload = {}, now = new Date()) {
  const normalizedAsset = String(asset || "").toUpperCase();
  if (normalizedAsset !== "BTC") throw new Error(`asset_not_allowed:${asset}`);
  return selectCurrentMarket({
    asset,
    durationMs: FIFTEEN_MINUTE_MS,
    interval: "15m",
    searchPayload,
    slugPrefix: ASSET_RULES.BTC.fifteenMinuteSlugPrefix,
    startOrderWindowMs: 5 * MINUTE_MS,
    now,
  });
}

function assertMarketAllowed(market, config) {
  if (!config.assets.includes(market.asset)) throw new Error(`asset_not_allowed:${market.asset}`);
}

function shouldPlaceStartBuys(market, marketState, nowMs, config) {
  const startsAtMs = toDateMs(market.startsAt);
  const startOrderWindowMs = toNumber(market.startOrderWindowMs) ?? config.startOrderWindowMs;
  return nowMs >= startsAtMs
    && nowMs <= startsAtMs + startOrderWindowMs
    && !marketState?.startBuysClosed
    && !hasAnyPosition(marketState);
}

function buildStartBuyActions(market, marketState, config) {
  const actions = [];
  for (const outcome of market.outcomes) {
    if (marketState?.buyOrders?.[outcome.key]) continue;
    actions.push({
      asset: market.asset,
      interval: market.interval,
      ...signingMetadata(market, outcome),
      marketId: market.marketId,
      outcomeKey: outcome.key,
      outcomeName: outcome.name,
      price: config.buyPrice,
      reason: "market_start",
      shares: config.sharesPerOutcome,
      type: "place_buy",
    });
  }
  return actions;
}

function buildCancelBuyActions(market, marketState) {
  const actions = [];
  for (const outcome of market.outcomes) {
    const order = marketState?.buyOrders?.[outcome.key];
    const shares = remainingShares(order);
    if (!isOpenOrder(order) || shares <= EPSILON) continue;
    actions.push({
      asset: market.asset,
      interval: market.interval,
      ...signingMetadata(market, outcome),
      marketId: market.marketId,
      orderId: order.id,
      outcomeKey: outcome.key,
      outcomeName: outcome.name,
      reason: "ten_minutes_before_end",
      shares,
      type: "cancel_buy",
    });
  }
  return actions;
}

function buildSellActions(market, marketState, orderbook, config) {
  const actions = [];
  for (const outcome of market.outcomes) {
    const shares = sellSharesToPlace(marketState, outcome.key);
    if (shares <= EPSILON) continue;
    const bestBid = bestBidForOutcome(orderbook, outcome.key);
    actions.push({
      asset: market.asset,
      interval: market.interval,
      bestBid,
      ...signingMetadata(market, outcome),
      marketId: market.marketId,
      outcomeKey: outcome.key,
      outcomeName: outcome.name,
      price: config.sellPriceWhenBidExists,
      reason: "sell_after_fill",
      shares,
      type: "place_sell",
    });
  }
  return actions;
}

export function buildTradingActions({
  config: rawConfig = {},
  markets = [],
  now = new Date(),
  orderbooksByMarketId = {},
  state = {},
} = {}) {
  const config = normalizeConfig(rawConfig);
  assertValidConfig(config);
  if (config.killSwitch) return [];
  const nowMs = toDateMs(now);
  const actions = [];

  for (const market of markets) {
    assertMarketAllowed(market, config);
    const marketState = state.markets?.[market.marketId] ?? {};
    const endsAtMs = toDateMs(market.endsAt);
    const orderbook = orderbooksByMarketId[market.marketId] ?? {};

    actions.push(...buildSellActions(market, marketState, orderbook, config));

    if (nowMs >= endsAtMs - config.cancelUnfilledMsBeforeEnd) {
      actions.push(...buildCancelBuyActions(market, marketState));
    } else if (shouldPlaceStartBuys(market, marketState, nowMs, config)) {
      actions.push(...buildStartBuyActions(market, marketState, config));
    }
  }

  return actions.slice(0, config.maxActionsPerRun);
}

export function applyMaxLossRiskControl({
  actions = [],
  cumulativePnl = 0,
  maxLossUsdt = DEFAULT_BOT_CONFIG.maxCumulativeLossUsdt,
  now = new Date(),
  pnlBaselineAt = null,
  state = {},
} = {}) {
  const next = cloneState(state);
  const nowIso = new Date(now).toISOString();
  const baselineAt = next.risk?.pnlBaselineAt || pnlBaselineAt || nowIso;
  const limit = Math.abs(Number(maxLossUsdt));
  const pnl = Number(Number(cumulativePnl || 0).toFixed(6));
  const priorPause = next.risk?.maxLossPaused === true;
  const thresholdBreached = Number.isFinite(limit) && limit > 0 && pnl <= -limit;
  const riskPaused = priorPause || thresholdBreached;

  next.risk ??= {};
  next.risk.cumulativePnl = pnl;
  next.risk.pnlBaselineAt = baselineAt;
  next.risk.maxLossUsdt = Number.isFinite(limit) && limit > 0 ? limit : null;
  next.risk.lastCheckedAt = nowIso;

  if (!riskPaused) return { actions, riskPaused, state: next };

  next.risk.maxLossPaused = true;
  next.risk.pauseReason = "max_cumulative_loss";
  next.risk.pausedAt ??= nowIso;

  return {
    actions: actions.filter((action) => action.type !== "place_buy"),
    riskPaused,
    state: next,
  };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state && typeof state === "object" ? state : {}));
}

function ensureMarketState(state, action) {
  state.markets ??= {};
  state.markets[action.marketId] ??= {
    asset: action.asset,
    buyOrders: {},
    positions: {},
    sellOrders: {},
  };
  state.markets[action.marketId].asset ??= action.asset;
  state.markets[action.marketId].buyOrders ??= {};
  state.markets[action.marketId].positions ??= {};
  state.markets[action.marketId].sellOrders ??= {};
  return state.markets[action.marketId];
}

function dryRunOrderId(prefix, action, nowMs) {
  return [
    "dry",
    prefix,
    action.marketId,
    action.outcomeKey,
    nowMs,
  ].join("-");
}

function allocateSoldShares(marketState, action) {
  marketState.positions[action.outcomeKey] ??= { shares: 0, soldShares: 0 };
  const position = marketState.positions[action.outcomeKey];
  position.soldShares = (toNumber(position.soldShares) ?? 0) + action.shares;
}

export function applyDryRunActions(state, actions, now = new Date()) {
  const next = cloneState(state);
  const nowMs = toDateMs(now);
  next.updatedAt = new Date(nowMs).toISOString();

  for (const action of actions) {
    const marketState = ensureMarketState(next, action);
    if (action.type === "place_buy") {
      marketState.buyOrders[action.outcomeKey] = {
        id: dryRunOrderId("buy", action, nowMs),
        filledShares: 0,
        outcomeName: action.outcomeName,
        price: action.price,
        remainingShares: action.shares,
        shares: action.shares,
        status: "OPEN",
        submittedAt: next.updatedAt,
      };
    } else if (action.type === "cancel_buy") {
      const order = marketState.buyOrders[action.outcomeKey];
      if (order) {
        order.canceledAt = next.updatedAt;
        order.remainingShares = 0;
        order.status = "CANCELED";
      }
    } else if (action.type === "place_sell") {
      allocateSoldShares(marketState, action);
      marketState.sellOrders[action.outcomeKey] = {
        id: dryRunOrderId("sell", action, nowMs),
        filledShares: 0,
        outcomeName: action.outcomeName,
        price: action.price,
        remainingShares: action.shares,
        shares: action.shares,
        status: "OPEN",
        submittedAt: next.updatedAt,
      };
    }
  }

  return next;
}
