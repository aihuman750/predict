# Operator Runbook

## Quick Status Checks

Check the site:

```bash
curl --fail --silent --head https://predict-favorites.aihuman750.workers.dev/
```

Check the Worker:

```bash
curl --fail --silent https://predict-favorites.aihuman750.workers.dev/health
```

Check favorites count after copying the logged-in browser's `pa_session` cookie:

```bash
curl --fail --silent --cookie 'pa_session=<redacted>' https://predict-favorites.aihuman750.workers.dev/api/favorites \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).favorites.length))'
```

Run local tests:

```bash
npm test
```

## Local Development

```bash
npm start
```

Open:

```text
http://localhost:5173
```

Optional:

```bash
PREDALPHA_API_KEY=<redacted> npm start
```

Do not put the real key in tracked files.

## Manual Deploys

Deploy Cloudflare Worker:

```bash
gh workflow run cloudflare-worker.yml --repo aihuman750/predict
```

Send the daily report manually through GitHub Actions:

```bash
gh workflow run daily-report.yml --repo aihuman750/predict
```

Run BTC backtest ingestion manually:

```bash
gh workflow run backtest-ingest.yml --repo aihuman750/predict \
  -f start=2026-05-01 \
  -f end=2026-06-01 \
  -f intervals=1h,15m,5m
```

Run one UTC day locally without writing D1:

```bash
PREDICT_API_KEY=<redacted> \
  node scripts/backtest-ingest.mjs --day 2026-06-01 --dry-run
```

## Required Secrets

Worker variables in `wrangler.toml`:

| Name | Purpose |
| --- | --- |
| `SITE_ACCESS_MODE = "public"` | Makes the deployed Worker site publicly accessible. Removing it or changing it restores the password gate. |
| `BACKTEST_DB` | D1 binding that stores BTC backtest markets, matches, ingestion runs, and daily matrices. |

GitHub Secrets:

| Name | Used by | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Worker deploy workflow | Cloudflare account selection. |
| `CLOUDFLARE_API_TOKEN` | Worker deploy workflow | Wrangler deploy and secret updates. |
| `BACKTEST_D1_DATABASE_ID` | Backtest ingestion workflow | Cloudflare D1 REST target for matrix and match writes. |
| `FEISHU_WEBHOOK` | Worker deploy workflow | Copied into Worker secret storage. |
| `FEISHU_SECRET` | Worker deploy workflow | Copied into Worker secret storage for Feishu signature checks. |
| `OPENAI_API_KEY` | Worker deploy workflow | Copied into Worker secret storage for GPT web-search impact briefs. |
| `PREDICT_API_KEY` | Worker deploy workflow | Copied into Worker secret storage for Predict wallet positions. |
| `REPORT_TOKEN` | Worker deploy workflow and daily report workflow | Authorizes scheduled report calls. |
| `SITE_PASSWORD` | Worker deploy workflow | Copied into Worker secret storage for private-mode login support and encrypted Predict JWT storage. |

Worker secrets:

- `FEISHU_WEBHOOK`
- `FEISHU_SECRET`
- `OPENAI_API_KEY`
- `PREDICT_API_KEY`
- `REPORT_TOKEN`
- `SITE_PASSWORD`

The Worker deployment workflow writes these values with `wrangler secret put`.

## Schedules

| Workflow | Schedule | Meaning |
| --- | --- | --- |
| `.github/workflows/daily-report.yml` | `0 2 * * *` UTC | Send Feishu report at 10:00 Asia/Shanghai. |
| `.github/workflows/backtest-ingest.yml` | `25 2 * * *` UTC | Fetch the previous UTC day's BTC 1h/15m/5m historical matches and write daily D1 matrices. |

## BTC Backtest D1 Setup

Create the D1 database once:

```bash
wrangler d1 create predict_backtest
```

Copy the returned database id into `wrangler.toml` under the `BACKTEST_DB` binding and GitHub Secret `BACKTEST_D1_DATABASE_ID`.

Apply the migration:

```bash
wrangler d1 migrations apply predict_backtest --remote
```

Backfill the latest 60 UTC days:

```bash
BACKTEST_D1_DATABASE_ID=<redacted> \
CLOUDFLARE_ACCOUNT_ID=<redacted> \
CLOUDFLARE_API_TOKEN=<redacted> \
PREDICT_API_KEY=<redacted> \
  node scripts/backtest-ingest.mjs --days 60
```

The script writes raw historical matches first, then daily matrices for each `day + interval + cutoff + perspective`. It uses `INSERT OR IGNORE` for matches and upserts matrices, so a date range can be rerun.

## Troubleshooting

### Site Shows Login Page

This should not happen in production while `SITE_ACCESS_MODE = "public"` is deployed. Check `wrangler.toml`, redeploy the Worker, and confirm `/api/site/status` returns `"public": true`. If private mode is intentionally restored, enter the site password; the cookie expires after 7 days.

### Site Loads But Rewards Are Stale

1. Confirm `https://api.predalpha.xyz/api/markets/rewards` is reachable.
2. Open `https://predict-favorites.aihuman750.workers.dev/data/rewards.json`.
3. Check the latest `Deploy Cloudflare Worker` workflow run.

### Favorites Do Not Sync

1. Check `https://predict-favorites.aihuman750.workers.dev/health`.
2. Check the `Deploy Cloudflare Worker` workflow status after any Worker change.
3. Verify the KV binding in `wrangler.toml` is still named `FAVORITES`.

