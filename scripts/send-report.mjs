import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildPriceRows,
  buildReportMarkdown,
  findCurrentMarket,
  snapshotMarkets,
} from "./report-core.mjs";

const DEFAULT_FAVORITES_API_BASE = "https://predict-favorites.aihuman750.workers.dev";
const REWARDS_URL = "https://api.predalpha.xyz/api/markets/rewards";
const STATE_PATH = path.join(process.cwd(), "reports", "price-state.json");
const RECENT_PROGRESS_MS = 48 * 60 * 60 * 1000;
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

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function dateLabel(date = new Date()) {
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
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
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

async function findProgress(favorite) {
  const query = `${favorite.question || favorite.title || favorite.categorySlug || ""} latest`;
  if (!query.trim()) return "无进展";

  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const response = await fetch(url, { headers: { "user-agent": "predict-report/1.0" } });
    if (!response.ok) return "无进展";
    const items = parseNewsItems(await response.text());
    const recent = items.find((item) => {
      const publishedAt = Date.parse(item.pubDate);
      return (
        Number.isFinite(publishedAt) &&
        Date.now() - publishedAt <= RECENT_PROGRESS_MS &&
        hasEnoughOverlap(favorite, item.title)
      );
    });
    if (!recent) return "无进展";

    const published = dateLabel(new Date(recent.pubDate));
    const title = recent.link ? `[${recent.title}](${recent.link})` : recent.title;
    return `${title}（${recent.source || "Google News"}，${published}）`;
  } catch {
    return "无进展";
  }
}

function signFeishu(secret, timestamp) {
  return crypto.createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

async function sendFeishu(markdown) {
  if (process.env.DRY_RUN === "1") {
    console.log(markdown);
    return;
  }

  const webhook = process.env.FEISHU_WEBHOOK;
  const secret = process.env.FEISHU_SECRET;
  if (!webhook || !secret) throw new Error("FEISHU_WEBHOOK and FEISHU_SECRET are required.");

  const timestamp = String(Math.floor(Date.now() / 1000));
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
    sign: signFeishu(secret, timestamp),
    timestamp,
  };

  const response = await fetch(webhook, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) throw new Error(`Feishu webhook returned HTTP ${response.status}`);
  const result = await response.json().catch(() => ({}));
  if (result.code && result.code !== 0) throw new Error(`Feishu webhook failed: ${result.msg || result.code}`);
}

async function main() {
  const favoritesApiBase = process.env.FAVORITES_API_BASE || DEFAULT_FAVORITES_API_BASE;
  const favoritesPayload = await fetchJson(`${favoritesApiBase}/api/favorites`);
  const favorites = Array.isArray(favoritesPayload.favorites) ? favoritesPayload.favorites : [];
  const rewardsPayload = await fetchJson(REWARDS_URL);
  const currentMarkets = Array.isArray(rewardsPayload) ? rewardsPayload : rewardsPayload.markets || [];
  const previousSnapshot = await readJson(STATE_PATH, { markets: {} });

  const priceRows = buildPriceRows({ currentMarkets, favorites, previousSnapshot });
  const progressRows = await Promise.all(
    favorites.map(async (favorite) => {
      const current = findCurrentMarket(favorite, currentMarkets);
      return {
        key: favorite.key,
        title: favorite.title || favorite.question || favorite.key,
        progress: await findProgress(current || favorite),
      };
    }),
  );
  const markdown = buildReportMarkdown({
    dateLabel: dateLabel(),
    priceRows,
    progressRows,
  });

  await sendFeishu(markdown);
  await writeJson(STATE_PATH, snapshotMarkets({ currentMarkets, favorites }));
}

await main();
