import test from "node:test";
import assert from "node:assert/strict";

import {
  previousCompletedHourWindow,
  renderBotReportMarkdown,
  summarizeAccountActivity,
  summarizeBotLogs,
  summarizeBotState,
  summarizeCompletedBuyPlacements,
} from "../scripts/predict-bot-report-core.mjs";

test("previousCompletedHourWindow returns the last full hourly market window", () => {
  assert.deepEqual(previousCompletedHourWindow("2026-05-31T04:02:00.000Z"), {
    windowEnd: "2026-05-31T04:00:00.000Z",
    windowStart: "2026-05-31T03:00:00.000Z",
  });
});

test("summarizeBotLogs counts runs, actions, and errors inside the report window", () => {
  const summary = summarizeBotLogs({
    botLogText: [
      JSON.stringify({
        actions: [{ asset: "BTC", interval: "1h", type: "place_buy" }],
        markets: [{ asset: "BTC", interval: "1h", marketId: 1 }],
        now: "2026-05-31T00:30:00.000Z",
      }, null, 2),
      JSON.stringify({
        actions: [{ asset: "BTC", interval: "15m", type: "place_sell" }],
        markets: [{ asset: "BTC", interval: "15m", marketId: 2 }],
        now: "2026-05-31T03:30:00.000Z",
      }, null, 2),
    ].join("\n"),
    errLogText: `${JSON.stringify({ error: "predict_create_order_failed:400", now: "2026-05-31T03:31:00.000Z" })}\n`,
    windowEnd: "2026-05-31T04:00:00.000Z",
    windowStart: "2026-05-31T00:00:00.000Z",
  });

  assert.equal(summary.runCount, 2);
  assert.equal(summary.actionCount, 2);
  assert.equal(summary.errorCount, 1);
  assert.deepEqual(summary.actionCounts, {
    "place_buy|BTC|1h": 1,
    "place_sell|BTC|15m": 1,
  });
  assert.deepEqual(summary.errorsByType, {
    "predict_create_order_failed:400": 1,
  });
  assert.deepEqual(summary.marketsByInterval, {
    "15m": [2],
    "1h": [1],
  });
});

test("summarizeAccountActivity groups open and filled orders by interval market", () => {
  const activity = summarizeAccountActivity({
    filledOrders: [
      {
        amount: "101000000000000000000",
        amountFilled: "101000000000000000000",
        marketId: 2,
        order: {
          makerAmount: "101000000000000000000",
          side: 1,
          takerAmount: "2020000000000000000",
        },
        status: "FILLED",
      },
    ],
    marketCatalog: {
      1: { interval: "1h", title: "BTC 1h" },
      2: { interval: "15m", title: "BTC 15m" },
    },
    openOrders: [
      {
        amount: "101000000000000000000",
        amountFilled: "0",
        marketId: 1,
        order: {
          makerAmount: "1010000000000000000",
          side: 0,
          takerAmount: "101000000000000000000",
        },
        status: "OPEN",
      },
    ],
    positions: [
      {
        amount: "101000000000000000000",
        market: { id: 2 },
        outcome: { name: "Up" },
      },
    ],
  });

  assert.deepEqual(activity.byInterval["1h"].openOrders, {
    buyOrders: 1,
    buyValue: 1.01,
    count: 1,
    sellOrders: 0,
    sellValue: 0,
    shares: 101,
    value: 1.01,
  });
  assert.deepEqual(activity.byInterval["15m"].filledOrders, {
    buyOrders: 0,
    buyValue: 0,
    count: 1,
    sellOrders: 1,
    sellValue: 2.02,
    shares: 101,
    value: 2.02,
  });
  assert.equal(activity.byInterval["15m"].positionCount, 1);
});

