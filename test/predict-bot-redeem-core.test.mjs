import test from "node:test";
import assert from "node:assert/strict";

import {
  redeemWonPositions,
  redeemableWonPositions,
} from "../scripts/predict-bot-redeem-core.mjs";

function position(overrides = {}) {
  return {
    amount: "101",
    market: {
      conditionId: "0xcondition",
      id: 414439,
      isNegRisk: false,
      isYieldBearing: false,
      status: "RESOLVED",
      tradingStatus: "CLOSED",
    },
    outcome: {
      indexSet: 1,
      name: "Up",
      status: "WON",
    },
    ...overrides,
  };
}

test("redeemableWonPositions only selects positive resolved winning positions", () => {
  const rows = redeemableWonPositions([
    position(),
    position({ amount: "0" }),
    position({ outcome: { indexSet: 2, name: "Down", status: "LOST" } }),
    position({ market: { conditionId: "0xopen", id: 1, status: "OPEN", tradingStatus: "OPEN" } }),
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].market.id, 414439);
});

test("redeemWonPositions calls the live adapter for each redeemable position", async () => {
  const calls = [];
  const results = await redeemWonPositions({
    adapter: {
      async redeemPosition(row) {
        calls.push(row.market.id);
        return { success: true };
      },
    },
    positions: [
      position(),
      position({ outcome: { indexSet: 2, name: "Down", status: "LOST" } }),
    ],
  });

  assert.deepEqual(calls, [414439]);
  assert.deepEqual(results, [{ marketId: 414439, outcomeName: "Up", success: true }]);
});
