import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BOT_CONFIG,
  applyMaxLossRiskControl,
  applyDryRunActions,
  bestBidForOutcome,
  buildTradingActions,
  normalizeBotAssets,
  selectCurrentFifteenMinuteMarket,
  selectCurrentOneHourMarket,
} from "../scripts/predict-bot-core.mjs";

const START = "2026-05-29T10:00:00.000Z";
const END = "2026-05-29T11:00:00.000Z";

function market(overrides = {}) {
  return {
    asset: "BTC",
    marketId: 398076,
    slug: "bitcoin-up-or-down-may-29-2026-6am-et",
    title: "Bitcoin Up or Down - May 29, 6AM ET",
    startsAt: START,
    endsAt: END,
    outcomes: [
      { key: "yes", name: "Up", indexSet: 1 },
      { key: "no", name: "Down", indexSet: 2 },
    ],
    ...overrides,
  };
}

test("buildTradingActions places 0.05 buy orders for both outcomes only at market start", () => {
  const actions = buildTradingActions({
    markets: [market()],
    now: "2026-05-29T10:00:20.000Z",
    orderbooksByMarketId: {},
    state: {},
  });

  assert.deepEqual(actions.map((action) => ({
    type: action.type,
    marketId: action.marketId,
    outcomeKey: action.outcomeKey,
    price: action.price,
    shares: action.shares,
  })), [
    { type: "place_buy", marketId: 398076, outcomeKey: "yes", price: 0.05, shares: 101 },
    { type: "place_buy", marketId: 398076, outcomeKey: "no", price: 0.05, shares: 101 },
  ]);
});

test("normalizeBotAssets supports pausing non-BTC assets through configuration", () => {
  assert.deepEqual(normalizeBotAssets("BTC"), ["BTC"]);
  assert.deepEqual(normalizeBotAssets("btc, eth"), ["BTC", "ETH"]);
});

test("buildTradingActions carries order signing metadata from market outcomes", () => {
  const actions = buildTradingActions({
    markets: [market({
      feeRateBps: 12,
      isNegRisk: true,
      isYieldBearing: false,
      outcomes: [
        { key: "yes", name: "Up", indexSet: 1, onChainId: "1001" },
        { key: "no", name: "Down", indexSet: 2, onChainId: "1002" },
      ],
    })],
    now: "2026-05-29T10:00:20.000Z",
    orderbooksByMarketId: {},
    state: {},
  });

  assert.deepEqual(actions.map((action) => ({
    feeRateBps: action.feeRateBps,
    indexSet: action.indexSet,
    isNegRisk: action.isNegRisk,
    isYieldBearing: action.isYieldBearing,
    outcomeKey: action.outcomeKey,
    outcomeTokenId: action.outcomeTokenId,
  })), [
    {
      feeRateBps: 12,
      indexSet: 1,
      isNegRisk: true,
      isYieldBearing: false,
      outcomeKey: "yes",
      outcomeTokenId: "1001",
    },
    {
      feeRateBps: 12,
      indexSet: 2,
      isNegRisk: true,
      isYieldBearing: false,
      outcomeKey: "no",
      outcomeTokenId: "1002",
    },
  ]);
});

test("buildTradingActions still places start buys within the first 30 minutes", () => {
  const actions = buildTradingActions({
    markets: [market()],
    now: "2026-05-29T10:29:00.000Z",
    orderbooksByMarketId: {},
    state: {},
  });

  assert.deepEqual(actions.map((action) => ({
    type: action.type,
    outcomeKey: action.outcomeKey,
    price: action.price,
    shares: action.shares,
  })), [
    { type: "place_buy", outcomeKey: "yes", price: 0.05, shares: 101 },
    { type: "place_buy", outcomeKey: "no", price: 0.05, shares: 101 },
  ]);
});

test("buildTradingActions does not place new buys after the 30 minute start window", () => {
  const actions = buildTradingActions({
    markets: [market()],
    now: "2026-05-29T10:31:00.000Z",
    orderbooksByMarketId: {},
    state: {},
  });

  assert.equal(actions.length, 0);
});

