import test from "node:test";
import assert from "node:assert/strict";

import {
  BUY_PRICE_MICROS,
  HOLD_EXPIRY,
  SELL_PRICE_MICROS,
  addBacktestMatrices,
  buildBacktestMatrix,
  createEmptyBacktestMatrix,
  normalizedCutoffMinutes,
  parseBacktestMatrixPayload,
  priceToMicros,
  serializeBacktestMatrix,
  simulateBacktestCell,
} from "../scripts/backtest-matrix-core.mjs";

const market = {
  endsAt: "2026-06-01T00:15:00.000Z",
  interval: "15m",
  marketId: "btc-15m-1",
  slug: "btc-updown-15m-1780272000",
  startsAt: "2026-06-01T00:00:00.000Z",
  winner: "yes",
};

function match({
  elapsedSeconds,
  executedAt,
  outcome = "yes",
  price = 0.05,
  quoteType = "ask",
  shares = 100,
} = {}) {
  return {
    elapsedSeconds,
    executedAt: executedAt || new Date(Date.parse(market.startsAt) + elapsedSeconds * 1000).toISOString(),
    outcome,
    price,
    quoteType,
    shares,
  };
}

test("simulateBacktestCell filters passive buys outside the cutoff window", () => {
  const result = simulateBacktestCell({
    buyPriceMicros: priceToMicros(0.05),
    cutoffMinutes: 5,
    interval: "15m",
    market,
    matches: [
      match({ elapsedSeconds: 60, shares: 60 }),
      match({ elapsedSeconds: 360, shares: 60 }),
    ],
    perspective: "yes",
    sellPriceMicros: HOLD_EXPIRY,
  });

  assert.equal(result.buyShares, 60);
  assert.equal(result.cost, 3);
  assert.equal(result.payout, 60);
  assert.equal(result.pnl, 57);
});

test("simulateBacktestCell sells after buys and settles the remaining winning inventory", () => {
  const result = simulateBacktestCell({
    buyPriceMicros: priceToMicros(0.05),
    cutoffMinutes: 5,
    interval: "15m",
    market,
    matches: [
      match({ elapsedSeconds: 30, price: 0.1, quoteType: "bid", shares: 100 }),
      match({ elapsedSeconds: 60, price: 0.05, quoteType: "ask", shares: 100 }),
      match({ elapsedSeconds: 120, price: 0.1, quoteType: "bid", shares: 40 }),
    ],
    perspective: "yes",
    sellPriceMicros: priceToMicros(0.1),
  });

  assert.equal(result.buyShares, 100);
  assert.equal(result.sellShares, 40);
  assert.equal(result.settlementShares, 60);
  assert.equal(result.cost, 5);
  assert.equal(result.payout, 64);
  assert.equal(result.pnl, 59);
});

test("HOLD_EXPIRY row never sells before settlement", () => {
  const result = simulateBacktestCell({
    buyPriceMicros: priceToMicros(0.05),
    cutoffMinutes: 5,
    interval: "15m",
    market,
    matches: [
      match({ elapsedSeconds: 60, price: 0.05, quoteType: "ask", shares: 100 }),
      match({ elapsedSeconds: 120, price: 0.2, quoteType: "bid", shares: 100 }),
    ],
    perspective: "yes",
    sellPriceMicros: HOLD_EXPIRY,
  });

  assert.equal(result.sellShares, 0);
  assert.equal(result.settlementShares, 100);
  assert.equal(result.pnl, 95);
});

test("yes and no perspectives are calculated independently", () => {
  const yes = simulateBacktestCell({
    buyPriceMicros: priceToMicros(0.05),
    cutoffMinutes: 5,
    interval: "15m",
    market,
    matches: [
      match({ elapsedSeconds: 60, outcome: "yes", shares: 100 }),
      match({ elapsedSeconds: 60, outcome: "no", shares: 100 }),
    ],
    perspective: "yes",
    sellPriceMicros: HOLD_EXPIRY,
  });
  const no = simulateBacktestCell({
    buyPriceMicros: priceToMicros(0.05),
    cutoffMinutes: 5,
    interval: "15m",
    market,
    matches: [
      match({ elapsedSeconds: 60, outcome: "yes", shares: 100 }),
      match({ elapsedSeconds: 60, outcome: "no", shares: 100 }),
    ],
    perspective: "no",
    sellPriceMicros: HOLD_EXPIRY,
  });

  assert.equal(yes.pnl, 95);
  assert.equal(no.pnl, -5);
});

test("cutoff minutes are capped by interval duration", () => {
  assert.equal(normalizedCutoffMinutes(10, "5m"), 5);
  assert.equal(normalizedCutoffMinutes(10, "15m"), 10);
});

test("daily matrices add element-wise", () => {
  const first = buildBacktestMatrix({
    cutoffMinutes: 5,
    interval: "15m",
    markets: [{ market, matches: [match({ elapsedSeconds: 60, shares: 100 })] }],
    perspective: "yes",
  });
  const second = buildBacktestMatrix({
    cutoffMinutes: 5,
    interval: "15m",
    markets: [{ market, matches: [match({ elapsedSeconds: 60, shares: 100 })] }],
    perspective: "yes",
  });
  const total = addBacktestMatrices(createEmptyBacktestMatrix(), first);
  addBacktestMatrices(total, second);

  const buyIndex = BUY_PRICE_MICROS.indexOf(priceToMicros(0.05));
  const holdIndex = SELL_PRICE_MICROS.indexOf(HOLD_EXPIRY);
  const cellIndex = holdIndex * BUY_PRICE_MICROS.length + buyIndex;
  assert.equal(total.pnl[cellIndex], 190);
});

test("serialized matrices keep only compact heatmap fields", () => {
  const matrix = createEmptyBacktestMatrix();
  matrix.buyShares[0] = 100.1234;
  matrix.pnl[0] = 95.9876;
  matrix.sellShares[0] = 4.5;

  const serialized = serializeBacktestMatrix(matrix);
  const payload = JSON.parse(serialized);
  const parsed = parseBacktestMatrixPayload(serialized);

  assert.equal(payload.version, 2);
  assert.deepEqual(Object.keys(payload.m).sort(), ["b", "p", "s"]);
  assert.equal(serialized.includes("cost"), false);
  assert.equal(serialized.includes("payout"), false);
  assert.equal(serialized.includes("buyPrices"), false);
  assert.equal(parsed.buyShares[0], 100.123);
  assert.equal(parsed.pnl[0], 95.988);
  assert.equal(parsed.sellShares[0], 4.5);
});

test("serialized matrices can be decoded with only pnl fields", () => {
  const matrix = createEmptyBacktestMatrix();
  matrix.buyShares[0] = 100.1234;
  matrix.pnl[0] = 95.9876;
  matrix.sellShares[0] = 4.5;

  const parsed = parseBacktestMatrixPayload(serializeBacktestMatrix(matrix), { fields: ["pnl"] });

  assert.deepEqual(Object.keys(parsed), ["pnl"]);
  assert.equal(parsed.pnl[0], 95.988);
});
