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

## Required Secrets

GitHub Secrets:

| Name | Used by | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Worker deploy workflow | Cloudflare account selection. |
| `CLOUDFLARE_API_TOKEN` | Worker deploy workflow | Wrangler deploy and secret updates. |
| `FEISHU_WEBHOOK` | Worker deploy workflow | Copied into Worker secret storage. |
| `FEISHU_SECRET` | Worker deploy workflow | Copied into Worker secret storage for Feishu signature checks. |
| `PREDICT_API_KEY` | Worker deploy workflow | Copied into Worker secret storage for Predict wallet positions. |
| `REPORT_TOKEN` | Worker deploy workflow and daily report workflow | Authorizes scheduled report calls. |
| `SITE_PASSWORD` | Worker deploy workflow | Copied into Worker secret storage for the private site login and encrypted Predict JWT storage. |

Worker secrets:

- `FEISHU_WEBHOOK`
- `FEISHU_SECRET`
- `PREDICT_API_KEY`
- `REPORT_TOKEN`
- `SITE_PASSWORD`

The Worker deployment workflow writes these values with `wrangler secret put`.

## Schedules

| Workflow | Schedule | Meaning |
| --- | --- | --- |
| `.github/workflows/daily-report.yml` | `0 2 * * *` UTC | Send Feishu report at 10:00 Asia/Shanghai. |

## Troubleshooting

### Site Shows Login Page

This is expected for browsers without a valid session. Enter the private site password. The cookie expires after 7 days.

### Site Loads But Rewards Are Stale

1. Confirm `https://api.predalpha.xyz/api/markets/rewards` is reachable.
2. Log in to the private site and open `https://predict-favorites.aihuman750.workers.dev/data/rewards.json`.
3. Check the latest `Deploy Cloudflare Worker` workflow run.

### Favorites Do Not Sync

1. Check `https://predict-favorites.aihuman750.workers.dev/health`.
2. Confirm the browser is logged in to the private Worker site.
3. Check the `Deploy Cloudflare Worker` workflow status after any Worker change.
4. Verify the KV binding in `wrangler.toml` is still named `FAVORITES`.

### Manual Report Button Fails

1. Confirm the Worker has `FEISHU_WEBHOOK` and `FEISHU_SECRET` secrets.
2. Confirm the Feishu bot webhook and signing secret have not been rotated without updating GitHub Secrets.
3. Check whether `https://api.predalpha.xyz/api/markets/rewards` is reachable from the Worker.
4. Check whether Google News RSS requests are failing. If they fail, event progress falls back to `无进展`, but report delivery should still work.

### Daily Report Fails

1. Check the `Daily Favorites Report` workflow log.
2. Confirm GitHub Secret `REPORT_TOKEN` matches the Worker secret `REPORT_TOKEN`.
3. Trigger `daily-report.yml` manually after updating the secret.

### Wallet Positions Fail

1. Confirm the Worker has `PREDICT_API_KEY` set.
2. Check `GET /api/wallets` to confirm the address was saved.
3. Check `GET /api/wallets/summary` and inspect whether each wallet has an `error` field.
4. Confirm the Predict API key still has access to `GET /v1/positions/{address}`.

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
5. If the route returns bids and asks but the table count is zero, inspect the rewards row's `spreadThreshold` and current best bid/ask. A spread outside the threshold intentionally produces zero active levels.
6. Remember the UI counts eligible aggregated price levels. Predict does not expose order age through this endpoint, so the five-minute active-order condition cannot be verified client-side.

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
