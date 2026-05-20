# Operator Runbook

## Quick Status Checks

Check the site:

```bash
curl --fail --silent --head https://aihuman750.github.io/predict/
```

Check the Worker:

```bash
curl --fail --silent https://predict-favorites.aihuman750.workers.dev/health
```

Check favorites count:

```bash
curl --fail --silent https://predict-favorites.aihuman750.workers.dev/api/favorites \
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

Deploy GitHub Pages:

```bash
gh workflow run pages.yml --repo aihuman750/predict
```

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

Worker secrets:

- `FEISHU_WEBHOOK`
- `FEISHU_SECRET`
- `PREDICT_API_KEY`
- `REPORT_TOKEN`

The Worker deployment workflow writes these values with `wrangler secret put`.

## Schedules

| Workflow | Schedule | Meaning |
| --- | --- | --- |
| `.github/workflows/pages.yml` | `*/5 * * * *` UTC | Refresh Pages rewards snapshot every 5 minutes. |
| `.github/workflows/daily-report.yml` | `0 2 * * *` UTC | Send Feishu report at 10:00 Asia/Shanghai. |

## Troubleshooting

### Site Loads But Rewards Are Stale

1. Check the latest `Deploy GitHub Pages` workflow run.
2. Confirm the `Fetch rewards snapshot` step succeeded.
3. Open `https://aihuman750.github.io/predict/data/rewards.json` and confirm it returns JSON.
4. Manually run `pages.yml` if needed.

### Favorites Do Not Sync

1. Check `https://predict-favorites.aihuman750.workers.dev/health`.
2. Confirm the browser origin is in `ALLOWED_ORIGINS` in `worker/index.mjs`.
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
5. If positions load but orders do not, that is expected for this iteration because arbitrary-address open-order monitoring is not exposed by the documented public orders endpoint.

## Secret Hygiene

The Feishu webhook, Feishu signing secret, Cloudflare API token, Predict API key, and report token must never be committed. If a secret appears in a prompt, log, screenshot, or issue, rotate it before relying on it for production.
