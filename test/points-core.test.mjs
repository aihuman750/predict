import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPointsStrategySummary,
  groupTradesByMarket,
  normalizePointsAccount,
  normalizePointsPosition,
  pointsWeekWindows,
} from "../public/points-core.mjs";

test("normalizePointsAccount maps leaderboard account statistics", () => {
  const account = normalizePointsAccount({
    node: {
      rank: 4,
      totalPoints: 3977857.0920130275,
      allocationRoundPoints: 296901.25974283624,
      account: {
        name: "predictorok",
        address: "0x239a39246abCF511E47733f0eED725bc08c79fee",
        positions: { totalCount: 88 },
        statistics: {
          marketsCount: 42,
          pnlUsd: -120.5,
          positionsValueUsd: 3456.78,
          volumeUsd: 987654.32,
        },
      },
    },
  });

  assert.deepEqual(account, {
    address: "0x239a39246abCF511E47733f0eED725bc08c79fee",
    allTimeRank: 4,
    lastWeekPoints: 296901.25974283624,
    marketsCount: 42,
    name: "predictorok",
    pnlUsd: -120.5,
    positionCount: 88,
    positionsValueUsd: 3456.78,
    rank: 4,
    totalPoints: 3977857.0920130275,
    volumeUsd: 987654.32,
  });
});

test("normalizePointsPosition produces display-safe position rows", () => {
  const position = normalizePointsPosition({
    averageBuyPriceUsd: 0.24,
    openSellOrdersShareCount: "1000000000000000000",
    pnlUsd: 12.34,
    shares: "2500000000000000000",
    valueUsd: 55.5,
    market: {
      id: "18695",
      question: "Will Brazil win Group C in the 2026 World Cup?",
      title: "Brazil",
    },
    outcome: {
      id: "36051",
      name: "No",
      onChainId: "112327222936684958228336871102931649936685089340380670269508309037212400755560",
    },
  });

  assert.equal(position.shares, 2.5);
  assert.equal(position.openSellShares, 1);
  assert.equal(position.marketId, "18695");
  assert.equal(position.outcomeName, "No");
});

test("pointsWeekWindows uses Predict points week numbers from week 23", () => {
  const windows = pointsWeekWindows(new Date("2026-06-02T06:30:00.000Z"));

  assert.equal(windows.lastWeek.weekNumber, 23);
  assert.equal(windows.lastWeek.from, "2026-05-20T16:00:00.000Z");
  assert.equal(windows.lastWeek.to, "2026-05-27T16:00:00.000Z");
  assert.equal(windows.lastWeek.label, "第23周 · 2026-05-21 - 2026-05-27");
  assert.equal(windows.thisWeek.weekNumber, 24);
  assert.equal(windows.thisWeek.from, "2026-05-27T16:00:00.000Z");
  assert.equal(windows.thisWeek.to, "2026-06-03T16:00:00.000Z");
  assert.equal(windows.thisWeek.label, "第24周 · 2026-05-28 - 2026-06-03");
});

test("groupTradesByMarket merges multiple outcomes under the same event", () => {
  const groups = groupTradesByMarket([
    {
      marketId: "419641",
      marketTitle: "Bitcoin Up or Down - June 2",
      outcomeName: "Up",
      estimatedNotionalUsd: 10,
      sideEstimate: "BUY_SHARES_EST",
      transactionHash: "0x1",
    },
    {
      marketId: "419641",
      marketTitle: "Bitcoin Up or Down - June 2",
      outcomeName: "Down",
      estimatedNotionalUsd: 6,
      sideEstimate: "SELL_SHARES_EST",
      transactionHash: "0x2",
    },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].tradeCount, 2);
  assert.equal(groups[0].outcomes.length, 2);
  assert.equal(groups[0].estimatedNotionalUsd, 16);
});

test("buildPointsStrategySummary summarizes directional and market concentration", () => {
  const summary = buildPointsStrategySummary([
    {
      contractName: "NEG_RISK_ADAPTER",
      estimatedNotionalUsd: 10,
      estimatedPrice: 0.49,
      marketId: "1",
      marketTitle: "Market 1",
      sideEstimate: "BUY_SHARES_EST",
      timestamp: "2026-05-27T01:00:00.000Z",
      transactionHash: "0x1",
    },
    {
      contractName: "NEG_RISK_ADAPTER",
      estimatedNotionalUsd: 9,
      estimatedPrice: 0.51,
      marketId: "1",
      marketTitle: "Market 1",
      sideEstimate: "SELL_SHARES_EST",
      timestamp: "2026-05-27T01:01:00.000Z",
      transactionHash: "0x2",
    },
  ]);

  assert.match(summary, /2 笔成交/);
  assert.match(summary, /买卖接近均衡/);
  assert.match(summary, /NEG_RISK_ADAPTER/);
  assert.match(summary, /集中在少数事件/);
});
