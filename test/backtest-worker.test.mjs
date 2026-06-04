import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import { handleRequest } from "../worker/index.mjs";
import {
  BUY_PRICE_MICROS,
  HOLD_EXPIRY,
  SELL_PRICE_MICROS,
  createEmptyBacktestMatrix,
  priceToMicros,
  serializeBacktestMatrix,
} from "../scripts/backtest-matrix-core.mjs";

class MemoryD1 {
  constructor(rows = []) {
    this.rows = rows;
  }

  prepare(sql) {
    return {
      bind: (...params) => ({
        all: async () => this.all(sql, params),
        first: async () => this.first(sql, params),
      }),
      all: async () => this.all(sql, []),
      first: async () => this.first(sql, []),
    };
  }

  async first(sql) {
    if (sql.includes("MIN(day)")) {
      const days = this.rows.map((row) => row.day).sort();
      return {
        end_day: days.at(-1) || null,
        matrix_count: this.rows.length,
        start_day: days[0] || null,
      };
    }
    return null;
  }

  async all(sql, params) {
    if (sql.includes("GROUP BY interval")) {
      const byInterval = new Map();
      for (const row of this.rows) {
        byInterval.set(row.interval, Math.max(byInterval.get(row.interval) || 0, row.cutoff_minutes));
      }
      return {
        results: [...byInterval.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([interval, cutoffMax]) => ({ cutoff_max: cutoffMax, interval })),
      };
    }

    const [start, end, interval, cutoff, perspective] = params;
    return {
      results: this.rows
        .filter((row) => row.day >= start && row.day <= end)
        .filter((row) => row.interval === interval)
        .filter((row) => row.cutoff_minutes === cutoff)
        .filter((row) => row.perspective === perspective)
        .map((row) => ({
          compression: row.compression,
          matrix_blob: row.matrix_blob,
        })),
    };
  }
}

function matrixWithPnl({ buyPrice = 0.05, pnl = 12.34, sellPrice = HOLD_EXPIRY } = {}) {
  const matrix = createEmptyBacktestMatrix();
  const buyIndex = BUY_PRICE_MICROS.indexOf(priceToMicros(buyPrice));
  const sellIndex = SELL_PRICE_MICROS.indexOf(sellPrice === HOLD_EXPIRY ? HOLD_EXPIRY : priceToMicros(sellPrice));
  const cellIndex = sellIndex * BUY_PRICE_MICROS.length + buyIndex;
  matrix.pnl[cellIndex] = pnl;
  matrix.buyShares[cellIndex] = 100;
  return matrix;
}

function row({ cutoff = 5, day = "2026-06-01", interval = "5m", perspective = "yes", pnl = 12.34 } = {}) {
  return {
    compression: "none",
    cutoff_minutes: cutoff,
    day,
    interval,
    matrix_blob: new TextEncoder().encode(serializeBacktestMatrix(matrixWithPnl({ pnl }))),
    perspective,
  };
}

function gzipBase64Row(options = {}) {
  return {
    ...row(options),
    compression: "gzip-base64",
    matrix_blob: gzipSync(Buffer.from(serializeBacktestMatrix(matrixWithPnl({ pnl: options.pnl ?? 12.34 })))).toString("base64"),
  };
}

test("backtest meta returns coverage, intervals, and axes", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/api/backtest/meta"),
    { BACKTEST_DB: new MemoryD1([row({ day: "2026-06-01" }), row({ day: "2026-06-02", interval: "15m", cutoff: 10 })]) },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.coverage, {
    end: "2026-06-02",
    matrixCount: 2,
    start: "2026-06-01",
  });
  assert.equal(payload.axes.buyPrices.length, 99);
  assert.equal(payload.axes.sellPrices.at(-1), "HOLD_EXPIRY");
  assert.deepEqual(payload.intervals, [
    { cutoffMax: 10, interval: "15m" },
    { cutoffMax: 5, interval: "5m" },
  ]);
});

test("backtest heatmap merges daily matrices and caps cutoff by interval duration", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/api/backtest/heatmap?start=2026-06-01&end=2026-06-02&intervals=5m&cutoff=10"),
    {
      BACKTEST_DB: new MemoryD1([
        row({ day: "2026-06-01", perspective: "yes", pnl: 10 }),
        row({ day: "2026-06-02", perspective: "yes", pnl: 20 }),
        row({ day: "2026-06-01", perspective: "no", pnl: -3 }),
      ]),
      SITE_ACCESS_MODE: "private",
      SITE_PASSWORD: "secret",
    },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  const buyIndex = BUY_PRICE_MICROS.indexOf(priceToMicros(0.05));
  const holdIndex = SELL_PRICE_MICROS.indexOf(HOLD_EXPIRY);
  const cellIndex = holdIndex * BUY_PRICE_MICROS.length + buyIndex;
  assert.equal(payload.summary.normalizedCutoffs["5m"], 5);
  assert.equal(payload.summary.dataRows, 3);
  assert.equal(payload.yes.pnl[cellIndex], 30);
  assert.equal(payload.no.pnl[cellIndex], -3);
});

test("backtest heatmap decodes gzip base64 matrices", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/api/backtest/heatmap?start=2026-06-01&end=2026-06-01&intervals=5m&cutoff=5"),
    { BACKTEST_DB: new MemoryD1([gzipBase64Row({ pnl: 42 })]) },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  const buyIndex = BUY_PRICE_MICROS.indexOf(priceToMicros(0.05));
  const holdIndex = SELL_PRICE_MICROS.indexOf(HOLD_EXPIRY);
  const cellIndex = holdIndex * BUY_PRICE_MICROS.length + buyIndex;
  assert.equal(payload.yes.pnl[cellIndex], 42);
});

test("backtest heatmap can return pnl-only matrices", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/api/backtest/heatmap?start=2026-06-01&end=2026-06-01&intervals=5m&cutoff=5&fields=pnl"),
    { BACKTEST_DB: new MemoryD1([row({ pnl: 42 })]) },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  const buyIndex = BUY_PRICE_MICROS.indexOf(priceToMicros(0.05));
  const holdIndex = SELL_PRICE_MICROS.indexOf(HOLD_EXPIRY);
  const cellIndex = holdIndex * BUY_PRICE_MICROS.length + buyIndex;
  assert.deepEqual(Object.keys(payload.yes), ["pnl"]);
  assert.equal(payload.yes.pnl[cellIndex], 42);
  assert.equal(payload.yes.buyShares, undefined);
});

test("backtest heatmap validates request parameters", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/api/backtest/heatmap?start=bad&end=2026-06-02&intervals=5m&cutoff=10"),
    { BACKTEST_DB: new MemoryD1([]) },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_date_range" });
});
