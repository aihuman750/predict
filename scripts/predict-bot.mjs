#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  DEFAULT_BOT_CONFIG,
  applyMaxLossRiskControl,
  buildTradingActions,
  normalizeBotAssets,
  selectCurrentFifteenMinuteMarket,
  selectCurrentOneHourMarket,
} from "./predict-bot-core.mjs";
import {
  applyAccountSnapshotToState,
  summarizeFilledOrderPnl,
} from "./predict-bot-account-sync.mjs";
import { createEoaLiveAdapter, readEoaAdapterConfig } from "./predict-bot-eoa-adapter.mjs";
import { executeActions } from "./predict-bot-executor.mjs";
import { redeemWonPositions } from "./predict-bot-redeem-core.mjs";

const API_BASE = "https://api.predict.fun";
const DEFAULT_STATE_FILE = ".predict-bot-state.json";
const DEFAULT_KILL_SWITCH_FILE = ".predict-bot-kill-switch";
const ASSET_SEARCH_QUERIES = Object.freeze({
  BTC: "Bitcoin Up or Down",
  ETH: "Ethereum Up or Down",
  BNB: "BNB Up or Down",
});
const BTC_FIFTEEN_MINUTE_SEARCH_QUERY = "Bitcoin Up or Down 15";

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function parseArgs(argv) {
  const options = {
    loop: false,
    pollSeconds: Number(process.env.PREDICT_BOT_POLL_SECONDS || 20),
    stateFile: process.env.PREDICT_BOT_STATE_FILE || DEFAULT_STATE_FILE,
    live: isTruthy(process.env.PREDICT_BOT_LIVE),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--loop") {
      options.loop = true;
    } else if (arg === "--once") {
      options.loop = false;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--dry-run") {
      options.live = false;
    } else if (arg === "--state-file") {
      options.stateFile = argv[index + 1];
      index += 1;
    } else if (arg === "--poll-seconds") {
      options.pollSeconds = Number(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`unknown_arg:${arg}`);
    }
  }

  if (!options.stateFile) throw new Error("state_file_required");
  if (!Number.isFinite(options.pollSeconds) || options.pollSeconds < 5) {
    throw new Error("poll_seconds_must_be_at_least_5");
  }
  return options;
}

function usage() {
  return [
    "Usage: node scripts/predict-bot.mjs [--once|--loop] [--dry-run] [--state-file PATH] [--poll-seconds N]",
    "",
    "Required env:",
    "  PREDICT_BOT_API_KEY      Predict API key for market and orderbook reads.",
    "  PREDICT_BOT_ASSETS       Optional comma-separated asset allowlist, e.g. BTC.",
    "",
    "Live EOA env:",
    "  PREDICT_BOT_WALLET_PRIVATE_KEY  Bot EOA private key. Never commit this.",
    "  PREDICT_BOT_RPC_URL             BNB mainnet RPC URL.",
    "  PREDICT_BOT_JWT                 Optional; generated dynamically when omitted.",
    "",
    "Safety env:",
    "  PREDICT_BOT_DISABLED=1   Kill switch; no actions are generated.",
    "  PREDICT_BOT_MAX_LOSS_USDT  Pause new buys after cumulative loss reaches this amount. Defaults to 20.",
    "  PREDICT_BOT_STATE_FILE   Local state path. Defaults to .predict-bot-state.json.",
    "",
    "Live trading requires --live and the EOA env above.",
  ].join("\n");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function loadState(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { markets: {} };
    throw error;
  }
}

