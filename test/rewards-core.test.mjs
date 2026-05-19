import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMarketTitle,
  buildPredictMarketUrl,
  competitionTier,
  filterAndSortMarkets,
  summarizeMarkets,
} from "../public/rewards-core.mjs";

const NOW = 1_000_000;

const markets = [
  {
    id: "1",
    title: "Bitcoin Up or Down",
    question: "Bitcoin Up or Down",
    categorySlug: "btc-updown-5m",
    yesBid: 0.6,
    noBid: 0.39,
    hourlyRate: 120,
    score: 499,
    expiresAtSec: NOW + 3600,
  },
  {
    id: "2",
    title: "June 30",
    question: "Will Polymarket launch their official token by June 30, 2026?",
    categorySlug: "will-polymarket-launch-their-official-token-by",
    yesBid: 0.1,
    noBid: 0.89,
    hourlyRate: 300,
    score: 2_000,
    expiresAtSec: NOW + 24 * 3600,
  },
  {
    id: "3",
    title: "September 30",
    question: "Will Polymarket launch their official token by September 30, 2026?",
    categorySlug: "will-polymarket-launch-their-official-token-by",
    yesBid: null,
    noBid: 0.4,
    hourlyRate: 500,
    score: 100_001,
    expiresAtSec: NOW + 90 * 24 * 3600,
  },
];

test("summarizeMarkets mirrors the rewards page stats", () => {
  assert.deepEqual(summarizeMarkets(markets), {
    activeCount: 3,
    lowCompetition: 1,
    top10Hourly: 920,
    totalHourly: 920,
  });
});

test("filterAndSortMarkets applies search, expiry windows, and quote-data priority", () => {
  const filtered = filterAndSortMarkets(markets, {
    nowSec: NOW,
    query: "polymarket",
    maxExpireHrs: 48,
    sortKey: "hourlyRate",
    sortDir: "desc",
  });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "2");

  const sorted = filterAndSortMarkets(markets, {
    nowSec: NOW,
    query: "",
    maxExpireHrs: null,
    sortKey: "hourlyRate",
    sortDir: "desc",
  });

  assert.deepEqual(sorted.map((market) => market.id), ["2", "1", "3"]);
});

test("buildMarketTitle prefixes shared categories only when the question needs context", () => {
  const duplicateCategories = new Set(["will-polymarket-launch-their-official-token-by"]);

  assert.equal(
    buildMarketTitle(markets[1], duplicateCategories),
    "Will Polymarket launch their official token by June 30, 2026?",
  );
  assert.equal(buildMarketTitle(markets[0], duplicateCategories), "Bitcoin Up or Down");
});

test("buildPredictMarketUrl points at the Predict market page", () => {
  assert.equal(
    buildPredictMarketUrl(markets[1]),
    "https://predict.fun/market/will-polymarket-launch-their-official-token-by",
  );

  assert.equal(buildPredictMarketUrl({ id: "no-slug" }), null);
});

test("competitionTier uses six score bands", () => {
  assert.equal(competitionTier(null), 1);
  assert.equal(competitionTier(499), 1);
  assert.equal(competitionTier(500), 2);
  assert.equal(competitionTier(2_000), 3);
  assert.equal(competitionTier(100_000), 6);
});
