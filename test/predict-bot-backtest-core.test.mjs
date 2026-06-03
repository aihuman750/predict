import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBacktestSummary,
  buildRoundTripBacktestSummary,
  compareBacktestPrices,
  simulateMarketRoundTripStrategy,
  simulateMarketStrategy,
  weiToNumber,
} from "../scripts/predict-bot-backtest-core.mjs";

function match({
  amount = "200000000000000000000",
  executedAt,
  outcome = "Down",
  price = "10000000000000000",
  quoteType = "Ask",
} = {}) {
  return {
    amountFilled: amount,
    executedAt,
    priceExecuted: price,
    taker: {
      outcome: { name: outcome },
      quoteType,
    },
  };
}

const resolvedMarket = {
  endsAt: "2026-06-01T00:15:00.000Z",
  id: 1,
  markets: [{
    id: 10,
    outcomes: [
      { name: "Up", status: "LOST" },
      { name: "Down", status: "WON" },
    ],
    resolution: { name: "Down", status: "WON" },
  }],
  slug: "btc-updown-15m-1780272000",
  startsAt: "2026-06-01T00:00:00.000Z",
  title: "Bitcoin Up or Down - June 1, 12AM-12:15AM ET",
};

test("weiToNumber parses 18-decimal API amounts", () => {
  assert.equal(weiToNumber("10000000000000000"), 0.01);
  assert.equal(weiToNumber("101000000000000000000"), 101);
});

test("simulateMarketStrategy only fills passive buy candidates inside the buy window", () => {
  const result = simulateMarketStrategy({
    buyPrice: 0.01,
    buyWindowMinutes: 10,
    market: resolvedMarket,
    matches: [
      match({ executedAt: "2026-06-01T00:02:00.000Z", outcome: "Down" }),
      match({ executedAt: "2026-06-01T00:02:30.000Z", outcome: "Down", quoteType: "Bid" }),
      match({ executedAt: "2026-06-01T00:03:00.000Z", outcome: "Up", price: "20000000000000000" }),
      match({ executedAt: "2026-06-01T00:11:00.000Z", outcome: "Up" }),
    ],
    sharesPerOutcome: 101,
  });

  assert.equal(result.filledOrders, 1);
  assert.equal(result.filledShares, 101);
  assert.equal(result.winShares, 101);
  assert.equal(result.lossShares, 0);
  assert.equal(result.cost, 1.01);
  assert.equal(result.payout, 101);
  assert.equal(result.pnl, 99.99);
});

test("simulateMarketStrategy records losing fills and caps shares by order size", () => {
  const result = simulateMarketStrategy({
    buyPrice: 0.01,
    buyWindowMinutes: 10,
    market: resolvedMarket,
    matches: [
      match({
        amount: "50000000000000000000",
        executedAt: "2026-06-01T00:04:00.000Z",
        outcome: "Up",
      }),
    ],
    sharesPerOutcome: 101,
  });

  assert.equal(result.filledOrders, 1);
  assert.equal(result.filledShares, 50);
  assert.equal(result.winShares, 0);
  assert.equal(result.lossShares, 50);
  assert.equal(result.cost, 0.5);
  assert.equal(result.payout, 0);
  assert.equal(result.pnl, -0.5);
});

test("buildBacktestSummary aggregates market results", () => {
  const first = simulateMarketStrategy({
    buyPrice: 0.01,
    market: resolvedMarket,
    matches: [match({ executedAt: "2026-06-01T00:02:00.000Z", outcome: "Down" })],
    sharesPerOutcome: 101,
  });
  const second = simulateMarketStrategy({
    buyPrice: 0.01,
    market: {
      ...resolvedMarket,
      id: 2,
      slug: "btc-updown-15m-1780272900",
    },
    matches: [],
    sharesPerOutcome: 101,
  });

  assert.deepEqual(buildBacktestSummary([first, second]), {
    attemptedOrders: 4,
    candidateFillVolume: 200,
    cost: 1.01,
    filledMarkets: 1,
    filledOrders: 1,
    filledShares: 101,
    lossShares: 0,
    marketCount: 2,
    payout: 101,
    pnl: 99.99,
    roiPct: 9900,
    winRateByFilledOrderPct: 100,
    winShares: 101,
  });
});

test("compareBacktestPrices summarizes the same markets across buy prices", () => {
  const marketRuns = [{
    market: resolvedMarket,
    matches: [
      match({
        executedAt: "2026-06-01T00:02:00.000Z",
        outcome: "Down",
        price: "20000000000000000",
      }),
      match({
        executedAt: "2026-06-01T00:03:00.000Z",
        outcome: "Down",
        price: "30000000000000000",
      }),
    ],
    matchPages: 1,
    matchRows: 2,
  }];

  const results = compareBacktestPrices({
    buyPrices: [0.02, 0.03],
    buyWindowMinutes: 10,
    marketRuns,
    sharesPerOutcome: 101,
  });

  assert.deepEqual(results.map((row) => row.buyPrice), [0.02, 0.03]);
  assert.equal(results[0].summary.filledShares, 101);
  assert.equal(results[0].summary.cost, 2.02);
  assert.equal(results[0].summary.payout, 101);
  assert.equal(results[0].summary.pnl, 98.98);
  assert.equal(results[1].summary.filledShares, 101);
  assert.equal(results[1].summary.cost, 3.03);
  assert.equal(results[1].summary.payout, 101);
  assert.equal(results[1].summary.pnl, 97.97);
});

