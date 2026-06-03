import test from "node:test";
import assert from "node:assert/strict";

import { buildMarketProfiles } from "../scripts/market-profile-core.mjs";

test("buildMarketProfiles explains FDV-after-launch settlement drivers", () => {
  const profiles = buildMarketProfiles({
    favorites: [
      {
        key: "standx-fdv",
        title: "StandX FDV above $50M one day after launch?",
        question: "StandX FDV above $50M one day after launch?",
        url: "https://predict.fun/market/standx-fdv-above-50m",
      },
    ],
    currentMarkets: [],
  });

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].key, "standx-fdv");
  assert.match(profiles[0].brief, /TGE|上线/);
  assert.match(profiles[0].brief, /FDV/);
  assert.match(profiles[0].brief, /初始流通量/);
});

test("buildMarketProfiles explains sports-match price drivers", () => {
  const profiles = buildMarketProfiles({
    favorites: [
      {
        key: "colombia-costa-rica",
        title: "Colombia vs. Costa Rica",
        question: "Colombia vs. Costa Rica",
      },
    ],
    currentMarkets: [],
  });

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].key, "colombia-costa-rica");
  assert.match(profiles[0].brief, /比赛/);
  assert.match(profiles[0].brief, /开赛时间/);
  assert.match(profiles[0].brief, /伤病|停赛/);
});
