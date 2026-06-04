import {
  buildPriceRows,
  buildReportMarkdown,
  snapshotMarkets,
} from "../scripts/report-core.mjs";
import { buildMarketProfiles } from "../scripts/market-profile-core.mjs";
import {
  BUY_PRICE_LABELS,
  SELL_PRICE_LABELS,
  addBacktestMatrices,
  createEmptyBacktestMatrix,
  normalizedCutoffMinutes,
  parseBacktestMatrixPayload,
  summarizeBacktestMatrix,
} from "../scripts/backtest-matrix-core.mjs";
import {
  mergeFavoriteMarkets,
  normalizeWalletAddress,
  orderToFavoriteMarket,
  positionToFavoriteMarket,
  summarizeOrder,
  summarizePosition,
} from "../public/wallet-core.mjs";
import {
  buildPointsStrategySummary,
  groupTradesByMarket,
  normalizePointsAccount,
  normalizePointsPosition,
  pointsWeekWindows,
  weiToNumber,
} from "../public/points-core.mjs";

const FAVORITES_KEY = "favorites:v1";
const REPORT_STATE_KEY = "report:price-state:v1";
const WALLETS_KEY = "wallets:v1";
const PREDICT_AUTH_KEY = "predict:auth:v1";
const POINTS_LEADERBOARD_KEY = "points:leaderboard:v1";
const DEPLOY_VERSION = "20260603-backtest-v2";
const REWARDS_URL = "https://api.predalpha.xyz/api/markets/rewards";
const PREDICT_GRAPHQL_URL = "https://graphql.predict.fun/graphql";
const PREDICT_AUTH_MESSAGE_URL = "https://api.predict.fun/v1/auth/message";
const PREDICT_AUTH_URL = "https://api.predict.fun/v1/auth";
const PREDICT_ACCOUNT_URL = "https://api.predict.fun/v1/account";
const PREDICT_MARKETS_URL = "https://api.predict.fun/v1/markets";
const PREDICT_ORDERS_URL = "https://api.predict.fun/v1/orders";
const PREDICT_POSITIONS_URL = "https://api.predict.fun/v1/positions";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL = "gpt-5";
const SESSION_COOKIE = "pa_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const POINTS_LEADERBOARD_TTL_MS = 30 * 60 * 1000;
const POINTS_TRADES_TTL_MS = 6 * 60 * 60 * 1000;
const POINTS_PAGE_SIZE = 100;
const POINTS_ACCOUNT_LIMIT = 200;
const POINTS_LEADERBOARD_SCAN_LIMIT = 1000;
const BSC_BLOCK_CHUNK_SIZE = 5_000;
const BSC_LOG_RPC_URLS = [
  "https://rpc-bsc.48.club",
  "https://bsc.rpc.blxrbdn.com",
  "https://bnb.api.onfinality.io/public",
];
const BSC_BLOCK_RPC_URL = "https://bsc-rpc.publicnode.com";
const PREDICT_TRADE_CONTRACTS = {
  "0x6bEb5a40C032AFc305961162d8204CDA16DECFa5": "CTF_EXCHANGE",
  "0x8A289d458f5a134bA40015085A8F50Ffb681B41d": "NEG_RISK_CTF_EXCHANGE",
  "0x8BC070BEdAB741406F4B1Eb65A72bee27894B689": "NEG_RISK_ADAPTER",
  "0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A": "NEG_RISK_ADAPTER_2",
};
const ORDER_FILLED_TOPIC = "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6";
const ORDERS_MATCHED_TOPIC = "0x63bf4d16b7fa898ef4c4b2b6d90fd201e9c56313b65638af6088d149d2ce956c";
const ALLOWED_ORIGINS = new Set([
  "https://aihuman750.github.io",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:4173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:4173",
  "https://predict-favorites.aihuman750.workers.dev",
]);
function json(data, init = {}, origin = null) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
      ...(init.headers || {}),
    },
  });
}

function corsHeaders(origin) {
  const allowOrigin = origin && (ALLOWED_ORIGINS.has(origin) || origin === "null") ? origin : "https://aihuman750.github.io";
  return {
    "access-control-allow-headers": "content-type,x-report-token",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-origin": allowOrigin,
    "cache-control": "no-store",
  };
}

function writeAllowed(request, authenticated = false) {
  if (authenticated) return true;
  const origin = request.headers.get("origin");
  return !origin || origin === "null" || ALLOWED_ORIGINS.has(origin);
}

function reportAllowed(request, env, authenticated = false) {
  if (authenticated) return true;
  const token = env.REPORT_TOKEN;
  if (token && request.headers.get("x-report-token") === token) return true;
  if (siteRequiresLogin(env)) return false;
  const origin = request.headers.get("origin");
  return Boolean(origin && (origin === "null" || ALLOWED_ORIGINS.has(origin)));
}

function siteRequiresLogin(env) {
  return String(env.SITE_ACCESS_MODE || "private").toLowerCase() !== "public";
}

function isPrivateWalletApi(pathname) {
  return pathname === "/api/wallets"
    || pathname === "/api/wallets/summary"
    || pathname === "/api/wallets/me/orders"
    || pathname.startsWith("/api/wallets/")
    || pathname.startsWith("/api/predict-auth/");
}

function isPublicBacktestApi(pathname) {
  return pathname === "/api/backtest/meta" || pathname === "/api/backtest/heatmap";
}

function base64UrlFromBytes(bytes) {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function bytesFromBase64Url(value) {
  const padded = String(value || "").replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(String(value || "").length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64UrlFromString(value) {
  return base64UrlFromBytes(new TextEncoder().encode(value));
}

function stringFromBase64Url(value) {
  return new TextDecoder().decode(bytesFromBase64Url(value));
}

function safeEqual(a, b) {
  const left = new TextEncoder().encode(String(a || ""));
  const right = new TextEncoder().encode(String(b || ""));
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] || 0) ^ (right[index] || 0);
  }
  return diff === 0;
}

function parseCookies(request) {
  const cookies = new Map();
  for (const chunk of String(request.headers.get("cookie") || "").split(";")) {
    const [name, ...rest] = chunk.trim().split("=");
    if (!name) continue;
    cookies.set(name, rest.join("="));
  }
  return cookies;
}

function nowMs(deps = {}) {
  return deps.now ? deps.now().getTime() : Date.now();
}

async function hmacBase64Url(secret, value) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`predict-monitor-session:${secret}`),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlFromBytes(new Uint8Array(signature));
}

async function createSiteSession(env, deps = {}) {
  const payload = base64UrlFromString(JSON.stringify({ iat: nowMs(deps) }));
  const signature = await hmacBase64Url(env.SITE_PASSWORD, payload);
  return `${payload}.${signature}`;
}

