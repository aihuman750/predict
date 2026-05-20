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

const views = new Set(["markets", "favorites", "wallets"]);
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
  ownOrdersAuth: { hasToken: false, signer: null },
  ownOrdersError: "",
  ownOrdersLoading: false,
  ownOrdersMessage: "",
};

function readView() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  return views.has(hash) ? hash : "markets";
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
  const walletLabel = state.ownOrdersAuth.signer ? shortAddress(state.ownOrdersAuth.signer) : "连接钱包";
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
              <th class="num sortable" style="width:74px" data-sort="yesBid" title="YES 一边的最优买价（概率）">Yes ${sortArrow("yesBid")}</th>
              <th class="num sortable" style="width:74px" data-sort="noBid" title="NO 一边的最优买价（概率）">No ${sortArrow("noBid")}</th>
              <th class="num sortable" style="width:104px" data-sort="hourlyRate">积分/小时 ${sortArrow("hourlyRate")}</th>
              <th class="num sortable" style="width:88px" data-sort="spreadThreshold" title="积分门槛：报价价差需 <= 此值（单位：美分）">最大价差 ${sortArrow("spreadThreshold")}</th>
              <th class="num sortable" style="width:88px" data-sort="shareThreshold" title="积分门槛：每边最低报价股数">最小股数 ${sortArrow("shareThreshold")}</th>
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
        </div>

        ${state.view === "markets" ? renderMarketsPage(rows, duplicateCategories) : ""}
        ${state.view === "favorites" ? renderFavoritesSection() : ""}
        ${state.view === "wallets" ? renderWalletPage() : ""}
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

function shortAddress(address) {
  return `${String(address).slice(0, 6)}...${String(address).slice(-4)}`;
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
          <div class="wallet-sub muted">选择浏览器钱包签署 Predict 登录消息，用于读取你自己的当前挂单。</div>
        </div>
        <button class="btn btn-sm" id="refreshOwnOrdersBtn" ${state.ownOrdersLoading || !state.ownOrdersAuth.hasToken ? "disabled" : ""}>${
          state.ownOrdersLoading ? "刷新中..." : "刷新挂单"
        }</button>
      </div>
      <div class="wallet-connect-row">
        <button class="btn" data-wallet-connect="okx" ${state.ownOrdersLoading ? "disabled" : ""}>连接 OKX 钱包</button>
        <button class="btn btn-secondary" data-wallet-connect="binance" ${state.ownOrdersLoading ? "disabled" : ""}>连接币安钱包</button>
        <button class="btn btn-secondary" data-wallet-connect="injected" ${state.ownOrdersLoading ? "disabled" : ""}>MetaMask / 其他</button>
        ${state.ownOrdersAuth.signer ? `<span class="wallet-status">已授权 ${escapeHtml(shortAddress(state.ownOrdersAuth.signer))}</span>` : ""}
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

function renderRows(rows, duplicateCategories) {
  if (!state.loaded) {
    return `<tr><td colspan="10" class="muted center-cell">加载积分市场中...</td></tr>`;
  }

  if (state.error) {
    return `<tr><td colspan="10" class="muted center-cell">无法连接到 alpha 后端。</td></tr>`;
  }

  if (!rows.length) {
    return `<tr><td colspan="10" class="muted center-cell">当前筛选条件下没有市场。</td></tr>`;
  }

  return rows
    .map((market, index) => {
      const title = buildMarketTitle(market, duplicateCategories);
      const predictUrl = buildPredictMarketUrl(market);
      const key = favoriteKey(market);
      const isFavorite = key && state.favoriteKeys.has(key);
      const isPending = key && state.favoritePending.has(key);
      const titleHtml = predictUrl
        ? `<a class="market-link" href="${escapeHtml(predictUrl)}" target="_blank" rel="noopener noreferrer" title="在 Predict 打开：${escapeHtml(title)}">${escapeHtml(title)} <span aria-hidden="true">↗</span></a>`
        : `<span title="${escapeHtml(title)}">${escapeHtml(title)}</span>`;
      return `
        <tr>
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
          <td class="num">${market.yesBid != null ? formatCents(market.yesBid, 1) : '<span class="muted">-</span>'}</td>
          <td class="num">${market.noBid != null ? formatCents(market.noBid, 1) : '<span class="muted">-</span>'}</td>
          <td class="num">${formatNumber(market.hourlyRate)}</td>
          <td class="num mono text-xs">${market.spreadThreshold != null ? formatCents(market.spreadThreshold, 1) : '<span class="muted">-</span>'}</td>
          <td class="num mono text-xs">${market.shareThreshold != null ? formatNumber(market.shareThreshold) : '<span class="muted">-</span>'}</td>
          <td class="mono text-xs muted">${formatDate(market.expiresAtSec)}</td>
          <td class="num">${competitionBars(market.score)}</td>
        </tr>
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

  for (const button of document.querySelectorAll("[data-accent]")) {
    button.addEventListener("click", () => setAccent(button.dataset.accent));
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

  for (const button of document.querySelectorAll("[data-favorite-remove]")) {
    button.addEventListener("click", () => removeFavorite(button.dataset.favoriteRemove));
  }

  for (const button of document.querySelectorAll("[data-wallet-remove]")) {
    button.addEventListener("click", () => removeWallet(button.dataset.walletRemove));
  }

  for (const button of document.querySelectorAll("[data-wallet-connect]")) {
    button.addEventListener("click", () => connectPredictWallet(button.dataset.walletConnect));
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
});
window.addEventListener("hashchange", () => {
  state.view = readView();
  renderPage({ preserveScroll: true });
  if (state.view === "wallets") {
    loadPredictAuthStatus({ render: false }).then(() => {
      loadWalletSummary({ preserveScroll: true });
      if (state.ownOrdersAuth.hasToken) loadOwnOrders({ preserveScroll: true });
    });
  }
});
setInterval(updateClock, 1000);
