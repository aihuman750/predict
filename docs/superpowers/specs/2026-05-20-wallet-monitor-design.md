# Wallet Monitor Design

Status note, 2026-05-26: this design describes the initial wallet-position monitor. It was later extended by the private Worker site and self-wallet order auth flow in `docs/superpowers/specs/2026-05-20-private-wallet-orders-design.md`; GitHub Pages is no longer the production host.

## Goal

Split the app into three pages and add a stable wallet-monitor page that can track Predict wallet positions, while clearly marking arbitrary-address open orders as unavailable until Predict exposes a suitable public endpoint.

## Source APIs

Predict positions API:

- `GET https://api.predict.fun/v1/positions/{address}`
- Requires `x-api-key`
- Returns position rows with `market`, `outcome`, `amount`, `valueUsd`, `averageBuyPriceUsd`, and `pnlUsd`.

Predict orders API:

- `GET https://api.predict.fun/v1/orders`
- Requires `x-api-key` and JWT.
- Documentation describes it as listing the authenticated user's own orders, so it is not suitable for public arbitrary-address order monitoring.

## UX

Top navigation has three pages:

- `积分市场`
- `收藏列表`
- `钱包监控`

`积分市场` contains only the rewards stats and rewards market table.

`收藏列表` contains the favorite-market list and manual Feishu report button.

`钱包监控` contains:

- an address input,
- monitored address list,
- per-address positions,
- per-address orders section that says public arbitrary-address order monitoring is not available,
- clear errors when an address is invalid or the upstream API fails.

## Data Ownership

Monitored wallet addresses are stored in Cloudflare KV, not localStorage, so the monitor scope is shared with the deployed app and future automated flows.

KV keys:

- `wallets:v1`: array of normalized lowercase EVM addresses.
- Existing `favorites:v1`: still stores favorite markets.

## Worker API

New routes:

- `GET /api/wallets`
- `POST /api/wallets`
- `DELETE /api/wallets/:address`
- `GET /api/wallets/summary`

`GET /api/wallets/summary` fetches positions for all monitored wallets, converts position markets into favorite-market objects, merges them into `favorites:v1`, and returns a per-address summary.

## Auto Favorites

Markets found in monitored wallet positions are automatically added to favorites.

Deduplication uses the same key priority as rewards favorites:

1. market id,
2. slug,
3. category slug,
4. category,
5. slugified market question/title.

If a position market already exists in favorites, it is not duplicated.

## Security

The Predict API key must be a Worker secret named `PREDICT_API_KEY`. It must never be committed.

GitHub Actions will copy `PREDICT_API_KEY` from GitHub Secrets into Worker secrets during Worker deployment.

## Testing

Add tests for:

- wallet address normalization and validation,
- positions-to-favorites conversion,
- favorites merging without duplicates,
- Worker wallet add/list/delete routes,
- Worker summary route fetching positions with `x-api-key`,
- Worker summary route auto-adding position markets into favorites.

## Non-Goals

- No JWT order auth flow in the initial wallet-position iteration. Self-wallet auth was added later in the private Worker order-monitor work.
- No private per-user storage. Existing project state is global/shared through Worker KV.
- No automatic scheduled wallet refresh beyond summary calls from the wallet page.
