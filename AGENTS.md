# Project Notes for Agents

This repository powers the Predict rewards monitor at https://aihuman750.github.io/predict/.

## Current Architecture

- Frontend is static HTML/CSS/ESM under `public/`.
- Local development uses `server.mjs` to serve `public/` and proxy `/api/markets/rewards`.
- Production rewards data is the static file `public/data/rewards.json`, refreshed by `.github/workflows/pages.yml`.
- Favorites and reports are handled by the Cloudflare Worker in `worker/index.mjs`.
- Wallet monitoring is handled by Worker wallet routes and shared helpers in `public/wallet-core.mjs`.
- Shared market and report helpers live in `public/rewards-core.mjs` and `scripts/report-core.mjs`.

## Important URLs

- Site: `https://aihuman750.github.io/predict/`
- Worker: `https://predict-favorites.aihuman750.workers.dev`
- Predict market links: `https://predict.fun/market/<slug>`
- PredAlpha rewards source: `https://api.predalpha.xyz/api/markets/rewards`

## Worker API

- `GET /health`
- `GET /api/favorites`
- `POST /api/favorites`
- `DELETE /api/favorites/:key`
- `POST /api/report/send`
- `GET /api/wallets`
- `POST /api/wallets`
- `DELETE /api/wallets/:address`
- `GET /api/wallets/summary`

Favorite data is stored in Cloudflare KV under `favorites:v1`. Report price snapshots are stored under `report:price-state:v1`.
Monitored wallet addresses are stored under `wallets:v1`.

## Environment and Secrets

Local optional:

- `PREDALPHA_API_KEY`: forwarded by `server.mjs` when proxying rewards data.

GitHub Secrets required for deployment and report sending:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `FEISHU_WEBHOOK`
- `FEISHU_SECRET`
- `PREDICT_API_KEY`
- `REPORT_TOKEN`

Do not write actual secret values into code, docs, tests, or commit messages.

## Verification

Before claiming this project is complete or deployed:

```bash
npm test
node --check public/app.mjs
node --check worker/index.mjs
node --check scripts/report-core.mjs
git diff --check
```

For frontend changes, verify the deployed or local page in a browser. Search input should keep focus while typing, and favorite actions should not reset page or table scroll.

## Cleanup Rules

- `scripts/send-report.mjs` and `reports/price-state.json` are not part of the current production flow. The Worker owns report sending and stores snapshots in KV.
- Keep `docs/architecture.md`, `docs/integration-guide.md`, and `docs/operator-runbook.md` aligned when adding Worker routes, KV keys, environment variables, or deployment steps.
