import test from "node:test";
import assert from "node:assert/strict";

import { handleRequest } from "../worker/index.mjs";

class MemoryKV {
  constructor() {
    this.store = new Map();
  }

  async get(key) {
    return this.store.get(key) || null;
  }

  async put(key, value) {
    this.store.set(key, value);
  }
}

const env = () => ({ FAVORITES: new MemoryKV() });

async function loginCookie(workerEnv, password = "correct-password") {
  const response = await handleRequest(
    new Request("https://worker.test/api/site/login", {
      body: JSON.stringify({ password }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    workerEnv,
  );
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie, /pa_session=/);
  return setCookie.split(";")[0];
}

test("favorites API lists, upserts, and deletes markets", async () => {
  const workerEnv = env();
  const origin = "https://aihuman750.github.io";
  const market = {
    key: "nexus",
    title: "Nexus FDV above $50M one day after launch?",
    url: "https://predict.fun/market/nexus-fdv-above-50m",
  };

  const emptyResponse = await handleRequest(new Request("https://worker.test/api/favorites"), workerEnv);
  assert.equal(emptyResponse.status, 200);
  assert.deepEqual(await emptyResponse.json(), { favorites: [] });

  const saveResponse = await handleRequest(
    new Request("https://worker.test/api/favorites", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ market }),
    }),
    workerEnv,
  );
  assert.equal(saveResponse.status, 200);
  assert.equal(saveResponse.headers.get("access-control-allow-origin"), origin);

  const savedResponse = await handleRequest(new Request("https://worker.test/api/favorites"), workerEnv);
  assert.deepEqual(await savedResponse.json(), { favorites: [market] });

  const deleteResponse = await handleRequest(
    new Request("https://worker.test/api/favorites/nexus", {
      method: "DELETE",
      headers: { origin },
    }),
    workerEnv,
  );
  assert.equal(deleteResponse.status, 200);

  const finalResponse = await handleRequest(new Request("https://worker.test/api/favorites"), workerEnv);
  assert.deepEqual(await finalResponse.json(), { favorites: [] });
});

test("favorites API rejects writes from unknown browser origins", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/api/favorites", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: JSON.stringify({ market: { key: "nexus", title: "Nexus" } }),
    }),
    env(),
  );

  assert.equal(response.status, 403);
});

test("favorites API allows the local development server origin", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/api/favorites", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ market: { key: "local", title: "Local dev market" } }),
    }),
    env(),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
});

test("report API sends the latest favorites report to Feishu and stores a price snapshot", async () => {
  const workerEnv = {
    ...env(),
    FEISHU_SECRET: "test-secret",
    FEISHU_WEBHOOK: "https://open.feishu.test/bot",
  };
  const origin = "https://aihuman750.github.io";
  const feishuCalls = [];
  const market = {
    categorySlug: "nexus-fdv-above-50m",
    id: "nexus",
    noBid: 0.57,
    question: "Nexus FDV above $50M one day after launch?",
    yesBid: 0.42,
  };

  await handleRequest(
    new Request("https://worker.test/api/favorites", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        market: {
          categorySlug: market.categorySlug,
          key: market.id,
          question: market.question,
          title: market.question,
          url: "https://predict.fun/market/nexus-fdv-above-50m",
        },
      }),
    }),
    workerEnv,
  );

  const response = await handleRequest(
    new Request("https://worker.test/api/report/send", {
      method: "POST",
      headers: { origin },
    }),
    workerEnv,
    {
      fetch: async (url, options) => {
        const target = String(url);
        if (target.includes("api.predalpha.xyz")) {
          return Response.json([market]);
        }
        if (target.includes("news.google.com")) {
          return new Response("<rss><channel></channel></rss>", {
            headers: { "content-type": "application/rss+xml" },
          });
        }
        if (target.includes("open.feishu.test")) {
          feishuCalls.push(JSON.parse(options.body));
          return Response.json({ code: 0, msg: "ok" });
        }
        throw new Error(`unexpected fetch: ${target}`);
      },
      now: () => new Date("2026-05-19T02:00:00.000Z"),
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    favoriteCount: 1,
    ok: true,
    sentAt: "2026-05-19T02:00:00.000Z",
  });
  assert.equal(feishuCalls.length, 1);
  assert.equal(feishuCalls[0].msg_type, "interactive");
  assert.match(feishuCalls[0].card.elements[0].content, /Nexus FDV above \$50M/);

  const snapshot = JSON.parse(await workerEnv.FAVORITES.get("report:price-state:v1"));
  assert.deepEqual(snapshot.markets.nexus, { yesBid: 0.42, noBid: 0.57 });
});

