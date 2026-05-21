import {
  buildPriceRows,
  buildReportMarkdown,
  findCurrentMarket,
  snapshotMarkets,
} from "../scripts/report-core.mjs";
import {
  mergeFavoriteMarkets,
  normalizeWalletAddress,
  orderToFavoriteMarket,
  positionToFavoriteMarket,
  summarizeOrder,
  summarizePosition,
} from "../public/wallet-core.mjs";

const FAVORITES_KEY = "favorites:v1";
const REPORT_STATE_KEY = "report:price-state:v1";
const WALLETS_KEY = "wallets:v1";
const PREDICT_AUTH_KEY = "predict:auth:v1";
const REWARDS_URL = "https://api.predalpha.xyz/api/markets/rewards";
const PREDICT_AUTH_MESSAGE_URL = "https://api.predict.fun/v1/auth/message";
const PREDICT_AUTH_URL = "https://api.predict.fun/v1/auth";
const PREDICT_ACCOUNT_URL = "https://api.predict.fun/v1/account";
const PREDICT_MARKETS_URL = "https://api.predict.fun/v1/markets";
const PREDICT_ORDERS_URL = "https://api.predict.fun/v1/orders";
const PREDICT_POSITIONS_URL = "https://api.predict.fun/v1/positions";
const RECENT_PROGRESS_MS = 48 * 60 * 60 * 1000;
const SESSION_COOKIE = "pa_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
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
const STOP_WORDS = new Set([
  "above",
  "after",
  "before",
  "does",
  "from",
  "have",
  "launch",
  "market",
  "one",
  "their",
  "will",
  "with",
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
  if (env.SITE_PASSWORD) return false;
  const origin = request.headers.get("origin");
  return Boolean(origin && (origin === "null" || ALLOWED_ORIGINS.has(origin)));
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

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function textBetween(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1]).replace(/<[^>]+>/g, "").trim() : "";
}

function parseNewsItems(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => {
    const item = match[1];
    return {
      link: textBetween(item, "link"),
      pubDate: textBetween(item, "pubDate"),
      source: textBetween(item, "source"),
      title: textBetween(item, "title"),
    };
  });
}

function significantTokens(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  );
}

function hasEnoughOverlap(market, itemTitle) {
  const marketTokens = significantTokens(`${market.question || ""} ${market.title || ""} ${market.categorySlug || ""}`);
  if (!marketTokens.size) return false;
  const itemTokens = significantTokens(itemTitle);
  let overlap = 0;
  for (const token of marketTokens) {
    if (itemTokens.has(token)) overlap += 1;
  }
  return overlap >= Math.min(2, marketTokens.size);
}

async function findProgress(market, fetcher, now) {
  const query = `${market.question || market.title || market.categorySlug || ""} latest`;
  if (!query.trim()) return "无进展";

  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const response = await fetcher(url, { headers: { "user-agent": "predict-report/1.0" } });
    if (!response.ok) return "无进展";
    const items = parseNewsItems(await response.text());
    const recent = items.find((item) => {
      const publishedAt = Date.parse(item.pubDate);
      return (
        Number.isFinite(publishedAt) &&
        now.getTime() - publishedAt <= RECENT_PROGRESS_MS &&
        hasEnoughOverlap(market, item.title)
      );
    });
    if (!recent) return "无进展";

    const title = recent.link ? `[${recent.title}](${recent.link})` : recent.title;
    return `${title}（${recent.source || "Google News"}，${dateLabel(new Date(recent.pubDate))}）`;
  } catch {
    return "无进展";
  }
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
  const favorites = await readFavorites(env);
  const rewardsPayload = await fetchJson(fetcher, REWARDS_URL);
  const currentMarkets = Array.isArray(rewardsPayload) ? rewardsPayload : rewardsPayload.markets || [];
  const previousSnapshot = await readReportState(env);
  const priceRows = buildPriceRows({ currentMarkets, favorites, previousSnapshot });
  const progressRows = await Promise.all(
    favorites.map(async (favorite) => {
      const current = findCurrentMarket(favorite, currentMarkets);
      return {
        key: favorite.key,
        title: favorite.title || favorite.question || favorite.key,
        progress: await findProgress(current || favorite, fetcher, now),
      };
    }),
  );
  const markdown = buildReportMarkdown({
    dateLabel: dateLabel(now),
    priceRows,
    progressRows,
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

export async function handleRequest(request, env, deps = {}) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const fetcher = deps.fetch || fetch;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (url.pathname === "/health") {
    return json({ ok: true }, {}, origin);
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

  const authenticated = await isSiteAuthenticated(request, env, deps);

  if (url.pathname === "/api/site/status" && request.method === "GET") {
    return json({ authenticated }, {}, origin);
  }

  if (url.pathname === "/data/rewards.json" && request.method === "GET") {
    if (!authenticated) return json({ error: "auth_required" }, { status: 401 }, origin);
    return json(await fetchJson(fetcher, REWARDS_URL), {}, origin);
  }

  if (url.pathname.startsWith("/api/") && !authenticated && url.pathname !== "/api/report/send") {
    return json({ error: "auth_required" }, { status: 401 }, origin);
  }

  if (url.pathname === "/api/favorites" && request.method === "GET") {
    return json({ favorites: await readFavorites(env) }, {}, origin);
  }

  if (url.pathname === "/api/favorites" && request.method === "POST") {
    if (!writeAllowed(request, Boolean(env.SITE_PASSWORD) && authenticated)) return json({ error: "origin_not_allowed" }, { status: 403 }, origin);

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
    if (!writeAllowed(request, Boolean(env.SITE_PASSWORD) && authenticated)) return json({ error: "origin_not_allowed" }, { status: 403 }, origin);

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
    if (!writeAllowed(request, Boolean(env.SITE_PASSWORD) && authenticated)) return json({ error: "origin_not_allowed" }, { status: 403 }, origin);

    const key = decodeURIComponent(deleteMatch[1]);
    const favorites = await readFavorites(env);
    const next = favorites.filter((item) => item.key !== key);
    await writeFavorites(env, next);
    return json({ favorites: next }, {}, origin);
  }

  const walletDeleteMatch = url.pathname.match(/^\/api\/wallets\/([^/]+)$/);
  if (walletDeleteMatch && request.method === "DELETE") {
    if (!writeAllowed(request, Boolean(env.SITE_PASSWORD) && authenticated)) return json({ error: "origin_not_allowed" }, { status: 403 }, origin);

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
    if (!authenticated) return loginPage();
    return env.ASSETS.fetch(request);
  }

  return json({ error: "not_found" }, { status: 404 }, origin);
}

export default {
  fetch: handleRequest,
};