test("buildTradingActions uses a five minute start window for BTC 15 minute markets", () => {
  const fifteenMinuteMarket = market({
    endsAt: "2026-05-29T10:15:00.000Z",
    interval: "15m",
    marketId: 410735,
    slug: "btc-updown-15m-1780194600",
    startOrderWindowMs: 5 * 60 * 1000,
    title: "Bitcoin Up or Down - May 29, 6:00AM-6:15AM ET",
  });

  const insideWindow = buildTradingActions({
    markets: [fifteenMinuteMarket],
    now: "2026-05-29T10:04:59.000Z",
    orderbooksByMarketId: {},
    state: {},
  });
  const outsideWindow = buildTradingActions({
    markets: [fifteenMinuteMarket],
    now: "2026-05-29T10:05:01.000Z",
    orderbooksByMarketId: {},
    state: {},
  });

  assert.deepEqual(insideWindow.map((action) => ({
    interval: action.interval,
    outcomeKey: action.outcomeKey,
    shares: action.shares,
    type: action.type,
  })), [
    { interval: "15m", outcomeKey: "yes", shares: 101, type: "place_buy" },
    { interval: "15m", outcomeKey: "no", shares: 101, type: "place_buy" },
  ]);
  assert.equal(outsideWindow.length, 0);
});

test("selectCurrentFifteenMinuteMarket selects the active BTC 15 minute category", () => {
  const selected = selectCurrentFifteenMinuteMarket("BTC", {
    data: {
      categories: [
        {
          slug: "bitcoin-up-or-down-may-29-2026-6am-et",
          title: "Bitcoin Up or Down - May 29, 6AM ET",
          startsAt: START,
          endsAt: END,
          markets: [{ id: 398076, title: "Bitcoin Up or Down - May 29, 6AM ET" }],
        },
        {
          slug: "btc-updown-15m-1780192800",
          title: "Bitcoin Up or Down - May 29, 6:00AM-6:15AM ET",
          startsAt: START,
          endsAt: "2026-05-29T10:15:00.000Z",
          markets: [{
            id: 410735,
            title: "Bitcoin Up or Down - May 29, 6:00AM-6:15AM ET",
            outcomes: [
              { name: "Up", indexSet: 1 },
              { name: "Down", indexSet: 2 },
            ],
          }],
        },
      ],
    },
  }, "2026-05-29T10:03:00.000Z");

  assert.equal(selected.marketId, 410735);
  assert.equal(selected.asset, "BTC");
  assert.equal(selected.interval, "15m");
  assert.equal(selected.startOrderWindowMs, 5 * 60 * 1000);
});

test("buildTradingActions cancels open unfilled buy orders ten minutes before market end", () => {
  const actions = buildTradingActions({
    markets: [market()],
    now: "2026-05-29T10:50:01.000Z",
    orderbooksByMarketId: {},
    state: {
      markets: {
        398076: {
          buyOrders: {
            yes: { id: "buy-yes", status: "OPEN", remainingShares: 101, filledShares: 0 },
            no: { id: "buy-no", status: "PARTIALLY_FILLED", remainingShares: 30, filledShares: 71 },
          },
        },
      },
    },
  });

  assert.deepEqual(actions.map((action) => ({
    type: action.type,
    marketId: action.marketId,
    outcomeKey: action.outcomeKey,
    orderId: action.orderId,
    shares: action.shares,
  })), [
    { type: "cancel_buy", marketId: 398076, outcomeKey: "yes", orderId: "buy-yes", shares: 101 },
    { type: "cancel_buy", marketId: 398076, outcomeKey: "no", orderId: "buy-no", shares: 30 },
  ]);
});

test("buildTradingActions sells filled shares at 0.10 when that outcome has a best bid", () => {
  const actions = buildTradingActions({
    markets: [market()],
    now: "2026-05-29T10:12:00.000Z",
    orderbooksByMarketId: {
      398076: {
        bids: [[0.04, 2000]],
        asks: [[0.96, 2000]],
      },
    },
    state: {
      markets: {
        398076: {
          positions: {
            yes: { shares: 600, soldShares: 0 },
            no: { shares: 500, soldShares: 200 },
          },
        },
      },
    },
  });

  assert.deepEqual(actions.map((action) => ({
    type: action.type,
    outcomeKey: action.outcomeKey,
    price: action.price,
    shares: action.shares,
  })), [
    { type: "place_sell", outcomeKey: "yes", price: 0.1, shares: 600 },
    { type: "place_sell", outcomeKey: "no", price: 0.1, shares: 500 },
  ]);
});

