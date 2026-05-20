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

```bash
curl --fail --silent https://predict-favorites.aihuman750.workers.dev/api/favorites
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

Browser writes are only accepted from allowed origins. Non-browser calls without an `Origin` header are accepted.

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

The web UI can also call this endpoint from an allowed browser origin.

## Error Responses

| Status | Error | Meaning |
| --- | --- | --- |
| `400` | `invalid_market` | The request body did not contain a usable `market`. |
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

## Wallet Monitor

### List Monitored Wallets

```bash
curl --fail --silent https://predict-favorites.aihuman750.workers.dev/api/wallets
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
  --data '{"address":"0x742d35cc6634c0532925a3b844bc454e4438f44e"}' \
  https://predict-favorites.aihuman750.workers.dev/api/wallets
```

Addresses must be valid EVM `0x` addresses and are stored lowercase.

### Remove a Monitored Wallet

```bash
curl --fail --silent \
  --request DELETE \
  https://predict-favorites.aihuman750.workers.dev/api/wallets/0x742d35cc6634c0532925a3b844bc454e4438f44e
```

### Fetch Wallet Summary

```bash
curl --fail --silent https://predict-favorites.aihuman750.workers.dev/api/wallets/summary
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