test("simulateMarketRoundTripStrategy sells only after a passive buy fill and settles unsold winners", () => {
  const result = simulateMarketRoundTripStrategy({
    buyPrice: 0.05,
    buyWindowMinutes: 5,
    market: resolvedMarket,
    matches: [
      match({
        amount: "100000000000000000000",
        executedAt: "2026-06-01T00:01:00.000Z",
        outcome: "Down",
        price: "100000000000000000",
        quoteType: "Bid",
      }),
      match({
        amount: "101000000000000000000",
        executedAt: "2026-06-01T00:02:00.000Z",
        outcome: "Down",
        price: "50000000000000000",
        quoteType: "Ask",
      }),
      match({
        amount: "60000000000000000000",
        executedAt: "2026-06-01T00:03:00.000Z",
        outcome: "Down",
        price: "100000000000000000",
        quoteType: "Bid",
      }),
      match({
        amount: "41000000000000000000",
        executedAt: "2026-06-01T00:06:00.000Z",
        outcome: "Down",
        price: "50000000000000000",
        quoteType: "Ask",
      }),
    ],
    sellPrice: 0.1,
    sharesPerOutcome: 101,
  });

  assert.equal(result.filledOrders, 1);
  assert.equal(result.boughtShares, 101);
  assert.equal(result.soldShares, 60);
  assert.equal(result.unsoldShares, 41);
  assert.equal(result.cost, 5.05);
  assert.equal(result.sellProceeds, 6);
  assert.equal(result.settlementPayout, 41);
  assert.equal(result.payout, 47);
  assert.equal(result.pnl, 41.95);
});

test("simulateMarketRoundTripStrategy does not backfill later buys into earlier sell volume", () => {
  const result = simulateMarketRoundTripStrategy({
    buyPrice: 0.05,
    buyWindowMinutes: 5,
    market: resolvedMarket,
    matches: [
      match({
        amount: "50000000000000000000",
        executedAt: "2026-06-01T00:02:00.000Z",
        outcome: "Up",
        price: "50000000000000000",
        quoteType: "Ask",
      }),
      match({
        amount: "101000000000000000000",
        executedAt: "2026-06-01T00:03:00.000Z",
        outcome: "Up",
        price: "100000000000000000",
        quoteType: "Bid",
      }),
      match({
        amount: "51000000000000000000",
        executedAt: "2026-06-01T00:04:00.000Z",
        outcome: "Up",
        price: "50000000000000000",
        quoteType: "Ask",
      }),
    ],
    sellPrice: 0.1,
    sharesPerOutcome: 101,
  });

  assert.equal(result.boughtShares, 101);
  assert.equal(result.soldShares, 50);
  assert.equal(result.unsoldShares, 51);
  assert.equal(result.settlementPayout, 0);
  assert.equal(result.pnl, -0.05);
});

test("buildRoundTripBacktestSummary aggregates buy, sell, and settlement legs", () => {
  const first = simulateMarketRoundTripStrategy({
    buyPrice: 0.05,
    buyWindowMinutes: 5,
    market: resolvedMarket,
    matches: [
      match({
        amount: "101000000000000000000",
        executedAt: "2026-06-01T00:02:00.000Z",
        outcome: "Down",
        price: "50000000000000000",
        quoteType: "Ask",
      }),
      match({
        amount: "101000000000000000000",
        executedAt: "2026-06-01T00:03:00.000Z",
        outcome: "Down",
        price: "100000000000000000",
        quoteType: "Bid",
      }),
    ],
    sellPrice: 0.1,
    sharesPerOutcome: 101,
  });
  const second = simulateMarketRoundTripStrategy({
    buyPrice: 0.05,
    buyWindowMinutes: 5,
    market: {
      ...resolvedMarket,
      id: 2,
      slug: "btc-updown-15m-1780272900",
    },
    matches: [],
    sellPrice: 0.1,
    sharesPerOutcome: 101,
  });

  assert.deepEqual(buildRoundTripBacktestSummary([first, second]), {
    attemptedOrders: 4,
    boughtShares: 101,
    buyCandidateFillVolume: 101,
    cost: 5.05,
    filledMarkets: 1,
    filledOrders: 1,
    marketCount: 2,
    payout: 10.1,
    pnl: 5.05,
    roiPct: 100,
    sellCandidateFillVolume: 101,
    sellFilledMarkets: 1,
    sellProceeds: 10.1,
    soldShares: 101,
    settlementPayout: 0,
    unsoldShares: 0,
  });
});
