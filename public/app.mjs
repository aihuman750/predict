import {
  buildDuplicateCategorySet,
  buildMarketTitle,
  buildPredictMarketUrl,
  competitionTier,
  favoriteKey,
  findMarketForFavorite,
  filterAndSortMarkets,
  summarizeMarkets,
  toFavoriteMarket,
} from "./rewards-core.mjs";
import { buildActivateOrderbook } from "./orderbook-core.mjs";
import { normalizeWalletAddress } from "./wallet-core.mjs";

const tierColors = ["#22C55E", "#84CC16", "#EAB308", "#F97316", "#F87171", "#B91C1C"];
const expireOptions = [
  { hrs: null, label: "全部" },
  { hrs: 4, label: "4h" },
  { hrs: 12, label: "12h" },
  { hrs: 24, label: "1d" },
  { hrs: 168, label: "1w" },
  { hrs: 720, label: "1m" },
  { hrs: 2160, label: "3m" },
];
const WORKER_ORIGIN = "https://predict-favorites.aihuman750.workers.dev";
const FAVORITES_API_BASE = window.PREDICT_FAVORITES_API || (window.location.origin === WORKER_ORIGIN ? "" : WORKER_ORIGIN);

const views = new Set(["markets", "favorites", "wallets", "points", "backtest"]);
const viewMeta = {
  markets: {
    label: "积分市场",
    subtitle: "按当前盘口做市得分排序的活跃积分市场。",
    title: "积分市场",
  },
  favorites: {
    label: "收藏列表",
    subtitle: "集中查看已收藏市场，并手动推送最新收藏市场报告。",
    title: "收藏列表",
  },
  wallets: {
    label: "钱包监控",
    subtitle: "监控 Predict 钱包持仓，并自动收藏持仓相关市场。",
    title: "钱包监控",
  },
  points: {
    label: "积分监控",
    subtitle: "跟踪上周积分榜前 200 名账号、持仓、成交明细和策略特征。",
    title: "积分监控",
  },
  backtest: {
    label: "策略回测",
    subtitle: "基于真实历史成交，按日期、单个市场周期和买入截止时间聚合策略收益矩阵。",
    title: "策略回测",
  },
};

const state = {
  dense: localStorage.getItem("predict_alpha_dense") === "1",
  error: false,
  favoriteError: false,
  favoriteKeys: new Set(),
  favoriteMarkets: [],
  favoritePending: new Set(),
  loaded: false,
  markets: [],
  maxExpireHrs: readExpireSetting(),
  expandedMarketId: null,
  orderbooks: new Map(),
  query: "",
  reportError: false,
  reportMessage: "",
  reportSending: false,
  sortDir: "desc",
  sortKey: "hourlyRate",
  view: readView(),
  walletError: "",
  walletInput: "",
  walletLoading: false,
  walletMessage: "",
  walletSummary: { favoritesAdded: 0, wallets: [] },
  ownOrders: [],
  ownOrdersAuth: { accountAddress: null, hasToken: false, signer: null },
  ownOrdersError: "",
  ownOrdersLoading: false,
  ownOrdersMessage: "",
  points: {
    accounts: [],
    detail: null,
    detailError: "",
    detailLoading: false,
    error: "",
    fetchedAt: "",
    loading: false,
    selectedAddress: readPointsAddress(),
    stale: false,
    windows: null,
  },
  backtest: {
    cutoffMinutes: 10,
    endIndex: 0,
    error: "",
    heatmap: null,
    interval: "5m",
    loading: false,
    meta: null,
    startIndex: 0,
  },
};

const ORDERBOOK_PREFETCH_DELAY_MS = 325;
let orderbookQueue = [];
let orderbookQueueRunning = false;
let orderbookQueueToken = 0;
let backtestLoadTimer = 0;

function readView() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash.startsWith("points/")) return "points";
  return views.has(hash) ? hash : "markets";
}

function readPointsAddress() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const match = hash.match(/^points\/([^/]+)$/);
  return match ? normalizeWalletAddress(decodeURIComponent(match[1])) || "" : "";
}

function readExpireSetting() {
  const value = localStorage.getItem("predict_alpha_max_expire_hrs");
  if (value == null || value === "all") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function setAccent(name) {
  const accents = {
    cyan: ["#22D3EE", "rgba(34, 211, 238, .12)", "rgba(34, 211, 238, .35)"],
    lime: ["#D7FF3B", "rgba(215, 255, 59, .12)", "rgba(215, 255, 59, .35)"],
    orange: ["#FB923C", "rgba(251, 146, 60, .12)", "rgba(251, 146, 60, .35)"],
    violet: ["#A78BFA", "rgba(167, 139, 250, .14)", "rgba(167, 139, 250, .4)"],
  };
  const [color, soft, line] = accents[name] || accents.violet;
  document.documentElement.style.setProperty("--accent", color);
  document.documentElement.style.setProperty("--accent-soft", soft);
  document.documentElement.style.setProperty("--accent-line", line);
  localStorage.setItem("predict_alpha_accent", name);
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme || "dark";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("predict_alpha_theme", next);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value, digits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return number.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function formatCents(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '<span class="muted">-</span>';
  return `${(number * 100).toFixed(digits).replace(/\.0$/, "")}<span class="muted">¢</span>`;
}

function formatQuantity(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return number.toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });
}

