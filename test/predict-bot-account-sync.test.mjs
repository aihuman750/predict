import test from "node:test";
import assert from "node:assert/strict";

import {
  applyAccountSnapshotToState,
  parseShareAmount,
  summarizeFilledOrderPnl,
} from "../scripts/predict-bot-account-sync.mjs";
import { fetchEoaAccountSnapshot } from "../scripts/predict-bot-eoa-adapter.mjs";

const market = {
  asset: "BTC",
  marketId: 398076,
  outcomes: [
    { key: "yes", name: "Up", indexSet: 1, onChainId: "1001" },
    { key: "no", name: "Down", indexSet: 2, onChainId: "1002" },
  ],
};

test("parseShareAmount reads API decimals and wei strings", () => {
  assert.equal(parseShareAmount("250"), 250);
  assert.equal(parseShareAmount("1000000000000000000000"), 1000);
  assert.equal(parseShareAmount("1250000000000000000"), 1.25);
});

test("applyAccountSnapshotToState syncs open orders and positions for known bot markets", () => {
  const state = applyAccountSnapshotToState({
    markets: {
      398076: {
        positions: {
          yes: { shares: 100, soldShares: 10 },
        },
      },
    },
  }, [market], {
    openOrders: [
      {
        id: "buy-yes",
        marketId: 398076,
        amount: "1000",
        amountFilled: "250",
        order: {
          hash: "0xbuy",
          makerAmount: "10000000000000000000",
          side: 0,
          takerAmount: "1000000000000000000000",
          tokenId: "1001",
        },
        status: "OPEN",
      },
      {
        id: "sell-no",
        marketId: 398076,
        amountFilled: "0",
        order: {
          hash: "0xsell",
          makerAmount: "500000000000000000000",
          side: 1,
          takerAmount: "10000000000000000000",
          tokenId: "1002",
        },
        status: "OPEN",
      },
    ],
    positions: [
      {
        amount: "250",
        market: { id: 398076 },
        outcome: { indexSet: 1, tokenId: "1001" },
      },
    ],
  }, "2026-05-29T10:12:00.000Z");

  assert.equal(state.markets["398076"].buyOrders.yes.id, "buy-yes");
  assert.equal(state.markets["398076"].buyOrders.yes.remainingShares, 750);
  assert.equal(state.markets["398076"].buyOrders.yes.price, 0.01);
  assert.equal(state.markets["398076"].sellOrders.no.id, "sell-no");
  assert.equal(state.markets["398076"].sellOrders.no.remainingShares, 500);
  assert.equal(state.markets["398076"].sellOrders.no.price, 0.02);
  assert.deepEqual(state.markets["398076"].positions.yes, {
    shares: 250,
    soldShares: 10,
    syncedAt: "2026-05-29T10:12:00.000Z",
  });
  assert.equal(JSON.stringify(state).includes("signature"), false);
});

test("applyAccountSnapshotToState ignores orders outside the configured bot markets", () => {
  const state = applyAccountSnapshotToState({}, [market], {
    openOrders: [
      {
        id: "other",
        marketId: 123,
        order: { side: 0, tokenId: "9001", takerAmount: "1000000000000000000" },
      },
    ],
    positions: [
      { amount: "1", market: { id: 123 }, outcome: { indexSet: 1 } },
    ],
  }, "2026-05-29T10:12:00.000Z");

  assert.deepEqual(state.markets ?? {}, {});
});

test("applyAccountSnapshotToState marks locally open orders missing from the API snapshot as not open", () => {
  const state = applyAccountSnapshotToState({
    markets: {
      398076: {
        buyOrders: {
          yes: { id: "old-buy", remainingShares: 10, status: "OPEN" },
        },
        sellOrders: {
          no: { id: "old-sell", remainingShares: 51, shares: 51, status: "OPEN" },
        },
      },
    },
  }, [market], {
    openOrders: [],
    positions: [
      {
        amount: "50",
        market: { id: 398076 },
        outcome: { indexSet: 2, tokenId: "1002" },
      },
    ],
  }, "2026-05-29T10:31:00.000Z");

  assert.equal(state.markets["398076"].buyOrders.yes.status, "SYNC_MISSING");
  assert.equal(state.markets["398076"].buyOrders.yes.remainingShares, 0);
  assert.equal(state.markets["398076"].sellOrders.no.status, "SYNC_MISSING");
  assert.equal(state.markets["398076"].sellOrders.no.remainingShares, 0);
  assert.deepEqual(state.markets["398076"].positions.no, {
    shares: 50,
    soldShares: 0,
    syncedAt: "2026-05-29T10:31:00.000Z",
  });
});

