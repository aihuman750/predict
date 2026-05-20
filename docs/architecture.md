# Architecture

## System Overview

Predict Rewards Monitor has three runtime surfaces:

1. Private Cloudflare Worker site for frontend assets, API routes, favorites, wallet monitoring, and reports.
2. Local development server for proxying live rewards data.
3. Predict APIs for positions, wallet auth, open orders, and market metadata.

```mermaid
flowchart LR
  A["PredAlpha rewards API"] --> E["Cloudflare Worker"]
  D["Private frontend assets"] --> E
  E --> D
  E --> F["Cloudflare KV"]
  E --> G["Feishu bot webhook"]
  E --> H["Google News RSS"]
  E --> J["Predict positions API"]
  E --> K["Predict auth and orders API"]
  I["Daily report workflow"] --> E
```

## Frontend

Files:

- `public/index.html`: page shell.
- `public/app.mjs`: rendering, UI state, favorite actions, and manual report trigger.
- `public/rewards-core.mjs`: shared rewards helpers and pure market logic.
- `public/wallet-core.mjs`: wallet address validation, position/order summaries, and market favorite conversion.
- `public/styles.css`: visual layout.

Production data path:

- On the Worker site, `public/app.mjs` reads same-origin `data/rewards.json`, which the Worker proxies live from PredAlpha after login.
- On `localhost`, `public/app.mjs` reads `/api/markets/rewards`.
- On `file://`, it reads the PredAlpha API directly.

The frontend fully rerenders on state changes. To avoid losing user context, `renderPage()` captures and restores:

- focused element id,
- search selection range,
- window scroll position,
- market table scroll position.

## Local Server

`server.mjs` serves static files from `public/` and proxies:

```text
GET /api/markets/rewards
```

The proxy forwards `PREDALPHA_API_KEY` as `x-api-key` when the variable is set. It keeps a 15 second in-memory response cache.

## Worker

Worker entrypoint: `worker/index.mjs`

Configured by `wrangler.toml`:

```toml
name = "predict-favorites"
main = "worker/index.mjs"
workers_dev = true

[assets]
directory = "./public"
binding = "ASSETS"
run_worker_first = true
```

KV namespace:

- Binding: `FAVORITES`
- Production id: `0e28a446d5f1460489ca5a7a8400a133`

Routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health check. |
| `POST` | `/api/site/login` | Validate `SITE_PASSWORD` and issue a seven-day signed HttpOnly cookie. |
| `POST` | `/api/site/logout` | Clear the site session cookie. |
| `GET` | `/api/site/status` | Return whether the current request has a valid site session. |
| `GET` | `/api/favorites` | Return all favorite markets. |
| `POST` | `/api/favorites` | Upsert one favorite market. |
| `DELETE` | `/api/favorites/:key` | Remove one favorite market. |
| `POST` | `/api/report/send` | Build and send the current favorite-market report to Feishu. |
| `GET` | `/api/predict-auth/status` | Return whether a Predict JWT is stored. |
| `GET` | `/api/predict-auth/message` | Proxy the official Predict auth message. |
| `POST` | `/api/predict-auth/token` | Exchange a wallet signature for a Predict JWT and store it encrypted in KV. |
| `GET` | `/api/wallets` | Return monitored wallet addresses. |
| `POST` | `/api/wallets` | Add one monitored wallet address. |
| `DELETE` | `/api/wallets/:address` | Remove one monitored wallet address. |
| `GET` | `/api/wallets/summary` | Fetch monitored wallet positions and auto-merge position markets into favorites. |
| `GET` | `/api/wallets/me/orders` | Fetch authenticated self-wallet open orders and auto-merge their markets into favorites. |

When `SITE_PASSWORD` is configured, all API routes except `/health`, `/api/site/login`, `/api/site/logout`, `/api/site/status`, and token-authorized `/api/report/send` require a valid site session cookie. Static assets are also served by the Worker only after this check.

## Data Model

KV key: `favorites:v1`

Value shape:

```json
[
  {
    "id": "32279",
    "key": "32279",
    "title": "Will Hylo launch a token by June 30, 2026?",
    "question": "Will Hylo launch a token by June 30, 2026?",
    "categorySlug": "will-hylo-launch-a-token-by",
    "yesBid": 0.056,
    "noBid": 0.942,
    "expiresAtSec": 1798794000,
    "url": "https://predict.fun/market/will-hylo-launch-a-token-by"
  }
]
```

KV key: `report:price-state:v1`

Value shape:

```json
{
  "generatedAt": "2026-05-19T02:00:00.000Z",
  "markets": {
    "32279": {
      "yesBid": 0.056,
      "noBid": 0.942
    }
  }
}
```

KV key: `wallets:v1`

Value shape:

```json
[
  "0x742d35cc6634c0532925a3b844bc454e4438f44e"
]
```

KV key: `predict:auth:v1`

Value shape: encrypted JSON created by the Worker. The plaintext contains the signer address, the Predict JWT, and the save timestamp. The plaintext value must not be logged or committed.

## Report Generation

Shared report helpers live in `scripts/report-core.mjs`.

The Worker report flow:

1. Read favorites from KV.
2. Fetch current rewards markets from `https://api.predalpha.xyz/api/markets/rewards`.
3. Read the previous price snapshot from KV.
4. Build price rows with latest Yes/No prices and deltas.
5. Search Google News RSS for event progress within a 48 hour window.
6. Send a signed interactive card to Feishu.
7. Store a new price snapshot in KV.

The report has two sections:

- Price changes: latest Yes/No and delta from the previous snapshot.
- Event progress: matching news item or `无进展`.

## Wallet Monitoring

The wallet monitor page is backed by Worker routes. Addresses are normalized to lowercase EVM addresses before storage.

`GET /api/wallets/summary`:

1. Reads `wallets:v1` from KV.
2. Fetches `GET https://api.predict.fun/v1/positions/{address}` for each address with Worker secret `PREDICT_API_KEY`.
3. Converts returned positions into display rows.
4. Converts each position market into a favorite-market candidate.
5. Merges candidates into `favorites:v1` without duplicating existing keys.

Self-wallet open-order flow:

1. Browser asks the selected injected wallet to connect.
2. Browser fetches `GET /api/predict-auth/message`.
3. Browser requests `personal_sign` for the official Predict login message.
4. Browser posts signer, message, and signature to `POST /api/predict-auth/token`.
5. Worker exchanges the signature for a Predict JWT and stores it encrypted in `predict:auth:v1`.
6. `GET /api/wallets/me/orders` calls `GET https://api.predict.fun/v1/orders?status=OPEN` with the stored JWT.
7. Worker fetches market metadata for each order, renders display rows, and auto-merges order markets into favorites.

Arbitrary-address open orders are still not fetched. Predict's documented `GET /v1/orders` endpoint lists the authenticated user's own orders and requires JWT authentication.

## Deployment

Cloudflare Worker workflow:

- File: `.github/workflows/cloudflare-worker.yml`
- Runs on push when Worker-related files change, or manual dispatch.
- Sets Worker secrets from GitHub Secrets, then runs `wrangler deploy`.
- Deploys `public/` as Workers static assets.

Daily report workflow:

- File: `.github/workflows/daily-report.yml`
- Runs at 10:00 Asia/Shanghai.
- Calls `POST https://predict-favorites.aihuman750.workers.dev/api/report/send`.
