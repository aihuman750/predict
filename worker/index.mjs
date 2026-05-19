const FAVORITES_KEY = "favorites:v1";
const ALLOWED_ORIGINS = new Set([
  "https://aihuman750.github.io",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:4173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:4173",
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
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-origin": allowOrigin,
    "cache-control": "no-store",
  };
}

function writeAllowed(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === "null" || ALLOWED_ORIGINS.has(origin);
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

export async function handleRequest(request, env) {
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

  const deleteMatch = url.pathname.match(/^\/api\/favorites\/([^/]+)$/);
  if (deleteMatch && request.method === "DELETE") {
    if (!writeAllowed(request)) return json({ error: "origin_not_allowed" }, { status: 403 }, origin);

    const key = decodeURIComponent(deleteMatch[1]);
    const favorites = await readFavorites(env);
    const next = favorites.filter((item) => item.key !== key);
    await writeFavorites(env, next);
    return json({ favorites: next }, {}, origin);
  }

  return json({ error: "not_found" }, { status: 404 }, origin);
}

export default {
  fetch: handleRequest,
};
