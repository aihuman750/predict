import test from "node:test";
import assert from "node:assert/strict";

import { buildActivateOrderbook } from "../public/orderbook-core.mjs";

test("buildActivateOrderbook counts top-five bid and ask levels that satisfy Activate Points rules", () => {
  const summary = buildActivateOrderbook({
    market: {
      id: "m1",
      shareThreshold: 100,
      spreadThreshold: 0.06,
      tick: 0.01,
    },
    orderbook: {
      bids: [
        [0.49, 100],
        [0.48, 99],
        [0.47, 120],
        [0.46, 130],
        [0.45, 140],
        [0.44, 10_000],
      ],
      asks: [
        [0.53, 150],
        [0.54, 75],
        [0.55, 100],
        [0.56, 101],
        [0.57, 10],
        [0.58, 10_000],
      ],
      marketId: "m1",
      updateTimestampMs: 1_779_775_202_089,
    },
  });

  assert.equal(summary.spreadEligible, true);
  assert.equal(summary.validOrderCount, 7);
  assert.deepEqual(summary.bids.map((level) => level.active).slice(0, 5), [true, false, true, true, true]);
  assert.deepEqual(summary.asks.map((level) => level.active).slice(0, 5), [true, false, true, true, false]);
  assert.equal(summary.bids[0].noPrice, 0.51);
  assert.equal(summary.asks[0].noPrice, 0.47);
});

test("buildActivateOrderbook returns zero active levels when the spread is outside the market threshold", () => {
  const summary = buildActivateOrderbook({
    market: {
      id: "m2",
      shareThreshold: 100,
      spreadThreshold: 0.03,
      tick: 0.01,
    },
    orderbook: {
      bids: [[0.49, 500]],
      asks: [[0.55, 500]],
    },
  });

  assert.equal(summary.spreadEligible, false);
  assert.equal(summary.validOrderCount, 0);
  assert.equal(summary.bids[0].active, false);
  assert.equal(summary.asks[0].active, false);
});