test("buildTradingActions sells filled shares at 0.10 even when that outcome has no best bid", () => {
  const actions = buildTradingActions({
    markets: [market()],
    now: "2026-05-29T10:12:00.000Z",
    orderbooksByMarketId: {
      398076: {
        bids: [],
        asks: [],
      },
    },
    state: {
      markets: {
        398076: {
          positions: {
            yes: { shares: 600, soldShares: 0 },
            no: { shares: 500, soldShares: 200 },
          },
        },
      },
    },
  });

  assert.deepEqual(actions.map((action) => ({
    type: action.type,
    outcomeKey: action.outcomeKey,
    price: action.price,
    shares: action.shares,
  })), [
    { type: "place_sell", outcomeKey: "yes", price: 0.1, shares: 600 },
    { type: "place_sell", outcomeKey: "no", price: 0.1, shares: 500 },
  ]);
});

test("buildTradingActions can sell filled shares after the buy window has closed", () => {
  const actions = buildTradingActions({
    markets: [market()],
    now: "2026-05-29T10:45:00.000Z",
    orderbooksByMarketId: {
      398076: {
        bids: [],
        asks: [],
      },
    },
    state: {
      markets: {
        398076: {
          positions: {
            yes: { shares: 101, soldShares: 0 },
          },
        },
      },
    },
  });

  assert.deepEqual(actions.map((action) => ({
    type: action.type,
    outcomeKey: action.outcomeKey,
    price: action.price,
    shares: action.shares,
  })), [
    { type: "place_sell", outcomeKey: "yes", price: 0.1, shares: 101 },
  ]);
});

test("buildTradingActions sells current remaining position shares without subtracting prior sold shares", () => {
  const actions = buildTradingActions({
    markets: [market()],
    now: "2026-05-29T10:45:00.000Z",
    orderbooksByMarketId: {
      398076: {
        bids: [],
        asks: [],
      },
    },
    state: {
      markets: {
        398076: {
          positions: {
            no: { shares: 50, soldShares: 51 },
          },
          sellOrders: {},
        },
      },
    },
  });

  assert.deepEqual(actions.map((action) => ({
    type: action.type,
    outcomeKey: action.outcomeKey,
    price: action.price,
    shares: action.shares,
  })), [
    { type: "place_sell", outcomeKey: "no", price: 0.1, shares: 50 },
  ]);
});

test("buildTradingActions tops up sell orders when open sells cover only part of the position", () => {
  const actions = buildTradingActions({
    markets: [market()],
    now: "2026-05-29T10:31:00.000Z",
    orderbooksByMarketId: {
      398076: {
        bids: [],
        asks: [],
      },
    },
    state: {
      markets: {
        398076: {
          positions: {
            no: { shares: 101 },
          },
          sellOrders: {
            no: { status: "OPEN", remainingShares: 51, shares: 51 },
          },
        },
      },
    },
  });

  assert.deepEqual(actions.map((action) => ({
    type: action.type,
    outcomeKey: action.outcomeKey,
    price: action.price,
    shares: action.shares,
  })), [
    { type: "place_sell", outcomeKey: "no", price: 0.1, shares: 50 },
  ]);
});

test("buildTradingActions defers failed sells until the position grows enough to retry all shares", () => {
  const unchanged = buildTradingActions({
    markets: [market()],
    now: "2026-05-29T10:12:00.000Z",
    orderbooksByMarketId: {
      398076: {
        bids: [],
        asks: [],
      },
    },
    state: {
      markets: {
        398076: {
          positions: {
            no: { shares: 50 },
          },
          sellOrders: {
            no: {
              lastError: "minimum order size",
              remainingShares: 50,
              shares: 50,
              status: "SUBMIT_FAILED",
            },
          },
        },
      },
    },
  });

  const increased = buildTradingActions({
    markets: [market()],
    now: "2026-05-29T10:20:00.000Z",
    orderbooksByMarketId: {
      398076: {
        bids: [],
        asks: [],
      },
    },
    state: {
      markets: {
        398076: {
          positions: {
            no: { shares: 101 },
          },
          sellOrders: {
            no: {
              lastError: "minimum order size",
              remainingShares: 50,
              shares: 50,
              status: "SUBMIT_FAILED",
            },
          },
        },
      },
    },
  });

  assert.deepEqual(unchanged, []);
  assert.deepEqual(increased.map((action) => ({
    type: action.type,
    outcomeKey: action.outcomeKey,
    price: action.price,
    shares: action.shares,
  })), [
    { type: "place_sell", outcomeKey: "no", price: 0.1, shares: 101 },
  ]);
});