test("summarizeFilledOrderPnl totals filled orders for new-strategy markets only", () => {
  const pnl = summarizeFilledOrderPnl({
    assets: ["BTC"],
    filledOrders: [
      {
        marketId: 398076,
        order: {
          makerAmount: "5050000000000000000",
          side: 0,
          takerAmount: "101000000000000000000",
        },
      },
      {
        marketId: 398076,
        order: {
          makerAmount: "101000000000000000000",
          side: 1,
          takerAmount: "1010000000000000000",
        },
      },
      {
        marketId: 999999,
        order: {
          makerAmount: "1000000000000000000",
          side: 0,
          takerAmount: "100000000000000000000",
        },
      },
    ],
    markets: [],
    pnlBaselineAt: "2026-05-31T13:18:00.000Z",
    state: {
      markets: {
        398076: {
          asset: "BTC",
          buyOrders: {
            yes: {
              status: "OPEN",
              submittedAt: "2026-05-31T13:19:00.000Z",
            },
          },
        },
        999999: { asset: "ETH" },
      },
    },
  });

  assert.equal(pnl, -4.04);
});

test("summarizeFilledOrderPnl ignores historical strategy markets before the baseline", () => {
  const pnl = summarizeFilledOrderPnl({
    assets: ["BTC"],
    filledOrders: [
      {
        marketId: 398076,
        order: {
          makerAmount: "10000000000000000000",
          side: 0,
          takerAmount: "1000000000000000000000",
        },
      },
      {
        marketId: 398076,
        order: {
          makerAmount: "1000000000000000000000",
          side: 1,
          takerAmount: "20000000000000000000",
        },
      },
    ],
    pnlBaselineAt: "2026-05-31T13:18:00.000Z",
    state: {
      markets: {
        398076: {
          asset: "BTC",
          buyOrders: {
            no: {
              status: "CANCELED",
              submittedAt: "2026-05-30T13:18:00.000Z",
            },
          },
        },
      },
    },
  });

  assert.equal(pnl, 0);
});

test("fetchEoaAccountSnapshot reads account, open orders, and positions with scoped auth", async () => {
  const calls = [];
  const snapshot = await fetchEoaAccountSnapshot({
    apiBase: "https://api.predict.fun",
    apiKey: "api-secret-value",
    walletPrivateKey: "wallet-secret-value",
  }, {
    async getJwt() {
      return "jwt-secret-value";
    },
    async fetch(url, init) {
      calls.push({ init, url: String(url) });
      if (String(url).endsWith("/v1/account")) {
        return {
          ok: true,
          async json() {
            return { success: true, data: { address: "0x1111111111111111111111111111111111111111" } };
          },
        };
      }
      if (String(url).includes("/v1/orders")) {
        return {
          ok: true,
          async json() {
            return { success: true, data: [{ id: "order-1" }] };
          },
        };
      }
      if (String(url).includes("/v1/positions/")) {
        return {
          ok: true,
          async json() {
            return { success: true, data: [{ id: "position-1" }] };
          },
        };
      }
      throw new Error(`unexpected_url:${url}`);
    },
  });

  assert.deepEqual(snapshot, {
    accountAddress: "0x1111111111111111111111111111111111111111",
    filledOrders: [{ id: "order-1" }],
    openOrders: [{ id: "order-1" }],
    positions: [{ id: "position-1" }],
  });
  const accountCall = calls.find((call) => /\/v1\/account$/.test(call.url));
  const openOrdersCall = calls.find((call) => /status=OPEN/.test(call.url));
  const filledOrdersCall = calls.find((call) => /status=FILLED/.test(call.url));
  const positionsCall = calls.find((call) => /\/v1\/positions\/0x1111111111111111111111111111111111111111$/.test(call.url));
  assert.ok(accountCall);
  assert.ok(openOrdersCall);
  assert.ok(filledOrdersCall);
  assert.ok(positionsCall);
  assert.equal(accountCall.init.headers.Authorization, "Bearer jwt-secret-value");
  assert.equal(openOrdersCall.init.headers.Authorization, "Bearer jwt-secret-value");
  assert.equal(filledOrdersCall.init.headers.Authorization, "Bearer jwt-secret-value");
  assert.equal(positionsCall.init.headers["x-api-key"], "api-secret-value");
  assert.equal(JSON.stringify(calls).includes("wallet-secret-value"), false);
});
