import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../public/app.mjs", import.meta.url), "utf8");

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
