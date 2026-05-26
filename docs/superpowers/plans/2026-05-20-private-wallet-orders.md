# Private Wallet Orders Implementation Plan

Status note, 2026-05-26: this plan was implemented in `0e05baf`. A follow-up in `05512d0` added `/v1/account` lookup so the stored Predict account address is tracked separately from the login signer.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move production access behind a Worker password gate and add wallet signing for authenticated self-wallet open order monitoring.

**Architecture:** The Worker serves static assets through an `ASSETS` binding after checking a signed seven-day site session cookie. Predict auth and orders stay server-side: the browser signs the official Predict auth message, the Worker exchanges it for a JWT, stores it encrypted in KV, then uses it to fetch open orders and merge their markets into favorites.

**Tech Stack:** Static HTML/CSS/ES modules, Cloudflare Workers static assets, Cloudflare KV, Web Crypto, injected EIP-1193 browser wallets, Node test runner, GitHub Actions.

---

### Task 1: Shared Order Helpers

**Files:**
- Modify: `public/wallet-core.mjs`
- Test: `test/wallet-core.test.mjs`

- [ ] Add tests for converting an authenticated Predict order plus market into a favorite market and a display summary.
- [ ] Run `node --test test/wallet-core.test.mjs` and confirm the new tests fail because the helpers are missing.
- [ ] Add `marketToFavoriteMarket`, `orderToFavoriteMarket`, and `summarizeOrder`.
- [ ] Run `node --test test/wallet-core.test.mjs` and confirm the helper tests pass.

### Task 2: Worker Auth and Orders

**Files:**
- Modify: `worker/index.mjs`
- Modify: `test/worker.test.mjs`

- [ ] Add failing Worker tests for site login, protected API access, Predict auth message proxying, JWT exchange, and open order summaries.
- [ ] Run `node --test test/worker.test.mjs` and confirm the new tests fail for missing routes and auth checks.
- [ ] Implement signed seven-day site sessions with `SITE_PASSWORD`.
- [ ] Implement encrypted Predict JWT KV storage under `predict:auth:v1`.
- [ ] Implement `/api/predict-auth/message`, `/api/predict-auth/token`, and `/api/wallets/me/orders`.
- [ ] Serve static assets through `env.ASSETS.fetch(request)` only after authentication.
- [ ] Run `node --test test/worker.test.mjs` and confirm Worker tests pass.

### Task 3: Frontend Wallet Signing UI

**Files:**
- Modify: `public/app.mjs`
- Modify: `public/styles.css`

- [ ] Add wallet provider detection for OKX, Binance, MetaMask, and generic EIP-1193 providers.
- [ ] Add a self-wallet panel on the wallet monitor page with connect/sign buttons and order refresh.
- [ ] Call `/api/predict-auth/message`, request `personal_sign`, submit to `/api/predict-auth/token`, then refresh `/api/wallets/me/orders`.
- [ ] Render open orders in a stable responsive list.
- [ ] Run `node --check public/app.mjs`.

### Task 4: Deployment

**Files:**
- Modify: `wrangler.toml`
- Modify: `.github/workflows/cloudflare-worker.yml`
- Delete: `.github/workflows/pages.yml`
- Modify: docs and runbook files

- [ ] Add a Workers static assets binding for `public/`.
- [ ] Add `SITE_PASSWORD` to Worker secret synchronization.
- [ ] Make the Worker deploy workflow run when `public/**` changes.
- [ ] Remove GitHub Pages deployment so the app is no longer redeployed publicly there.
- [ ] Update docs with the private Worker URL, new routes, KV key, and secret.

### Task 5: Verification and Deployment

- [ ] Set `SITE_PASSWORD` as a GitHub Secret and deploy it to the Worker through the workflow.
- [ ] Run `npm test`.
- [ ] Run `node --check public/app.mjs && node --check worker/index.mjs && node --check scripts/report-core.mjs && node --check public/wallet-core.mjs && git diff --check`.
- [ ] Deploy the Worker.
- [ ] Verify `/health` remains public.
- [ ] Verify the Worker root shows the login page without a cookie.
- [ ] Verify a valid login reaches the app and protected APIs work.
- [ ] Verify the wallet page renders the signing controls and open-order section.
