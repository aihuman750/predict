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

test("site assets and rewards data are public even when SITE_PASSWORD exists", async () => {
  const workerEnv = {
    ...env(),
    ASSETS: {
      fetch: async () =>
        new Response("console.log('public')", {
          headers: { "cache-control": "public, max-age=31536000", "content-type": "text/javascript" },
        }),
    },
    SITE_PASSWORD: "legacy-encryption-secret",
    SITE_ACCESS_MODE: "public",
  };

  const assetResponse = await handleRequest(new Request("https://worker.test/app.mjs"), workerEnv);
  assert.equal(assetResponse.status, 200);
  assert.equal(await assetResponse.text(), "console.log('public')");
  assert.equal(assetResponse.headers.get("cache-control"), "no-store");

  const dataResponse = await handleRequest(
    new Request("https://worker.test/data/rewards.json"),
    workerEnv,
    {
      fetch: async () => Response.json([{ id: 1, question: "Public market" }]),
    },
  );

  assert.equal(dataResponse.status, 200);
  assert.deepEqual(await dataResponse.json(), [{ id: 1, question: "Public market" }]);
});

test("public site status does not require a session", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/api/site/status"),
    {
      ...env(),
      SITE_PASSWORD: "legacy-encryption-secret",
      SITE_ACCESS_MODE: "public",
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true, public: true });
});

test("public site still rejects writes from unknown browser origins", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/api/favorites", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: JSON.stringify({ market: { key: "nexus", title: "Nexus" } }),
    }),
    {
      ...env(),
      SITE_PASSWORD: "legacy-encryption-secret",
      SITE_ACCESS_MODE: "public",
    },
  );

  assert.equal(response.status, 403);
});