test("wallet API lists, adds, and deletes monitored addresses", async () => {
  const workerEnv = env();
  const origin = "https://aihuman750.github.io";
  const address = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
  const normalized = "0x742d35cc6634c0532925a3b844bc454e4438f44e";

  const emptyResponse = await handleRequest(new Request("https://worker.test/api/wallets"), workerEnv);
  assert.deepEqual(await emptyResponse.json(), { wallets: [] });

  const addResponse = await handleRequest(
    new Request("https://worker.test/api/wallets", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ address }),
    }),
    workerEnv,
  );
  assert.equal(addResponse.status, 200);
  assert.deepEqual(await addResponse.json(), { wallets: [normalized] });

  const duplicateResponse = await handleRequest(
    new Request("https://worker.test/api/wallets", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ address: normalized }),
    }),
    workerEnv,
  );
  assert.deepEqual(await duplicateResponse.json(), { wallets: [normalized] });

  const deleteResponse = await handleRequest(
    new Request(`https://worker.test/api/wallets/${normalized}`, {
      method: "DELETE",
      headers: { origin },
    }),
    workerEnv,
  );
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { wallets: [] });
});

test("wallet summary fetches positions and auto-adds position markets to favorites", async () => {
  const workerEnv = {
    ...env(),
    PREDICT_API_KEY: "predict-test-key",
  };
  const origin = "https://aihuman750.github.io";
  const address = "0x742d35cc6634c0532925a3b844bc454e4438f44e";
  const predictCalls = [];

  await handleRequest(
    new Request("https://worker.test/api/wallets", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ address }),
    }),
    workerEnv,
  );

  const response = await handleRequest(
    new Request("https://worker.test/api/wallets/summary", {
      headers: { origin },
    }),
    workerEnv,
    {
      fetch: async (url, options) => {
        predictCalls.push({ url: String(url), apiKey: options.headers["x-api-key"] });
        return Response.json({
          success: true,
          data: [
            {
              id: "position-1",
              market: {
                id: 32279,
                question: "Will Hylo launch a token by June 30, 2026?",
                categorySlug: "will-hylo-launch-a-token-by",
              },
              outcome: { name: "Yes" },
              amount: "10",
              valueUsd: "1.25",
              averageBuyPriceUsd: "0.12",
              pnlUsd: "0.05",
            },
          ],
        });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    favoritesAdded: 1,
    wallets: [
      {
        address,
        error: null,
        orders: {
          available: false,
          reason: "Predict public API does not expose arbitrary-address open orders.",
        },
        positions: [
          {
            id: "position-1",
            marketId: "32279",
            title: "Will Hylo launch a token by June 30, 2026?",
            outcome: "Yes",
            amount: "10",
            valueUsd: "1.25",
            averageBuyPriceUsd: "0.12",
            pnlUsd: "0.05",
            url: "https://predict.fun/market/will-hylo-launch-a-token-by",
          },
        ],
      },
    ],
  });
  assert.equal(predictCalls.length, 1);
  assert.match(predictCalls[0].url, /https:\/\/api\.predict\.fun\/v1\/positions\/0x742d35/);
  assert.equal(predictCalls[0].apiKey, "predict-test-key");

  const favorites = JSON.parse(await workerEnv.FAVORITES.get("favorites:v1"));
  assert.equal(favorites.length, 1);
  assert.equal(favorites[0].key, "32279");
});

