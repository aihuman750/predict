# Predict Rewards Monitor

Predict Rewards Monitor is a public Worker-hosted rewards-market dashboard for Predict alpha. It shows active rewards markets, links each row to the matching Predict market, tracks favorite markets in Cloudflare KV, monitors wallet positions and self-wallet open orders, and sends favorite-market reports to a Feishu bot.

Production URLs:

- Site and Worker: https://predict-favorites.aihuman750.workers.dev

## Features

- Rewards market table sorted by points per hour, with search, expiry filters, density controls, quote prices, and competition tiers.
- Activate Points orderbook quantity totals and expandable bid/ask depth for each rewards market.
- Direct market links to `https://predict.fun/market/<slug>`.
- Favorite star on every market row.
- Favorite list with latest Yes/No prices.
- Wallet monitor page for Predict wallet positions.
- Points monitor page for the top 200 weekly points accounts, with portfolio stats, public positions, cached trade details, and strategy summaries.
- Position markets from monitored wallets are automatically merged into favorites.
- Wallet signing flow for the user's own Predict account, with authenticated open orders and Predict account-address detection through `/v1/account`.
- Open-order markets are automatically merged into favorites.
- Manual "推送最新报告" button that sends the current favorite-market report to Feishu.
- Daily favorite-market report at 10:00 Asia/Shanghai via GitHub Actions calling the Worker report endpoint. The report includes price changes plus a GPT web-search impact brief generated from fixed market summaries.

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

The test suite covers rewards-table helpers, Activate Points orderbook filtering, points-monitor normalization, wallet/order formatting, market-summary generation, report markdown generation, Worker favorite APIs, public/private site access, Predict auth routing, wallet monitoring, self-order monitoring, and Worker report sending with mocked Feishu, OpenAI, and rewards responses.

## Deployment

Cloudflare Worker deploys the public site, favorite storage, points monitoring, wallet monitoring, authenticated open-order monitoring, and report sending.

- Workflow: `.github/workflows/cloudflare-worker.yml`
- Worker config: `wrangler.toml`
- Worker name: `predict-favorites`
- KV binding: `FAVORITES`
- Static assets: `public/`, served publicly by the Worker when `SITE_ACCESS_MODE = "public"`.

Worker vars:

- `SITE_ACCESS_MODE = "public"` keeps the deployed site publicly accessible. Removing it or changing it to another value restores the password gate.
- Wallet and Predict auth APIs still require a private `pa_session` in public mode so real wallet identifiers are not exposed through public reads.

Daily Feishu report:

- Workflow: `.github/workflows/daily-report.yml`
- Schedule: `0 2 * * *` UTC, which is 10:00 Asia/Shanghai.
- The workflow calls `POST /api/report/send` with `x-report-token`.

Required GitHub Secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `FEISHU_WEBHOOK`
- `FEISHU_SECRET`
- `OPENAI_API_KEY`
- `PREDICT_API_KEY`
- `REPORT_TOKEN`
- `SITE_PASSWORD`

`SITE_PASSWORD` is still kept as a secret for private-mode login support and encrypted Predict JWT storage. Do not commit secret values to the repository.

## Documentation

- [Architecture](docs/architecture.md)
- [Integration Guide](docs/integration-guide.md)
- [Operator Runbook](docs/operator-runbook.md)
- [Handoff](docs/handoff.md)
