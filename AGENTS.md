# Project Notes for Agents

This repository powers the private Predict rewards monitor at https://predict-favorites.aihuman750.workers.dev/.

## Current Architecture

- Frontend is static HTML/CSS/ESM under `public/`.
- Local development uses `server.mjs` to serve `public/` and proxy `/api/markets/rewards`.
- Production is served by the Cloudflare Worker in `worker/index.mjs` with a password gate and static assets binding.
- Production rewards data is fetched by the Worker at `/data/rewards.json`.
- Favorites and reports are handled by the Worker.
- Activate Points orderbook counts use Predict `/v1/markets/{id}/orderbook` through the Worker route `/api/markets/:id/orderbook`; frontend filtering helpers live in `public/orderbook-core.mjs`.
- Wallet monitoring is handled by Worker wallet routes and shared helpers in `public/wallet-core.mjs`.
- Self-wallet open orders are fetched through the Worker after Predict wallet signing stores an encrypted JWT in KV. The Worker calls Predict `/v1/account` after signing and stores the returned Predict account address when available.
- Shared market and report helpers live in `public/rewards-core.mjs` and `scripts/report-core.mjs`.

## Important URLs

- Private site and Worker: `https://predict-favorites.aihuman750.workers.dev`
- Predict market links: `https://predict.fun/market/<slug>`
- PredAlpha rewards source: `https://api.predalpha.xyz/api/markets/rewards`

## Worker API

- `GET /health`
- `GET /api/favorites`
- `POST /api/favorites`
- `DELETE /api/favorites/:key`
- `POST /api/report/send`
- `POST /api/site/login`
- `POST /api/site/logout`
- `GET /api/site/status`
- `GET /api/predict-auth/status`
- `GET /api/predict-auth/message`
- `POST /api/predict-auth/token`
- `GET /api/markets/:id/orderbook`
- `GET /api/wallets`
- `POST /api/wallets`
- `DELETE /api/wallets/:address`
- `GET /api/wallets/summary`
- `GET /api/wallets/me/orders`

Favorite data is stored in Cloudflare KV under `favorites:v1`. Report price snapshots are stored under `report:price-state:v1`.
Monitored wallet addresses are stored under `wallets:v1`.
The encrypted Predict JWT and Predict account metadata are stored under `predict:auth:v1`.

## Environment and Secrets

Local optional:

- `PREDALPHA_API_KEY`: forwarded by `server.mjs` when proxying rewards data.
- `PREDICT_API_KEY`: forwarded by `server.mjs` when proxying local orderbook data.

GitHub Secrets required for deployment and report sending:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `FEISHU_WEBHOOK`
- `FEISHU_SECRET`
- `PREDICT_API_KEY`
- `REPORT_TOKEN`
- `SITE_PASSWORD`

Do not write actual secret values into code, docs, tests, or commit messages.

## Verification

Before claiming this project is complete or deployed:

```bash
npm test
node --check public/app.mjs
node --check worker/index.mjs
node --check scripts/report-core.mjs
node --check public/wallet-core.mjs
git diff --check
```

For frontend changes, verify the deployed or local page in a browser. Search input should keep focus while typing, and favorite actions should not reset page or table scroll.

## Cleanup Rules

- `scripts/send-report.mjs` and `reports/price-state.json` are not part of the current production flow. The Worker owns report sending and stores snapshots in KV.
- Keep `docs/architecture.md`, `docs/integration-guide.md`, and `docs/operator-runbook.md` aligned when adding Worker routes, KV keys, environment variables, or deployment steps.
