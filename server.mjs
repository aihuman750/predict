import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 5173);
const upstream = "https://api.predalpha.xyz/api/markets/rewards";
const predictApi = "https://api.predict.fun/v1";

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

let cache = {
  at: 0,
  body: null,
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
  });
  res.end(body);
}

async function proxyRewards(res) {
  const now = Date.now();
  if (cache.body && now - cache.at < 15_000) {
    send(res, 200, cache.body, "application/json; charset=utf-8");
    return;
  }

  const headers = {
    accept: "application/json",
    "user-agent": "predict-rewards-monitor/1.0",
  };

  if (process.env.PREDALPHA_API_KEY) {
    headers["x-api-key"] = process.env.PREDALPHA_API_KEY;
  }

  try {
    const upstreamRes = await fetch(upstream, { headers });
    const body = await upstreamRes.text();
    if (!upstreamRes.ok) {
      send(res, upstreamRes.status, body || `Upstream HTTP ${upstreamRes.status}`);
      return;
    }

    cache = { at: now, body };
    send(res, 200, body, "application/json; charset=utf-8");
  } catch (error) {
    send(res, 502, JSON.stringify({ error: error.message }), "application/json; charset=utf-8");
  }
}

async function proxyOrderbook(marketId, res) {
  if (!process.env.PREDICT_API_KEY) {
    send(res, 500, JSON.stringify({ error: "predict_api_key_not_configured" }), "application/json; charset=utf-8");
    return;
  }

  try {
    const upstreamRes = await fetch(`${predictApi}/markets/${encodeURIComponent(marketId)}/orderbook`, {
      headers: {
        accept: "application/json",
        "x-api-key": process.env.PREDICT_API_KEY,
      },
    });
    const body = await upstreamRes.text();
    if (!upstreamRes.ok) {
      send(res, upstreamRes.status, body || `Upstream HTTP ${upstreamRes.status}`);
      return;
    }
    const payload = JSON.parse(body);
    send(res, 200, JSON.stringify({ orderbook: payload?.data || payload }), "application/json; charset=utf-8");
  } catch (error) {
    send(res, 502, JSON.stringify({ error: error.message }), "application/json; charset=utf-8");
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/") pathname = "/index.html";
  const normalized = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, normalized);

  if (!filePath.startsWith(publicDir)) {
    send(res, 403, "Forbidden");
    return;
  }

  try {
    const data = await readFile(filePath);
    send(res, 200, data, mime.get(extname(filePath)) || "application/octet-stream");
  } catch {
    send(res, 404, "Not found");
  }
}

createServer((req, res) => {
  if (req.url?.startsWith("/api/markets/rewards")) {
    proxyRewards(res);
    return;
  }

  const orderbookMatch = req.url?.match(/^\/api\/markets\/([^/?]+)\/orderbook(?:[?].*)?$/);
  if (orderbookMatch) {
    proxyOrderbook(decodeURIComponent(orderbookMatch[1]), res);
    return;
  }

  serveStatic(req, res);
}).listen(port, () => {
  console.log(`Predict rewards monitor running at http://localhost:${port}`);
});
