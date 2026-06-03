import test from "node:test";
import assert from "node:assert/strict";

import { executeActions } from "../scripts/predict-bot-executor.mjs";

const NOW = "2026-05-29T10:00:20.000Z";

const buyAction = {
  asset: "BTC",
  marketId: 398076,
  outcomeKey: "yes",
  outcomeName: "Up",
  price: 0.01,
  shares: 1000,
  type: "place_buy",
};

const sellAction = {
  asset: "BTC",
  marketId: 398076,
  outcomeKey: "yes",
  outcomeName: "Up",
  price: 0.02,
  shares: 500,
  type: "place_sell",
};

const cancelAction = {
  asset: "BTC",
  marketId: 398076,
  orderId: "buy-real-no",
  outcomeKey: "no",
  outcomeName: "Down",
  shares: 500,
  type: "cancel_buy",
};

test("executeActions dry-run applies actions locally and does not require a live adapter", async () => {
  const result = await executeActions({
    actions: [buyAction],
    live: false,
    now: NOW,
    state: {},
  });

  assert.equal(result.executed.length, 1);
  assert.equal(result.executed[0].mode, "dry_run");
  assert.equal(result.state.markets["398076"].buyOrders.yes.status, "OPEN");
  assert.equal(result.state.markets["398076"].buyOrders.yes.price, 0.01);
});

test("executeActions live mode refuses to run without a complete adapter", async () => {
  await assert.rejects(() => executeActions({
    actions: [buyAction],
    live: true,
    now: NOW,
    state: {},
  }), /live_adapter_required/);
});

test("executeActions live mode calls adapter methods and records returned order ids", async () => {
  const calls = [];
  const result = await executeActions({
    actions: [buyAction, sellAction, cancelAction],
    live: true,
    now: NOW,
    state: {
      markets: {
        398076: {
          buyOrders: {
            no: {
              id: "buy-real-no",
              outcomeName: "Down",
              price: 0.01,
              remainingShares: 500,
              shares: 1000,
              status: "PARTIALLY_FILLED",
            },
          },
          positions: {
            yes: { shares: 500, soldShares: 0 },
          },
          sellOrders: {},
        },
      },
    },
    adapter: {
      async placeOrder(action) {
        calls.push(["placeOrder", action.type, action.price, action.shares]);
        return {
          orderHash: `${action.type}-hash`,
          orderId: `${action.type}-id`,
          status: "OPEN",
        };
      },
      async cancelOrder(action) {
        calls.push(["cancelOrder", action.orderId, action.shares]);
        return {
          orderId: action.orderId,
          status: "CANCELED",
        };
      },
    },
  });

  assert.deepEqual(calls, [
    ["placeOrder", "place_buy", 0.01, 1000],
    ["placeOrder", "place_sell", 0.02, 500],
    ["cancelOrder", "buy-real-no", 500],
  ]);
  assert.equal(result.state.markets["398076"].buyOrders.yes.id, "place_buy-id");
  assert.equal(result.state.markets["398076"].buyOrders.no.id, "buy-real-no");
  assert.equal(result.state.markets["398076"].buyOrders.no.status, "CANCELED");
  assert.equal(result.state.markets["398076"].sellOrders.yes.id, "place_sell-id");
  assert.equal(result.state.markets["398076"].positions.yes.soldShares, 500);
  assert.equal(result.executed.length, 3);
  assert.equal(result.executed[0].mode, "live");
});

test("executeActions live mode stops before later actions when the adapter fails", async () => {
  const calls = [];
  await assert.rejects(() => executeActions({
    actions: [buyAction, sellAction],
    live: true,
    now: NOW,
    state: {},
    adapter: {
      async placeOrder(action) {
        calls.push(action.type);
        throw new Error("signed_order_failed");
      },
      async cancelOrder() {
        throw new Error("should_not_call");
      },
    },
  }), (error) => {
    assert.match(error.message, /signed_order_failed/);
    assert.equal(error.state.markets["398076"].buyOrders.yes.status, "SUBMIT_FAILED");
    assert.equal(error.state.markets["398076"].buyOrders.yes.lastError, "signed_order_failed");
    return true;
  });

  assert.deepEqual(calls, ["place_buy"]);
});
