import {
  buildPriceRows,
  buildReportMarkdown,
  findCurrentMarket,
  snapshotMarkets,
} from "../scripts/report-core.mjs";
import {
  mergeFavoriteMarkets,
  normalizeWalletAddress,
  positionToFavoriteMarket,
  summarizePosition,
} from "../public/wallet-core.mjs";

const FAVORITES_KEY = "favorites:v1";
const REPORT_STATE_KEY = "report:price-state:v1";
const WALLETS_KEY = "wallets:v1";
const REWARDS_URL = "https://api.predalpha.xyz/api/markets/rewards";
const PREDICT_POSITIONS_URL = "https://api.predict.fun/v1/positions";
const RECENT_PROGRESS_MS = 48 * 60 * 60 * 1000;
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

function writeAllowed(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === "null" || ALLOWED_ORIGINS.has(origin);
}

function reportAllowed(request, env) {
  const token = env.REPORT_TOKEN;
  if (token && request.headers.get("x-report-token") === token) return true;
  const origin = request.headers.get("origin");
  return Boolean(origin && (origin === "null" || ALLOWED_ORIGINS.has(origin)));
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

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (url.pathname === "/health") {
    return json({ ok: true }, {}, origin);
  }

  if (url.pathname === "/api/favorites" && request.method === "GET") {
    return json({ favorites: await readFavorites(env) }, {}, origin);
  }

  if (url.pathname === "/api/favorites" && request.method === "POST") {
    if (!writeAllowed(request)) return json({ error: "origin_not_allowed" }, { status: 403 }, origin);

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
    if (!writeAllowed(request)) return json({ error: "origin_not_allowed" }, { status: 403 }, origin);

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

  const deleteMatch = url.pathname.match(/^\/api\/favorites\/([^/]+)$/);
  if (deleteMatch && request.method === "DELETE") {
    if (!writeAllowed(request)) return json({ error: "origin_not_allowed" }, { status: 403 }, origin);

    const key = decodeURIComponent(deleteMatch[1]);
    const favorites = await readFavorites(env);
    const next = favorites.filter((item) => item.key !== key);
    await writeFavorites(env, next);
    return json({ favorites: next }, {}, origin);
  }

  const walletDeleteMatch = url.pathname.match(/^\/api\/wallets\/([^/]+)$/);
  if (walletDeleteMatch && request.method === "DELETE") {
    if (!writeAllowed(request)) return json({ error: "origin_not_allowed" }, { status: 403 }, origin);

    const address = normalizeWalletAddress(decodeURIComponent(walletDeleteMatch[1]));
    if (!address) return json({ error: "invalid_wallet_address" }, { status: 400 }, origin);

    const wallets = await readWallets(env);
    const next = wallets.filter((item) => item !== address);
    await writeWallets(env, next);
    return json({ wallets: next }, {}, origin);
  }

  if (url.pathname === "/api/report/send" && request.method === "POST") {
    if (!reportAllowed(request, env)) return json({ error: "origin_not_allowed" }, { status: 403 }, origin);

    try {
      return json(await sendLatestReport(env, deps), {}, origin);
    } catch (error) {
      console.error(error);
      return json({ error: "report_failed" }, { status: 500 }, origin);
    }
  }

  return json({ error: "not_found" }, { status: 404 }, origin);
}

export default {
  fetch: handleRequest,
};