async function saveState(filePath, state) {
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function fetchJson(url, apiKey) {
  const response = await fetch(url, {
    headers: { "x-api-key": apiKey },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`predict_http_${response.status}`);
  if (payload?.success === false) throw new Error(`predict_api_failed:${url}`);
  return payload;
}

async function fetchSearch(asset, apiKey, apiBase) {
  const url = new URL("/v1/search", apiBase);
  url.searchParams.set("query", ASSET_SEARCH_QUERIES[asset]);
  url.searchParams.set("includeResolved", "false");
  url.searchParams.set("limit", "25");
  return fetchJson(url, apiKey);
}

async function fetchSearchByQuery(query, apiKey, apiBase) {
  const url = new URL("/v1/search", apiBase);
  url.searchParams.set("query", query);
  url.searchParams.set("includeResolved", "false");
  url.searchParams.set("limit", "25");
  return fetchJson(url, apiKey);
}

async function fetchOrderbook(marketId, apiKey, apiBase) {
  return fetchJson(new URL(`/v1/markets/${marketId}/orderbook`, apiBase), apiKey);
}

async function loadMarketsAndOrderbooks({ apiBase, apiKey, now, assets = DEFAULT_BOT_CONFIG.assets }) {
  const markets = [];
  const orderbooksByMarketId = {};

  for (const asset of assets) {
    const searchPayload = await fetchSearch(asset, apiKey, apiBase);
    const market = selectCurrentOneHourMarket(asset, searchPayload, now);
    if (!market) continue;
    markets.push(market);
    const orderbookPayload = await fetchOrderbook(market.marketId, apiKey, apiBase);
    orderbooksByMarketId[market.marketId] = orderbookPayload.data ?? orderbookPayload;
  }

  if (assets.includes("BTC")) {
    const searchPayload = await fetchSearchByQuery(BTC_FIFTEEN_MINUTE_SEARCH_QUERY, apiKey, apiBase);
    const market = selectCurrentFifteenMinuteMarket("BTC", searchPayload, now);
    if (market) {
      markets.push(market);
      const orderbookPayload = await fetchOrderbook(market.marketId, apiKey, apiBase);
      orderbooksByMarketId[market.marketId] = orderbookPayload.data ?? orderbookPayload;
    }
  }

  return { markets, orderbooksByMarketId };
}

function marketSummary(market) {
  return {
    asset: market.asset,
    endsAt: market.endsAt,
    interval: market.interval,
    marketId: market.marketId,
    slug: market.slug,
    startsAt: market.startsAt,
    title: market.title,
  };
}

function actionSummary(action) {
  return {
    asset: action.asset,
    interval: action.interval,
    marketId: action.marketId,
    outcome: action.outcomeName,
    price: action.price,
    reason: action.reason,
    shares: action.shares,
    type: action.type,
  };
}

function createLiveAdapter() {
  return createEoaLiveAdapter(readEoaAdapterConfig());
}

async function runOnce(options) {
  const apiKey = process.env.PREDICT_BOT_API_KEY;
  if (!apiKey) throw new Error("missing_predict_bot_api_key");
  const apiBase = process.env.PREDICT_BOT_API_BASE || API_BASE;
  const assets = normalizeBotAssets(process.env.PREDICT_BOT_ASSETS);
  const now = new Date();
  const stateFile = path.resolve(options.stateFile);
  const state = await loadState(stateFile);
  const killSwitchFile = process.env.PREDICT_BOT_KILL_SWITCH_FILE || DEFAULT_KILL_SWITCH_FILE;
  const killSwitch = isTruthy(process.env.PREDICT_BOT_DISABLED) || await fileExists(killSwitchFile);
  const liveAdapter = options.live && !killSwitch ? createLiveAdapter() : null;

  const { markets, orderbooksByMarketId } = await loadMarketsAndOrderbooks({ apiBase, apiKey, now, assets });
  let syncedState = state;
  let accountSynced = false;
  let autoRedeems = [];
  let cumulativePnl = 0;
  let maxLossUsdt = DEFAULT_BOT_CONFIG.maxCumulativeLossUsdt;
  let pnlBaselineAt = state.risk?.pnlBaselineAt || now.toISOString();
  if (!killSwitch && options.live && typeof liveAdapter?.loadAccountSnapshot === "function") {
    let snapshot = await liveAdapter.loadAccountSnapshot();
    autoRedeems = await redeemWonPositions({ adapter: liveAdapter, positions: snapshot.positions });
    if (autoRedeems.some((result) => result.success)) {
      snapshot = await liveAdapter.loadAccountSnapshot();
    }
    syncedState = applyAccountSnapshotToState(state, markets, snapshot, now);
    pnlBaselineAt = syncedState.risk?.pnlBaselineAt || pnlBaselineAt;
    cumulativePnl = summarizeFilledOrderPnl({
      assets,
      filledOrders: snapshot.filledOrders,
      markets,
      pnlBaselineAt,
      state: syncedState,
    });
    accountSynced = true;
  }

  let actions = buildTradingActions({
    config: { assets, killSwitch, liveTrading: options.live },
    markets,
    now,
    orderbooksByMarketId,
    state: syncedState,
  });
  maxLossUsdt = Number(process.env.PREDICT_BOT_MAX_LOSS_USDT || maxLossUsdt);
  const riskControl = applyMaxLossRiskControl({
    actions,
    cumulativePnl,
    maxLossUsdt,
    now,
    pnlBaselineAt,
    state: syncedState,
  });
  actions = riskControl.actions;
  syncedState = riskControl.state;

  const result = {
    accountSynced,
    actions: actions.map(actionSummary),
    autoRedeems,
    dryRun: !options.live,
    assets,
    killSwitch,
    markets: markets.map(marketSummary),
    now: now.toISOString(),
    risk: {
      cumulativePnl,
      maxLossUsdt,
      pnlBaselineAt,
      paused: riskControl.riskPaused,
    },
    stateFile,
  };

  console.log(JSON.stringify(result, null, 2));

  let execution = { executed: [], state: syncedState };
  if (!killSwitch) {
    try {
      execution = await executeActions({
        actions,
        adapter: liveAdapter,
        live: options.live,
        now,
        state: syncedState,
      });
    } catch (error) {
      if (error?.state) await saveState(stateFile, error.state);
      throw error;
    }
  }

  if (actions.length > 0 || accountSynced || autoRedeems.length > 0) {
    await saveState(stateFile, execution.state);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  do {
    try {
      await runOnce(options);
    } catch (error) {
      if (!options.loop) throw error;
      console.error(JSON.stringify({
        error: error?.message || String(error),
        now: new Date().toISOString(),
      }));
    }
    if (!options.loop) break;
    await sleep(options.pollSeconds * 1000);
  } while (true);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
