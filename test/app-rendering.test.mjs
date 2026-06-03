import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../public/app.mjs", import.meta.url), "utf8");
const indexSource = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("market table renders trade amount columns before Yes price", () => {
  const totalIndex = appSource.indexOf('data-sort="totalLiq"');
  const volume24Index = appSource.indexOf('data-sort="vol24"');
  const yesIndex = appSource.indexOf('data-sort="yesBid"');

  assert.notEqual(totalIndex, -1);
  assert.notEqual(volume24Index, -1);
  assert.notEqual(yesIndex, -1);
  assert.ok(totalIndex < volume24Index);
  assert.ok(volume24Index < yesIndex);
  assert.match(appSource, /market\.totalLiq/);
  assert.match(appSource, /market\.vol24/);
  assert.doesNotMatch(appSource, /colspan="10"/);
});

test("market table hides minimum shares and exposes Activate Points orderbook UI", () => {
  assert.doesNotMatch(appSource, />最小股数/);
  assert.match(appSource, />有效订单数/);
  assert.match(appSource, /data-market-row=/);
  assert.match(appSource, /renderOrderbookExpansion/);
  assert.doesNotMatch(appSource, /<th>#<\/th>/);
  assert.doesNotMatch(appSource, />No等价/);
  assert.match(appSource, /orderbook-qty-bar/);
});

test("orderbook quantities render as whole numbers", () => {
  assert.match(appSource, /function formatQuantity[\s\S]*maximumFractionDigits: 0/);
});

test("index loads app script through a versioned URL", () => {
  assert.match(indexSource, /src="app\.mjs\?v=[0-9a-z.-]+"/);
});

test("app exposes the points monitor view and account detail renderer", () => {
  assert.match(appSource, /const views = new Set\(\[[^\]]*"points"/);
  assert.match(appSource, /label: "积分监控"/);
  assert.match(appSource, /function renderPointsPage/);
  assert.match(appSource, /function renderPointsAccountDetail/);
  assert.match(appSource, /data-points-account=/);
});

test("app exposes the strategy backtest view and heatmap API wiring", () => {
  assert.match(appSource, /backtest:\s*\{/);
  assert.match(appSource, /label:\s*"策略回测"/);
  assert.match(appSource, /renderBacktestPage/);
  assert.match(appSource, /renderBacktestHeatmap/);
  assert.match(appSource, /\/api\/backtest\/meta/);
  assert.match(appSource, /\/api\/backtest\/heatmap/);
});