test("private site login rejects invalid passwords and sets a seven day session cookie", async () => {
  const workerEnv = {
    ...env(),
    SITE_PASSWORD: "correct-password",
  };

  const protectedResponse = await handleRequest(new Request("https://worker.test/api/favorites"), workerEnv);
  assert.equal(protectedResponse.status, 401);
  assert.deepEqual(await protectedResponse.json(), { error: "auth_required" });

  const badLogin = await handleRequest(
    new Request("https://worker.test/api/site/login", {
      body: JSON.stringify({ password: "wrong-password" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    workerEnv,
  );
  assert.equal(badLogin.status, 401);

  const login = await handleRequest(
    new Request("https://worker.test/api/site/login", {
      body: JSON.stringify({ password: "correct-password" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    workerEnv,
  );
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), { ok: true });
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  assert.match(login.headers.get("set-cookie"), /Max-Age=604800/);

  const cookie = login.headers.get("set-cookie").split(";")[0];
  const favorites = await handleRequest(
    new Request("https://worker.test/api/favorites", {
      headers: { cookie },
    }),
    workerEnv,
  );
  assert.equal(favorites.status, 200);
  assert.deepEqual(await favorites.json(), { favorites: [] });
});

test("private authenticated same-origin writes are allowed", async () => {
  const workerEnv = {
    ...env(),
    SITE_PASSWORD: "correct-password",
  };
  const cookie = await loginCookie(workerEnv);

  const response = await handleRequest(
    new Request("https://worker.test/api/favorites", {
      body: JSON.stringify({ market: { key: "private", title: "Private market" } }),
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "https://predict-favorites.aihuman750.workers.dev",
      },
      method: "POST",
    }),
    workerEnv,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    favorites: [{ key: "private", title: "Private market" }],
  });
});

test("authenticated static assets are returned with no-store caching", async () => {
  const workerEnv = {
    ...env(),
    ASSETS: {
      fetch: async () =>
        new Response("console.log('asset')", {
          headers: { "cache-control": "public, max-age=31536000", "content-type": "text/javascript" },
        }),
    },
    SITE_PASSWORD: "correct-password",
  };
  const cookie = await loginCookie(workerEnv);

  const response = await handleRequest(
    new Request("https://worker.test/app.mjs", {
      headers: { cookie },
    }),
    workerEnv,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "text/javascript");
  assert.equal(await response.text(), "console.log('asset')");
});

test("predict auth routes exchange a wallet signature for a stored JWT", async () => {
  const workerEnv = {
    ...env(),
    PREDICT_API_KEY: "predict-test-key",
    SITE_PASSWORD: "correct-password",
  };
  const cookie = await loginCookie(workerEnv);
  const calls = [];
  const signer = "0x742d35cc6634c0532925a3b844bc454e4438f44e";
  const accountAddress = "0x1111111111111111111111111111111111111111";
  await workerEnv.FAVORITES.put("wallets:v1", JSON.stringify([signer]));

  const messageResponse = await handleRequest(
    new Request("https://worker.test/api/predict-auth/message", {
      headers: { cookie },
    }),
    workerEnv,
    {
      fetch: async (url, options) => {
        calls.push({ url: String(url), headers: options.headers });
        return Response.json({ success: true, data: { message: "Sign in to Predict" } });
      },
    },
  );
  assert.equal(messageResponse.status, 200);
  assert.deepEqual(await messageResponse.json(), { message: "Sign in to Predict" });

  const tokenResponse = await handleRequest(
    new Request("https://worker.test/api/predict-auth/token", {
      body: JSON.stringify({
        message: "Sign in to Predict",
        signature: "0xsig",
        signer: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      }),
      headers: { "content-type": "application/json", cookie },
      method: "POST",
    }),
    workerEnv,
    {
      fetch: async (url, options) => {
        calls.push({
          url: String(url),
          body: options.body ? JSON.parse(options.body) : null,
          headers: options.headers,
        });
        if (String(url).includes("/v1/account")) {
          return Response.json({ success: true, data: { address: accountAddress, name: "Predict Account" } });
        }
        return Response.json({ success: true, data: { token: "predict-jwt" } });
      },
    },
  );
  assert.equal(tokenResponse.status, 200);
  assert.deepEqual(await tokenResponse.json(), {
    accountAddress,
    hasToken: true,
    signer,
  });

  const storedWallets = JSON.parse(await workerEnv.FAVORITES.get("wallets:v1"));
  assert.deepEqual(storedWallets, [accountAddress]);
  const storedToken = await workerEnv.FAVORITES.get("predict:auth:v1");
  assert.ok(storedToken);
  assert.equal(storedToken.includes("predict-jwt"), false);
});

test("authenticated self orders fetch open orders and auto-add their markets to favorites", async () => {
  const workerEnv = {
    ...env(),
    PREDICT_API_KEY: "predict-test-key",
    SITE_PASSWORD: "correct-password",
  };
  const cookie = await loginCookie(workerEnv);
  const calls = [];
  const accountAddress = "0x1111111111111111111111111111111111111111";

  await handleRequest(
    new Request("https://worker.test/api/predict-auth/token", {
      body: JSON.stringify({
        message: "Sign in to Predict",
        signature: "0xsig",
        signer: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      }),
      headers: { "content-type": "application/json", cookie },
      method: "POST",
    }),
    workerEnv,
    {
      fetch: async (url) => {
        if (String(url).includes("/v1/account")) {
          return Response.json({ success: true, data: { address: accountAddress, name: "Predict Account" } });
        }
        return Response.json({ success: true, data: { token: "predict-jwt" } });
      },
    },
  );

  const response = await handleRequest(
    new Request("https://worker.test/api/wallets/me/orders", {
      headers: { cookie },
    }),
    workerEnv,
    {
      fetch: async (url, options) => {
        calls.push({ url: String(url), headers: options.headers });
        if (String(url).includes("/v1/orders")) {
          return Response.json({
            success: true,
            data: [
              {
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
              },
            ],
          });
        }
        if (String(url).includes("/v1/markets/456")) {
          return Response.json({
            success: true,
            data: {
              id: 456,
              question: "Will Nexus FDV be above $50M one day after launch?",
              categorySlug: "nexus-fdv-above-50m-one-day-after-launch",
              outcomes: [
                { name: "Yes", tokenId: "1001", indexSet: 1 },
                { name: "No", tokenId: "1002", indexSet: 2 },
              ],
            },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    favoritesAdded: 1,
    accountAddress,
    hasToken: true,
    orders: [
      {
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
      },
    ],
    signer: "0x742d35cc6634c0532925a3b844bc454e4438f44e",
  });

  const ordersCall = calls.find((call) => call.url.includes("/v1/orders"));
  assert.match(ordersCall.url, /status=OPEN/);
  assert.equal(ordersCall.headers.authorization, "Bearer predict-jwt");

  const favorites = JSON.parse(await workerEnv.FAVORITES.get("favorites:v1"));
  assert.equal(favorites.length, 1);
  assert.equal(favorites[0].key, "456");
});
