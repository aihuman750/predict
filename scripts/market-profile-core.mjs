import { buildPredictMarketUrl, favoriteKey, findMarketForFavorite } from "../public/rewards-core.mjs";

export const MARKET_PROFILE_OVERRIDES = {};

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function pickTitle(favorite, current, key) {
  return cleanText(favorite?.title || favorite?.question || current?.question || current?.title || key);
}

function overrideFor(profileOverrides, favorite, key) {
  if (!profileOverrides || typeof profileOverrides !== "object") return null;
  return profileOverrides[key] || profileOverrides[favorite?.categorySlug] || profileOverrides[favorite?.category] || null;
}

function projectNameFromFdvTitle(title) {
  const normalized = title.replace(/^will\s+/i, "").trim();
  const match = normalized.match(/^(.+?)\s+FDV\b/i);
  return cleanText(match?.[1]) || "该项目";
}

function sportsTeamsFromTitle(title) {
  const match = title.match(/^(.+?)\s+v(?:s\.?|\.?)\s+(.+?)$/i);
  if (!match) return null;
  return [cleanText(match[1]), cleanText(match[2])].filter(Boolean);
}

export function inferMarketBrief(title) {
  const normalized = cleanText(title);
  const lower = normalized.toLowerCase();
  const teams = sportsTeamsFromTitle(normalized);

  if (lower.includes("fdv") && lower.includes("after launch")) {
    const project = projectNameFromFdvTitle(normalized);
    return `该市场判断 ${project} 在正式 TGE/上线后约 24 小时的 FDV 是否高于标题中的门槛。关键影响因素包括官方 TGE 或上线时间、交易所上线安排、初始流通量、代币价格、估值披露、空投或解锁安排、延期或取消公告。`;
  }

  if (teams?.length === 2) {
    return `该市场与 ${teams[0]} 对 ${teams[1]} 的比赛结果或比赛相关事件有关。关键影响因素包括官方赛程确认、开赛时间、首发阵容、伤病、停赛、天气、场地、比赛延期或取消，以及临近开赛前的赔率和阵容变化。`;
  }

  if ((lower.includes("launch") && lower.includes("token")) || lower.includes("tge")) {
    return "该市场判断相关项目是否会在标题指定时间或条件内完成代币发布、TGE 或公开上线。关键影响因素包括官方公告、代币合约或申领页面、交易所上线、空投时间表、延期说明和团队对发布时间的更新。";
  }

  if (lower.includes("up or down")) {
    return "该市场判断标题指定资产在指定时间窗口内的价格方向。关键影响因素包括现货价格、主要交易所行情、宏观数据、突发公告、流动性冲击，以及结算窗口附近的短周期价格波动。";
  }

  if (/\babove\b|\bbelow\b|\bover\b|\bunder\b/i.test(normalized)) {
    return "该市场判断标题中的阈值条件是否会在结算规则指定的时间或事件窗口内成立。关键影响因素包括官方数据、项目公告、实时价格、赛程或时间变化、延期取消，以及任何会直接改变阈值达成概率的信息。";
  }

  return "该市场按标题所述事件或条件进行结算。关键影响因素包括官方公告、日程确认或变更、数据更新、延期或取消、参与方状态变化，以及任何会直接改变条件成立概率的信息。";
}

export function buildMarketProfile(favorite, currentMarkets = [], profileOverrides = MARKET_PROFILE_OVERRIDES) {
  const current = findMarketForFavorite(favorite, currentMarkets);
  const key = favorite?.key || favoriteKey(favorite) || favoriteKey(current);
  if (!key) return null;

  const title = pickTitle(favorite, current, key);
  const override = overrideFor(profileOverrides, favorite, key);
  const overrideObject = typeof override === "object" && override ? override : null;
  const brief = cleanText(overrideObject?.brief || (typeof override === "string" ? override : "") || inferMarketBrief(title));

  return {
    key,
    title: cleanText(overrideObject?.title || title),
    brief,
    url: favorite?.url || buildPredictMarketUrl(current || favorite),
    expiresAtSec: current?.expiresAtSec ?? favorite?.expiresAtSec ?? null,
    yesBid: current?.yesBid ?? favorite?.yesBid ?? null,
    noBid: current?.noBid ?? favorite?.noBid ?? null,
  };
}

export function buildMarketProfiles({ favorites, currentMarkets = [], profileOverrides = MARKET_PROFILE_OVERRIDES }) {
  return (Array.isArray(favorites) ? favorites : [])
    .map((favorite) => buildMarketProfile(favorite, currentMarkets, profileOverrides))
    .filter(Boolean);
}
