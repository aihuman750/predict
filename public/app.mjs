import {
  buildDuplicateCategorySet,
  buildMarketTitle,
  buildPredictMarketUrl,
  competitionTier,
  favoriteKey,
  filterAndSortMarkets,
  summarizeMarkets,
  toFavoriteMarket,
} from "./rewards-core.mjs";

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
const FAVORITES_API_BASE = window.PREDICT_FAVORITES_API || "https://predict-favorites.aihuman750.workers.dev";

const state = {
  dense: localStorage.getItem("predict_alpha_dense") === "1",
  error: false,
  favoriteError: false,
  favoriteKeys: new Set(),
  favoritePending: new Set(),
  loaded: false,
  markets: [],
  maxExpireHrs: readExpireSetting(),
  query: "",
  sortDir: "desc",
  sortKey: "hourlyRate",
};

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

function renderHeader() {
  return `
    <header class="pa-header">
      <div class="pa-brand" aria-label="predict alpha">
        <span class="pa-brand-mark">α</span>
        <span class="pa-brand-name">predict <em>alpha</em></span>
      </div>
      <nav class="pa-nav">
        <a class="pa-nav-item active" href="#">积分市场</a>
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
        <button class="btn btn-sm wallet-btn">未设置钱包</button>
      </div>
    </header>
  `;
}

function renderPage() {
  const app = document.querySelector("#app");
  const stats = summarizeMarkets(state.markets);
  const duplicateCategories = buildDuplicateCategorySet(state.markets);
  const rows = filterAndSortMarkets(state.markets, {
    maxExpireHrs: state.maxExpireHrs,
    query: state.query,
    sortDir: state.sortDir,
    sortKey: state.sortKey,
  });

  const top10Share =
    state.loaded && stats.totalHourly > 0 ? `${(stats.top10Hourly / stats.totalHourly * 100).toFixed(0)}<span>%</span>` : "-";

  app.innerHTML = `
    ${renderHeader()}
    <main class="pa-page">
      <div class="pa-container">
        <div class="page-head">
          <div>
            <div class="pa-eyebrow">${
              state.loaded ? (state.error ? "模块 · Predict.fun 积分扫描器 · 离线" : "模块 · Predict.fun 积分扫描器 · 实时") : "模块 · Predict.fun 积分扫描器 · 加载中..."
            }</div>
            <h1 class="pa-h1">积分市场</h1>
            <div class="pa-sub">按当前盘口做市得分排序的活跃积分市场。</div>
          </div>
          <button class="btn btn-sm" id="refreshBtn">刷新</button>
        </div>

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
  document.querySelector("#refreshBtn")?.addEventListener("click", () => loadRewards({ force: true }));
  document.querySelector("#searchInput")?.addEventListener("input", (event) => {
    state.query = event.target.value;
    renderPage();
  });
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
      renderPage();
    });
  }

  for (const button of document.querySelectorAll("[data-expire]")) {
    button.addEventListener("click", () => {
      const value = button.dataset.expire;
      state.maxExpireHrs = value === "all" ? null : Number(value);
      localStorage.setItem("predict_alpha_max_expire_hrs", value);
      renderPage();
    });
  }

  for (const button of document.querySelectorAll("[data-density]")) {
    button.addEventListener("click", () => {
      state.dense = button.dataset.density === "dense";
      localStorage.setItem("predict_alpha_dense", state.dense ? "1" : "0");
      renderPage();
    });
  }

  for (const button of document.querySelectorAll("[data-favorite-key]")) {
    button.addEventListener("click", () => toggleFavorite(button.dataset.favoriteKey));
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

function setFavoriteKeys(favorites) {
  state.favoriteKeys = new Set((Array.isArray(favorites) ? favorites : []).map((item) => item.key).filter(Boolean));
}

async function loadFavorites() {
  try {
    const response = await fetch(favoritesEndpoint("/api/favorites"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    setFavoriteKeys(payload.favorites);
    state.favoriteError = false;
  } catch (error) {
    console.error(error);
    state.favoriteError = true;
  } finally {
    renderPage();
  }
}

async function toggleFavorite(key) {
  if (!key || state.favoritePending.has(key)) return;
  const market = state.markets.find((item) => favoriteKey(item) === key);
  if (!market) return;

  const wasFavorite = state.favoriteKeys.has(key);
  state.favoritePending.add(key);
  renderPage();

  try {
    const response = await fetch(favoritesEndpoint(`/api/favorites${wasFavorite ? `/${encodeURIComponent(key)}` : ""}`), {
      body: wasFavorite ? undefined : JSON.stringify({ market: toFavoriteMarket(market) }),
      headers: wasFavorite ? undefined : { "content-type": "application/json" },
      method: wasFavorite ? "DELETE" : "POST",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    setFavoriteKeys(payload.favorites);
    state.favoriteError = false;
  } catch (error) {
    console.error(error);
    state.favoriteError = true;
  } finally {
    state.favoritePending.delete(key);
    renderPage();
  }
}

async function loadRewards({ force = false } = {}) {
  state.loaded = false;
  if (force) state.error = false;
  renderPage();

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
    renderPage();
  }
}

document.documentElement.dataset.theme = localStorage.getItem("predict_alpha_theme") || "dark";
setAccent(localStorage.getItem("predict_alpha_accent") || "violet");
renderPage();
loadRewards();
loadFavorites();
setInterval(updateClock, 1000);
