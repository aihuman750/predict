import test from "node:test";
import assert from "node:assert/strict";

import {
  candidateStartsForDay,
  categorySlugForStart,
  executeD1,
  fetchWithTimeout,
  hourlyCategorySlug,
  parseArgs,
  parseCategoryMarket,
  parseMatchRow,
  putMatches,
} from "../scripts/backtest-ingest.mjs";

test("5m and 15m category slugs use unix start seconds", () => {
  const startMs = Date.parse("2026-06-01T00:00:00.000Z");
  assert.equal(categorySlugForStart("5m", startMs), "btc-updown-5m-1780272000");
  assert.equal(categorySlugForStart("15m", startMs), "btc-updown-15m-1780272000");
});

test("1h category slug is generated from America/New_York wall time", () => {
  assert.equal(
    hourlyCategorySlug(Date.parse("2026-06-01T00:00:00.000Z")),
    "bitcoin-up-or-down-may-31-2026-8pm-et",
  );
  assert.equal(
    hourlyCategorySlug(Date.parse("2026-12-01T13:00:00.000Z")),
    "bitcoin-up-or-down-december-1-2026-8am-et",
  );
});

test("candidateStartsForDay enumerates interval boundaries in UTC", () => {
  assert.equal(candidateStartsForDay("2026-06-01", "1h").length, 24);
  assert.equal(candidateStartsForDay("2026-06-01", "15m").length, 96);
  assert.equal(candidateStartsForDay("2026-06-01", "5m").length, 288);
});

test("parseCategoryMarket extracts resolved market metadata", () => {
  const parsed = parseCategoryMarket({
    endsAt: "2026-06-01T00:15:00.000Z",
    markets: [{
      id: 123,
      outcomes: [{ name: "Up", status: "WON" }],
      resolution: { name: "Up", status: "WON" },
    }],
    slug: "btc-updown-15m-1780272000",
    startsAt: "2026-06-01T00:00:00.000Z",
  }, { interval: "15m", sourceDay: "2026-06-01" });

  assert.equal(parsed.marketId, "123");
  assert.equal(parsed.winner, "yes");
  assert.equal(parsed.sourceDay, "2026-06-01");
});

test("parseCategoryMarket skips missing category payloads", () => {
  assert.equal(parseCategoryMarket(null, { interval: "15m", sourceDay: "2026-06-01" }), null);
});

test("parseMatchRow normalizes quote type, outcome, price, shares, and dedupe hash", () => {
  const row = parseMatchRow({
    amountFilled: "25000000000000000000",
    executedAt: "2026-06-01T00:03:00.000Z",
    id: "match-1",
    priceExecuted: "50000000000000000",
    taker: {
      outcome: { name: "Down" },
      quoteType: "Bid",
    },
  }, {
    marketId: "123",
    startsAt: "2026-06-01T00:00:00.000Z",
  });

  assert.equal(row.elapsedSeconds, 180);
  assert.equal(row.outcome, "no");
  assert.equal(row.quoteType, "bid");
  assert.equal(row.priceMicros, 50_000);
  assert.equal(row.sharesMicros, 25_000_000);
  assert.match(row.dedupeHash, /^[0-9a-f]{64}$/);
});

test("parseArgs defaults to a 60-day UTC backfill ending yesterday", () => {
  const parsed = parseArgs(["--start", "2026-05-01", "--end", "2026-05-02", "--intervals", "5m,15m"]);
  assert.equal(parsed.start, "2026-05-01");
  assert.equal(parsed.end, "2026-05-02");
  assert.deepEqual(parsed.intervals, ["5m", "15m"]);
});

test("executeD1 retries transient fetch failures", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("network dropped");
    return new Response(JSON.stringify({ result: [], success: true }), { status: 200 });
  };

  try {
    await executeD1("SELECT 1", [], {
      BACKTEST_D1_DATABASE_ID: "db",
      BACKTEST_D1_TRANSPORT: "fetch",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(attempts, 2);
});

test("fetchWithTimeout passes an abort signal to fetch", async () => {
  const originalFetch = globalThis.fetch;
  let signalSeen = false;
  globalThis.fetch = async (_url, init = {}) => {
    signalSeen = init.signal instanceof AbortSignal;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  try {
    await fetchWithTimeout("https://example.test");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(signalSeen, true);
});

test("putMatches batches match inserts without D1 SQL variables", async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init = {}) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ result: [], success: true }), { status: 200 });
  };

  try {
    await putMatches([
      {
        dedupeHash: "a",
        elapsedSeconds: 1,
        executedAt: "2026-06-01T00:00:01.000Z",
        marketId: "1",
        outcome: "yes",
        priceMicros: 10_000,
        quoteType: "ask",
        rawJson: "{\"note\":\"can't\"}",
        sharesMicros: 100_000_000,
      },
      {
        dedupeHash: "b",
        elapsedSeconds: 2,
        executedAt: "2026-06-01T00:00:02.000Z",
        marketId: "1",
        outcome: "no",
        priceMicros: 20_000,
        quoteType: "bid",
        rawJson: "{}",
        sharesMicros: 50_000_000,
      },
    ], {
      dryRun: false,
      env: {
        BACKTEST_D1_DATABASE_ID: "db",
        BACKTEST_D1_TRANSPORT: "fetch",
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "token",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(bodies.length, 1);
  assert.match(bodies[0].sql, /VALUES \('a', '1', 'yes', 'ask'/);
  assert.match(bodies[0].sql, /can''t/);
  assert.equal(bodies[0].params.length, 0);
});

test("putMatches splits batches below D1 SQL variable limits", async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init = {}) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ result: [], success: true }), { status: 200 });
  };
  const matches = Array.from({ length: 12 }, (_, index) => ({
    dedupeHash: `hash-${index}`,
    elapsedSeconds: index,
    executedAt: "2026-06-01T00:00:01.000Z",
    marketId: "1",
    outcome: index % 2 === 0 ? "yes" : "no",
    priceMicros: 10_000,
    quoteType: "ask",
    rawJson: "{}",
    sharesMicros: 100_000_000,
  }));

  try {
    await putMatches(matches, {
      dryRun: false,
      env: {
        BACKTEST_D1_DATABASE_ID: "db",
        BACKTEST_D1_TRANSPORT: "fetch",
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "token",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].params.length, 0);
  assert.equal(bodies[1].params.length, 0);
});
