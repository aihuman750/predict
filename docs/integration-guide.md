# Integration Guide

This guide is for code or operators that need to read favorites, change favorites, or trigger a report without using the web UI.

Base URL:

```text
https://predict-favorites.aihuman750.workers.dev
```

## Health Check

```bash
curl --fail --silent https://predict-favorites.aihuman750.workers.dev/health
```

Expected response:

```json
{"ok":true}
```

## List Favorites

Production currently runs with `SITE_ACCESS_MODE = "public"`, so API reads do not require a site session cookie. If private mode is restored, include the `pa_session` cookie from `/api/site/login`.

```bash
curl --fail --silent \
  https://predict-favorites.aihuman750.workers.dev/api/favorites
```

Response shape:

```json
{
  "favorites": [
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
}
```

## Add or Update a Favorite

Production public mode allows same-site browser writes and curl calls without a site cookie. Private mode requires a valid site session.

```bash
curl --fail --silent \
  --request POST \
  --header "content-type: application/json" \
  --data '{
    "market": {
      "key": "32279",
      "title": "Will Hylo launch a token by June 30, 2026?",
      "question": "Will Hylo launch a token by June 30, 2026?",
      "categorySlug": "will-hylo-launch-a-token-by",
      "url": "https://predict.fun/market/will-hylo-launch-a-token-by"
    }
  }' \
  https://predict-favorites.aihuman750.workers.dev/api/favorites
```

Response shape:

```json
{
  "favorites": []
}
```

The returned `favorites` array is the complete post-write list.

## Remove a Favorite

```bash
curl --fail --silent \
  --request DELETE \
  https://predict-favorites.aihuman750.workers.dev/api/favorites/32279
```

The response is the complete post-delete favorites list.

## Send a Report

For scheduled or server-side callers, pass `x-report-token` with the value stored in GitHub Secret `REPORT_TOKEN`.

```bash
curl --fail --silent \
  --request POST \
  --header "x-report-token: $REPORT_TOKEN" \
  https://predict-favorites.aihuman750.workers.dev/api/report/send
```

Response shape:

```json
{
  "favoriteCount": 15,
  "ok": true,
  "sentAt": "2026-05-19T15:51:00.000Z"
}
```

The web UI can also call this endpoint from the public site. Private mode requires a valid site session.

## Error Responses

| Status | Error | Meaning |
| --- | --- | --- |
| `400` | `invalid_market` | The request body did not contain a usable `market`. |
| `401` | `auth_required` | Private mode is active and a site session cookie is required. |
| `403` | `origin_not_allowed` | Browser origin or report token is not allowed. |
| `404` | `not_found` | Route does not exist. |
| `500` | `report_failed` | Report generation or Feishu delivery failed. |
| `500` | `wallet_summary_failed` | Wallet summary fetch or auto-favorite merge failed. |

## Favorite Key Rules

The frontend uses `favoriteKey()` from `public/rewards-core.mjs`.

Priority:

1. `id`
2. `slug`
3. `categorySlug`
4. `category`
5. slugified `question` or `title`

Report matching uses the key first, then category, then normalized question text.

## Market Orderbooks

The private site uses this route to calculate Activate Points depth without exposing the Predict API key to the browser:

```bash
curl --fail --silent \
  --cookie 'pa_session=<redacted>' \
  https://predict-favorites.aihuman750.workers.dev/api/markets/388797/orderbook
```

Response shape:

```json
{
  "orderbook": {
    "marketId": 388797,
    "updateTimestampMs": 1779775202089,
    "bids": [[0.49, 120]],
    "asks": [[0.53, 150]]
  }
}
```

`bids` and `asks` are Yes-side aggregated price levels. `public/orderbook-core.mjs` combines this data with the rewards row's `spreadThreshold`, `shareThreshold`, and `tick` to sum and render Activate Points-eligible bid/ask quantities. The endpoint does not expose individual order makers, hashes, or order age.

## Wallet Monitor

### Predict Auth Status

```bash
curl --fail --silent \
  --cookie 'pa_session=<redacted>' \
  https://predict-favorites.aihuman750.workers.dev/api/predict-auth/status
```

Response shape:

```json
{
  "accountAddress": "0x1111111111111111111111111111111111111111",
  "hasToken": true,
  "signer": "0x742d35cc6634c0532925a3b844bc454e4438f44e"
}
```

`signer` is the browser wallet that signed the Predict login message. `accountAddress` is the Predict account address returned by `/v1/account` when the Worker exchanged the signature for a JWT.

### List Monitored Wallets

```bash
curl --fail --silent \
  --cookie 'pa_session=<redacted>' \
  https://predict-favorites.aihuman750.workers.dev/api/wallets
```

Response:

```json
{
  "wallets": [
    "0x742d35cc6634c0532925a3b844bc454e4438f44e"
  ]
}
```

### Add a Monitored Wallet

```bash
curl --fail --silent \
  --request POST \
  --header "content-type: application/json" \
  --cookie 'pa_session=<redacted>' \
  --data '{"address":"0x742d35cc6634c0532925a3b844bc454e4438f44e"}' \
  https://predict-favorites.aihuman750.workers.dev/api/wallets
```

Addresses must be valid EVM `0x` addresses and are stored lowercase.

### Remove a Monitored Wallet

```bash
curl --fail --silent \
  --request DELETE \
  --cookie 'pa_session=<redacted>' \
  https://predict-favorites.aihuman750.workers.dev/api/wallets/0x742d35cc6634c0532925a3b844bc454e4438f44e
```

### Fetch Wallet Summary

```bash
curl --fail --silent \
  --cookie 'pa_session=<redacted>' \
  https://predict-favorites.aihuman750.workers.dev/api/wallets/summary
```

Response shape:

```json
{
  "favoritesAdded": 1,
  "wallets": [
    {
      "address": "0x742d35cc6634c0532925a3b844bc454e4438f44e",
      "error": null,
      "orders": {
        "available": false,
        "reason": "Predict public API does not expose arbitrary-address open orders."
      },
      "positions": [
        {
          "id": "position-1",
          "marketId": "32279",
          "title": "Will Hylo launch a token by June 30, 2026?",
          "outcome": "Yes",
          "amount": "10",
          "valueUsd": "1.25",
          "averageBuyPriceUsd": "0.12",
          "pnlUsd": "0.05",
          "url": "https://predict.fun/market/will-hylo-launch-a-token-by"
        }
      ]
    }
  ]
}
```

### Self-Wallet Open Orders

The browser UI is the normal integration path because the wallet must sign the official Predict auth message with `personal_sign`.

After signing, the Worker stores an encrypted Predict JWT in KV and exposes:

```bash
curl --fail --silent \
  --cookie 'pa_session=<redacted>' \
  https://predict-favorites.aihuman750.workers.dev/api/wallets/me/orders
```

Response shape:

```json
{
  "favoritesAdded": 1,
  "accountAddress": "0x1111111111111111111111111111111111111111",
  "hasToken": true,
  "signer": "0x742d35cc6634c0532925a3b844bc454e4438f44e",
  "orders": [
    {
      "id": "order-1",
      "hash": "0xhash",
      "marketId": "456",
      "title": "Will Nexus FDV be above $50M one day after launch?",
      "outcome": "Yes",
      "side": "买入",
      "price": "0.5",
      "quantity": "10",
      "remainingQuantity": "8",
      "amountFilled": "2",
      "rewardEarningRate": "4.25",
      "status": "OPEN",
      "strategy": "LIMIT",
      "expiration": "2026-10-01 08:00",
      "url": "https://predict.fun/market/nexus-fdv-above-50m-one-day-after-launch"
    }
  ]
}
```