async function isSiteAuthenticated(request, env, deps = {}) {
  if (!env.SITE_PASSWORD) return true;
  const session = parseCookies(request).get(SESSION_COOKIE);
  if (!session) return false;

  const [payload, signature] = session.split(".");
  if (!payload || !signature) return false;

  const expected = await hmacBase64Url(env.SITE_PASSWORD, payload);
  if (!safeEqual(signature, expected)) return false;

  try {
    const parsed = JSON.parse(stringFromBase64Url(payload));
    const issuedAt = Number(parsed.iat);
    return Number.isFinite(issuedAt) && nowMs(deps) - issuedAt >= 0 && nowMs(deps) - issuedAt <= SESSION_TTL_MS;
  } catch {
    return false;
  }
}

function sessionCookie(value) {
  return `${SESSION_COOKIE}=${value}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function loginPage() {
  return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Predict Monitor Login</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { align-items: center; background: #09090b; color: #f4f4f5; display: flex; justify-content: center; min-height: 100vh; margin: 0; }
    main { border: 1px solid #27272a; background: #111113; border-radius: 8px; padding: 28px; width: min(420px, calc(100vw - 32px)); }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { color: #a1a1aa; line-height: 1.5; margin: 0 0 20px; }
    form { display: grid; gap: 12px; }
    input, button { border-radius: 6px; box-sizing: border-box; font: inherit; min-height: 42px; width: 100%; }
    input { background: #09090b; border: 1px solid #3f3f46; color: #fff; padding: 0 12px; }
    button { background: #a78bfa; border: 0; color: #18181b; cursor: pointer; font-weight: 700; }
    .error { color: #fca5a5; min-height: 20px; }
  </style>
</head>
<body>
  <main>
    <h1>Predict Monitor</h1>
    <p>请输入访问密码。登录状态会在当前浏览器保留 7 天。</p>
    <form id="loginForm">
      <input id="password" type="password" autocomplete="current-password" placeholder="访问密码" autofocus />
      <button type="submit">登录</button>
      <div class="error" id="error"></div>
    </form>
  </main>
  <script>
    document.querySelector("#loginForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const error = document.querySelector("#error");
      error.textContent = "";
      const response = await fetch("/api/site/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: document.querySelector("#password").value })
      });
      if (response.ok) {
        window.location.reload();
      } else {
        error.textContent = "密码不正确";
      }
    });
  </script>
</body>
</html>`, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    },
  });
}

