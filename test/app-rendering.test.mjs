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
});

test("index loads app script through a versioned URL", () => {
  assert.match(indexSource, /src="app\.mjs\?v=[0-9a-z.-]+"/);
});