test("buildTradingActions retries current shares after a non-minimum sell submission failure", () => {
  const actions = buildTradingActions({
    markets: [market()],
    now: "2026-05-29T10:20:00.000Z",
    orderbooksByMarketId: {
      398076: {
        bids: [],
        asks: [],
      },
    },
    state: {
      markets: {
        398076: {
          positions: {
            no: { shares: 50 },
          },
          sellOrders: {
            no: {
              lastError: "Insufficient shares: token balance is less than the total ask amount.",
              remainingShares: 101,
              shares: 101,
              status: "SUBMIT_FAILED",
            },
          },
        },
      },
    },
  });

  assert.deepEqual(actions.map((action) => ({
    type: action.type,
    outcomeKey: action.outcomeKey,
    price: action.price,
    shares: action.shares,
  })), [
    { type: "place_sell", outcomeKey: "no", price: 0.1, shares: 50 },
  ]);
});

test("bestBidForOutcome reads No bids from Yes asks", () => {
  assert.deepEqual(bestBidForOutcome({
    bids: [[0.04, 2000]],
    asks: [[0.96, 300]],
  }, "yes"), { price: 0.04, shares: 2000 });

  assert.deepEqual(bestBidForOutcome({
    bids: [[0.04, 2000]],
    asks: [[0.96, 300]],
  }, "no"), { price: 0.04, shares: 300 });
});

test("selectCurrentOneHourMarket selects the current BTC hourly category and excludes 5 minute markets", () => {
  const selected = selectCurrentOneHourMarket("BTC", {
    data: {
      categories: [
        {
          slug: "btc-updown-5m-1780016400",
          title: "Bitcoin Up or Down - May 29, 6AM-6:05AM ET",
          startsAt: "2026-05-29T10:00:00.000Z",
          endsAt: "2026-05-29T10:05:00.000Z",
          markets: [{ id: 401448, title: "Bitcoin Up or Down - May 29, 6AM-6:05AM ET" }],
        },
        {
          slug: "bitcoin-up-or-down-may-29-2026-6am-et",
          title: "Bitcoin Up or Down - May 29, 6AM ET",
          startsAt: START,
          endsAt: END,
          markets: [{
            id: 398076,
            title: "Bitcoin Up or Down - May 29, 6AM ET",
            outcomes: [
              { name: "Up", indexSet: 1 },
              { name: "Down", indexSet: 2 },
            ],
          }],
        },
      ],
    },
  }, "2026-05-29T10:03:00.000Z");

  assert.equal(selected.marketId, 398076);
  assert.equal(selected.asset, "BTC");
  assert.equal(selected.outcomes[0].key, "yes");
  assert.equal(selected.outcomes[1].key, "no");
});

test("buildTradingActions refuses markets outside the three asset allowlist", () => {
  assert.throws(() => buildTradingActions({
    markets: [market({ asset: "SOL" })],
    now: "2026-05-29T10:00:20.000Z",
    orderbooksByMarketId: {},
    state: {},
  }), /asset_not_allowed/);
});

test("default bot config uses the confirmed 0.05 and 0.10 API prices", () => {
  assert.equal(DEFAULT_BOT_CONFIG.buyPrice, 0.05);
  assert.equal(DEFAULT_BOT_CONFIG.sellPriceWhenBidExists, 0.1);
  assert.equal(DEFAULT_BOT_CONFIG.sellPriceFallback, 0.1);
  assert.equal(DEFAULT_BOT_CONFIG.sharesPerOutcome, 101);
  assert.equal(DEFAULT_BOT_CONFIG.maxSharesPerOutcome, 101);
});

