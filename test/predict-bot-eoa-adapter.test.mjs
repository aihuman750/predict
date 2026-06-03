import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRedeemPositionsOptions,
  buildSignedLimitOrder,
  createEoaLiveAdapter,
  decimalToWei,
  readEoaAdapterConfig,
  requestEoaJwt,
} from "../scripts/predict-bot-eoa-adapter.mjs";

const baseConfig = {
  apiBase: "https://api.predict.fun",
  apiKey: "api-secret-value",
  rpcUrl: "https://rpc.example",
  walletPrivateKey: "wallet-secret-value",
};

const buyAction = {
  asset: "BTC",
  feeRateBps: 7,
  isNegRisk: false,
  isYieldBearing: true,
  marketId: 398076,
  outcomeKey: "yes",
  outcomeName: "Up",
  outcomeTokenId: "123456",
  price: 0.01,
  shares: 1000,
  type: "place_buy",
};

function fakeBuilder(calls) {
  return {
    getLimitOrderAmounts(input) {
      calls.push(["getLimitOrderAmounts", input]);
      return {
        makerAmount: 10n,
        pricePerShare: input.pricePerShareWei,
        takerAmount: input.quantityWei,
      };
    },
    buildOrder(strategy, input) {
      calls.push(["buildOrder", strategy, input]);
      return {
        expiration: "4102444800",
        feeRateBps: String(input.feeRateBps),
        maker: "0xmaker",
        makerAmount: String(input.makerAmount),
        nonce: "0",
        salt: "42",
        side: input.side,
        signatureType: 0,
        signer: "0xmaker",
        taker: "0x0000000000000000000000000000000000000000",
        takerAmount: String(input.takerAmount),
        tokenId: String(input.tokenId),
      };
    },
    buildTypedData(order, options) {
      calls.push(["buildTypedData", order, options]);
      return { message: order, options };
    },
    async signTypedDataOrder(typedData) {
      calls.push(["signTypedDataOrder", typedData]);
      return { ...typedData.message, signature: "0xsigned" };
    },
    buildTypedDataHash(typedData) {
      calls.push(["buildTypedDataHash", typedData]);
      return "0xhash";
    },
  };
}

test("readEoaAdapterConfig requires private-key wallet env without leaking values", () => {
  assert.throws(() => readEoaAdapterConfig({
    PREDICT_BOT_API_KEY: "api-secret-value",
    PREDICT_BOT_RPC_URL: "",
    PREDICT_BOT_WALLET_PRIVATE_KEY: "wallet-secret-value",
  }), (error) => {
    assert.match(error.message, /missing_eoa_adapter_env:PREDICT_BOT_RPC_URL/);
    assert.equal(error.message.includes("api-secret-value"), false);
    assert.equal(error.message.includes("wallet-secret-value"), false);
    return true;
  });
});

test("decimalToWei converts API decimal prices and share quantities exactly", () => {
  assert.equal(decimalToWei(0.01), 10_000_000_000_000_000n);
  assert.equal(decimalToWei("0.02"), 20_000_000_000_000_000n);
  assert.equal(decimalToWei(1000), 1_000_000_000_000_000_000_000n);
});

test("buildSignedLimitOrder signs a LIMIT order with action metadata", async () => {
  const calls = [];
  const signed = await buildSignedLimitOrder({
    action: buyAction,
    builder: fakeBuilder(calls),
    Side: { BUY: 0, SELL: 1 },
  });

  assert.equal(signed.order.hash, "0xhash");
  assert.equal(signed.order.signature, "0xsigned");
  assert.equal(calls[0][0], "getLimitOrderAmounts");
  assert.equal(calls[0][1].side, 0);
  assert.equal(calls[0][1].pricePerShareWei, 10_000_000_000_000_000n);
  assert.equal(calls[0][1].quantityWei, 1_000_000_000_000_000_000_000n);
  assert.equal(calls[1][2].tokenId, "123456");
  assert.equal(calls[1][2].feeRateBps, 7n);
  assert.deepEqual(calls[2][2], { isNegRisk: false, isYieldBearing: true });
  assert.equal(signed.pricePerShare, "10000000000000000");
});

test("createEoaLiveAdapter posts signed orders with bearer auth and no secret in body", async () => {
  const requests = [];
  const adapter = createEoaLiveAdapter({
    ...baseConfig,
    jwt: "jwt-secret-value",
  }, {
    async getBuilderContext() {
      return { builder: fakeBuilder([]), Side: { BUY: 0, SELL: 1 } };
    },
    async fetch(url, init) {
      requests.push({ init, url: String(url) });
      return {
        ok: true,
        async json() {
          return { success: true, data: { orderHash: "0xhash", orderId: "order-1" } };
        },
      };
    },
  });

  const response = await adapter.placeOrder(buyAction);
  const body = JSON.parse(requests[0].init.body);

  assert.equal(response.orderId, "order-1");
  assert.equal(requests[0].url, "https://api.predict.fun/v1/orders");
  assert.equal(requests[0].init.headers["x-api-key"], "api-secret-value");
  assert.equal(requests[0].init.headers.Authorization, "Bearer jwt-secret-value");
  assert.equal(body.data.strategy, "LIMIT");
  assert.equal(body.data.isPostOnly, true);
  assert.equal(body.data.pricePerShare, "10000000000000000");
  assert.equal("reservedBalancePolicy" in body.data, false);
  assert.equal(body.data.order.signature, "0xsigned");
  assert.equal(JSON.stringify(body).includes("wallet-secret-value"), false);
});

