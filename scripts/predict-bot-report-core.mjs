const DEFAULT_WINDOW_HOURS = 1;
const WEI_DECIMALS = 18;

function toDateMs(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid_date:${value}`);
  return ms;
}

export function previousCompletedHourWindow(now = new Date()) {
  const end = new Date(toDateMs(now));
  end.setUTCMinutes(0, 0, 0);
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  return {
    windowEnd: end.toISOString(),
    windowStart: start.toISOString(),
  };
}

function parseJsonObjects(text = "") {
  const objects = [];
  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) startIndex = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        try {
          objects.push(JSON.parse(text.slice(startIndex, index + 1)));
        } catch {
          // Ignore partial log records.
        }
        startIndex = -1;
      }
    }
  }

  return objects;
}

function parseJsonLines(text = "") {
  return text
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function inWindow(row, startMs, endMs) {
  const ms = Date.parse(row?.now);
  return Number.isFinite(ms) && ms >= startMs && ms <= endMs;
}

export function summarizeBotLogs({
  botLogText = "",
  errLogText = "",
  now = new Date(),
  windowEnd = null,
  windowHours = DEFAULT_WINDOW_HOURS,
  windowStart = null,
} = {}) {
  const endMs = windowEnd ? toDateMs(windowEnd) : toDateMs(now);
  const startMs = windowStart ? toDateMs(windowStart) : endMs - windowHours * 60 * 60 * 1000;
  const effectiveWindowHours = (endMs - startMs) / (60 * 60 * 1000);
  const runs = parseJsonObjects(botLogText).filter((row) => inWindow(row, startMs, endMs));
  const errors = parseJsonLines(errLogText).filter((row) => inWindow(row, startMs, endMs));
  const actionCounts = {};
  const marketCatalog = {};
  const marketAssets = {};
  const marketsByInterval = {};
  let actionCount = 0;

  for (const run of runs) {
    for (const market of Array.isArray(run.markets) ? run.markets : []) {
      increment(marketAssets, market.asset || "unknown");
      const marketId = market.marketId;
      if (marketId == null) continue;
      const interval = market.interval || "unknown";
      marketCatalog[marketId] = {
        asset: market.asset || "unknown",
        endsAt: market.endsAt || null,
        interval,
        marketId,
        startsAt: market.startsAt || null,
        title: market.title || "",
      };
      marketsByInterval[interval] ??= [];
      if (!marketsByInterval[interval].includes(marketId)) {
        marketsByInterval[interval].push(marketId);
      }
    }
    for (const action of Array.isArray(run.actions) ? run.actions : []) {
      actionCount += 1;
      const keyParts = [action.type || "unknown", action.asset || "unknown"];
      if (action.interval) keyParts.push(action.interval);
      increment(actionCounts, keyParts.join("|"));
    }
  }

  const errorsByType = {};
  for (const error of errors) {
    increment(errorsByType, error.error || "unknown");
  }

  return {
    actionCount,
    actionCounts,
    errorCount: errors.length,
    errorsByType,
    firstRun: runs[0]?.now || null,
    lastRun: runs.at(-1)?.now || null,
    marketCatalog,
    marketAssets,
    marketsByInterval,
    runCount: runs.length,
    windowEnd: new Date(endMs).toISOString(),
    windowHours: effectiveWindowHours,
    windowStart: new Date(startMs).toISOString(),
  };
}

function decimalFromWeiString(raw) {
  const padded = raw.padStart(WEI_DECIMALS + 1, "0");
  const whole = padded.slice(0, -WEI_DECIMALS) || "0";
  const fraction = padded.slice(-WEI_DECIMALS).replace(/0+$/g, "");
  return Number(fraction ? `${whole}.${fraction}` : whole);
}

function parseShareAmount(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw) && raw.length >= WEI_DECIMALS - 1) {
    const parsedWei = decimalFromWeiString(raw);
    return Number.isFinite(parsedWei) ? parsedWei : 0;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function orderSide(order) {
  const side = Number(order?.order?.side ?? order?.side);
  if (side === 0 || side === 1) return side;
  return null;
}

function orderShares(order, side) {
  if (order?.amount != null) return parseShareAmount(order.amount);
  if (side === 0) return parseShareAmount(order?.order?.takerAmount);
  if (side === 1) return parseShareAmount(order?.order?.makerAmount);
  return 0;
}

function orderPrice(order, side) {
  const makerAmount = parseShareAmount(order?.order?.makerAmount);
  const takerAmount = parseShareAmount(order?.order?.takerAmount);
  if (makerAmount <= 0 || takerAmount <= 0) return 0;
  const price = side === 1 ? takerAmount / makerAmount : makerAmount / takerAmount;
  return Number(price.toFixed(6));
}

function emptyOrderMetrics() {
  return {
    buyOrders: 0,
    buyValue: 0,
    count: 0,
    sellOrders: 0,
    sellValue: 0,
    shares: 0,
    value: 0,
  };
}

function emptyIntervalActivity() {
  return {
    filledOrders: emptyOrderMetrics(),
    marketCount: 0,
    openOrders: emptyOrderMetrics(),
    positionCount: 0,
    positionShares: 0,
  };
}

function intervalForMarket(marketCatalog, marketId) {
  return marketCatalog[String(marketId)]?.interval
    ?? marketCatalog[marketId]?.interval
    ?? null;
}

function addOrderMetric(metrics, order) {
  const side = orderSide(order);
  const shares = orderShares(order, side);
  const price = orderPrice(order, side);
  metrics.count += 1;
  metrics.shares += shares;
  metrics.value += shares * price;
  if (side === 0) {
    metrics.buyOrders += 1;
    metrics.buyValue += shares * price;
  }
  if (side === 1) {
    metrics.sellOrders += 1;
    metrics.sellValue += shares * price;
  }
}

function roundMetrics(metrics) {
  metrics.buyValue = Number(metrics.buyValue.toFixed(6));
  metrics.sellValue = Number(metrics.sellValue.toFixed(6));
  metrics.shares = Number(metrics.shares.toFixed(6));
  metrics.value = Number(metrics.value.toFixed(6));
  return metrics;
}

export function summarizeAccountActivity({
  filledOrders = [],
  marketCatalog = {},
  openOrders = [],
  positions = [],
} = {}) {
  const byInterval = {};

  for (const market of Object.values(marketCatalog)) {
    const interval = market.interval || "unknown";
    byInterval[interval] ??= emptyIntervalActivity();
    byInterval[interval].marketCount += 1;
  }

  for (const order of openOrders) {
    const interval = intervalForMarket(marketCatalog, order?.marketId);
    if (!interval) continue;
    byInterval[interval] ??= emptyIntervalActivity();
    addOrderMetric(byInterval[interval].openOrders, order);
  }

  for (const order of filledOrders) {
    const interval = intervalForMarket(marketCatalog, order?.marketId);
    if (!interval) continue;
    byInterval[interval] ??= emptyIntervalActivity();
    addOrderMetric(byInterval[interval].filledOrders, order);
  }

  for (const position of positions) {
    const marketId = position?.market?.id ?? position?.marketId;
    const interval = intervalForMarket(marketCatalog, marketId);
    if (!interval) continue;
    byInterval[interval] ??= emptyIntervalActivity();
    byInterval[interval].positionCount += 1;
    byInterval[interval].positionShares += parseShareAmount(position?.amount ?? position?.shares);
  }

  for (const activity of Object.values(byInterval)) {
    roundMetrics(activity.openOrders);
    roundMetrics(activity.filledOrders);
    activity.positionShares = Number(activity.positionShares.toFixed(6));
  }

  return { byInterval };
}

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection === "object") return Object.values(collection);
  return [];
}

export function summarizeCompletedBuyPlacements(state = {}, marketCatalog = {}) {
  const markets = state.markets && typeof state.markets === "object" ? state.markets : {};
  const byInterval = {};

  for (const [marketId, market] of Object.entries(markets)) {
    const interval = intervalForMarket(marketCatalog, marketId);
    if (!interval) continue;
    const buyOrders = values(market.buyOrders).filter((order) => order?.id || order?.hash);
    if (buyOrders.length === 0) continue;
    byInterval[interval] = (byInterval[interval] || 0) + buyOrders.length;
  }

  return byInterval;
}

export function summarizeBotState(state = {}, marketCatalog = {}) {
  const markets = state.markets && typeof state.markets === "object" ? state.markets : {};
  const buyOrdersByStatus = {};
  const sellOrdersByStatus = {};
  let positionCount = 0;
  let unsoldShares = 0;

  for (const market of Object.values(markets)) {
    for (const order of values(market.buyOrders)) {
      increment(buyOrdersByStatus, order.status || "unknown");
    }
    for (const order of values(market.sellOrders)) {
      increment(sellOrdersByStatus, order.status || "unknown");
    }
    for (const position of values(market.positions)) {
      const shares = Number(position.shares || 0);
      const soldShares = Number(position.soldShares || 0);
      if (shares > 0 || soldShares > 0) positionCount += 1;
      unsoldShares += Math.max(0, shares - soldShares);
    }
  }

  return {
    buyOrdersByStatus,
    completedBuyPlacementsByInterval: summarizeCompletedBuyPlacements(state, marketCatalog),
    marketCount: Object.keys(markets).length,
    positionCount,
    sellOrdersByStatus,
    stateUpdatedAt: state.updatedAt || null,
    unsoldShares,
  };
}

function simplifiedIntervalLine({ activity = {}, interval, label, stateSummary = {} }) {
  const row = activity.byInterval?.[interval] ?? emptyIntervalActivity();
  const filledOrders = row.filledOrders ?? emptyOrderMetrics();
  const buyValue = Number(filledOrders.buyValue ?? 0);
  const sellValue = Number(filledOrders.sellValue ?? 0);
  const pnl = sellValue - buyValue;
  return [
    `## ${label}`,
    "",
    `买入挂单: ${stateSummary.completedBuyPlacementsByInterval?.[interval] ?? 0} 次`,
    `买入成交: ${filledOrders.buyOrders ?? 0} 次`,
    `卖出成交: ${filledOrders.sellOrders ?? 0} 次`,
    `盈亏: ${pnl.toFixed(4)} USDT`,
    "",
  ];
}

function formatWalletBalance(accountSummary = {}) {
  const balances = [];
  if (accountSummary.usdt != null) balances.push(`${accountSummary.usdt} USDT`);
  if (accountSummary.bnb != null) balances.push(`${accountSummary.bnb} BNB`);
  return balances.length > 0 ? balances.join("，") : "读取失败";
}

export function renderBotReportMarkdown({
  accountSummary = {},
  generatedAt = new Date().toISOString(),
  logSummary,
  stateSummary,
} = {}) {
  return [
    "# Predict Bot 运行报告",
    "",
    `生成时间: ${generatedAt}`,
    `统计窗口: ${logSummary.windowStart} 至 ${logSummary.windowEnd}`,
    `钱包余额: ${formatWalletBalance(accountSummary)}`,
    "",
    ...simplifiedIntervalLine({
      activity: accountSummary.activity,
      interval: "1h",
      label: "1小时市场",
      stateSummary,
    }),
    ...simplifiedIntervalLine({
      activity: accountSummary.activity,
      interval: "15m",
      label: "15分钟市场",
      stateSummary,
    }),
  ].join("\n");
}