test("summarizeCompletedBuyPlacements counts successful buy orders from local state", () => {
  const stateSummary = summarizeBotState({
    markets: {
      1: {
        asset: "BTC",
        buyOrders: {
          failed: { status: "SUBMIT_FAILED" },
          no: { id: "buy-no", status: "OPEN" },
          yes: { id: "buy-yes", status: "CANCELED" },
        },
      },
      2: {
        asset: "BTC",
        buyOrders: {
          yes: { hash: "0xbuy", status: "CANCELED" },
        },
        positions: {
          yes: { shares: 101, soldShares: 0 },
        },
        sellOrders: {
          yes: { status: "OPEN" },
        },
      },
    },
    updatedAt: "2026-05-31T03:59:00.000Z",
  }, {
    1: { interval: "1h" },
    2: { interval: "15m" },
  });

  assert.deepEqual(stateSummary.completedBuyPlacementsByInterval, {
    "15m": 1,
    "1h": 2,
  });
  assert.deepEqual(summarizeCompletedBuyPlacements({
    markets: {
      1: {
        buyOrders: {
          failed: { status: "SUBMIT_FAILED" },
          yes: { id: "buy-yes", status: "CANCELED" },
        },
      },
    },
  }, {
    1: { interval: "1h" },
  }), { "1h": 1 });
});

test("renderBotReportMarkdown produces a simplified interval report", () => {
  const stateSummary = summarizeBotState({
    markets: {
      1: {
        asset: "BTC",
        buyOrders: {
          yes: { id: "buy-yes", status: "OPEN" },
        },
      },
      2: {
        asset: "BTC",
        buyOrders: {
          yes: { hash: "0xbuy", status: "CANCELED" },
        },
      },
    },
    updatedAt: "2026-05-31T03:59:00.000Z",
  }, {
    1: { interval: "1h" },
    2: { interval: "15m" },
  });

  const markdown = renderBotReportMarkdown({
    accountSummary: {
      activity: {
        byInterval: {
          "15m": {
            filledOrders: { buyOrders: 0, buyValue: 0, count: 1, sellOrders: 1, sellValue: 2.02, shares: 101, value: 2.02 },
            marketCount: 1,
            openOrders: { buyOrders: 0, buyValue: 0, count: 0, sellOrders: 0, sellValue: 0, shares: 0, value: 0 },
            positionCount: 1,
            positionShares: 101,
          },
          "1h": {
            filledOrders: { buyOrders: 0, buyValue: 0, count: 0, sellOrders: 0, sellValue: 0, shares: 0, value: 0 },
            marketCount: 1,
            openOrders: { buyOrders: 1, buyValue: 1.01, count: 1, sellOrders: 0, sellValue: 0, shares: 101, value: 1.01 },
            positionCount: 0,
            positionShares: 0,
          },
        },
      },
      bnb: "0.009983",
      openOrderCount: 1,
      positionCount: 1,
      usdt: "59.577640",
    },
    generatedAt: "2026-05-31T04:00:00.000Z",
    logSummary: {
      actionCount: 2,
      actionCounts: { "place_buy|BTC": 1, "place_sell|BTC": 1 },
      errorCount: 1,
      errorsByType: { "predict_create_order_failed:400": 1 },
      firstRun: "2026-05-31T00:30:00.000Z",
      lastRun: "2026-05-31T03:30:00.000Z",
      runCount: 2,
      windowEnd: "2026-05-31T04:00:00.000Z",
      marketsByInterval: { "15m": [2], "1h": [1] },
      windowHours: 1,
      windowStart: "2026-05-31T00:00:00.000Z",
    },
    stateSummary,
  });

  assert.match(markdown, /Predict Bot 运行报告/);
  assert.match(markdown, /钱包余额: 59.577640 USDT，0.009983 BNB/);
  assert.match(markdown, /1小时市场/);
  assert.match(markdown, /15分钟市场/);
  assert.match(markdown, /买入挂单: 1 次/);
  assert.match(markdown, /买入成交: 0 次/);
  assert.match(markdown, /卖出成交: 1 次/);
  assert.match(markdown, /盈亏: 2.0200 USDT/);
  assert.doesNotMatch(markdown, /运行轮次/);
  assert.doesNotMatch(markdown, /错误数/);
});