async function readFavorites(env) {
  const raw = await env.FAVORITES.get(FAVORITES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeFavorites(env, favorites) {
  await env.FAVORITES.put(FAVORITES_KEY, JSON.stringify(favorites));
}

async function readWallets(env) {
  const raw = await env.FAVORITES.get(WALLETS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeWalletAddress).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function writeWallets(env, wallets) {
  await env.FAVORITES.put(WALLETS_KEY, JSON.stringify(wallets));
}

async function authStorageKey(env, usage) {
  if (!env.SITE_PASSWORD) throw new Error("site_password_not_configured");
  const material = new TextEncoder().encode(`predict-monitor-auth:${env.SITE_PASSWORD}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, usage);
}

async function sealAuthRecord(env, record) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await authStorageKey(env, ["encrypt"]);
  const plaintext = new TextEncoder().encode(JSON.stringify(record));
  const ciphertext = await crypto.subtle.encrypt({ iv, name: "AES-GCM" }, key, plaintext);
  return `${base64UrlFromBytes(iv)}.${base64UrlFromBytes(new Uint8Array(ciphertext))}`;
}

async function openAuthRecord(env, raw) {
  if (!raw) return null;
  const [ivValue, ciphertextValue] = String(raw).split(".");
  if (!ivValue || !ciphertextValue) return null;
  try {
    const key = await authStorageKey(env, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt(
      { iv: bytesFromBase64Url(ivValue), name: "AES-GCM" },
      key,
      bytesFromBase64Url(ciphertextValue),
    );
    const parsed = JSON.parse(new TextDecoder().decode(decrypted));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readPredictAuth(env) {
  return openAuthRecord(env, await env.FAVORITES.get(PREDICT_AUTH_KEY));
}

async function writePredictAuth(env, record) {
  await env.FAVORITES.put(PREDICT_AUTH_KEY, await sealAuthRecord(env, record));
}

async function readReportState(env) {
  const raw = await env.FAVORITES.get(REPORT_STATE_KEY);
  if (!raw) return { markets: {} };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { markets: {} };
  } catch {
    return { markets: {} };
  }
}

function cleanFavorite(market) {
  const key = String(market?.key || market?.id || market?.categorySlug || "").trim();
  if (!key) return null;
  const title = String(market?.title || market?.question || key).trim();

  return {
    ...market,
    key,
    title,
  };
}

function dateLabel(date) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function signFeishu(secret, timestamp) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${timestamp}\n${secret}`),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new Uint8Array());
  return bytesToBase64(new Uint8Array(signature));
}

async function fetchJson(fetcher, url, options) {
  const response = await fetcher(url, options);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function impactBriefSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["markets"],
    properties: {
      markets: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "information", "impact", "strength", "confidence", "sources"],
          properties: {
            key: { type: "string" },
            information: { type: "string" },
            impact: { enum: ["偏 Yes", "偏 No", "不明确", "无"], type: "string" },
            strength: { enum: ["高", "中", "低", "无"], type: "string" },
            confidence: { enum: ["高", "中", "低"], type: "string" },
            sources: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["title", "url", "publishedAt", "source"],
                properties: {
                  title: { type: "string" },
                  url: { type: "string" },
                  publishedAt: { type: "string" },
                  source: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  };
}

function buildImpactBriefRequestBody(marketProfiles, label, env) {
  const gptMarkets = marketProfiles.map((profile) => ({
    key: profile.key,
    title: profile.title,
    brief: profile.brief,
  }));

  return {
    model: env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    include: ["web_search_call.action.sources"],
    text: {
      format: {
        type: "json_schema",
        name: "predict_market_impact_brief",
        strict: true,
        schema: impactBriefSchema(),
      },
    },
    instructions:
      "你是预测市场监控分析员。你的任务不是复述新闻标题，而是查找可能影响市场价格和结算概率的最新事实。必须使用可验证来源，优先官方 X、官网公告、项目博客、赛事官网、交易所公告、权威数据源；其次使用可靠新闻。不要编造，没有来源支撑就写未发现高影响更新。",
    input: [
      `今天的报告时间：${label}（Asia/Shanghai）。`,
      "下面是今日收藏市场列表。每个市场都包含固定简介，用来说明市场判断什么、哪些信息会影响价格。",
      "请逐个市场联网检索最近可能影响价格的信息，并返回 JSON。若没有高影响更新，information 写“未发现高影响更新”，impact 写“无”，strength 写“无”，sources 为空数组。",
      JSON.stringify({ markets: gptMarkets }, null, 2),
    ].join("\n\n"),
  };
}

function extractOpenAIText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;

  const parts = [];
  for (const output of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(output?.content) ? output.content : []) {
      if (typeof content?.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function normalizeEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeImpactRows(markets, marketProfiles) {
  const rowsByKey = new Map();
  for (const row of Array.isArray(markets) ? markets : []) {
    if (row?.key) rowsByKey.set(String(row.key), row);
  }

  return marketProfiles.map((profile) => {
    const row = rowsByKey.get(String(profile.key)) || {};
    const sources = (Array.isArray(row.sources) ? row.sources : [])
      .map((source) => ({
        title: String(source?.title || "").trim(),
        url: String(source?.url || "").trim(),
        publishedAt: String(source?.publishedAt || "").trim(),
        source: String(source?.source || "").trim(),
      }))
      .filter((source) => source.title || source.url || source.source);

    return {
      key: profile.key,
      title: profile.title,
      url: profile.url,
      information: String(row.information || "未发现高影响更新").trim(),
      impact: normalizeEnum(row.impact, ["偏 Yes", "偏 No", "不明确", "无"], "无"),
      strength: normalizeEnum(row.strength, ["高", "中", "低", "无"], "无"),
      confidence: normalizeEnum(row.confidence, ["高", "中", "低"], "低"),
      sources,
    };
  });
}

function fallbackImpactRows(marketProfiles, information) {
  return marketProfiles.map((profile) => ({
    key: profile.key,
    title: profile.title,
    url: profile.url,
    information,
    impact: "无",
    strength: "无",
    confidence: "低",
    sources: [],
  }));
}

async function buildImpactRows(env, fetcher, marketProfiles, label) {
  if (!marketProfiles.length) return [];
  if (!env.OPENAI_API_KEY) return fallbackImpactRows(marketProfiles, "未配置 OPENAI_API_KEY，未生成 GPT 简报。");

  try {
    const response = await fetcher(OPENAI_RESPONSES_URL, {
      body: JSON.stringify(buildImpactBriefRequestBody(marketProfiles, label, env)),
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    if (!response.ok) throw new Error(`openai_http_${response.status}`);

    const text = extractOpenAIText(await response.json());
    if (!text) throw new Error("openai_empty_output");

    const parsed = JSON.parse(text);
    return normalizeImpactRows(parsed.markets, marketProfiles);
  } catch (error) {
    console.error(error);
    return fallbackImpactRows(marketProfiles, "GPT 简报生成失败，今日只发送价格表。");
  }
}

async function sendFeishu(env, fetcher, markdown, now) {
  if (!env.FEISHU_WEBHOOK || !env.FEISHU_SECRET) throw new Error("feishu_not_configured");

  const timestamp = String(Math.floor(now.getTime() / 1000));
  const payload = {
    card: {
      config: { wide_screen_mode: true },
      elements: [{ tag: "markdown", content: markdown }],
      header: {
        template: "blue",
        title: { tag: "plain_text", content: "Predict 收藏市场日报" },
      },
    },
    msg_type: "interactive",
    sign: await signFeishu(env.FEISHU_SECRET, timestamp),
    timestamp,
  };

  const response = await fetcher(env.FEISHU_WEBHOOK, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) throw new Error(`feishu_http_${response.status}`);
  const result = await response.json().catch(() => ({}));
  if (result.code && result.code !== 0) throw new Error(`feishu_code_${result.code}`);
}

async function sendLatestReport(env, deps = {}) {
  const fetcher = deps.fetch || fetch;
  const now = deps.now ? deps.now() : new Date();
  const label = dateLabel(now);
  const favorites = await readFavorites(env);
  const rewardsPayload = await fetchJson(fetcher, REWARDS_URL);
  const currentMarkets = Array.isArray(rewardsPayload) ? rewardsPayload : rewardsPayload.markets || [];
  const previousSnapshot = await readReportState(env);
  const priceRows = buildPriceRows({ currentMarkets, favorites, previousSnapshot });
  const marketProfiles = buildMarketProfiles({ currentMarkets, favorites });
  const impactRows = await buildImpactRows(env, fetcher, marketProfiles, label);
  const markdown = buildReportMarkdown({
    dateLabel: label,
    priceRows,
    impactRows,
  });

  await sendFeishu(env, fetcher, markdown, now);
  await env.FAVORITES.put(
    REPORT_STATE_KEY,
    JSON.stringify(snapshotMarkets({ currentMarkets, favorites, generatedAt: now.toISOString() })),
  );

  return {
    favoriteCount: favorites.length,
    ok: true,
    sentAt: now.toISOString(),
  };
}

async function fetchWalletPositions(address, env, fetcher) {
  if (!env.PREDICT_API_KEY) throw new Error("predict_api_key_not_configured");

  const positions = [];
  let cursor = null;

  for (let page = 0; page < 5; page += 1) {
    const url = new URL(`${PREDICT_POSITIONS_URL}/${encodeURIComponent(address)}`);
    url.searchParams.set("first", "100");
    if (cursor) url.searchParams.set("after", cursor);

    const response = await fetcher(url.toString(), {
      headers: {
        accept: "application/json",
        "x-api-key": env.PREDICT_API_KEY,
      },
    });
    if (!response.ok) throw new Error(`predict_positions_http_${response.status}`);
    const payload = await response.json();
    if (payload?.success === false) throw new Error("predict_positions_failed");

    const rows = Array.isArray(payload) ? payload : payload?.data || [];
    positions.push(...rows);

    cursor = payload?.cursor || null;
    if (!cursor || !rows.length) break;
  }

  return positions;
}

async function fetchPredictAuthMessage(env, fetcher) {
  if (!env.PREDICT_API_KEY) throw new Error("predict_api_key_not_configured");
  const payload = await fetchJson(fetcher, PREDICT_AUTH_MESSAGE_URL, {
    headers: {
      accept: "application/json",
      "x-api-key": env.PREDICT_API_KEY,
    },
  });
  if (payload?.success === false) throw new Error("predict_auth_message_failed");
  const message = payload?.data?.message;
  if (!message) throw new Error("predict_auth_message_missing");
  return String(message);
}

async function exchangePredictJwt({ env, fetcher, message, signature, signer }) {
  if (!env.PREDICT_API_KEY) throw new Error("predict_api_key_not_configured");
  const response = await fetcher(PREDICT_AUTH_URL, {
    body: JSON.stringify({ message, signature, signer }),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": env.PREDICT_API_KEY,
    },
    method: "POST",
  });
  if (!response.ok) throw new Error(`predict_auth_http_${response.status}`);
  const payload = await response.json();
  if (payload?.success === false) throw new Error("predict_auth_failed");
  const token = payload?.data?.token;
  if (!token) throw new Error("predict_auth_token_missing");
  return String(token);
}

async function fetchConnectedAccount(env, fetcher, token) {
  if (!env.PREDICT_API_KEY) throw new Error("predict_api_key_not_configured");
  const payload = await fetchJson(fetcher, PREDICT_ACCOUNT_URL, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "x-api-key": env.PREDICT_API_KEY,
    },
  });
  if (payload?.success === false) throw new Error("predict_account_failed");
  return payload?.data || payload;
}

async function fetchOwnOrders(env, fetcher, token) {
  if (!env.PREDICT_API_KEY) throw new Error("predict_api_key_not_configured");

  const orders = [];
  let cursor = null;

  for (let page = 0; page < 5; page += 1) {
    const url = new URL(PREDICT_ORDERS_URL);
    url.searchParams.set("first", "100");
    url.searchParams.set("status", "OPEN");
    if (cursor) url.searchParams.set("after", cursor);

    const response = await fetcher(url.toString(), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "x-api-key": env.PREDICT_API_KEY,
      },
    });
    if (!response.ok) throw new Error(`predict_orders_http_${response.status}`);
    const payload = await response.json();
    if (payload?.success === false) throw new Error("predict_orders_failed");

    const rows = Array.isArray(payload) ? payload : payload?.data || [];
    orders.push(...rows);

    cursor = payload?.cursor || null;
    if (!cursor || !rows.length) break;
  }

  return orders;
}

async function fetchPredictMarket(marketId, env, fetcher) {
  if (!env.PREDICT_API_KEY) throw new Error("predict_api_key_not_configured");
  const payload = await fetchJson(fetcher, `${PREDICT_MARKETS_URL}/${encodeURIComponent(marketId)}`, {
    headers: {
      accept: "application/json",
      "x-api-key": env.PREDICT_API_KEY,
    },
  });
  if (payload?.success === false) throw new Error("predict_market_failed");
  return payload?.data || payload;
}

async function fetchPredictOrderbook(marketId, env, fetcher) {
  if (!env.PREDICT_API_KEY) throw new Error("predict_api_key_not_configured");
  const payload = await fetchJson(fetcher, `${PREDICT_MARKETS_URL}/${encodeURIComponent(marketId)}/orderbook`, {
    headers: {
      accept: "application/json",
      "x-api-key": env.PREDICT_API_KEY,
    },
  });
  if (payload?.success === false) throw new Error("predict_orderbook_failed");
  return payload?.data || payload;
}

function backtestDb(env) {
  if (!env.BACKTEST_DB) throw new Error("backtest_db_not_configured");
  return env.BACKTEST_DB;
}

function parseUtcDay(value) {
  const text = String(value || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function parseBacktestIntervals(value) {
  const intervals = String(value || "1h,15m,5m")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = new Set(["1h", "15m", "5m"]);
  return [...new Set(intervals)].filter((interval) => allowed.has(interval));
}

function parseBacktestCutoff(value) {
  const cutoff = Math.floor(Number(value));
  return Number.isFinite(cutoff) && cutoff > 0 ? cutoff : null;
}

function matrixBytes(blob) {
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
  if (blob instanceof Uint8Array) return blob;
  if (Array.isArray(blob)) return Uint8Array.from(blob);
  if (typeof blob === "string") return new TextEncoder().encode(blob);
  return new Uint8Array();
}

function matrixString(blob) {
  if (typeof blob === "string") return blob;
  return new TextDecoder().decode(matrixBytes(blob));
}

function base64Bytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function matrixTextFromBlob(blob, compression) {
  const normalizedCompression = String(compression || "none").toLowerCase();
  const bytes = normalizedCompression === "gzip-base64" ? base64Bytes(matrixString(blob)) : matrixBytes(blob);
  if (normalizedCompression === "gzip" || normalizedCompression === "gzip-base64") {
    if (typeof DecompressionStream !== "function") throw new Error("gzip_decompression_unavailable");
    const stream = new Response(bytes).body.pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

async function decodeBacktestMatrix(blob, compression, options = {}) {
  return parseBacktestMatrixPayload(await matrixTextFromBlob(blob, compression), options);
}

function backtestAxes() {
  return {
    buyPrices: BUY_PRICE_LABELS,
    sellPrices: SELL_PRICE_LABELS,
  };
}

function parseBacktestFields(value) {
  const fields = String(value || "")
    .split(",")
    .map((field) => field.trim())
    .filter((field) => ["buyShares", "pnl", "sellShares"].includes(field));
  return fields.length ? fields : null;
}

function pickBacktestMatrixFields(matrix, fields) {
  if (!fields) return matrix;
  const picked = {};
  for (const field of fields) {
    picked[field] = matrix?.[field] || [];
  }
  return picked;
}

async function readBacktestMeta(env) {
  const db = backtestDb(env);
  const coverage = await db.prepare(
    "SELECT MIN(day) AS start_day, MAX(day) AS end_day, COUNT(*) AS matrix_count FROM backtest_daily_matrices",
  ).first();
  const intervalRows = await db.prepare(
    "SELECT interval, MAX(cutoff_minutes) AS cutoff_max FROM backtest_daily_matrices GROUP BY interval ORDER BY interval",
  ).all();
  const intervals = (intervalRows.results || []).map((row) => ({
    cutoffMax: Number(row.cutoff_max || 0),
    interval: row.interval,
  }));
  return {
    axes: backtestAxes(),
    coverage: {
      end: coverage?.end_day || null,
      matrixCount: Number(coverage?.matrix_count || 0),
      start: coverage?.start_day || null,
    },
    intervals,
  };
}

async function readBacktestHeatmap(env, params) {
  const start = parseUtcDay(params.get("start"));
  const end = parseUtcDay(params.get("end"));
  const cutoff = parseBacktestCutoff(params.get("cutoff"));
  const intervals = parseBacktestIntervals(params.get("intervals"));
  const fields = parseBacktestFields(params.get("fields"));
  if (!start || !end || start > end) return { error: "invalid_date_range" };
  if (!cutoff) return { error: "invalid_cutoff" };
  if (!intervals.length) return { error: "invalid_intervals" };

  const db = backtestDb(env);
  const byPerspective = {
    no: createEmptyBacktestMatrix(),
    yes: createEmptyBacktestMatrix(),
  };
  const normalizedCutoffs = {};
  let dataRows = 0;

  for (const interval of intervals) {
    const effectiveCutoff = normalizedCutoffMinutes(cutoff, interval);
    normalizedCutoffs[interval] = effectiveCutoff;
    for (const perspective of ["yes", "no"]) {
      const rows = await db.prepare(
        `SELECT compression, matrix_blob
         FROM backtest_daily_matrices
         WHERE day >= ? AND day <= ? AND interval = ? AND cutoff_minutes = ? AND perspective = ?`,
      ).bind(start, end, interval, effectiveCutoff, perspective).all();
      for (const row of rows.results || []) {
        addBacktestMatrices(byPerspective[perspective], await decodeBacktestMatrix(row.matrix_blob, row.compression, { fields }));
        dataRows += 1;
      }
    }
  }

  return {
    axes: backtestAxes(),
    no: pickBacktestMatrixFields(byPerspective.no, fields),
    summary: {
      cutoff,
      dataRows,
      end,
      intervals,
      normalizedCutoffs,
      no: summarizeBacktestMatrix(byPerspective.no),
      start,
      yes: summarizeBacktestMatrix(byPerspective.yes),
    },
    yes: pickBacktestMatrixFields(byPerspective.yes, fields),
  };
}

async function buildOwnOrdersSummary(env, deps = {}) {
  const fetcher = deps.fetch || fetch;
  const auth = await readPredictAuth(env);
  if (!auth?.token) {
    return {
      favoritesAdded: 0,
      hasToken: false,
      orders: [],
      accountAddress: auth?.accountAddress || null,
      signer: auth?.signer || null,
    };
  }

  const orders = await fetchOwnOrders(env, fetcher, auth.token);
  const marketIds = [...new Set(orders.map((order) => order?.marketId).filter((marketId) => marketId != null).map(String))];
  const marketEntries = await Promise.all(
    marketIds.map(async (marketId) => {
      try {
        return [marketId, await fetchPredictMarket(marketId, env, fetcher)];
      } catch (error) {
        console.error(error);
        return [marketId, null];
      }
    }),
  );
  const markets = new Map(marketEntries);
  const candidateFavorites = orders
    .map((order) => orderToFavoriteMarket(order, markets.get(String(order?.marketId))))
    .filter(Boolean);

  const favorites = await readFavorites(env);
  const nextFavorites = mergeFavoriteMarkets(favorites, candidateFavorites);
  if (nextFavorites.length !== favorites.length) await writeFavorites(env, nextFavorites);

  return {
    favoritesAdded: nextFavorites.length - favorites.length,
    accountAddress: auth.accountAddress || null,
    hasToken: true,
    orders: orders.map((order) => summarizeOrder(order, markets.get(String(order?.marketId)))),
    signer: auth.signer || null,
  };
}

async function buildWalletSummary(env, deps = {}) {
  const fetcher = deps.fetch || fetch;
  const wallets = await readWallets(env);
  const favorites = await readFavorites(env);
  const candidateFavorites = [];
  const summaries = [];

  for (const address of wallets) {
    try {
      const positions = await fetchWalletPositions(address, env, fetcher);
      candidateFavorites.push(...positions.map(positionToFavoriteMarket).filter(Boolean));
      summaries.push({
        address,
        error: null,
        orders: {
          available: false,
          reason: "Predict public API does not expose arbitrary-address open orders.",
        },
        positions: positions.map(summarizePosition),
      });
    } catch (error) {
      summaries.push({
        address,
        error: error.message,
        orders: {
          available: false,
          reason: "Predict public API does not expose arbitrary-address open orders.",
        },
        positions: [],
      });
    }
  }

  const nextFavorites = mergeFavoriteMarkets(favorites, candidateFavorites);
  if (nextFavorites.length !== favorites.length) await writeFavorites(env, nextFavorites);

  return {
    favoritesAdded: nextFavorites.length - favorites.length,
    wallets: summaries,
  };
}

function pointCacheFresh(payload, ttlMs, now) {
  if (!payload?.fetchedAt) return false;
  const fetchedAt = new Date(payload.fetchedAt).getTime();
  return Number.isFinite(fetchedAt) && now.getTime() - fetchedAt <= ttlMs;
}

async function readKvJson(env, key) {
  const raw = await env.FAVORITES.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeKvJson(env, key, payload) {
  await env.FAVORITES.put(key, JSON.stringify(payload));
}

async function fetchPredictGraphql(fetcher, query, variables = {}, operationName = "PredictGraphql") {
  const response = await fetcher(PREDICT_GRAPHQL_URL, {
    body: JSON.stringify({ operationName, query, variables }),
    headers: {
      accept: "application/graphql-response+json, application/json",
      "content-type": "application/json",
      referer: "https://predict.fun/",
      "user-agent": "predict-rewards-monitor/1.0",
      "x-accept-language": "zh-CN",
    },
    method: "POST",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`predict_graphql_http_${response.status}`);
  const payload = JSON.parse(text);
  if (payload.errors?.length) {
    throw new Error(payload.errors[0]?.extensions?.code || payload.errors[0]?.message || "predict_graphql_error");
  }
  return payload.data;
}

const POINTS_LEADERBOARD_QUERY = `query GetPointsLeaderboard($pagination: ForwardPaginationInput) {
  leaderboard(pagination: $pagination) {
    edges {
      cursor
      node {
        rank
        totalPoints
        allocationRoundPoints
        account {
          name
          address
          positions(pagination: { first: 1 }) {
            totalCount
          }
          statistics {
            volumeUsd
            positionsValueUsd
            pnlUsd
            marketsCount
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

const POINTS_POSITIONS_QUERY = `query GetPointsAccountPositions($address: Address!, $pagination: ForwardPaginationInput) {
  account(address: $address) {
    name
    positions(pagination: $pagination) {
      totalCount
      edges {
        node {
          shares
          averageBuyPriceUsd
          valueUsd
          pnlUsd
          openSellOrdersShareCount
          market {
            id
            title
            question
            marketType
          }
          outcome {
            id
            name
            onChainId
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

async function fetchPointsLeaderboard(env, deps = {}) {
  const fetcher = deps.fetch || fetch;
  const now = deps.now ? deps.now() : new Date();
  const cached = await readKvJson(env, POINTS_LEADERBOARD_KEY);
  if (pointCacheFresh(cached, POINTS_LEADERBOARD_TTL_MS, now)) return { ...cached, stale: false };

  try {
    const accounts = [];
    let cursor = null;
    for (let page = 0; page < 10 && accounts.length < POINTS_LEADERBOARD_SCAN_LIMIT; page += 1) {
      const data = await fetchPredictGraphql(
        fetcher,
        POINTS_LEADERBOARD_QUERY,
        { pagination: { first: POINTS_PAGE_SIZE, ...(cursor ? { after: cursor } : {}) } },
        "GetPointsLeaderboard",
      );
      const edges = data?.leaderboard?.edges || [];
      accounts.push(...edges.map(normalizePointsAccount));
      cursor = data?.leaderboard?.pageInfo?.endCursor || null;
      if (!data?.leaderboard?.pageInfo?.hasNextPage || !edges.length) break;
    }

    const weeklyAccounts = accounts
      .sort((a, b) => b.lastWeekPoints - a.lastWeekPoints || b.totalPoints - a.totalPoints)
      .slice(0, POINTS_ACCOUNT_LIMIT)
      .map((account, index) => ({ ...account, rank: index + 1 }));

    const payload = {
      accounts: weeklyAccounts,
      count: weeklyAccounts.length,
      fetchedAt: now.toISOString(),
      source: "predict_graphql",
      stale: false,
      windows: pointsWeekWindows(now),
    };
    await writeKvJson(env, POINTS_LEADERBOARD_KEY, payload);
    return payload;
  } catch (error) {
    if (cached) return { ...cached, stale: true };
    throw error;
  }
}

async function fetchPointsPositions(address, deps = {}) {
  const fetcher = deps.fetch || fetch;
  const positions = [];
  let cursor = null;

  for (let page = 0; page < 5; page += 1) {
    const data = await fetchPredictGraphql(
      fetcher,
      POINTS_POSITIONS_QUERY,
      { address, pagination: { first: POINTS_PAGE_SIZE, ...(cursor ? { after: cursor } : {}) } },
      "GetPointsAccountPositions",
    );
    if (!data?.account) throw new Error("predict_points_account_not_found");
    const connection = data.account.positions;
    positions.push(...(connection?.edges || []).map((edge) => normalizePointsPosition(edge.node)));
    cursor = connection?.pageInfo?.endCursor || null;
    if (!connection?.pageInfo?.hasNextPage || !connection?.edges?.length) break;
  }

  return positions;
}

function pointsTradesCacheKey(address, windows) {
  return `points:trades:v1:${address}:${windows.lastWeek.from}:${windows.thisWeek.from}`;
}

function hexQuantity(value) {
  return `0x${Number(value).toString(16)}`;
}

function normalizeHexAddress(address) {
  return String(address || "").toLowerCase();
}

function topicAddress(address) {
  return `0x${"0".repeat(24)}${String(address).slice(2)}`.toLowerCase();
}

function addressFromTopic(topic) {
  return `0x${String(topic || "").slice(-40)}`.toLowerCase();
}

function uint256Slots(data) {
  const clean = String(data || "").replace(/^0x/, "");
  const slots = [];
  for (let index = 0; index + 64 <= clean.length; index += 64) {
    slots.push(BigInt(`0x${clean.slice(index, index + 64)}`));
  }
  return slots;
}

function amount18(value) {
  return weiToNumber(value?.toString?.() || value || "0");
}

function estimateTradeAmounts(left, right) {
  const a = amount18(left);
  const b = amount18(right);
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  return {
    amountA: a,
    amountB: b,
    estimatedNotionalUsd: low,
    estimatedPrice: high > 0 ? low / high : null,
  };
}

function estimateSide(givenAmount, receivedAmount) {
  if (givenAmount === receivedAmount) return "UNKNOWN";
  return givenAmount > receivedAmount ? "SELL_SHARES_EST" : "BUY_SHARES_EST";
}

function displayAssetId(primary, secondary) {
  return (primary && primary !== 0n ? primary : secondary || primary || 0n).toString();
}

async function bscRpc(fetcher, url, method, params, attempt = 1) {
  const response = await fetcher(url, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const payload = await response.json();
  if (payload.error) {
    const message = `${payload.error.code || ""} ${payload.error.message || ""}`;
    if ((response.status === 429 || /Too Many Requests/i.test(message)) && attempt < 4) {
      return bscRpc(fetcher, url, method, params, attempt + 1);
    }
    throw new Error(message || "bsc_rpc_error");
  }
  return payload.result;
}

async function bscLogRpc(fetcher, method, params) {
  let lastError = null;
  for (const url of BSC_LOG_RPC_URLS) {
    try {
      return await bscRpc(fetcher, url, method, params);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("bsc_log_rpc_failed");
}

async function bscBlock(fetcher, blockTag) {
  const block = await bscRpc(fetcher, BSC_BLOCK_RPC_URL, "eth_getBlockByNumber", [blockTag, false]);
  if (!block) throw new Error("bsc_block_not_found");
  return {
    number: Number.parseInt(block.number, 16),
    timestamp: Number.parseInt(block.timestamp, 16),
  };
}

async function findBscBlockAtOrAfter(fetcher, timestampSec, latestBlock) {
  let lo = Math.max(1, latestBlock.number - 5_000_000);
  let hi = latestBlock.number;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const block = await bscBlock(fetcher, hexQuantity(mid));
    if (block.timestamp < timestampSec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function tradePeriod(timestamp, windows) {
  if (!timestamp) return null;
  const value = new Date(timestamp).getTime();
  const lastFrom = new Date(windows.lastWeek.from).getTime();
  const lastTo = new Date(windows.lastWeek.to).getTime();
  const thisFrom = new Date(windows.thisWeek.from).getTime();
  const thisTo = new Date(windows.thisWeek.to).getTime();
  if (value >= lastFrom && value < lastTo) return "lastWeek";
  if (value >= thisFrom && value < thisTo) return "thisWeek";
  return null;
}

function decodePredictLog(log, accountAddress) {
  const topic0 = String(log.topics?.[0] || "").toLowerCase();
  const contractName = PREDICT_TRADE_CONTRACTS[
    Object.keys(PREDICT_TRADE_CONTRACTS).find((address) => normalizeHexAddress(address) === normalizeHexAddress(log.address))
  ] || log.address;
  const timestamp = log.blockTimestamp
    ? new Date(Number.parseInt(log.blockTimestamp, 16) * 1000).toISOString()
    : null;
  const common = {
    blockNumber: Number.parseInt(log.blockNumber || "0x0", 16),
    contractName,
    timestamp,
    transactionHash: log.transactionHash,
  };

  if (topic0 === ORDER_FILLED_TOPIC) {
    const maker = addressFromTopic(log.topics?.[2]);
    const taker = addressFromTopic(log.topics?.[3]);
    const [makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled] = uint256Slots(log.data);
    const { amountA: makerAmount, amountB: takerAmount, estimatedNotionalUsd, estimatedPrice } =
      estimateTradeAmounts(makerAmountFilled, takerAmountFilled);
    const trades = [];
    if (maker === accountAddress) {
      const assetId = displayAssetId(makerAssetId, takerAssetId);
      trades.push({
        ...common,
        estimatedNotionalUsd,
        estimatedPrice,
        marketId: assetId,
        marketTitle: `资产 ${assetId.slice(0, 12)}...`,
        outcomeName: "maker asset",
        role: "MAKER",
        sideEstimate: estimateSide(makerAmount, takerAmount),
      });
    }
    if (taker === accountAddress) {
      const assetId = displayAssetId(takerAssetId, makerAssetId);
      trades.push({
        ...common,
        estimatedNotionalUsd,
        estimatedPrice,
        marketId: assetId,
        marketTitle: `资产 ${assetId.slice(0, 12)}...`,
        outcomeName: "taker asset",
        role: "TAKER",
        sideEstimate: estimateSide(takerAmount, makerAmount),
      });
    }
    return trades;
  }

  if (topic0 === ORDERS_MATCHED_TOPIC) {
    const takerOrderMaker = addressFromTopic(log.topics?.[2]);
    if (takerOrderMaker !== accountAddress) return [];
    const [makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled] = uint256Slots(log.data);
    const { amountA: makerAmount, amountB: takerAmount, estimatedNotionalUsd, estimatedPrice } =
      estimateTradeAmounts(makerAmountFilled, takerAmountFilled);
    const assetId = displayAssetId(takerAssetId, makerAssetId);
    return [{
      ...common,
      estimatedNotionalUsd,
      estimatedPrice,
      marketId: assetId,
      marketTitle: `资产 ${assetId.slice(0, 12)}...`,
      outcomeName: "matched asset",
      role: "TAKER_ORDER_MAKER",
      sideEstimate: estimateSide(takerAmount, makerAmount),
    }];
  }

  return [];
}

async function scanPointsTrades(address, windows, deps = {}) {
  const fetcher = deps.fetch || fetch;
  const latest = await bscBlock(fetcher, "latest");
  const fromTimestampSec = Math.floor(new Date(windows.lastWeek.from).getTime() / 1000);
  const toTimestampSec = Math.min(
    Math.floor(Date.now() / 1000),
    Math.floor(new Date(windows.thisWeek.to).getTime() / 1000),
  );
  const fromBlock = await findBscBlockAtOrAfter(fetcher, fromTimestampSec, latest);
  const toBlock = await findBscBlockAtOrAfter(fetcher, toTimestampSec, latest);
  const accountTopic = topicAddress(address);
  const filters = [
    { topics: [ORDER_FILLED_TOPIC, null, accountTopic, null] },
    { topics: [ORDER_FILLED_TOPIC, null, null, accountTopic] },
    { topics: [ORDERS_MATCHED_TOPIC, null, accountTopic] },
  ];
  const logs = [];
  for (let chunkFrom = fromBlock; chunkFrom <= toBlock; chunkFrom += BSC_BLOCK_CHUNK_SIZE + 1) {
    const chunkTo = Math.min(toBlock, chunkFrom + BSC_BLOCK_CHUNK_SIZE);
    for (const filter of filters) {
      const result = await bscLogRpc(fetcher, "eth_getLogs", [{
        address: Object.keys(PREDICT_TRADE_CONTRACTS),
        fromBlock: hexQuantity(chunkFrom),
        toBlock: hexQuantity(chunkTo),
        topics: filter.topics,
      }]);
      logs.push(...(Array.isArray(result) ? result : []));
    }
  }

  const seen = new Set();
  const lastWeekTrades = [];
  const thisWeekTrades = [];
  for (const log of logs) {
    const dedupe = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    for (const trade of decodePredictLog(log, address)) {
      const period = tradePeriod(trade.timestamp, windows);
      if (period === "lastWeek") lastWeekTrades.push(trade);
      if (period === "thisWeek") thisWeekTrades.push(trade);
    }
  }

  return {
    fetchedAt: new Date().toISOString(),
    lastWeekTrades,
    source: "bsc_logs",
    thisWeekTrades,
  };
}

async function readOrBuildPointsTrades(address, windows, env, deps = {}) {
  const now = deps.now ? deps.now() : new Date();
  const key = pointsTradesCacheKey(address, windows);
  const cached = await readKvJson(env, key);
  if (pointCacheFresh(cached, POINTS_TRADES_TTL_MS, now)) return { ...cached, source: cached.source || "cache" };
  const payload = await scanPointsTrades(address, windows, deps);
  await writeKvJson(env, key, payload);
  return payload;
}

function detailPeriodPayload(trades) {
  return {
    marketGroups: groupTradesByMarket(trades),
    strategy: buildPointsStrategySummary(trades),
    trades,
  };
}

async function buildPointsAccountDetail(address, env, deps = {}) {
  const normalized = normalizeWalletAddress(address);
  if (!normalized) throw new Error("invalid_wallet_address");
  const now = deps.now ? deps.now() : new Date();
  const windows = pointsWeekWindows(now);
  const [positions, tradePayload] = await Promise.all([
    fetchPointsPositions(normalized, deps),
    readOrBuildPointsTrades(normalized, windows, env, deps),
  ]);

  return {
    address: normalized,
    fetchedAt: now.toISOString(),
    positions,
    tradeSource: tradePayload.source || "cache",
    tradesFetchedAt: tradePayload.fetchedAt || null,
    windows,
    lastWeek: detailPeriodPayload(tradePayload.lastWeekTrades || []),
    thisWeek: detailPeriodPayload(tradePayload.thisWeekTrades || []),
  };
}

export async function handleRequest(request, env, deps = {}) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const fetcher = deps.fetch || fetch;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (url.pathname === "/health") {
    return json({ ok: true, version: DEPLOY_VERSION }, {}, origin);
  }

  if (url.pathname === "/api/site/login" && request.method === "POST") {
    if (!env.SITE_PASSWORD) return json({ error: "site_password_not_configured" }, { status: 500 }, origin);
    const body = await request.json().catch(() => null);
    if (!safeEqual(body?.password, env.SITE_PASSWORD)) {
      return json({ error: "invalid_password" }, { status: 401 }, origin);
    }
    return json({ ok: true }, { headers: { "set-cookie": sessionCookie(await createSiteSession(env, deps)) } }, origin);
  }

  if (url.pathname === "/api/site/logout" && request.method === "POST") {
    return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } }, origin);
  }

  const requiresLogin = siteRequiresLogin(env);
  const privateSessionAuthenticated = await isSiteAuthenticated(request, env, deps);
  const authenticated = requiresLogin ? privateSessionAuthenticated : true;
  const hasPrivateSession = Boolean(env.SITE_PASSWORD) && privateSessionAuthenticated;

  if (url.pathname === "/api/site/status" && request.method === "GET") {
    return json({ authenticated, public: !requiresLogin }, {}, origin);
  }

  if (url.pathname === "/data/rewards.json" && request.method === "GET") {
    if (requiresLogin && !authenticated) return json({ error: "auth_required" }, { status: 401 }, origin);
    return json(await fetchJson(fetcher, REWARDS_URL), {}, origin);
  }

  if (url.pathname.startsWith("/api/") && requiresLogin && !authenticated && url.pathname !== "/api/report/send" && !isPublicBacktestApi(url.pathname)) {
    return json({ error: "auth_required" }, { status: 401 }, origin);
  }

  if (!requiresLogin && env.SITE_PASSWORD && isPrivateWalletApi(url.pathname) && !hasPrivateSession) {
    return json({ error: "auth_required" }, { status: 401 }, origin);
  }

  if (url.pathname === "/api/favorites" && request.method === "GET") {
    return json({ favorites: await readFavorites(env) }, {}, origin);
  }

  if (url.pathname === "/api/backtest/meta" && request.method === "GET") {
    try {
      return json(await readBacktestMeta(env), {}, origin);
    } catch (error) {
      console.error(error);
      return json({ error: "backtest_meta_failed" }, { status: 500 }, origin);
    }
  }

  if (url.pathname === "/api/backtest/heatmap" && request.method === "GET") {
    try {
      const payload = await readBacktestHeatmap(env, url.searchParams);
      if (payload.error) return json({ error: payload.error }, { status: 400 }, origin);
      return json(payload, {}, origin);
    } catch (error) {
      console.error(error);
      return json({ error: "backtest_heatmap_failed" }, { status: 500 }, origin);
    }
  }

  if (url.pathname === "/api/points/leaderboard" && request.method === "GET") {
    try {
      return json(await fetchPointsLeaderboard(env, deps), {}, origin);
    } catch (error) {
      console.error(error);
      return json({ error: "points_leaderboard_failed" }, { status: 500 }, origin);
    }
  }

  const pointsAccountMatch = url.pathname.match(/^\/api\/points\/accounts\/([^/]+)$/);
  if (pointsAccountMatch && request.method === "GET") {
    try {
      return json(await buildPointsAccountDetail(decodeURIComponent(pointsAccountMatch[1]), env, deps), {}, origin);
    } catch (error) {
      console.error(error);
      const status = error.message === "invalid_wallet_address" ? 400 : 500;
      return json({ error: status === 400 ? "invalid_wallet_address" : "points_account_failed" }, { status }, origin);
    }
  }

  if (url.pathname === "/api/favorites" && request.method === "POST") {
    if (!writeAllowed(request, hasPrivateSession)) return json({ error: "origin_not_allowed" }, { status: 403 }, origin);

    const body = await request.json().catch(() => null);
    const favorite = cleanFavorite(body?.market);
    if (!favorite) return json({ error: "invalid_market" }, { status: 400 }, origin);

    const favorites = await readFavorites(env);
    const next = [favorite, ...favorites.filter((item) => item.key !== favorite.key)];
    await writeFavorites(env, next);
    return json({ favorites: next }, {}, origin);
  }

  if (url.pathname === "/api/wallets" && request.method === "GET") {
    return json({ wallets: await readWallets(env) }, {}, origin);
  }

  if (url.pathname === "/api/wallets" && request.method === "POST") {
    if (!writeAllowed(request, hasPrivateSession)) return json({ error: "origin_not_allowed" }, { status: 403 }, origin);

    const body = await request.json().catch(() => null);
    const address = normalizeWalletAddress(body?.address);
    if (!address) return json({ error: "invalid_wallet_address" }, { status: 400 }, origin);

    const wallets = await readWallets(env);
    const next = wallets.includes(address) ? wallets : [address, ...wallets];
    await writeWallets(env, next);
    return json({ wallets: next }, {}, origin);
  }

  if (url.pathname === "/api/wallets/summary" && request.method === "GET") {
    try {
      return json(await buildWalletSummary(env, deps), {}, origin);
    } catch (error) {
      console.error(error);
      return json({ error: "wallet_summary_failed" }, { status: 500 }, origin);
    }
  }

  const orderbookMatch = url.pathname.match(/^\/api\/markets\/([^/]+)\/orderbook$/);
  if (orderbookMatch && request.method === "GET") {
    try {
      return json({ orderbook: await fetchPredictOrderbook(decodeURIComponent(orderbookMatch[1]), env, fetcher) }, {}, origin);
    } catch (error) {
      console.error(error);
      return json({ error: "predict_orderbook_failed" }, { status: 500 }, origin);
    }
  }

  if (url.pathname === "/api/predict-auth/status" && request.method === "GET") {
    const auth = await readPredictAuth(env);
    return json({
      accountAddress: auth?.accountAddress || null,
      hasToken: Boolean(auth?.token),
      signer: auth?.signer || null,
    }, {}, origin);
  }

  if (url.pathname === "/api/predict-auth/message" && request.method === "GET") {
    try {
      return json({ message: await fetchPredictAuthMessage(env, fetcher) }, {}, origin);
    } catch (error) {
      console.error(error);
      return json({ error: "predict_auth_message_failed" }, { status: 500 }, origin);
    }
  }

  if (url.pathname === "/api/predict-auth/token" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    const signer = normalizeWalletAddress(body?.signer);
    const message = String(body?.message || "");
    const signature = String(body?.signature || "");
    if (!signer || !message || !signature) return json({ error: "invalid_predict_auth" }, { status: 400 }, origin);

    try {
      const token = await exchangePredictJwt({ env, fetcher, message, signature, signer });
      const account = await fetchConnectedAccount(env, fetcher, token);
      const accountAddress = normalizeWalletAddress(account?.address) || signer;
      await writePredictAuth(env, {
        accountAddress,
        savedAt: new Date(nowMs(deps)).toISOString(),
        signer,
        token,
      });

      const wallets = await readWallets(env);
      const nextWallets = [
        accountAddress,
        ...wallets.filter((address) => address !== accountAddress && address !== signer),
      ];
      if (nextWallets.length !== wallets.length || nextWallets.some((address, index) => address !== wallets[index])) {
        await writeWallets(env, nextWallets);
      }

      return json({ accountAddress, hasToken: true, signer }, {}, origin);
    } catch (error) {
      console.error(error);
      return json({ error: "predict_auth_failed" }, { status: 500 }, origin);
    }
  }

  if (url.pathname === "/api/wallets/me/orders" && request.method === "GET") {
    try {
      return json(await buildOwnOrdersSummary(env, deps), {}, origin);
    } catch (error) {
      console.error(error);
      return json({ error: "wallet_orders_failed" }, { status: 500 }, origin);
    }
  }

  const deleteMatch = url.pathname.match(/^\/api\/favorites\/([^/]+)$/);
  if (deleteMatch && request.method === "DELETE") {
    if (!writeAllowed(request, hasPrivateSession)) return json({ error: "origin_not_allowed" }, { status: 403 }, origin);

    const key = decodeURIComponent(deleteMatch[1]);
    const favorites = await readFavorites(env);
    const next = favorites.filter((item) => item.key !== key);
    await writeFavorites(env, next);
    return json({ favorites: next }, {}, origin);
  }

  const walletDeleteMatch = url.pathname.match(/^\/api\/wallets\/([^/]+)$/);
  if (walletDeleteMatch && request.method === "DELETE") {
    if (!writeAllowed(request, hasPrivateSession)) return json({ error: "origin_not_allowed" }, { status: 403 }, origin);

    const address = normalizeWalletAddress(decodeURIComponent(walletDeleteMatch[1]));
    if (!address) return json({ error: "invalid_wallet_address" }, { status: 400 }, origin);

    const wallets = await readWallets(env);
    const next = wallets.filter((item) => item !== address);
    await writeWallets(env, next);
    return json({ wallets: next }, {}, origin);
  }

  if (url.pathname === "/api/report/send" && request.method === "POST") {
    if (!reportAllowed(request, env, authenticated)) return json({ error: "origin_not_allowed" }, { status: 403 }, origin);

    try {
      return json(await sendLatestReport(env, deps), {}, origin);
    } catch (error) {
      console.error(error);
      return json({ error: "report_failed" }, { status: 500 }, origin);
    }
  }

  if (env.ASSETS && request.method === "GET") {
    if (requiresLogin && !authenticated) return loginPage();
    const assetResponse = await env.ASSETS.fetch(request);
    const headers = new Headers(assetResponse.headers);
    headers.set("cache-control", "no-store");
    headers.set("pragma", "no-cache");
    headers.set("expires", "0");
    return new Response(assetResponse.body, {
      headers,
      status: assetResponse.status,
      statusText: assetResponse.statusText,
    });
  }

  return json({ error: "not_found" }, { status: 404 }, origin);
}

export default {
  fetch: handleRequest,
};