test("applyDryRunActions records planned buys and cancels remaining buy shares", () => {
  const afterBuys = applyDryRunActions({}, [
    {
      asset: "BTC",
      marketId: 398076,
      outcomeKey: "yes",
      outcomeName: "Up",
      price: 0.05,
      shares: 101,
      type: "place_buy",
    },
    {
      asset: "BTC",
      marketId: 398076,
      outcomeKey: "no",
      outcomeName: "Down",
      price: 0.05,
      shares: 101,
      type: "place_buy",
    },
  ], "2026-05-29T10:00:20.000Z");

  assert.equal(afterBuys.markets["398076"].buyOrders.yes.status, "OPEN");
  assert.equal(afterBuys.markets["398076"].buyOrders.no.remainingShares, 101);

  const afterCancel = applyDryRunActions(afterBuys, [
    {
      asset: "BTC",
      marketId: 398076,
      orderId: afterBuys.markets["398076"].buyOrders.yes.id,
      outcomeKey: "yes",
      outcomeName: "Up",
      shares: 101,
      type: "cancel_buy",
    },
  ], "2026-05-29T10:50:01.000Z");

  assert.equal(afterCancel.markets["398076"].buyOrders.yes.status, "CANCELED");
  assert.equal(afterCancel.markets["398076"].buyOrders.yes.remainingShares, 0);
  assert.equal(afterCancel.markets["398076"].buyOrders.no.status, "OPEN");
});

test("applyDryRunActions marks sell shares as already allocated to avoid duplicate sells", () => {
  const afterSell = applyDryRunActions({
    markets: {
      398076: {
        positions: {
          yes: { shares: 600, soldShares: 100 },
        },
      },
    },
  }, [
    {
      asset: "BTC",
      marketId: 398076,
      outcomeKey: "yes",
      outcomeName: "Up",
      price: 0.1,
      shares: 500,
      type: "place_sell",
    },
  ], "2026-05-29T10:12:00.000Z");

  assert.equal(afterSell.markets["398076"].positions.yes.soldShares, 600);
  assert.equal(afterSell.markets["398076"].sellOrders.yes.status, "OPEN");
});

test("applyMaxLossRiskControl pauses new buys after cumulative loss reaches the limit", () => {
  const actions = [
    { type: "place_buy", marketId: 398076 },
    { type: "place_sell", marketId: 398076 },
    { type: "cancel_buy", marketId: 398076 },
  ];

  const result = applyMaxLossRiskControl({
    actions,
    cumulativePnl: -20,
    maxLossUsdt: 20,
    now: "2026-05-31T13:00:00.000Z",
    pnlBaselineAt: "2026-05-31T12:00:00.000Z",
    state: { markets: {} },
  });

  assert.equal(result.riskPaused, true);
  assert.deepEqual(result.actions.map((action) => action.type), ["place_sell", "cancel_buy"]);
  assert.equal(result.state.risk.maxLossPaused, true);
  assert.equal(result.state.risk.cumulativePnl, -20);
  assert.equal(result.state.risk.pnlBaselineAt, "2026-05-31T12:00:00.000Z");
  assert.equal(result.state.risk.pausedAt, "2026-05-31T13:00:00.000Z");
});

test("applyMaxLossRiskControl keeps a prior max-loss pause latched", () => {
  const result = applyMaxLossRiskControl({
    actions: [{ type: "place_buy", marketId: 398076 }],
    cumulativePnl: 0,
    maxLossUsdt: 20,
    now: "2026-05-31T13:10:00.000Z",
    pnlBaselineAt: "2026-05-31T13:10:00.000Z",
    state: {
      markets: {},
      risk: {
        maxLossPaused: true,
        pausedAt: "2026-05-31T13:00:00.000Z",
      },
    },
  });

  assert.equal(result.riskPaused, true);
  assert.deepEqual(result.actions, []);
  assert.equal(result.state.risk.pausedAt, "2026-05-31T13:00:00.000Z");
});

test("applyMaxLossRiskControl initializes the PnL baseline when missing", () => {
  const result = applyMaxLossRiskControl({
    actions: [],
    cumulativePnl: 0,
    maxLossUsdt: 20,
    now: "2026-05-31T13:18:00.000Z",
    state: { markets: {} },
  });

  assert.equal(result.riskPaused, false);
  assert.equal(result.state.risk.cumulativePnl, 0);
  assert.equal(result.state.risk.pnlBaselineAt, "2026-05-31T13:18:00.000Z");
});
