import { applyDryRunActions } from "./predict-bot-core.mjs";

function cloneState(state) {
  return JSON.parse(JSON.stringify(state && typeof state === "object" ? state : {}));
}

function assertLiveAdapter(adapter) {
  if (!adapter || typeof adapter.placeOrder !== "function" || typeof adapter.cancelOrder !== "function") {
    throw new Error("live_adapter_required");
  }
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

function liveOrderState(action, response, nowIso) {
  return {
    hash: response?.orderHash ?? response?.hash ?? null,
    id: response?.orderId ?? response?.id ?? response?.orderHash ?? response?.hash,
    outcomeName: action.outcomeName,
    price: action.price,
    remainingShares: action.shares,
    shares: action.shares,
    status: response?.status ?? "OPEN",
    submittedAt: nowIso,
  };
}

function allocateSoldShares(marketState, action) {
  marketState.positions[action.outcomeKey] ??= { shares: 0, soldShares: 0 };
  const position = marketState.positions[action.outcomeKey];
  position.soldShares = Number(position.soldShares || 0) + action.shares;
}

function recordLivePlaceOrder(state, action, response, nowIso) {
  const marketState = ensureMarketState(state, action);
  if (action.type === "place_buy") {
    marketState.buyOrders[action.outcomeKey] = liveOrderState(action, response, nowIso);
  } else if (action.type === "place_sell") {
    allocateSoldShares(marketState, action);
    marketState.sellOrders[action.outcomeKey] = liveOrderState(action, response, nowIso);
  }
}

function recordLivePlaceOrderFailure(state, action, error, nowIso) {
  const marketState = ensureMarketState(state, action);
  const orderState = {
    outcomeName: action.outcomeName,
    price: action.price,
    remainingShares: action.shares,
    shares: action.shares,
    status: "SUBMIT_FAILED",
    lastError: error?.message || String(error),
    submittedAt: nowIso,
  };
  if (action.type === "place_buy") {
    marketState.buyOrders[action.outcomeKey] = orderState;
  } else if (action.type === "place_sell") {
    marketState.sellOrders[action.outcomeKey] = orderState;
  }
}

function recordLiveCancelOrder(state, action, response, nowIso) {
  const marketState = ensureMarketState(state, action);
  const order = marketState.buyOrders[action.outcomeKey];
  if (!order) return;
  order.canceledAt = nowIso;
  order.remainingShares = 0;
  order.status = response?.status ?? "CANCELED";
}

async function executeLiveActions({ actions, adapter, now, state }) {
  assertLiveAdapter(adapter);
  const nextState = cloneState(state);
  const nowIso = new Date(now).toISOString();
  const executed = [];

  for (const action of actions) {
    if (action.type === "place_buy" || action.type === "place_sell") {
      let response;
      try {
        response = await adapter.placeOrder(action);
      } catch (error) {
        recordLivePlaceOrderFailure(nextState, action, error, nowIso);
        nextState.updatedAt = nowIso;
        error.state = nextState;
        throw error;
      }
      recordLivePlaceOrder(nextState, action, response, nowIso);
      executed.push({ action, mode: "live", response });
    } else if (action.type === "cancel_buy") {
      const response = await adapter.cancelOrder(action);
      recordLiveCancelOrder(nextState, action, response, nowIso);
      executed.push({ action, mode: "live", response });
    } else {
      throw new Error(`unsupported_action:${action.type}`);
    }
  }

  nextState.updatedAt = nowIso;
  return { executed, state: nextState };
}

export async function executeActions({
  actions = [],
  adapter = null,
  live = false,
  now = new Date(),
  state = {},
} = {}) {
  if (!live) {
    return {
      executed: actions.map((action) => ({ action, mode: "dry_run" })),
      state: applyDryRunActions(state, actions, now),
    };
  }

  return executeLiveActions({ actions, adapter, now, state });
}
