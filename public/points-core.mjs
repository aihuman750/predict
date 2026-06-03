const POINTS_WEEK_OFFSET_HOURS = 8;
const POINTS_BASE_WEEK_NUMBER = 23;
const POINTS_BASE_WEEK_LOCAL_START_MS = Date.UTC(2026, 4, 21);
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function weiToNumber(value, decimals = 18) {
  if (value == null || value === "") return 0;
  const raw = BigInt(String(value));
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  return Number(whole) + Number(fraction) / Number(scale);
}

export function normalizePointsAccount(edge) {
  const node = edge?.node || edge || {};
  const account = node.account || {};
  const statistics = account.statistics || {};

  return {
    address: String(account.address || ""),
    allTimeRank: numberOrNull(node.rank) ?? 0,
    lastWeekPoints: numberOrNull(node.allocationRoundPoints) ?? 0,
    marketsCount: numberOrNull(statistics.marketsCount) ?? 0,
    name: account.name || "未命名账号",
    pnlUsd: numberOrNull(statistics.pnlUsd) ?? 0,
    positionCount: numberOrNull(account.positions?.totalCount) ?? 0,
    positionsValueUsd: numberOrNull(statistics.positionsValueUsd) ?? 0,
    rank: numberOrNull(node.rank) ?? 0,
    totalPoints: numberOrNull(node.totalPoints) ?? 0,
    volumeUsd: numberOrNull(statistics.volumeUsd) ?? 0,
  };
}

export function normalizePointsPosition(node) {
  const position = node?.node || node || {};
  const market = position.market || {};
  const outcome = position.outcome || {};

  return {
    averageBuyPriceUsd: numberOrNull(position.averageBuyPriceUsd) ?? 0,
    marketId: String(market.id || ""),
    marketQuestion: market.question || market.title || "",
    marketTitle: market.title || market.question || "",
    openSellShares: weiToNumber(position.openSellOrdersShareCount || "0"),
    outcomeId: String(outcome.id || ""),
    outcomeName: outcome.name || "",
    outcomeOnChainId: String(outcome.onChainId || ""),
    pnlUsd: numberOrNull(position.pnlUsd) ?? 0,
    shares: weiToNumber(position.shares || "0"),
    valueUsd: numberOrNull(position.valueUsd) ?? 0,
  };
}

function shiftedDate(date) {
  return new Date(date.getTime() + POINTS_WEEK_OFFSET_HOURS * 60 * 60 * 1000);
}

function unshiftedDate(date) {
  return new Date(date.getTime() - POINTS_WEEK_OFFSET_HOURS * 60 * 60 * 1000);
}

function startOfLocalDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatLocalDate(date) {
  const local = shiftedDate(date);
  const yyyy = local.getUTCFullYear();
  const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(local.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function pointsWeekWindows(now = new Date()) {
  const localNow = shiftedDate(now);
  const localDayStart = startOfLocalDay(localNow);
  const currentWeekOffset = Math.floor((localDayStart.getTime() - POINTS_BASE_WEEK_LOCAL_START_MS) / WEEK_MS);
  const currentWeekNumber = POINTS_BASE_WEEK_NUMBER + currentWeekOffset;
  const currentWeekLocalStart = new Date(POINTS_BASE_WEEK_LOCAL_START_MS + currentWeekOffset * WEEK_MS);
  const previousWeekLocalStart = new Date(currentWeekLocalStart.getTime() - WEEK_MS);

  function buildWindow(weekNumber, localStart) {
    const from = unshiftedDate(localStart);
    const to = new Date(from.getTime() + WEEK_MS);
    const dateLabel = `${formatLocalDate(from)} - ${formatLocalDate(new Date(to.getTime() - DAY_MS))}`;
    return {
      dateLabel,
      from: from.toISOString(),
      label: `第${weekNumber}周 · ${dateLabel}`,
      to: to.toISOString(),
      weekNumber,
    };
  }

  return {
    lastWeek: buildWindow(currentWeekNumber - 1, previousWeekLocalStart),
    thisWeek: buildWindow(currentWeekNumber, currentWeekLocalStart),
  };
}

export function groupTradesByMarket(trades = []) {
  const groups = new Map();

  for (const trade of Array.isArray(trades) ? trades : []) {
    const marketId = String(trade.marketId || "");
    const key = marketId || trade.marketTitle || "unknown";
    const group = groups.get(key) || {
      estimatedNotionalUsd: 0,
      marketId,
      marketTitle: trade.marketTitle || trade.marketQuestion || "未知事件",
      outcomes: [],
      tradeCount: 0,
      transactionCount: 0,
      transactions: new Set(),
    };
    group.tradeCount += 1;
    group.estimatedNotionalUsd += Number(trade.estimatedNotionalUsd || 0);
    if (trade.transactionHash) group.transactions.add(trade.transactionHash);

    const outcomeName = trade.outcomeName || "未知选项";
    let outcome = group.outcomes.find((item) => item.name === outcomeName);
    if (!outcome) {
      outcome = {
        buyNotionalUsd: 0,
        name: outcomeName,
        sellNotionalUsd: 0,
        tradeCount: 0,
      };
      group.outcomes.push(outcome);
    }
    outcome.tradeCount += 1;
    if (trade.sideEstimate === "SELL_SHARES_EST") {
      outcome.sellNotionalUsd += Number(trade.estimatedNotionalUsd || 0);
    } else if (trade.sideEstimate === "BUY_SHARES_EST") {
      outcome.buyNotionalUsd += Number(trade.estimatedNotionalUsd || 0);
    }

    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      transactionCount: group.transactions.size,
      transactions: undefined,
    }))
    .sort((a, b) => b.estimatedNotionalUsd - a.estimatedNotionalUsd || b.tradeCount - a.tradeCount);
}

function median(values) {
  const numbers = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function mainContractName(trades) {
  const counts = new Map();
  for (const trade of trades) {
    const name = trade.contractName || "UNKNOWN";
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "UNKNOWN";
}

export function buildPointsStrategySummary(trades = []) {
  const rows = Array.isArray(trades) ? trades : [];
  if (!rows.length) return "暂无可用成交记录，无法稳定判断该账号本轮交易策略。";

  const txCount = new Set(rows.map((trade) => trade.transactionHash).filter(Boolean)).size;
  const buyNotional = rows
    .filter((trade) => trade.sideEstimate === "BUY_SHARES_EST")
    .reduce((sum, trade) => sum + Number(trade.estimatedNotionalUsd || 0), 0);
  const sellNotional = rows
    .filter((trade) => trade.sideEstimate === "SELL_SHARES_EST")
    .reduce((sum, trade) => sum + Number(trade.estimatedNotionalUsd || 0), 0);
  const totalNotional = buyNotional + sellNotional;
  const net = buyNotional - sellNotional;
  const skew = totalNotional > 0 ? net / totalNotional : 0;
  const direction = Math.abs(skew) < 0.12
    ? "买卖接近均衡"
    : skew > 0
      ? "净买入偏多"
      : "净卖出偏多";
  const markets = groupTradesByMarket(rows);
  const topShare = markets[0]?.estimatedNotionalUsd && totalNotional
    ? markets[0].estimatedNotionalUsd / totalNotional
    : 0;
  const concentration = markets.length <= 3 || topShare >= 0.55 ? "集中在少数事件" : "分散在多个事件";
  const price = median(rows.map((trade) => trade.estimatedPrice).filter((value) => value != null));
  const contract = mainContractName(rows);

  return `${rows.length.toLocaleString("en-US")} 笔成交，${txCount.toLocaleString("en-US")} 个交易，${direction}；主要通过 ${contract}，价格中位数 ${price == null ? "-" : price.toFixed(3)}，成交${concentration}。`;
}
