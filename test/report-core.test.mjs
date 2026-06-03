import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPriceRows,
  buildReportMarkdown,
  formatPriceDelta,
  snapshotMarkets,
} from "../scripts/report-core.mjs";

const favorite = {
  key: "nexus",
  title: "Nexus FDV above $50M one day after launch?",
  question: "Nexus FDV above $50M one day after launch?",
  categorySlug: "nexus-fdv-above-50m",
  url: "https://predict.fun/market/nexus-fdv-above-50m",
};

test("formatPriceDelta describes new, flat, and directional price changes", () => {
  assert.equal(formatPriceDelta(0.42, undefined), "新增");
  assert.equal(formatPriceDelta(0.42, 0.42), "持平");
  assert.equal(formatPriceDelta(0.42, 0.4), "+2¢");
  assert.equal(formatPriceDelta(0.385, 0.4), "-1.5¢");
  assert.equal(formatPriceDelta(undefined, 0.4), "-");
});

test("buildPriceRows matches favorites to current markets and previous snapshot", () => {
  const rows = buildPriceRows({
    currentMarkets: [
      {
        id: "nexus",
        question: favorite.question,
        categorySlug: favorite.categorySlug,
        yesBid: 0.42,
        noBid: 0.57,
      },
    ],
    favorites: [favorite],
    previousSnapshot: {
      markets: {
        nexus: { yesBid: 0.4, noBid: 0.59 },
      },
    },
  });

  assert.deepEqual(rows, [
    {
      key: "nexus",
      title: favorite.title,
      url: favorite.url,
      yes: "42¢",
      yesDelta: "+2¢",
      no: "57¢",
      noDelta: "-2¢",
      status: "active",
    },
  ]);
});

test("snapshotMarkets stores latest matched prices by favorite key", () => {
  const snapshot = snapshotMarkets({
    currentMarkets: [{ id: "nexus", yesBid: 0.42, noBid: 0.57 }],
    favorites: [favorite],
    generatedAt: "2026-05-19T02:00:00.000Z",
  });

  assert.deepEqual(snapshot, {
    generatedAt: "2026-05-19T02:00:00.000Z",
    markets: {
      nexus: { noBid: 0.57, yesBid: 0.42 },
    },
  });
});

test("buildReportMarkdown renders price and market-impact brief tables", () => {
  const markdown = buildReportMarkdown({
    dateLabel: "2026-05-19 10:00",
    priceRows: [
      {
        key: "nexus",
        title: favorite.title,
        url: favorite.url,
        yes: "42¢",
        yesDelta: "+2¢",
        no: "57¢",
        noDelta: "-2¢",
        status: "active",
      },
    ],
    impactRows: [
      {
        key: "nexus",
        title: favorite.title,
        information: "Nexus announced its TGE date.",
        impact: "偏 Yes",
        strength: "高",
        confidence: "高",
        sources: [
          {
            title: "Nexus official TGE update",
            url: "https://example.com/nexus-tge",
            publishedAt: "2026-05-19 09:30",
            source: "Nexus Blog",
          },
        ],
      },
    ],
  });

  assert.match(markdown, /Predict 收藏市场日报/);
  assert.match(markdown, /\\| 市场 \\| Yes 最新 \\| Yes 变化 \\| No 最新 \\| No 变化 \\|/);
  assert.match(markdown, /Nexus FDV above \$50M one day after launch\?/);
  assert.match(markdown, /### 2\. 价格影响简报/);
  assert.match(markdown, /\\| 市场 \\| 关键信息 \\| 潜在影响 \\| 强度 \\| 置信度 \\| 来源 \\|/);
  assert.match(markdown, /Nexus announced its TGE date\./);
  assert.match(markdown, /\[Nexus Blog\]\(https:\/\/example\.com\/nexus-tge\)/);
});
