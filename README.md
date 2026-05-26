# Predict Rewards Monitor

Predict Rewards Monitor is a private Worker-hosted rewards-market dashboard for Predict alpha. It shows active rewards markets, links each row to the matching Predict market, tracks favorite markets in Cloudflare KV, monitors wallet positions and self-wallet open orders, and sends favorite-market reports to a Feishu bot.

Production URLs:

- Private site and Worker: https://predict-favorites.aihuman750.workers.dev

## Features

- Rewards market table sorted by points per hour, with search, expiry filters, density controls, quote prices, and competition tiers.
- Activate Points orderbook counts and expandable bid/ask depth for each rewards market.
- Direct market links to `https://predict.fun/market/<slug>`.
- Favorite star on every market row.
- Favorite list with latest Yes/No prices.
- Wallet monitor page for Predict wallet positions.
- Position markets from monitored wallets are automatically merged into favorites.
- Wallet signing flow for the user's own Predict account, with authenticated open orders and Predict account-address detection through `/v1/account`.
- Open-order markets are automatically merged into favorites.
- Manual "推送最新报告" button that sends the current favorite-market report to Feishu.
- Daily favorite-market report at 10:00 Asia/Shanghai via GitHub Actions calling the Worker report endpoint.

## Local Development

Requirements:

- Node.js 22 or newer for parity with the Worker deployment workflow.

Run locally:

```bash
npm start
```

Then open:

```text
http://localhost:5173
```

Optional environment variable:

- `PREDALPHA_API_KEY`: forwarded by `server.mjs` as `x-api-key` when fetching `https://api.predalpha.xyz/api/markets/rewards`.
- `PREDICT_API_KEY`: forwarded by `server.mjs` when proxying local orderbook requests to `https://api.predict.fun/v1/markets/{id}/orderbook`.

The local server serves `public/`, proxies `/api/markets/rewards` to PredAlpha with a 15 second in-memory cache, and proxies `/api/markets/:id/orderbook` to Predict when `PREDICT_API_KEY` is set.

## Tests

```bash
npm test
```

The test suite covers rewards-table helpers, Activate Points orderbook filtering, wallet/order formatting, report markdown generation, Worker favorite APIs, private site login, Predict auth routing, wallet monitoring, self-order monitoring, and Worker report sending with mocked Feishu and rewards responses.

## Deployment

Cloudflare Worker deploys the private site, favorite storage, wallet monitoring, authenticated open-order monitoring, and report sending.

- Workflow: `.github/workflows/cloudflare-worker.yml`
- Worker config: `wrangler.toml`
- Worker name: `predict-favorites`
- KV binding: `FAVORITES`
- Static assets: `public/`, served by the Worker after password login.

Daily Feishu report:

- Workflow: `.github/workflows/daily-report.yml`
- Schedule: `0 2 * * *` UTC, which is 10:00 Asia/Shanghai.
- The workflow calls `POST /api/report/send` with `x-report-token`.

Required GitHub Secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `FEISHU_WEBHOOK`
- `FEISHU_SECRET`
- `PREDICT_API_KEY`
- `REPORT_TOKEN`
- `SITE_PASSWORD`

Do not commit secret values to the repository.

## Documentation

- [Architecture](docs/architecture.md)
- [Integration Guide](docs/integration-guide.md)
- [Operator Runbook](docs/operator-runbook.md)
- [Handoff](docs/handoff.md)