function formatDate(sec) {
  if (!sec) return "-";
  const date = new Date(sec * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function hoursLeft(market) {
  if (market.expiresAtSec != null) {
    return Math.max(0, (market.expiresAtSec - Math.floor(Date.now() / 1000)) / 3600);
  }
  return Number(market.remainHrs ?? 0);
}

function marketId(market) {
  return market?.id != null ? String(market.id) : "";
}

function findMarketById(id) {
  const value = String(id || "");
  return state.markets.find((market) => marketId(market) === value) || null;
}

function orderbookEntry(market) {
  const id = marketId(market);
  return id ? state.orderbooks.get(id) || null : null;
}

function sortArrow(key) {
  if (state.sortKey !== key) return "";
  return state.sortDir === "desc" ? "↓" : "↑";
}

function statHtml(label, value, sub, extraClass = "") {
  return `
    <div class="stat">
      <div class="stat-label">${label}</div>
      <div class="stat-value ${extraClass}">${value}</div>
      ${sub ? `<div class="stat-delta muted">${sub}</div>` : ""}
    </div>
  `;
}

function competitionBars(score) {
  const tier = competitionTier(score);
  const color = tierColors[tier - 1];
  const title = Number.isFinite(Number(score))
    ? `score ${Math.round(score).toLocaleString("en-US")} · tier ${tier}/6`
    : "no data";

  return `
    <div class="bars" title="${escapeHtml(title)}">
      ${Array.from({ length: 6 }, (_, index) => {
        const active = index < tier;
        return `<span style="background:${active ? color : "var(--hairline)"}"></span>`;
      }).join("")}
    </div>
  `;
}

function captureRenderState({ preserveFocus, preserveScroll }) {
  const active = document.activeElement;
  const tableScroll = document.querySelector(".table-scroll");

  return {
    activeId: preserveFocus && active?.id ? active.id : null,
    selectionEnd: preserveFocus && "selectionEnd" in active ? active.selectionEnd : null,
    selectionStart: preserveFocus && "selectionStart" in active ? active.selectionStart : null,
    tableLeft: preserveScroll ? tableScroll?.scrollLeft || 0 : 0,
    tableTop: preserveScroll ? tableScroll?.scrollTop || 0 : 0,
    windowX: preserveScroll ? window.scrollX : 0,
    windowY: preserveScroll ? window.scrollY : 0,
  };
}

function restoreRenderState(renderState) {
  if (renderState.tableTop || renderState.tableLeft) {
    const tableScroll = document.querySelector(".table-scroll");
    if (tableScroll) {
      tableScroll.scrollTop = renderState.tableTop;
      tableScroll.scrollLeft = renderState.tableLeft;
    }
  }

  if (renderState.windowX || renderState.windowY) {
    window.scrollTo(renderState.windowX, renderState.windowY);
  }

  if (!renderState.activeId) return;
  const active = document.getElementById(renderState.activeId);
  if (!active) return;
  active.focus({ preventScroll: true });
  if (
    renderState.selectionStart != null &&
    renderState.selectionEnd != null &&
    typeof active.setSelectionRange === "function"
  ) {
    active.setSelectionRange(renderState.selectionStart, renderState.selectionEnd);
  }
}

function renderHeader() {
  const walletLabel = state.ownOrdersAuth.accountAddress || state.ownOrdersAuth.signer
    ? shortAddress(state.ownOrdersAuth.accountAddress || state.ownOrdersAuth.signer)
    : "连接钱包";
  return `
    <header class="pa-header">
      <div class="pa-brand" aria-label="predict alpha">
        <span class="pa-brand-mark">α</span>
        <span class="pa-brand-name">predict <em>alpha</em></span>
      </div>
      <nav class="pa-nav">
        ${Object.entries(viewMeta)
          .map(
            ([view, meta]) => `
              <a class="pa-nav-item ${state.view === view ? "active" : ""}" href="#${view}" data-view="${view}">${meta.label}</a>
            `,
          )
          .join("")}
      </nav>
      <div class="pa-header-right">
        <div class="pa-status"><span class="dot"></span><span>实时</span><span id="clock">--</span></div>
        <div class="accent-picker" title="主色调">
          <button data-accent="violet" style="--swatch:#A78BFA" aria-label="Accent violet"></button>
          <button data-accent="lime" style="--swatch:#D7FF3B" aria-label="Accent lime"></button>
          <button data-accent="cyan" style="--swatch:#22D3EE" aria-label="Accent cyan"></button>
          <button data-accent="orange" style="--swatch:#FB923C" aria-label="Accent orange"></button>
        </div>
        <button class="pa-iconbtn lang-btn" title="语言">中</button>
        <button class="pa-iconbtn" id="themeBtn" title="切换主题">◐</button>
        <a class="btn btn-sm wallet-btn" href="#wallets">${escapeHtml(walletLabel)}</a>
      </div>
    </header>
  `;
}

function renderMarketsPage(rows, duplicateCategories) {
  const stats = summarizeMarkets(state.markets);
  const top10Share =
    state.loaded && stats.totalHourly > 0 ? `${(stats.top10Hourly / stats.totalHourly * 100).toFixed(0)}<span>%</span>` : "-";

  return `
    <section class="pa-card stat-card">
      <div class="stat-row">
        ${statHtml("积分市场数", state.loaded ? formatNumber(stats.activeCount) : "-", "当前处于积分窗口")}
        ${statHtml("总 pts/小时", state.loaded ? formatNumber(stats.totalHourly) : "-", "")}
        ${statHtml("低竞争市场", state.loaded ? formatNumber(stats.lowCompetition) : "-", "竞争程度 1-2 档", "accent")}
        ${statHtml("Top-10 占比", top10Share, "占总 pts/h")}
      </div>
    </section>

    <section class="pa-card table-card">
      <div class="pa-card-head">
        <div class="table-title-wrap">
          <div class="pa-card-title">积分市场</div>
          <div class="pill mono">${rows.length} 行</div>
          <div class="pill mono ${state.favoriteError ? "sync-pill" : ""}">${state.favoriteError ? "收藏同步离线" : `收藏 ${state.favoriteKeys.size}`}</div>
        </div>
        <div class="controls">
          <input class="inp" id="searchInput" type="search" placeholder="搜索市场..." value="${escapeHtml(state.query)}" />
          <div class="filter-group" title="只保留奖励窗口在此时段内结束的市场">
            <span>到期窗口</span>
            <div class="seg">
              ${expireOptions
                .map(
                  (option) => `
                    <button class="seg-item ${state.maxExpireHrs === option.hrs ? "active" : ""}" data-expire="${option.hrs ?? "all"}">
                      ${option.label}
                    </button>
                  `,
                )
                .join("")}
            </div>
          </div>
          <div class="seg">
            <button class="seg-item ${state.dense ? "" : "active"}" data-density="std">标准</button>
            <button class="seg-item ${state.dense ? "active" : ""}" data-density="dense">紧凑</button>
          </div>
        </div>
      </div>
      <div class="table-scroll">
        <table class="pa-table ${state.dense ? "dense" : ""}">
          <thead>
            <tr>
              <th style="width:42px">收藏</th>
              <th style="width:32px">#</th>
              <th>市场</th>
              <th class="num sortable" style="width:104px" data-sort="totalLiq" title="上游 totalLiq 字段：当前市场总额">总交易额 ${sortArrow("totalLiq")}</th>
              <th class="num sortable" style="width:104px" data-sort="vol24" title="过去 24 小时交易额">24h交易额 ${sortArrow("vol24")}</th>
              <th class="num sortable" style="width:74px" data-sort="yesBid" title="YES 一边的最优买价（概率）">Yes ${sortArrow("yesBid")}</th>
              <th class="num sortable" style="width:74px" data-sort="noBid" title="NO 一边的最优买价（概率）">No ${sortArrow("noBid")}</th>
              <th class="num sortable" style="width:104px" data-sort="hourlyRate">积分/小时 ${sortArrow("hourlyRate")}</th>
              <th class="num sortable" style="width:88px" data-sort="spreadThreshold" title="积分门槛：报价价差需 <= 此值（单位：美分）">最大价差 ${sortArrow("spreadThreshold")}</th>
              <th class="num" style="width:104px" title="当前 Activate Points 范围内买盘和卖盘的数量合计">有效订单数</th>
              <th class="sortable" style="width:132px" data-sort="expiresAtSec">到期时间 ${sortArrow("expiresAtSec")}</th>
              <th class="num sortable" style="width:96px" data-sort="score" title="做市竞争程度指示灯(6 档)。绿 = 清淡;橙 = 一般;红 = 拥挤。">竞争程度 ${sortArrow("score")}</th>
            </tr>
          </thead>
          <tbody>
            ${renderRows(rows, duplicateCategories)}
          </tbody>
        </table>
      </div>
    </section>

    <section class="pa-card disclaimer">
      <div class="pa-eyebrow">免责声明</div>
      <p>积分分配具体计算公式官方未公布，本页面分配比例按照推测的数学模型进行计算，仅供参考。</p>
    </section>
  `;
}

function renderPage(options = {}) {
  const renderState = captureRenderState({
    preserveFocus: Boolean(options.preserveFocus),
    preserveScroll: Boolean(options.preserveScroll),
  });
  const app = document.querySelector("#app");
  const duplicateCategories = buildDuplicateCategorySet(state.markets);
  const rows = filterAndSortMarkets(state.markets, {
    maxExpireHrs: state.maxExpireHrs,
    query: state.query,
    sortDir: state.sortDir,
    sortKey: state.sortKey,
  });
  const meta = viewMeta[state.view] || viewMeta.markets;

  app.innerHTML = `
    ${renderHeader()}
    <main class="pa-page">
      <div class="pa-container">
        <div class="page-head">
          <div>
            <div class="pa-eyebrow">${
              state.loaded ? (state.error ? "模块 · Predict.fun 积分扫描器 · 离线" : "模块 · Predict.fun 积分扫描器 · 实时") : "模块 · Predict.fun 积分扫描器 · 加载中..."
            }</div>
            <h1 class="pa-h1">${meta.title}</h1>
            <div class="pa-sub">${meta.subtitle}</div>
          </div>
          ${state.view === "markets" ? `<button class="btn btn-sm" id="refreshBtn">刷新</button>` : ""}
          ${state.view === "points" ? `<button class="btn btn-sm" id="pointsRefreshBtn" ${state.points.loading ? "disabled" : ""}>${state.points.loading ? "刷新中..." : "刷新榜单"}</button>` : ""}
        </div>

        ${state.view === "markets" ? renderMarketsPage(rows, duplicateCategories) : ""}
        ${state.view === "favorites" ? renderFavoritesSection() : ""}
        ${state.view === "wallets" ? renderWalletPage() : ""}
        ${state.view === "points" ? renderPointsPage() : ""}
        ${state.view === "backtest" ? renderBacktestPage() : ""}
      </div>
    </main>
    <footer class="pa-footer">
      <span>predict α · v2.0 · ${new Date().getFullYear()}</span>
      <span>免责声明</span>
      <span>文档</span>
      <span>接口</span>
      <span>Discord</span>
      <a href="https://x.com/dev_xjm" target="_blank" rel="noreferrer">Twitter</a>
    </footer>
  `;

  bindEvents();
  updateClock();
  restoreRenderState(renderState);
  if (state.view === "markets" && state.loaded && !state.error) {
    queueOrderbookPrefetch(rows);
  }
}

function favoriteView(favorite) {
  const current = findMarketForFavorite(favorite, state.markets);
  const title = favorite.title || favorite.question || current?.question || current?.title || favorite.key;
  const url = favorite.url || buildPredictMarketUrl(current || favorite);
  return {
    ...favorite,
    current,
    expiresAtSec: current?.expiresAtSec ?? favorite.expiresAtSec,
    noBid: current?.noBid ?? favorite.noBid,
    title,
    url,
    yesBid: current?.yesBid ?? favorite.yesBid,
  };
}

function renderFavoritesSection() {
  const favorites = state.favoriteMarkets.map(favoriteView);
  const statusClass = state.reportError ? "report-status error" : "report-status";
  const reportLabel = state.reportSending ? "推送中..." : "推送最新报告";

  return `
    <section class="pa-card favorites-card">
      <div class="pa-card-head favorites-head">
        <div class="table-title-wrap">
          <div class="pa-card-title">收藏列表</div>
          <div class="pill mono">${favorites.length} 个市场</div>
        </div>
        <div class="report-actions">
          ${state.reportMessage ? `<span class="${statusClass}">${escapeHtml(state.reportMessage)}</span>` : ""}
          <button class="btn btn-sm" id="sendReportBtn" ${state.reportSending ? "disabled" : ""}>${reportLabel}</button>
        </div>
      </div>
      <div class="favorite-list">
        ${
          favorites.length
            ? favorites.map(renderFavoriteItem).join("")
            : `<div class="favorite-empty muted">还没有收藏市场。点击市场前面的五角星后，会在这里汇总。</div>`
        }
      </div>
    </section>
  `;
}

function renderFavoriteItem(favorite) {
  const titleHtml = favorite.url
    ? `<a class="market-link" href="${escapeHtml(favorite.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(favorite.title)} <span aria-hidden="true">↗</span></a>`
    : escapeHtml(favorite.title);
  const expires = favorite.expiresAtSec ? formatDate(favorite.expiresAtSec) : "-";

  return `
    <div class="favorite-item">
      <div class="favorite-title">
        <button class="favorite-btn active" data-favorite-remove="${escapeHtml(favorite.key)}" title="取消收藏">★</button>
        <div>
          <div class="market-name">${titleHtml}</div>
          <div class="market-meta">#${escapeHtml(favorite.id || favorite.key)} · ${escapeHtml(expires)}</div>
        </div>
      </div>
      <div class="favorite-prices">
        <span>Yes ${favorite.yesBid != null ? formatCents(favorite.yesBid, 1) : '<span class="muted">-</span>'}</span>
        <span>No ${favorite.noBid != null ? formatCents(favorite.noBid, 1) : '<span class="muted">-</span>'}</span>
      </div>
    </div>
  `;
}

function formatUsdText(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return escapeHtml(value ?? "-");
  return `$${number.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function formatProfitText(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  const abs = Math.abs(number);
  if (abs >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}m`;
  if (abs >= 10_000) return `${(number / 1_000).toFixed(1)}k`;
  if (abs >= 100) return number.toFixed(0);
  return number.toFixed(2);
}

function formatBacktestMetric(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return number.toLocaleString("en-US", {
    maximumFractionDigits: Math.abs(number) >= 100 ? 0 : 2,
    minimumFractionDigits: 0,
  });
}

function backtestDays() {
  const coverage = state.backtest.meta?.coverage;
  if (!coverage?.start || !coverage?.end) return [];
  const days = [];
  const date = new Date(`${coverage.start}T00:00:00.000Z`);
  const end = new Date(`${coverage.end}T00:00:00.000Z`);
  while (date <= end) {
    days.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return days;
}

function backtestSelectedDays() {
  const days = backtestDays();
  if (!days.length) return { end: null, start: null };
  const startIndex = Math.min(state.backtest.startIndex, state.backtest.endIndex);
  const endIndex = Math.max(state.backtest.startIndex, state.backtest.endIndex);
  return {
    end: days[Math.min(endIndex, days.length - 1)],
    start: days[Math.max(0, startIndex)],
  };
}

function shortAddress(address) {
  return `${String(address).slice(0, 6)}...${String(address).slice(-4)}`;
}

function predictPortfolioUrl(address) {
  return `https://predict.fun/portfolio/${encodeURIComponent(address)}`;
}

function renderPointsPage() {
  if (state.points.selectedAddress) return renderPointsAccountDetail();
  const accounts = state.points.accounts || [];
  const windows = state.points.windows;
  const status = state.points.error
    ? `<span class="wallet-status error">${escapeHtml(state.points.error)}</span>`
    : state.points.fetchedAt
      ? `<span class="wallet-status">${state.points.stale ? "缓存数据" : "实时数据"} · ${escapeHtml(new Date(state.points.fetchedAt).toLocaleString("zh-CN", { hour12: false }))}</span>`
      : "";

  return `
    <section class="pa-card stat-card">
      <div class="stat-row">
        ${statHtml("榜单账号", state.points.loading && !accounts.length ? "-" : formatNumber(accounts.length), "上周积分前 200")}
        ${statHtml("积分周期", windows?.lastWeek?.label || "-", "Predict 周三至周二周期")}
        ${statHtml("总持仓", accounts.length ? formatUsdText(accounts.reduce((sum, account) => sum + Number(account.positionsValueUsd || 0), 0)) : "-", "榜单账号当前持仓")}
        ${statHtml("总成交量", accounts.length ? formatUsdText(accounts.reduce((sum, account) => sum + Number(account.volumeUsd || 0), 0)) : "-", "Predict 账号统计")}
      </div>
    </section>

    <section class="pa-card table-card">
      <div class="pa-card-head">
        <div class="table-title-wrap">
          <div class="pa-card-title">上周积分前 200</div>
          <div class="pill mono">${accounts.length || 0} 个账号</div>
          ${status}
        </div>
      </div>
      ${
        state.points.loading && !accounts.length
          ? `<div class="favorite-empty muted">正在读取积分榜...</div>`
          : state.points.error && !accounts.length
            ? `<div class="favorite-empty muted">积分榜读取失败，请稍后重试。</div>`
            : renderPointsTable(accounts)
      }
    </section>
  `;
}

function renderPointsTable(accounts) {
  if (!accounts.length) return `<div class="favorite-empty muted">暂无积分榜数据。</div>`;

  return `
    <div class="table-scroll points-table-scroll">
      <table class="pa-table points-table">
        <thead>
          <tr>
            <th style="width:64px">排名</th>
            <th>账号</th>
            <th class="num" style="width:128px">持仓金额</th>
            <th class="num" style="width:128px">盈亏金额</th>
            <th class="num" style="width:132px">总成交量</th>
            <th class="num" style="width:132px">上周积分</th>
            <th style="width:164px">钱包地址</th>
          </tr>
        </thead>
        <tbody>
          ${accounts.map(renderPointsAccountRow).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderPointsAccountRow(account) {
  const address = account.address || "";
  return `
    <tr class="points-account-row" data-points-account="${escapeHtml(address)}" tabindex="0">
      <td class="mono">#${formatNumber(account.rank)}</td>
      <td>
        <div class="market-name">${escapeHtml(account.name || "未命名账号")}</div>
        <div class="market-meta">${formatNumber(account.marketsCount)} 个市场 · ${formatNumber(account.positionCount)} 个持仓</div>
      </td>
      <td class="num mono">${formatUsdText(account.positionsValueUsd)}</td>
      <td class="num mono ${Number(account.pnlUsd) >= 0 ? "profit" : "loss"}">${formatUsdText(account.pnlUsd)}</td>
      <td class="num mono">${formatUsdText(account.volumeUsd)}</td>
      <td class="num mono accent">${formatNumber(account.lastWeekPoints, 0)}</td>
      <td class="mono">
        <a href="#points/${encodeURIComponent(address)}" title="${escapeHtml(address)}">${escapeHtml(shortAddress(address))}</a>
      </td>
    </tr>
  `;
}

function renderPointsAccountDetail() {
  const detail = state.points.detail;
  const address = state.points.selectedAddress;
  const title = detail?.address || address;

  return `
    <section class="pa-card wallet-card points-detail-head">
      <div class="pa-card-head wallet-address-head">
        <div>
          <div class="wallet-address mono">${escapeHtml(shortAddress(title))}</div>
          <div class="wallet-sub muted">${detail?.windows?.lastWeek?.label || state.points.windows?.lastWeek?.label || "-"} 上周积分周期</div>
        </div>
        <div class="points-detail-actions">
          <a class="btn btn-secondary btn-sm" href="#points">返回榜单</a>
          <a class="btn btn-sm" href="${escapeHtml(predictPortfolioUrl(title))}" target="_blank" rel="noopener noreferrer">打开组合页</a>
        </div>
      </div>
      ${
        state.points.detailError
          ? `<div class="wallet-error">${escapeHtml(state.points.detailError)}</div>`
          : state.points.detailLoading && !detail
            ? `<div class="favorite-empty muted">正在读取账号详情和交易缓存...</div>`
            : ""
      }
    </section>

    ${detail ? `
      <section class="pa-card stat-card">
        <div class="stat-row">
          ${statHtml("持仓明细", formatNumber(detail.positions.length), "当前公开持仓")}
          ${statHtml("上周成交", formatNumber(detail.lastWeek.trades.length), detail.windows.lastWeek.label)}
          ${statHtml("本周成交", formatNumber(detail.thisWeek.trades.length), detail.windows.thisWeek.label)}
          ${statHtml("数据源", escapeHtml(detail.tradeSource || "cache"), detail.tradesFetchedAt ? `成交缓存 ${escapeHtml(new Date(detail.tradesFetchedAt).toLocaleString("zh-CN", { hour12: false }))}` : "")}
        </div>
      </section>

      <section class="pa-card wallet-card">
        <div class="pa-card-head wallet-head">
          <div>
            <div class="pa-card-title">策略说明</div>
            <div class="wallet-sub muted">基于上周成交方向、价格、合约类型和事件集中度生成。</div>
          </div>
        </div>
        <div class="points-strategy">${escapeHtml(detail.lastWeek.strategy)}</div>
      </section>

      <section class="pa-card wallet-card">
        <div class="pa-card-head wallet-head">
          <div>
            <div class="pa-card-title">持仓明细</div>
            <div class="wallet-sub muted">同一事件的不同选项在交易分析中会按市场 ID 聚合。</div>
          </div>
        </div>
        ${renderPointsPositions(detail.positions)}
      </section>

      ${renderPointsTradeSection("上周交易记录", detail.windows.lastWeek.label, detail.lastWeek)}
      ${renderPointsTradeSection("本周交易记录", detail.windows.thisWeek.label, detail.thisWeek)}
    ` : ""}
  `;
}

function renderPointsPositions(positions) {
  if (!positions.length) return `<div class="favorite-empty muted">该账号暂无公开持仓。</div>`;
  return `<div class="wallet-position-list">${positions.map((position) => `
    <div class="wallet-position">
      <div class="wallet-position-main">
        <div class="market-name">${escapeHtml(position.marketQuestion || position.marketTitle || "-")}</div>
        <div class="market-meta">#${escapeHtml(position.marketId)} · ${escapeHtml(position.outcomeName)}</div>
      </div>
      <div class="wallet-position-metrics">
        <span>数量 ${formatNumber(position.shares, 2)}</span>
        <span>价值 ${formatUsdText(position.valueUsd)}</span>
        <span>均价 ${formatUsdText(position.averageBuyPriceUsd)}</span>
        <span>PnL ${formatUsdText(position.pnlUsd)}</span>
      </div>
    </div>
  `).join("")}</div>`;
}

function renderPointsTradeSection(title, label, period) {
  const trades = period.trades || [];
  return `
    <section class="pa-card wallet-card">
      <div class="pa-card-head wallet-head">
        <div>
          <div class="pa-card-title">${escapeHtml(title)}</div>
          <div class="wallet-sub muted">${escapeHtml(label)} · ${formatNumber(trades.length)} 笔成交</div>
        </div>
      </div>
      ${renderPointsMarketGroups(period.marketGroups || [])}
      ${renderPointsTrades(trades)}
    </section>
  `;
}

function renderPointsMarketGroups(groups) {
  if (!groups.length) return `<div class="favorite-empty muted">暂无可聚合的事件成交。</div>`;
  return `
    <div class="points-market-groups">
      ${groups.slice(0, 8).map((group) => `
        <div class="points-market-group">
          <div>
            <div class="market-name">${escapeHtml(group.marketTitle || "-")}</div>
            <div class="market-meta">#${escapeHtml(group.marketId || "-")} · ${formatNumber(group.tradeCount)} 笔 · ${formatNumber(group.transactionCount)} tx</div>
          </div>
          <div class="points-outcomes">
            ${(group.outcomes || []).map((outcome) => `<span>${escapeHtml(outcome.name)} ${formatNumber(outcome.tradeCount)}</span>`).join("")}
          </div>
          <div class="mono">${formatUsdText(group.estimatedNotionalUsd)}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderPointsTrades(trades) {
  if (!trades.length) return "";
  return `
    <div class="points-trade-list">
      ${trades.slice(0, 80).map((trade) => `
        <div class="points-trade-row">
          <span class="mono">${escapeHtml(trade.timestamp ? trade.timestamp.replace("T", " ").slice(0, 19) : "-")}</span>
          <span>${escapeHtml(trade.marketTitle || "-")}</span>
          <span>${escapeHtml(trade.outcomeName || "-")}</span>
          <span class="mono">${escapeHtml(trade.sideEstimate || "-")}</span>
          <span class="mono">${formatUsdText(trade.estimatedNotionalUsd)}</span>
          <span class="mono">${trade.estimatedPrice == null ? "-" : formatNumber(trade.estimatedPrice, 3)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderWalletPage() {
  const wallets = state.walletSummary.wallets || [];
  const status = state.walletError || state.walletMessage;
  const statusClass = state.walletError ? "wallet-status error" : "wallet-status";
  const ownOrdersStatus = state.ownOrdersError || state.ownOrdersMessage;
  const ownOrdersStatusClass = state.ownOrdersError ? "wallet-status error" : "wallet-status";

  return `
    <section class="pa-card wallet-card">
      <div class="pa-card-head wallet-head">
        <div>
          <div class="pa-card-title">我的钱包授权</div>
          <div class="wallet-sub muted">选择浏览器钱包签署 Predict 登录消息，会自动识别关联的 Predict 内部钱包。</div>
        </div>
        <button class="btn btn-sm" id="refreshOwnOrdersBtn" ${state.ownOrdersLoading || !state.ownOrdersAuth.hasToken ? "disabled" : ""}>${
          state.ownOrdersLoading ? "刷新中..." : "刷新挂单"
        }</button>
      </div>
      <div class="wallet-connect-row">
        <button class="btn" data-wallet-connect="okx" ${state.ownOrdersLoading ? "disabled" : ""}>连接 OKX 钱包</button>
        <button class="btn btn-secondary" data-wallet-connect="binance" ${state.ownOrdersLoading ? "disabled" : ""}>连接币安钱包</button>
        <button class="btn btn-secondary" data-wallet-connect="injected" ${state.ownOrdersLoading ? "disabled" : ""}>MetaMask / 其他</button>
        ${renderAuthWalletStatus()}
        ${ownOrdersStatus ? `<span class="${ownOrdersStatusClass}">${escapeHtml(ownOrdersStatus)}</span>` : ""}
      </div>
    </section>

    <section class="pa-card wallet-card">
      <div class="pa-card-head wallet-head">
        <div>
          <div class="pa-card-title">我的当前挂单</div>
          <div class="wallet-sub muted">${state.ownOrdersAuth.hasToken ? `${state.ownOrders.length} 个 OPEN 挂单` : "连接并签名后显示你的 OPEN 挂单。"}</div>
        </div>
      </div>
      ${
        state.ownOrdersAuth.hasToken
          ? renderOwnOrders()
          : `<div class="favorite-empty muted">还没有 Predict 授权。点击上方钱包按钮并签名后，会在这里展示当前挂单。</div>`
      }
    </section>

    <section class="pa-card wallet-card">
      <div class="pa-card-head wallet-head">
        <div>
          <div class="pa-card-title">监控地址</div>
          <div class="wallet-sub muted">添加 Predict 钱包地址后，会读取持仓并自动收藏相关市场。</div>
        </div>
        <button class="btn btn-sm" id="refreshWalletsBtn" ${state.walletLoading ? "disabled" : ""}>${state.walletLoading ? "刷新中..." : "刷新持仓"}</button>
      </div>
      <form class="wallet-form" id="walletForm">
        <input
          class="inp wallet-input"
          id="walletInput"
          type="text"
          placeholder="输入 0x 钱包地址"
          value="${escapeHtml(state.walletInput)}"
          autocomplete="off"
        />
        <button class="btn" type="submit" ${state.walletLoading ? "disabled" : ""}>添加监控</button>
        ${status ? `<span class="${statusClass}">${escapeHtml(status)}</span>` : ""}
      </form>
    </section>

    <section class="wallet-list">
      ${
        wallets.length
          ? wallets.map(renderWalletSummary).join("")
          : `<div class="pa-card wallet-empty muted">还没有监控地址。添加地址后会在这里展示持仓和挂单状态。</div>`
      }
    </section>
  `;
}

function renderAuthWalletStatus() {
  if (!state.ownOrdersAuth.signer && !state.ownOrdersAuth.accountAddress) return "";
  const parts = [];
  if (state.ownOrdersAuth.accountAddress) parts.push(`Predict ${shortAddress(state.ownOrdersAuth.accountAddress)}`);
  if (state.ownOrdersAuth.signer) parts.push(`登录 ${shortAddress(state.ownOrdersAuth.signer)}`);
  return `<span class="wallet-status">${escapeHtml(parts.join(" · "))}</span>`;
}

function renderOwnOrders() {
  if (state.ownOrdersLoading) {
    return `<div class="favorite-empty muted">正在读取当前挂单...</div>`;
  }

  if (!state.ownOrders.length) {
    return `<div class="favorite-empty muted">当前没有 OPEN 挂单。</div>`;
  }

  return `<div class="wallet-order-list">${state.ownOrders.map(renderOwnOrder).join("")}</div>`;
}

function renderOwnOrder(order) {
  const title = order.url
    ? `<a class="market-link" href="${escapeHtml(order.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(order.title)} <span aria-hidden="true">↗</span></a>`
    : escapeHtml(order.title);

  return `
    <div class="wallet-order">
      <div class="wallet-position-main">
        <div class="market-name">${title}</div>
        <div class="market-meta">#${escapeHtml(order.marketId || "-")} · ${escapeHtml(order.id || order.hash || "-")}</div>
      </div>
      <div class="wallet-position-metrics wallet-order-metrics">
        <span>${escapeHtml(order.side)} ${escapeHtml(order.outcome)}</span>
        <span>价格 ${escapeHtml(order.price)}</span>
        <span>数量 ${escapeHtml(order.quantity)}</span>
        <span>剩余 ${escapeHtml(order.remainingQuantity)}</span>
        <span>已成交 ${escapeHtml(order.amountFilled)}</span>
        <span>状态 ${escapeHtml(order.status)}</span>
        <span>积分速率 ${escapeHtml(order.rewardEarningRate)}</span>
        <span>到期 ${escapeHtml(order.expiration)}</span>
      </div>
    </div>
  `;
}

function renderWalletSummary(wallet) {
  const positions = Array.isArray(wallet.positions) ? wallet.positions : [];

  return `
    <section class="pa-card wallet-address-card">
      <div class="pa-card-head wallet-address-head">
        <div>
          <div class="wallet-address mono" title="${escapeHtml(wallet.address)}">${escapeHtml(shortAddress(wallet.address))}</div>
          <div class="wallet-sub muted">${positions.length} 个持仓市场</div>
        </div>
        <button class="pa-iconbtn wallet-remove" data-wallet-remove="${escapeHtml(wallet.address)}" title="移除监控地址">×</button>
      </div>
      ${wallet.error ? `<div class="wallet-error">持仓读取失败：${escapeHtml(wallet.error)}</div>` : ""}
      <div class="wallet-section">
        <div class="wallet-section-title">持仓</div>
        ${
          positions.length
            ? `<div class="wallet-position-list">${positions.map(renderWalletPosition).join("")}</div>`
            : `<div class="favorite-empty muted">该地址暂无可显示持仓。</div>`
        }
      </div>
      <div class="wallet-section orders-unavailable">
        <div class="wallet-section-title">挂单</div>
        <div class="muted">${escapeHtml(wallet.orders?.reason || "公开接口暂不支持按地址查询挂单。")}</div>
      </div>
    </section>
  `;
}

function renderWalletPosition(position) {
  const title = position.url
    ? `<a class="market-link" href="${escapeHtml(position.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(position.title)} <span aria-hidden="true">↗</span></a>`
    : escapeHtml(position.title);

  return `
    <div class="wallet-position">
      <div class="wallet-position-main">
        <div class="market-name">${title}</div>
        <div class="market-meta">#${escapeHtml(position.marketId || "-")} · ${escapeHtml(position.outcome || "-")}</div>
      </div>
      <div class="wallet-position-metrics">
        <span>数量 ${escapeHtml(position.amount)}</span>
        <span>价值 ${formatUsdText(position.valueUsd)}</span>
        <span>均价 ${formatUsdText(position.averageBuyPriceUsd)}</span>
        <span>PnL ${formatUsdText(position.pnlUsd)}</span>
      </div>
    </div>
  `;
}

function renderBacktestPage() {
  const days = backtestDays();
  const selected = backtestSelectedDays();
  const availableIntervals = state.backtest.meta?.intervals?.map((row) => row.interval) || ["1h", "15m", "5m"];
  const selectedInterval = state.backtest.interval || "5m";
  const summary = state.backtest.heatmap?.summary;

  return `
    <section class="backtest-toolbar">
      <div class="backtest-filter">
        <div class="filter-label">回测日期</div>
        ${
          days.length
            ? `
              <div class="range-pair">
                <input id="backtestStartRange" type="range" min="0" max="${days.length - 1}" value="${state.backtest.startIndex}" />
                <input id="backtestEndRange" type="range" min="0" max="${days.length - 1}" value="${state.backtest.endIndex}" />
              </div>
              <div class="range-labels mono">
                <span>${escapeHtml(selected.start || "-")}</span>
                <span>${escapeHtml(selected.end || "-")}</span>
              </div>
            `
            : `<div class="muted">暂无 D1 回测覆盖日期。</div>`
        }
      </div>
      <label class="backtest-filter compact">
        <span class="filter-label">买入截止分钟</span>
        <input class="inp" id="backtestCutoffInput" type="number" min="1" step="1" value="${escapeHtml(state.backtest.cutoffMinutes)}" />
      </label>
      <div class="backtest-filter">
        <div class="filter-label">市场</div>
        <div class="seg interval-seg">
          ${["1h", "15m", "5m"].map((interval) => `
            <button
              class="seg-item ${selectedInterval === interval ? "active" : ""}"
              data-backtest-interval="${interval}"
              ${availableIntervals.includes(interval) ? "" : "disabled"}
            >${interval}</button>
          `).join("")}
        </div>
      </div>
      <button class="btn btn-sm" id="backtestRefreshBtn" ${state.backtest.loading ? "disabled" : ""}>${state.backtest.loading ? "计算中..." : "刷新"}</button>
    </section>

    <section class="backtest-summary">
      ${statHtml("时间范围", selected.start && selected.end ? `${selected.start}<span> 至 </span>${selected.end}` : "-", "UTC 日期")}
      ${statHtml("市场周期", selectedInterval, summary?.normalizedCutoffs ? `实际 cutoff ${Object.entries(summary.normalizedCutoffs).map(([key, value]) => `${key}:${value}`).join(" · ")}` : "")}
      ${statHtml("Yes 最优格", summary ? formatBacktestMetric(summary.yes.bestPnl) : "-", "累计利润 U", "accent")}
      ${statHtml("No 最优格", summary ? formatBacktestMetric(summary.no.bestPnl) : "-", "累计利润 U", "accent")}
    </section>

    ${state.backtest.error ? `<div class="backtest-error">${escapeHtml(state.backtest.error)}</div>` : ""}
    ${state.backtest.loading && !state.backtest.heatmap ? `<div class="favorite-empty muted">正在读取回测矩阵...</div>` : ""}
    ${
      state.backtest.heatmap
        ? `
          <section class="heatmap-pair">
            ${renderBacktestHeatmap("Yes 视角", state.backtest.heatmap.yes)}
            ${renderBacktestHeatmap("No 视角", state.backtest.heatmap.no)}
          </section>
        `
        : ""
    }
  `;
}

function renderBacktestHeatmap(title, matrix) {
  const axes = state.backtest.heatmap?.axes || state.backtest.meta?.axes || { buyPrices: [], sellPrices: [] };
  const buyPrices = axes.buyPrices || [];
  const sellPrices = axes.sellPrices || [];
  const cells = matrix?.pnl || [];
  const columnMaxIndexes = buyPrices.map((_, buyIndex) => {
    let maxIndex = -1;
    let maxPnl = -Infinity;
    for (let sellIndex = 0; sellIndex < sellPrices.length; sellIndex += 1) {
      const cellIndex = sellIndex * buyPrices.length + buyIndex;
      const pnl = Number(matrix?.pnl?.[cellIndex]);
      if (Number.isFinite(pnl) && pnl > maxPnl) {
        maxIndex = cellIndex;
        maxPnl = pnl;
      }
    }
    return maxIndex;
  });

  return `
    <section class="heatmap-panel">
      <div class="heatmap-head">
        <div class="pa-card-title">${escapeHtml(title)}</div>
        <div class="pill mono">${formatBacktestMetric(Math.max(...cells.map(Number).filter(Number.isFinite), 0))} U max</div>
      </div>
      <div class="heatmap-scroll">
        <div class="heatmap-grid" style="--heatmap-cols:${buyPrices.length}">
          <div class="heatmap-axis corner">卖出\\买入</div>
          ${buyPrices.map((price) => `<div class="heatmap-axis top">${escapeHtml(price)}</div>`).join("")}
          ${sellPrices.map((sellPrice, sellIndex) => `
            <div class="heatmap-axis side">${escapeHtml(sellPrice === "HOLD_EXPIRY" ? "持有到期" : sellPrice)}</div>
            ${buyPrices.map((buyPrice, buyIndex) => {
              const cellIndex = sellIndex * buyPrices.length + buyIndex;
              const pnl = Number(matrix?.pnl?.[cellIndex] || 0);
              const hasShareMetrics = Array.isArray(matrix?.buyShares) && Array.isArray(matrix?.sellShares);
              const buyShares = Number(matrix?.buyShares?.[cellIndex] || 0);
              const storedCost = Number(matrix?.cost?.[cellIndex]);
              const cost = Number.isFinite(storedCost) ? storedCost : buyShares * Number(buyPrice);
              const storedPayout = Number(matrix?.payout?.[cellIndex]);
              const payout = Number.isFinite(storedPayout) ? storedPayout : cost + pnl;
              const titleText = [
                `买入 ${buyPrice}`,
                `卖出 ${sellPrice === "HOLD_EXPIRY" ? "持有到期" : sellPrice}`,
                ...(hasShareMetrics
                  ? [
                      `成本 ${formatBacktestMetric(cost)}U`,
                      `回款 ${formatBacktestMetric(payout)}U`,
                      `买入份额 ${formatBacktestMetric(buyShares)}`,
                      `卖出份额 ${formatBacktestMetric(matrix?.sellShares?.[cellIndex] || 0)}`,
                    ]
                  : []),
                `利润 ${formatBacktestMetric(pnl)}U`,
              ].join(" · ");
              const isColumnMax = columnMaxIndexes[buyIndex] === cellIndex;
              return `<div class="heatmap-cell ${isColumnMax ? "column-max" : ""}" title="${escapeHtml(titleText)}">${escapeHtml(formatProfitText(pnl))}</div>`;
            }).join("")}
          `).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderActiveOrderCount(market) {
  const id = marketId(market);
  if (!id) return '<span class="muted">-</span>';
  const entry = state.orderbooks.get(id);
  if (entry?.summary) return formatQuantity(entry.summary.validOrderCount);
  if (entry?.error) return '<span class="muted">-</span>';
  return '<span class="muted">...</span>';
}

function renderOrderbookExpansion(market) {
  const entry = orderbookEntry(market);
  const summary = entry?.summary;

  if (entry?.loading || !entry) {
    return `<tr class="orderbook-row"><td colspan="12"><div class="orderbook-panel muted">加载 Activate Points 盘口中...</div></td></tr>`;
  }

  if (entry.error || !summary) {
    return `<tr class="orderbook-row"><td colspan="12"><div class="orderbook-panel muted">盘口读取失败，请稍后重试。</div></td></tr>`;
  }

  const activeBids = summary.bids.filter((level) => level.active);
  const activeAsks = summary.asks.filter((level) => level.active);
  const spreadLabel = summary.spread != null ? formatCents(summary.spread, 1) : '<span class="muted">-</span>';
  const limitLabel = summary.spreadThreshold != null ? formatCents(summary.spreadThreshold, 1) : '<span class="muted">-</span>';
  const updatedAt = summary.updateTimestampMs
    ? new Date(summary.updateTimestampMs).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        hour12: false,
        minute: "2-digit",
        second: "2-digit",
        timeZone: "Asia/Shanghai",
      })
    : "-";

  return `
    <tr class="orderbook-row">
      <td colspan="12">
        <div class="orderbook-panel">
          <div class="orderbook-head">
            <span>Activate Points 盘口</span>
            <span class="muted">有效订单数 ${formatQuantity(summary.validOrderCount)} · Spread ${spreadLabel} / ${limitLabel} · 更新 ${escapeHtml(updatedAt)}</span>
          </div>
          <div class="orderbook-grid">
            ${renderOrderbookSide("买盘", activeBids)}
            ${renderOrderbookSide("卖盘", activeAsks)}
          </div>
          ${
            summary.spreadEligible
              ? ""
              : `<div class="orderbook-note muted">当前买卖价差未进入 Activate Points 范围。</div>`
          }
        </div>
      </td>
    </tr>
  `;
}

function renderOrderbookSide(label, levels) {
  const sideClass = label === "买盘" ? "bid" : "ask";
  const maxQuantity = Math.max(0, ...levels.map((level) => Number(level.quantity) || 0));

  return `
    <div class="orderbook-side">
      <div class="orderbook-side-title">${label}</div>
      ${
        levels.length
          ? `
            <table class="orderbook-mini">
              <thead>
                <tr>
                  <th class="num">Yes</th>
                  <th class="num">数量</th>
                </tr>
              </thead>
              <tbody>
                ${levels.map((level) => renderOrderbookLevel(level, maxQuantity, sideClass)).join("")}
              </tbody>
            </table>
          `
          : `<div class="orderbook-empty muted">暂无符合范围的档位</div>`
      }
    </div>
  `;
}

function renderOrderbookLevel(level, maxQuantity, sideClass) {
  const quantity = Number(level.quantity);
  const width = Number.isFinite(quantity) && maxQuantity > 0 ? Math.max(2, Math.min(100, quantity / maxQuantity * 100)) : 0;

  return `
    <tr>
      <td class="num">${formatCents(level.yesPrice, 1)}</td>
      <td class="num mono orderbook-qty">
        <span class="orderbook-qty-track" aria-hidden="true">
          <span class="orderbook-qty-bar ${sideClass}" style="width:${width.toFixed(1)}%"></span>
        </span>
        <span class="orderbook-qty-value">${formatQuantity(level.quantity)}</span>
      </td>
    </tr>
  `;
}

function renderRows(rows, duplicateCategories) {
  if (!state.loaded) {
    return `<tr><td colspan="12" class="muted center-cell">加载积分市场中...</td></tr>`;
  }

  if (state.error) {
    return `<tr><td colspan="12" class="muted center-cell">无法连接到 alpha 后端。</td></tr>`;
  }

  if (!rows.length) {
    return `<tr><td colspan="12" class="muted center-cell">当前筛选条件下没有市场。</td></tr>`;
  }

  return rows
    .map((market, index) => {
      const title = buildMarketTitle(market, duplicateCategories);
      const predictUrl = buildPredictMarketUrl(market);
      const key = favoriteKey(market);
      const isFavorite = key && state.favoriteKeys.has(key);
      const isPending = key && state.favoritePending.has(key);
      const id = marketId(market);
      const isExpanded = id && state.expandedMarketId === id;
      const titleHtml = predictUrl
        ? `<a class="market-link" href="${escapeHtml(predictUrl)}" target="_blank" rel="noopener noreferrer" title="在 Predict 打开：${escapeHtml(title)}">${escapeHtml(title)} <span aria-hidden="true">↗</span></a>`
        : `<span title="${escapeHtml(title)}">${escapeHtml(title)}</span>`;
      return `
        <tr class="market-row ${isExpanded ? "expanded" : ""}" data-market-row="${escapeHtml(id)}" tabindex="0">
          <td class="favorite-cell">
            <button
              class="favorite-btn ${isFavorite ? "active" : ""}"
              data-favorite-key="${escapeHtml(key || "")}"
              aria-pressed="${isFavorite ? "true" : "false"}"
              title="${isFavorite ? "取消收藏" : "收藏市场"}"
              ${!key || isPending ? "disabled" : ""}
            >${isFavorite ? "★" : "☆"}</button>
          </td>
          <td class="num muted row-index">${String(index + 1).padStart(2, "0")}</td>
          <td>
            <div class="market-name">${titleHtml}</div>
            <div class="market-meta">#${escapeHtml(market.id)} · ${hoursLeft(market).toFixed(1)}h 剩余</div>
          </td>
          <td class="num mono text-xs">${market.totalLiq != null ? formatUsdText(market.totalLiq) : '<span class="muted">-</span>'}</td>
          <td class="num mono text-xs">${market.vol24 != null ? formatUsdText(market.vol24) : '<span class="muted">-</span>'}</td>
          <td class="num">${market.yesBid != null ? formatCents(market.yesBid, 1) : '<span class="muted">-</span>'}</td>
          <td class="num">${market.noBid != null ? formatCents(market.noBid, 1) : '<span class="muted">-</span>'}</td>
          <td class="num">${formatNumber(market.hourlyRate)}</td>
          <td class="num mono text-xs">${market.spreadThreshold != null ? formatCents(market.spreadThreshold, 1) : '<span class="muted">-</span>'}</td>
          <td class="num mono text-xs">${renderActiveOrderCount(market)}</td>
          <td class="mono text-xs muted">${formatDate(market.expiresAtSec)}</td>
          <td class="num">${competitionBars(market.score)}</td>
        </tr>
        ${isExpanded ? renderOrderbookExpansion(market) : ""}
      `;
    })
    .join("");
}

function bindEvents() {
  document.querySelector("#refreshBtn")?.addEventListener("click", () => loadRewards({ force: true, preserveScroll: true }));
  document.querySelector("#searchInput")?.addEventListener("input", (event) => {
    state.query = event.target.value;
    renderPage({ preserveFocus: true, preserveScroll: true });
  });
  document.querySelector("#walletForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    addWallet();
  });
  document.querySelector("#walletInput")?.addEventListener("input", (event) => {
    state.walletInput = event.target.value;
    state.walletError = "";
    renderPage({ preserveFocus: true, preserveScroll: true });
  });
  document.querySelector("#refreshWalletsBtn")?.addEventListener("click", () => loadWalletSummary({ preserveScroll: true }));
  document.querySelector("#refreshOwnOrdersBtn")?.addEventListener("click", () => loadOwnOrders({ preserveScroll: true }));
  document.querySelector("#sendReportBtn")?.addEventListener("click", sendLatestReport);
  document.querySelector("#themeBtn")?.addEventListener("click", toggleTheme);
  document.querySelector("#backtestRefreshBtn")?.addEventListener("click", () => loadBacktestHeatmap({ preserveScroll: true }));
  document.querySelector("#pointsRefreshBtn")?.addEventListener("click", () => loadPointsLeaderboard({ preserveScroll: true }));
  document.querySelector("#backtestCutoffInput")?.addEventListener("input", (event) => {
    const parsed = Math.floor(Number(event.target.value));
    state.backtest.cutoffMinutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    scheduleBacktestHeatmapLoad();
    renderPage({ preserveFocus: true, preserveScroll: true });
  });
  document.querySelector("#backtestStartRange")?.addEventListener("input", (event) => {
    const value = Number(event.target.value);
    state.backtest.startIndex = Math.min(value, state.backtest.endIndex);
    scheduleBacktestHeatmapLoad();
    renderPage({ preserveFocus: true, preserveScroll: true });
  });
  document.querySelector("#backtestEndRange")?.addEventListener("input", (event) => {
    const value = Number(event.target.value);
    state.backtest.endIndex = Math.max(value, state.backtest.startIndex);
    scheduleBacktestHeatmapLoad();
    renderPage({ preserveFocus: true, preserveScroll: true });
  });

  for (const button of document.querySelectorAll("[data-accent]")) {
    button.addEventListener("click", () => setAccent(button.dataset.accent));
  }

  for (const button of document.querySelectorAll("[data-backtest-interval]")) {
    button.addEventListener("click", () => {
      const interval = button.dataset.backtestInterval;
      if (!interval || state.backtest.interval === interval) return;
      state.backtest.interval = interval;
      scheduleBacktestHeatmapLoad();
      renderPage({ preserveScroll: true });
    });
  }

  for (const button of document.querySelectorAll("[data-sort]")) {
    button.addEventListener("click", () => {
      const key = button.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
      } else {
        state.sortKey = key;
        state.sortDir = "desc";
      }
      renderPage({ preserveScroll: true });
    });
  }

  for (const button of document.querySelectorAll("[data-expire]")) {
    button.addEventListener("click", () => {
      const value = button.dataset.expire;
      state.maxExpireHrs = value === "all" ? null : Number(value);
      localStorage.setItem("predict_alpha_max_expire_hrs", value);
      renderPage({ preserveScroll: true });
    });
  }

  for (const button of document.querySelectorAll("[data-density]")) {
    button.addEventListener("click", () => {
      state.dense = button.dataset.density === "dense";
      localStorage.setItem("predict_alpha_dense", state.dense ? "1" : "0");
      renderPage({ preserveScroll: true });
    });
  }

  for (const button of document.querySelectorAll("[data-favorite-key]")) {
    button.addEventListener("click", () => toggleFavorite(button.dataset.favoriteKey));
  }

  for (const row of document.querySelectorAll("[data-market-row]")) {
    row.addEventListener("click", (event) => {
      if (event.target.closest("a, button, input, select, textarea")) return;
      toggleMarketExpansion(row.dataset.marketRow);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleMarketExpansion(row.dataset.marketRow);
    });
  }

  for (const button of document.querySelectorAll("[data-favorite-remove]")) {
    button.addEventListener("click", () => removeFavorite(button.dataset.favoriteRemove));
  }

  for (const button of document.querySelectorAll("[data-wallet-remove]")) {
    button.addEventListener("click", () => removeWallet(button.dataset.walletRemove));
  }

  for (const button of document.querySelectorAll("[data-wallet-connect]")) {
    button.addEventListener("click", () => connectPredictWallet(button.dataset.walletConnect));
  }

  for (const row of document.querySelectorAll("[data-points-account]")) {
    row.addEventListener("click", (event) => {
      if (event.target.closest("a, button, input, select, textarea")) return;
      window.location.hash = `points/${encodeURIComponent(row.dataset.pointsAccount)}`;
    });
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      window.location.hash = `points/${encodeURIComponent(row.dataset.pointsAccount)}`;
    });
  }
}

function injectedProviders() {
  const ethereum = window.ethereum;
  const providers = Array.isArray(ethereum?.providers) ? ethereum.providers : ethereum ? [ethereum] : [];
  return providers.filter(Boolean);
}

function firstProvider(match) {
  return injectedProviders().find(match) || null;
}

function walletProvider(kind) {
  if (kind === "okx") {
    return window.okxwallet || firstProvider((provider) => provider.isOkxWallet || provider.isOKExWallet) || null;
  }
  if (kind === "binance") {
    return window.BinanceChain || firstProvider((provider) => provider.isBinance || provider.isBinanceWallet) || null;
  }
  if (kind === "injected") {
    return (
      firstProvider((provider) => provider.isMetaMask && !provider.isOkxWallet && !provider.isOKExWallet) ||
      window.ethereum ||
      null
    );
  }
  return null;
}

async function requestWalletAddress(provider) {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  return normalizeWalletAddress(accounts?.[0]);
}

async function signPredictMessage(provider, address, message) {
  try {
    return await provider.request({ method: "personal_sign", params: [message, address] });
  } catch (firstError) {
    try {
      return await provider.request({ method: "personal_sign", params: [address, message] });
    } catch {
      throw firstError;
    }
  }
}

async function connectPredictWallet(kind) {
  const provider = walletProvider(kind);
  if (!provider?.request) {
    state.ownOrdersError = kind === "okx"
      ? "没有检测到 OKX 钱包"
      : kind === "binance"
        ? "没有检测到币安钱包"
        : "没有检测到浏览器钱包";
    state.ownOrdersMessage = "";
    renderPage({ preserveScroll: true });
    return;
  }

  state.ownOrdersLoading = true;
  state.ownOrdersError = "";
  state.ownOrdersMessage = "请在钱包中确认签名";
  renderPage({ preserveScroll: true });

  try {
    const signer = await requestWalletAddress(provider);
    if (!signer) throw new Error("invalid_wallet_address");

    const messageResponse = await fetch(favoritesEndpoint("/api/predict-auth/message"), { cache: "no-store" });
    if (!messageResponse.ok) throw new Error(`message_http_${messageResponse.status}`);
    const { message } = await messageResponse.json();
    if (!message) throw new Error("missing_predict_message");

    const signature = await signPredictMessage(provider, signer, message);
    if (!signature) throw new Error("missing_signature");

    const tokenResponse = await fetch(favoritesEndpoint("/api/predict-auth/token"), {
      body: JSON.stringify({ message, signature, signer }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!tokenResponse.ok) throw new Error(`token_http_${tokenResponse.status}`);
    const tokenPayload = await tokenResponse.json();
    state.ownOrdersAuth = {
      accountAddress: tokenPayload.accountAddress || null,
      hasToken: Boolean(tokenPayload.hasToken),
      signer: tokenPayload.signer || signer,
    };
    state.ownOrdersMessage = "授权已保存";
    await loadOwnOrders({ preserveScroll: true, renderLoading: false });
    await loadWalletSummary({ preserveScroll: true });
  } catch (error) {
    console.error(error);
    state.ownOrdersError = "钱包授权失败，请确认签名内容来自 Predict";
    state.ownOrdersMessage = "";
  } finally {
    state.ownOrdersLoading = false;
    renderPage({ preserveScroll: true });
  }
}

function updateClock() {
  const clock = document.querySelector("#clock");
  if (!clock) return;
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const utc = `${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${now.toISOString().slice(11, 19)} UTC`;
  const etParts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: "America/New_York",
  }).formatToParts(now);
  const pick = (type) => etParts.find((part) => part.type === type)?.value || "";
  const etHour = pick("hour") === "24" ? "00" : pick("hour");
  clock.textContent = `${utc} · ${pick("month")}-${pick("day")} ${etHour}:${pick("minute")}:${pick("second")} ET`;
}

function rewardsEndpoint() {
  const isLocalHttp = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  const base =
    window.location.protocol === "file:"
      ? "https://api.predalpha.xyz/api/markets/rewards"
      : isLocalHttp
        ? "/api/markets/rewards"
        : "data/rewards.json";
  return `${base}?ts=${Date.now()}`;
}

function favoritesEndpoint(path = "") {
  return `${FAVORITES_API_BASE}${path}`;
}

function backtestEndpoint(path = "") {
  return favoritesEndpoint(path);
}

function orderbookEndpoint(id) {
  const encoded = encodeURIComponent(id);
  const isLocalHttp = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  return isLocalHttp ? `/api/markets/${encoded}/orderbook` : favoritesEndpoint(`/api/markets/${encoded}/orderbook`);
}

function resetOrderbookQueue() {
  state.orderbooks.clear();
  state.expandedMarketId = null;
  orderbookQueue = [];
  orderbookQueueToken += 1;
}

function queueOrderbookPrefetch(rows) {
  const nextIds = [];
  for (const market of rows) {
    const id = marketId(market);
    const entry = id ? state.orderbooks.get(id) : null;
    if (!id || entry?.summary || entry?.loading || entry?.error) continue;
    nextIds.push(id);
  }
  if (!nextIds.length) return;

  orderbookQueue = [...new Set([...orderbookQueue, ...nextIds])];
  if (!orderbookQueueRunning) runOrderbookQueue(orderbookQueueToken);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOrderbookQueue(token) {
  orderbookQueueRunning = true;
  while (orderbookQueue.length && token === orderbookQueueToken) {
    const id = orderbookQueue.shift();
    const market = findMarketById(id);
    if (market) await loadMarketOrderbook(market, { renderResult: true });
    await delay(ORDERBOOK_PREFETCH_DELAY_MS);
  }
  orderbookQueueRunning = false;
  if (orderbookQueue.length && token === orderbookQueueToken) runOrderbookQueue(token);
}

async function loadMarketOrderbook(market, { renderLoading = false, renderResult = renderLoading } = {}) {
  const id = marketId(market);
  if (!id) return null;

  const current = state.orderbooks.get(id);
  if (current?.summary) return current.summary;
  if (current?.loading) return null;

  state.orderbooks.set(id, { loading: true });
  if (renderLoading) renderPage({ preserveScroll: true });

  try {
    const response = await fetch(orderbookEndpoint(id), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const orderbook = payload.orderbook || payload.data || payload;
    const summary = buildActivateOrderbook({ market, orderbook });
    state.orderbooks.set(id, {
      fetchedAt: Date.now(),
      orderbook,
      summary,
    });
    return summary;
  } catch (error) {
    console.error(error);
    state.orderbooks.set(id, { error: true });
    return null;
  } finally {
    if (renderResult) renderPage({ preserveScroll: true });
  }
}

function toggleMarketExpansion(id) {
  const value = String(id || "");
  if (!value) return;
  if (state.expandedMarketId === value) {
    state.expandedMarketId = null;
    renderPage({ preserveScroll: true });
    return;
  }

  state.expandedMarketId = value;
  renderPage({ preserveScroll: true });
  const market = findMarketById(value);
  if (market) loadMarketOrderbook(market, { renderLoading: true, renderResult: true });
}

function setFavorites(favorites) {
  state.favoriteMarkets = Array.isArray(favorites) ? favorites : [];
  state.favoriteKeys = new Set(state.favoriteMarkets.map((item) => item.key).filter(Boolean));
}

async function loadFavorites({ render = true } = {}) {
  try {
    const response = await fetch(favoritesEndpoint("/api/favorites"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    setFavorites(payload.favorites);
    state.favoriteError = false;
  } catch (error) {
    console.error(error);
    state.favoriteError = true;
  } finally {
    if (render) renderPage();
  }
}

async function toggleFavorite(key) {
  if (!key || state.favoritePending.has(key)) return;
  if (state.favoriteKeys.has(key)) {
    await removeFavorite(key);
    return;
  }

  const market = state.markets.find((item) => favoriteKey(item) === key);
  if (!market) return;

  state.favoritePending.add(key);
  renderPage({ preserveScroll: true });

  try {
    const response = await fetch(favoritesEndpoint("/api/favorites"), {
      body: JSON.stringify({ market: toFavoriteMarket(market) }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    setFavorites(payload.favorites);
    state.favoriteError = false;
  } catch (error) {
    console.error(error);
    state.favoriteError = true;
  } finally {
    state.favoritePending.delete(key);
    renderPage({ preserveScroll: true });
  }
}

async function removeFavorite(key) {
  if (!key || state.favoritePending.has(key)) return;

  state.favoritePending.add(key);
  renderPage({ preserveScroll: true });

  try {
    const response = await fetch(favoritesEndpoint(`/api/favorites/${encodeURIComponent(key)}`), {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    setFavorites(payload.favorites);
    state.favoriteError = false;
  } catch (error) {
    console.error(error);
    state.favoriteError = true;
  } finally {
    state.favoritePending.delete(key);
    renderPage({ preserveScroll: true });
  }
}

async function loadWalletSummary({ preserveScroll = false } = {}) {
  state.walletLoading = true;
  state.walletError = "";
  renderPage({ preserveScroll });

  try {
    const response = await fetch(favoritesEndpoint("/api/wallets/summary"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.walletSummary = {
      favoritesAdded: Number(payload.favoritesAdded || 0),
      wallets: Array.isArray(payload.wallets) ? payload.wallets : [],
    };
    state.walletMessage = state.walletSummary.favoritesAdded > 0
      ? `已自动收藏 ${state.walletSummary.favoritesAdded} 个持仓市场`
      : "";
    await loadFavorites({ render: false });
  } catch (error) {
    console.error(error);
    state.walletError = "钱包持仓读取失败";
  } finally {
    state.walletLoading = false;
    renderPage({ preserveScroll });
  }
}

async function loadPredictAuthStatus({ render = true } = {}) {
  try {
    const response = await fetch(favoritesEndpoint("/api/predict-auth/status"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.ownOrdersAuth = {
      accountAddress: payload.accountAddress || null,
      hasToken: Boolean(payload.hasToken),
      signer: payload.signer || null,
    };
  } catch (error) {
    console.error(error);
    state.ownOrdersError = "授权状态读取失败";
  } finally {
    if (render) renderPage();
  }
}

async function loadOwnOrders({ preserveScroll = false, renderLoading = true } = {}) {
  if (renderLoading) {
    state.ownOrdersLoading = true;
    state.ownOrdersError = "";
    renderPage({ preserveScroll });
  }

  try {
    const response = await fetch(favoritesEndpoint("/api/wallets/me/orders"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.ownOrdersAuth = {
      accountAddress: payload.accountAddress || state.ownOrdersAuth.accountAddress || null,
      hasToken: Boolean(payload.hasToken),
      signer: payload.signer || state.ownOrdersAuth.signer || null,
    };
    state.ownOrders = Array.isArray(payload.orders) ? payload.orders : [];
    state.ownOrdersMessage = payload.favoritesAdded > 0
      ? `已自动收藏 ${payload.favoritesAdded} 个挂单市场`
      : state.ownOrdersAuth.hasToken
        ? ""
        : "连接钱包后读取当前挂单";
    state.ownOrdersError = "";
    if (payload.favoritesAdded > 0) await loadFavorites({ render: false });
  } catch (error) {
    console.error(error);
    state.ownOrdersError = "当前挂单读取失败，请重新授权后再试";
  } finally {
    if (renderLoading) state.ownOrdersLoading = false;
    renderPage({ preserveScroll });
  }
}

function scheduleBacktestHeatmapLoad() {
  clearTimeout(backtestLoadTimer);
  backtestLoadTimer = setTimeout(() => {
    loadBacktestHeatmap({ preserveScroll: true });
  }, 275);
}

async function loadBacktestMeta({ render = true } = {}) {
  if (state.backtest.meta) {
    if (!state.backtest.heatmap && !state.backtest.loading) loadBacktestHeatmap({ preserveScroll: true });
    return;
  }

  state.backtest.loading = true;
  state.backtest.error = "";
  if (render) renderPage();

  try {
    const response = await fetch(backtestEndpoint("/api/backtest/meta"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.backtest.meta = payload;
    const days = backtestDays();
    state.backtest.startIndex = 0;
    state.backtest.endIndex = Math.max(0, days.length - 1);
    state.backtest.error = "";
    if (days.length) {
      await loadBacktestHeatmap({ preserveScroll: true, renderLoading: false });
    }
  } catch (error) {
    console.error(error);
    state.backtest.error = "回测元数据读取失败";
  } finally {
    state.backtest.loading = false;
    if (render) renderPage({ preserveScroll: true });
  }
}

async function loadBacktestHeatmap({ preserveScroll = false, renderLoading = true } = {}) {
  const selected = backtestSelectedDays();
  const interval = state.backtest.interval || "5m";
  if (!state.backtest.meta || !selected.start || !selected.end) return;

  state.backtest.loading = true;
  state.backtest.error = "";
  if (renderLoading) renderPage({ preserveScroll });

  try {
    const params = new URLSearchParams({
      cutoff: String(state.backtest.cutoffMinutes),
      end: selected.end,
      fields: "pnl",
      intervals: interval,
      start: selected.start,
    });
    const response = await fetch(backtestEndpoint(`/api/backtest/heatmap?${params}`), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.backtest.heatmap = await response.json();
    state.backtest.error = "";
  } catch (error) {
    console.error(error);
    state.backtest.error = "回测矩阵读取失败";
  } finally {
    state.backtest.loading = false;
    renderPage({ preserveScroll });
  }
}

async function loadPointsLeaderboard({ preserveScroll = false, renderLoading = true } = {}) {
  state.points.loading = true;
  state.points.error = "";
  if (renderLoading) renderPage({ preserveScroll });

  try {
    const response = await fetch(favoritesEndpoint("/api/points/leaderboard"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.points.accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    state.points.fetchedAt = payload.fetchedAt || "";
    state.points.stale = Boolean(payload.stale);
    state.points.windows = payload.windows || null;
    state.points.error = "";
  } catch (error) {
    console.error(error);
    state.points.error = "积分榜读取失败";
  } finally {
    state.points.loading = false;
    renderPage({ preserveScroll });
  }
}

async function loadPointsAccount(address, { preserveScroll = false, renderLoading = true } = {}) {
  const normalized = normalizeWalletAddress(address);
  if (!normalized) return;
  state.points.selectedAddress = normalized;
  state.points.detailLoading = true;
  state.points.detailError = "";
  if (state.points.detail?.address !== normalized) state.points.detail = null;
  if (renderLoading) renderPage({ preserveScroll });

  try {
    const response = await fetch(favoritesEndpoint(`/api/points/accounts/${encodeURIComponent(normalized)}`), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.points.detail = await response.json();
    state.points.detailError = "";
  } catch (error) {
    console.error(error);
    state.points.detailError = "账号详情读取失败，成交缓存或链上数据暂不可用";
  } finally {
    state.points.detailLoading = false;
    renderPage({ preserveScroll });
  }
}

async function addWallet() {
  const address = normalizeWalletAddress(state.walletInput);
  if (!address) {
    state.walletError = "钱包地址格式不正确";
    renderPage({ preserveFocus: true, preserveScroll: true });
    return;
  }

  state.walletLoading = true;
  state.walletError = "";
  state.walletMessage = "";
  renderPage({ preserveScroll: true });

  try {
    const response = await fetch(favoritesEndpoint("/api/wallets"), {
      body: JSON.stringify({ address }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.walletInput = "";
    state.walletMessage = "监控地址已添加";
    await loadWalletSummary({ preserveScroll: true });
  } catch (error) {
    console.error(error);
    state.walletError = "添加监控地址失败";
  } finally {
    state.walletLoading = false;
    renderPage({ preserveScroll: true });
  }
}

async function removeWallet(address) {
  const normalized = normalizeWalletAddress(address);
  if (!normalized) return;

  state.walletLoading = true;
  state.walletError = "";
  state.walletMessage = "";
  renderPage({ preserveScroll: true });

  try {
    const response = await fetch(favoritesEndpoint(`/api/wallets/${encodeURIComponent(normalized)}`), {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.walletMessage = "监控地址已移除";
    await loadWalletSummary({ preserveScroll: true });
  } catch (error) {
    console.error(error);
    state.walletError = "移除监控地址失败";
  } finally {
    state.walletLoading = false;
    renderPage({ preserveScroll: true });
  }
}

async function sendLatestReport() {
  if (state.reportSending) return;

  state.reportSending = true;
  state.reportError = false;
  state.reportMessage = "";
  renderPage({ preserveScroll: true });

  try {
    const response = await fetch(favoritesEndpoint("/api/report/send"), {
      method: "POST",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const sentAt = payload.sentAt ? new Date(payload.sentAt) : new Date();
    const time = sentAt.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      timeZone: "Asia/Shanghai",
    });
    state.reportMessage = `已推送 ${time} · ${payload.favoriteCount ?? state.favoriteKeys.size} 个市场`;
  } catch (error) {
    console.error(error);
    state.reportError = true;
    state.reportMessage = "推送失败，请稍后重试";
  } finally {
    state.reportSending = false;
    renderPage({ preserveScroll: true });
  }
}

async function loadRewards({ force = false, preserveScroll = false } = {}) {
  state.loaded = false;
  if (force) state.error = false;
  if (force) resetOrderbookQueue();
  renderPage({ preserveScroll });

  try {
    const response = await fetch(rewardsEndpoint());
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.markets = Array.isArray(payload) ? payload : payload.markets || [];
    state.error = false;
  } catch (error) {
    console.error(error);
    state.error = true;
  } finally {
    state.loaded = true;
    renderPage({ preserveScroll });
  }
}

document.documentElement.dataset.theme = localStorage.getItem("predict_alpha_theme") || "dark";
setAccent(localStorage.getItem("predict_alpha_accent") || "violet");
renderPage();
loadRewards();
loadFavorites();
loadPredictAuthStatus({ render: false }).then(() => {
  renderPage();
  if (state.view === "wallets") {
    loadWalletSummary();
    if (state.ownOrdersAuth.hasToken) loadOwnOrders();
  }
  if (state.view === "points") {
    loadPointsLeaderboard();
    if (state.points.selectedAddress) loadPointsAccount(state.points.selectedAddress);
  }
  if (state.view === "backtest") {
    loadBacktestMeta();
  }
});
window.addEventListener("hashchange", () => {
  state.view = readView();
  state.points.selectedAddress = readPointsAddress();
  renderPage({ preserveScroll: true });
  if (state.view === "wallets") {
    loadPredictAuthStatus({ render: false }).then(() => {
      loadWalletSummary({ preserveScroll: true });
      if (state.ownOrdersAuth.hasToken) loadOwnOrders({ preserveScroll: true });
    });
  }
  if (state.view === "points") {
    if (!state.points.accounts.length) loadPointsLeaderboard({ preserveScroll: true });
    if (state.points.selectedAddress) loadPointsAccount(state.points.selectedAddress, { preserveScroll: true });
  }
  if (state.view === "backtest") {
    loadBacktestMeta();
  }
});
setInterval(updateClock, 1000);