test("createEoaLiveAdapter surfaces safe Predict order rejection details", async () => {
  const adapter = createEoaLiveAdapter({
    ...baseConfig,
    jwt: "jwt-secret-value",
  }, {
    async getBuilderContext() {
      return { builder: fakeBuilder([]), Side: { BUY: 0, SELL: 1 } };
    },
    async fetch() {
      return {
        ok: false,
        status: 400,
        async json() {
          return {
            success: false,
            data: {
              code: "PRICE_NOT_ALLOWED",
              message: "Invalid tick price",
              signature: "0xshould-not-leak",
            },
          };
        },
      };
    },
  });

  await assert.rejects(() => adapter.placeOrder(buyAction), (error) => {
    assert.match(error.message, /predict_create_order_failed:400/);
    assert.match(error.message, /PRICE_NOT_ALLOWED/);
    assert.match(error.message, /Invalid tick price/);
    assert.equal(error.message.includes("0xshould-not-leak"), false);
    assert.equal(error.message.includes("api-secret-value"), false);
    assert.equal(error.message.includes("wallet-secret-value"), false);
    return true;
  });
});

test("createEoaLiveAdapter removes buy orders from the orderbook with bearer auth", async () => {
  const requests = [];
  const adapter = createEoaLiveAdapter({
    ...baseConfig,
    jwt: "jwt-secret-value",
  }, {
    async getBuilderContext() {
      throw new Error("builder_not_needed_for_offchain_remove");
    },
    async fetch(url, init) {
      requests.push({ init, url: String(url) });
      return {
        ok: true,
        async json() {
          return { success: true, removed: ["order-1"], noop: [] };
        },
      };
    },
  });

  const response = await adapter.cancelOrder({ ...buyAction, orderId: "order-1", type: "cancel_buy" });

  assert.deepEqual(response.removed, ["order-1"]);
  assert.equal(requests[0].url, "https://api.predict.fun/v1/orders/remove");
  assert.equal(requests[0].init.headers.Authorization, "Bearer jwt-secret-value");
  assert.deepEqual(JSON.parse(requests[0].init.body), { data: { ids: ["order-1"] } });
});

test("buildRedeemPositionsOptions prepares standard and neg-risk redemption inputs", () => {
  assert.deepEqual(buildRedeemPositionsOptions({
    amount: "101",
    market: {
      conditionId: "0xcondition",
      isNegRisk: false,
      isYieldBearing: false,
    },
    outcome: { indexSet: 1 },
  }), {
    conditionId: "0xcondition",
    indexSet: 1,
    isNegRisk: false,
    isYieldBearing: false,
  });

  assert.deepEqual(buildRedeemPositionsOptions({
    amount: "101000000000000000000",
    market: {
      conditionId: "0xcondition",
      isNegRisk: true,
      isYieldBearing: true,
    },
    outcome: { indexSet: 2 },
  }), {
    amount: 101000000000000000000n,
    conditionId: "0xcondition",
    indexSet: 2,
    isNegRisk: true,
    isYieldBearing: true,
  });
});

test("createEoaLiveAdapter redeems winning positions through the order builder", async () => {
  const calls = [];
  const adapter = createEoaLiveAdapter({
    ...baseConfig,
    jwt: "jwt-secret-value",
  }, {
    async getBuilderContext() {
      return {
        builder: {
          async redeemPositions(options) {
            calls.push(options);
            return { success: true, receipt: { hash: "0xredeem" } };
          },
        },
        Side: { BUY: 0, SELL: 1 },
      };
    },
  });

  const result = await adapter.redeemPosition({
    amount: "101",
    market: {
      conditionId: "0xcondition",
      isNegRisk: false,
      isYieldBearing: false,
    },
    outcome: { indexSet: 1 },
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, [{
    conditionId: "0xcondition",
    indexSet: 1,
    isNegRisk: false,
    isYieldBearing: false,
  }]);
});

test("createEoaLiveAdapter loads filled orders for max-loss risk checks", async () => {
  const requests = [];
  const adapter = createEoaLiveAdapter({
    ...baseConfig,
    jwt: "jwt-secret-value",
  }, {
    async fetch(url, init) {
      requests.push({ init, url: String(url) });
      if (String(url).endsWith("/v1/account")) {
        return {
          ok: true,
          async json() {
            return { success: true, data: { address: "0x1111111111111111111111111111111111111111" } };
          },
        };
      }
      if (String(url).includes("status=OPEN")) {
        return {
          ok: true,
          async json() {
            return { success: true, data: [{ id: "open-1" }] };
          },
        };
      }
      if (String(url).includes("status=FILLED")) {
        return {
          ok: true,
          async json() {
            return { success: true, data: [{ id: "filled-1" }] };
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

  const snapshot = await adapter.loadAccountSnapshot();

  assert.deepEqual(snapshot.filledOrders, [{ id: "filled-1" }]);
  assert.equal(requests.some((request) => request.url.includes("status=FILLED")), true);
});

test("requestEoaJwt signs the dynamic auth message without saving the token", async () => {
  const requests = [];
  const token = await requestEoaJwt(baseConfig, {
    Wallet: class {
      constructor(privateKey) {
        assert.equal(privateKey, "wallet-secret-value");
        this.address = "0xwallet";
      }

      async signMessage(message) {
        assert.equal(message, "sign this");
        return "0xsig";
      }
    },
    async fetch(url, init) {
      requests.push({ init, url: String(url) });
      if (String(url).endsWith("/v1/auth/message")) {
        return {
          ok: true,
          async json() {
            return { success: true, data: { message: "sign this" } };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { success: true, data: { token: "jwt-from-api" } };
        },
      };
    },
  });

  assert.equal(token, "jwt-from-api");
  assert.equal(requests[0].url, "https://api.predict.fun/v1/auth/message");
  assert.equal(requests[1].url, "https://api.predict.fun/v1/auth");
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    message: "sign this",
    signature: "0xsig",
    signer: "0xwallet",
  });
});
