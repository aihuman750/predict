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
