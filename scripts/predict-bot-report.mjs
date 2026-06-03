#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  previousCompletedHourWindow,
  renderBotReportMarkdown,
  summarizeAccountActivity,
  summarizeBotLogs,
  summarizeBotState,
} from "./predict-bot-report-core.mjs";
import { readEoaAdapterConfig, requestEoaJwt } from "./predict-bot-eoa-adapter.mjs";

const DEFAULT_LOG_FILE = "/Users/penghuihui/.predict-bot/bot.log";
const DEFAULT_ERR_LOG_FILE = "/Users/penghuihui/.predict-bot/bot.err.log";
const DEFAULT_REPORT_DIR = "/Users/penghuihui/.predict-bot/reports";
const DEFAULT_STATE_FILE = ".predict-bot-state.json";
const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";

function parseArgs(argv) {
  const options = {
    errLogFile: process.env.PREDICT_BOT_ERR_LOG_FILE || DEFAULT_ERR_LOG_FILE,
    logFile: process.env.PREDICT_BOT_LOG_FILE || DEFAULT_LOG_FILE,
    outputDir: process.env.PREDICT_BOT_REPORT_DIR || DEFAULT_REPORT_DIR,
    stateFile: process.env.PREDICT_BOT_STATE_FILE || DEFAULT_STATE_FILE,
    windowHours: Number(process.env.PREDICT_BOT_REPORT_WINDOW_HOURS || 1),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      options.outputDir = argv[index + 1];
      index += 1;
    } else if (arg === "--window-hours") {
      options.windowHours = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--state-file") {
      options.stateFile = argv[index + 1];
      index += 1;
    } else if (arg === "--log-file") {
      options.logFile = argv[index + 1];
      index += 1;
    } else if (arg === "--err-log-file") {
      options.errLogFile = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown_arg:${arg}`);
    }
  }

  if (!Number.isFinite(options.windowHours) || options.windowHours <= 0) {
    throw new Error("invalid_window_hours");
  }

  return options;
}

async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function readOptionalJson(filePath) {
  const text = await readOptionalText(filePath);
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function maskAddress(address) {
  const value = String(address || "");
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value || null;
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`predict_http_${response.status}`);
  return payload;
}

async function readAccountSummary(marketCatalog = {}) {
  try {
    const config = readEoaAdapterConfig();
    const jwt = config.jwt || await requestEoaJwt(config);
    const headers = {
      accept: "application/json",
      Authorization: `Bearer ${jwt}`,
      "x-api-key": config.apiKey,
    };
    const accountPayload = await fetchJson(new URL("/v1/account", config.apiBase), headers);
    const accountAddress = accountPayload?.data?.address || accountPayload?.address || "";
    const [openOrdersPayload, filledOrdersPayload, positionsPayload, balanceSummary] = await Promise.all([
      fetchJson(new URL("/v1/orders?first=100&status=OPEN", config.apiBase), headers),
      fetchJson(new URL("/v1/orders?first=100&status=FILLED", config.apiBase), headers),
      accountAddress
        ? fetchJson(new URL(`/v1/positions/${encodeURIComponent(accountAddress)}`, config.apiBase), {
          accept: "application/json",
          "x-api-key": config.apiKey,
        })
        : Promise.resolve({ data: [] }),
      readBalanceSummary(config).catch(() => ({})),
    ]);
    const openOrders = rowsOf(openOrdersPayload);
    const filledOrders = rowsOf(filledOrdersPayload);
    const positions = rowsOf(positionsPayload);

    return {
      ...balanceSummary,
      account: maskAddress(accountAddress),
      activity: summarizeAccountActivity({
        filledOrders,
        marketCatalog,
        openOrders,
        positions,
      }),
      filledOrderCount: filledOrders.length,
      openOrderCount: openOrders.length,
      positionCount: positions.length,
    };
  } catch {
    return {};
  }
}

async function readBalanceSummary(config) {
  const [{ Contract, JsonRpcProvider, Wallet, formatEther, formatUnits }] = await Promise.all([
    import("ethers"),
  ]);
  const provider = new JsonRpcProvider(config.rpcUrl);
  const wallet = new Wallet(config.walletPrivateKey, provider);
  const usdt = new Contract(USDT_ADDRESS, [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
  ], provider);
  const [bnbBalance, usdtBalance, decimals] = await Promise.all([
    provider.getBalance(wallet.address),
    usdt.balanceOf(wallet.address),
    usdt.decimals(),
  ]);
  return {
    bnb: Number(formatEther(bnbBalance)).toFixed(6),
    usdt: Number(formatUnits(usdtBalance, decimals)).toFixed(6),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const now = new Date();
  const [botLogText, errLogText, state] = await Promise.all([
    readOptionalText(options.logFile),
    readOptionalText(options.errLogFile),
    readOptionalJson(path.resolve(options.stateFile)),
  ]);
  const logSummary = summarizeBotLogs({
    botLogText,
    errLogText,
    now,
    ...previousCompletedHourWindow(now),
  });
  const accountSummary = await readAccountSummary(logSummary.marketCatalog);
  const stateSummary = summarizeBotState(state, logSummary.marketCatalog);
  const markdown = renderBotReportMarkdown({
    accountSummary,
    generatedAt: now.toISOString(),
    logSummary,
    stateSummary,
  });
  const outputDir = path.resolve(options.outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const filename = `predict-bot-report-${now.toISOString().replace(/[:.]/g, "-")}.md`;
  const reportPath = path.join(outputDir, filename);
  const latestPath = path.join(outputDir, "latest.md");
  await Promise.all([
    fs.writeFile(reportPath, markdown),
    fs.writeFile(latestPath, markdown),
  ]);
  console.log(JSON.stringify({ latestPath, reportPath }, null, 2));
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
