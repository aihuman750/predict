# Wallet Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the app into market, favorites, and wallet-monitor pages, then add server-side Predict position monitoring that auto-adds position markets to favorites.

**Architecture:** Add pure wallet helper functions in `public/wallet-core.mjs`, reuse them from both the browser and Worker, and expose wallet routes from `worker/index.mjs`. Keep page switching inside the existing static frontend with hash routing.

**Tech Stack:** Static HTML/CSS/ES modules, Node test runner, Cloudflare Worker KV, GitHub Actions, Predict REST API.

---

### Task 1: Wallet Core Helpers

**Files:**
- Create: `public/wallet-core.mjs`
- Test: `test/wallet-core.test.mjs`

- [ ] Write failing tests for `normalizeWalletAddress`, `positionToFavoriteMarket`, `mergeFavoriteMarkets`, and `summarizePosition`.
- [ ] Run `node --test test/wallet-core.test.mjs` and confirm failures are due to missing exports.
- [ ] Implement the helpers in `public/wallet-core.mjs`.
- [ ] Run `node --test test/wallet-core.test.mjs` and confirm pass.

### Task 2: Worker Wallet Routes

**Files:**
- Modify: `worker/index.mjs`
- Modify: `test/worker.test.mjs`
- Modify: `.github/workflows/cloudflare-worker.yml`

- [ ] Write failing Worker tests for `GET /api/wallets`, `POST /api/wallets`, `DELETE /api/wallets/:address`, and `GET /api/wallets/summary`.
- [ ] Run `node --test test/worker.test.mjs` and confirm failures are due to missing wallet routes.
- [ ] Implement wallet KV reads/writes, Predict position fetch with `x-api-key`, summary response, and auto-favorite merge.
- [ ] Add `PREDICT_API_KEY` to the Worker secret sync step.
- [ ] Run `node --test test/worker.test.mjs` and confirm pass.

### Task 3: Frontend Page Split and Wallet UI

**Files:**
- Modify: `public/app.mjs`
- Modify: `public/styles.css`

- [ ] Add hash route state for `markets`, `favorites`, and `wallets`.
- [ ] Move `renderFavoritesSection()` so it renders only on the favorites page.
- [ ] Add wallet monitor state, form, monitored address list, positions display, and unavailable orders message.
- [ ] Load wallet summaries from `GET /api/wallets/summary`.
- [ ] Preserve existing search focus and scroll behavior on the market page.

### Task 4: Docs, Verification, Deployment

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/architecture.md`
- Modify: `docs/integration-guide.md`
- Modify: `docs/operator-runbook.md`
- Modify: `docs/handoff.md`

- [ ] Document wallet monitor routes, `PREDICT_API_KEY`, and limitations.
- [ ] Run `npm test`.
- [ ] Run `node --check public/app.mjs && node --check worker/index.mjs && node --check scripts/report-core.mjs && git diff --check`.
- [ ] Set GitHub Secret `PREDICT_API_KEY`.
- [ ] Push and verify GitHub Pages and Worker deployments.
- [ ] Verify online page navigation, wallet input behavior, and existing search/favorite behavior.
