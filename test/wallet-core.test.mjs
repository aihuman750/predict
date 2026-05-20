import test from "node:test";
import assert from "node:assert/strict";

import {
  marketToFavoriteMarket,
  mergeFavoriteMarkets,
  normalizeWalletAddress,
  orderToFavoriteMarket,
  positionToFavoriteMarket,
  summarizeOrder,
  summarizePosition,
} from "../public/wallet-core.mjs";

const address = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

const position = {
  id: "position-1",
  market: {
    id: 123,
    question: "Will Hylo launch a token by June 30, 2026?",
    categorySlug: "will-hylo-launch-a-token-by",
  },
  outcome: {
    name: "Yes",
    indexSet: 1,
  },
  amount: "42.5",
  valueUsd: "12.34",
  averageBuyPriceUsd: "0.29",
  pnlUsd: "-1.23",
};

const market = {
  id: 456,
  question: "Will Nexus FDV be above $50M one day after launch?",
  categorySlug: "nexus-fdv-above-50m-one-day-after-launch",
  outcomes: [
    { name: "Yes", tokenId: "1001", indexSet: 1 },
    { name: "No", tokenId: "1002", indexSet: 2 },
  ],
};

const buyOrder = {
  id: "order-1",
  marketId: 456,
  amount: "12",
  amountFilled: "2",
  order: {
    hash: "0xhash",
    tokenId: "1001",
    side: 0,
    makerAmount: "5000000000000000000",
    takerAmount: "10000000000000000000",
    expiration: "1790812800",
  },
  rewardEarningRate: 4.25,
  status: "OPEN",
  strategy: "LIMIT",
};

test("normalizeWalletAddress accepts EVM addresses and lowercases them", () => {
  assert.equal(normalizeWalletAddress(address), "0x742d35cc6634c0532925a3b844bc454e4438f44e");
  assert.equal(normalizeWalletAddress(" not-an-address "), null);
  assert.equal(normalizeWalletAddress(""), null);
});

test("positionToFavoriteMarket converts a Predict position market into a favorite", () => {
  assert.deepEqual(positionToFavoriteMarket(position), {
    id: "123",
    key: "123",
    title: "Will Hylo launch a token by June 30, 2026?",
    question: "Will Hylo launch a token by June 30, 2026?",
    categorySlug: "will-hylo-launch-a-token-by",
    yesBid: null,
    noBid: null,
    expiresAtSec: null,
    url: "https://predict.fun/market/will-hylo-launch-a-token-by",
  });

  assert.equal(positionToFavoriteMarket({ market: {} }), null);
});

test("marketToFavoriteMarket converts a Predict market into a favorite", () => {
  assert.deepEqual(marketToFavoriteMarket(market), {
    id: "456",
    key: "456",
    title: "Will Nexus FDV be above $50M one day after launch?",
    question: "Will Nexus FDV be above $50M one day after launch?",
    categorySlug: "nexus-fdv-above-50m-one-day-after-launch",
    yesBid: null,
    noBid: null,
    expiresAtSec: null,
    url: "https://predict.fun/market/nexus-fdv-above-50m-one-day-after-launch",
  });

  assert.equal(marketToFavoriteMarket({}), null);
});

test("orderToFavoriteMarket converts a Predict open order market into a favorite", () => {
  assert.deepEqual(orderToFavoriteMarket(buyOrder, market), {
    id: "456",
    key: "456",
    title: "Will Nexus FDV be above $50M one day after launch?",
    question: "Will Nexus FDV be above $50M one day after launch?",
    categorySlug: "nexus-fdv-above-50m-one-day-after-launch",
    yesBid: null,
    noBid: null,
    expiresAtSec: null,
    url: "https://predict.fun/market/nexus-fdv-above-50m-one-day-after-launch",
  });
});

test("mergeFavoriteMarkets prepends new markets and avoids duplicate keys", () => {
  const existing = [{ key: "123", title: "Existing Hylo" }];
  const next = [
    { key: "999", title: "New market" },
    { key: "123", title: "Duplicate Hylo" },
    null,
  ];

  assert.deepEqual(mergeFavoriteMarkets(existing, next), [
    { key: "999", title: "New market" },
    { key: "123", title: "Existing Hylo" },
  ]);
});

test("summarizePosition produces display-safe wallet position rows", () => {
  assert.deepEqual(summarizePosition(position), {
    id: "position-1",
    marketId: "123",
    title: "Will Hylo launch a token by June 30, 2026?",
    outcome: "Yes",
    amount: "42.5",
    valueUsd: "12.34",
    averageBuyPriceUsd: "0.29",
    pnlUsd: "-1.23",
    url: "https://predict.fun/market/will-hylo-launch-a-token-by",
  });
});

test("summarizeOrder produces display-safe open order rows", () => {
  assert.deepEqual(summarizeOrder(buyOrder, market), {
    id: "order-1",
    hash: "0xhash",
    marketId: "456",
    title: "Will Nexus FDV be above $50M one day after launch?",
    outcome: "Yes",
    side: "买入",
    price: "0.5",
    quantity: "10",
    remainingQuantity: "8",
    amountFilled: "2",
    rewardEarningRate: "4.25",
    status: "OPEN",
    strategy: "LIMIT",
    expiration: "2026-10-01 08:00",
    url: "https://predict.fun/market/nexus-fdv-above-50m-one-day-after-launch",
  });
});
