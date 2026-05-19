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