### Manual Report Button Fails

1. Confirm the Worker has `FEISHU_WEBHOOK` and `FEISHU_SECRET` secrets.
2. Confirm the Feishu bot webhook and signing secret have not been rotated without updating GitHub Secrets.
3. Check whether `https://api.predalpha.xyz/api/markets/rewards` is reachable from the Worker.
4. Confirm `OPENAI_API_KEY` is set if the `价格影响简报` section shows the OpenAI fallback message. OpenAI failures should not block report delivery.

### Daily Report Fails

1. Check the `Daily Favorites Report` workflow log.
2. Confirm GitHub Secret `REPORT_TOKEN` matches the Worker secret `REPORT_TOKEN`.
3. Confirm the Worker has `OPENAI_API_KEY` if the report sends but lacks GPT impact details.
4. Trigger `daily-report.yml` manually after updating the secret.

### Wallet Positions Fail

1. Confirm the Worker has `PREDICT_API_KEY` set.
2. Confirm the private site session is valid.
3. Check `GET /api/wallets` with the `pa_session` cookie to confirm the address was saved.
4. Check `GET /api/wallets/summary` with the `pa_session` cookie and inspect whether each wallet has an `error` field.
5. Confirm the Predict API key still has access to `GET /v1/positions/{address}`.

### Activate Points Orderbook Counts Fail

1. Confirm the Worker has `PREDICT_API_KEY` set.
2. Confirm the private site session is valid.
3. Check one market orderbook response:

```bash
curl --fail --silent \
  --cookie 'pa_session=<redacted>' \
  https://predict-favorites.aihuman750.workers.dev/api/markets/388797/orderbook
```

4. If the route returns 500, confirm the Predict API key still has access to `GET /v1/markets/{id}/orderbook`.
5. If the route returns bids and asks but the table count is zero, inspect the rewards row's `spreadThreshold` and current best bid/ask. A spread outside the threshold intentionally produces zero active quantity.
6. Remember the UI sums eligible aggregated bid/ask quantities. Predict does not expose order age through this endpoint, so the five-minute active-order condition cannot be verified client-side.

### Backtest Page Has No Data

1. Confirm the Worker has the `BACKTEST_DB` D1 binding and `wrangler.toml` no longer contains the placeholder D1 id.
2. Check metadata:

```bash
curl --fail --silent https://predict-favorites.aihuman750.workers.dev/api/backtest/meta
```

3. If `coverage.start` is null, apply `migrations/0001_backtest.sql` and run the 60-day ingestion.
4. Check the `Backtest Ingestion` workflow logs. Confirm GitHub Secrets `BACKTEST_D1_DATABASE_ID`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `PREDICT_API_KEY` are set.
5. If `cutoff` is larger than the selected interval, confirm the API response `summary.normalizedCutoffs` maps that interval to its maximum duration.

### Points Monitor Has No Data

1. Check the top-200 leaderboard route:

```bash
curl --fail --silent https://predict-favorites.aihuman750.workers.dev/api/points/leaderboard
```

2. Confirm the response `windows` field shows the expected Predict week numbers. The baseline is week 23 starting on 2026-05-21 Asia/Shanghai time, with later weeks advancing every seven days.
3. If it returns `points_leaderboard_failed`, verify `https://graphql.predict.fun/graphql` is reachable and retry because the upstream occasionally resets TLS connections.
4. For a detail page, check the account route directly:

```bash
curl --fail --silent \
  https://predict-favorites.aihuman750.workers.dev/api/points/accounts/0x402582D54b7Bd3A44b57A6A0b4ac60c0BE1af608
```

5. If positions load but trades are empty, inspect the KV key pattern `points:trades:v1:<address>:<lastWeekFrom>:<thisWeekFrom>`. Cached trade rows with Predict market IDs/titles give the best event grouping.
6. If the Worker falls back to BNB Chain logs and returns asset-ID labels, the trade direction summary is still usable, but event names may be less readable until enriched cache data is written.

### My Open Orders Fail

1. Confirm the Worker has `SITE_PASSWORD` and `PREDICT_API_KEY` set.
2. Log in to the private site.
3. Open the wallet monitor page and reconnect the wallet so the Predict auth message is signed again.
4. Check auth status:

```bash
curl --fail --silent \
  --cookie 'pa_session=<redacted>' \
  https://predict-favorites.aihuman750.workers.dev/api/predict-auth/status
```

5. Check the open-order response shape:

```bash
curl --fail --silent \
  --cookie 'pa_session=<redacted>' \
  https://predict-favorites.aihuman750.workers.dev/api/wallets/me/orders
```

6. If `hasToken` is false, reconnect and sign again.
7. If `hasToken` is true but `orders` is empty, confirm there are active `OPEN` orders in Predict for the account represented by the JWT.
8. If `accountAddress` equals the login `signer` while the Predict UI shows positions under a different internal wallet, manually add that internal wallet address to the monitor for positions. Current open-order monitoring still cannot read arbitrary internal-wallet orders without a JWT for that Predict account.
9. If positions load but arbitrary-address orders do not, that is expected. Only the authenticated self-wallet orders endpoint is supported.

## Secret Hygiene

The Feishu webhook, Feishu signing secret, Cloudflare API token, Predict API key, report token, site password, and Predict JWT must never be committed. If a secret appears in a prompt, log, screenshot, or issue, rotate it before relying on it for production.
