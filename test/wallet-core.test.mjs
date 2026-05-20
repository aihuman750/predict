import test from "node:test";
import assert from "node:assert/strict";

import {
  mergeFavoriteMarkets,
  normalizeWalletAddress,
  positionToFavoriteMarket,
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
