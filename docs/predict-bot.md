# Predict Trading Bot

This bot targets only configured Predict Up or Down markets. In the current live
setup, BTC 1-hour and BTC 15-minute markets run together; ETH and BNB are
disabled through `PREDICT_BOT_ASSETS=BTC`. It discovers current markets through
the Predict search API, reads each market orderbook, and generates strategy
actions for the configured intervals.

## Current Safety Boundary

The bot is dry-run by default. Live trading is only enabled with `--live` and the
private-key wallet environment variables listed below. Predict order creation
requires an API key, a JWT, and a signed order payload; the API key alone is not
enough to place orders.

Predict's current SDK package is `@predictdotfun/sdk` (`1.3.5` when checked).
Official docs show live order work going through `OrderBuilder` on BNB mainnet.
This implementation uses an EOA private-key wallet flow first. For a Predict
account, a later adapter would also need the Predict account/deposit address and
the Privy wallet private key. These values must be supplied by environment
variables or a secret manager, never by committed files.

Do not write real API keys, JWTs, private keys, or wallet identifiers into this
repository.

## Strategy

- At market start, place two buy orders:
  - Up/Yes: 101 shares at API price `0.05`.
  - Down/No: 101 shares at API price `0.05`.
- When filled shares exist:
  - Immediately place sell orders for all filled shares at `0.10`.
- Ten minutes before the market ends, cancel remaining unfilled buy shares.
- BTC 1-hour markets use a 30-minute buy window.
- BTC 15-minute markets use a 5-minute buy window.

Predict orderbooks are stored on a Yes-price basis. For Down/No, the bot derives
the best bid from the best Yes ask.

## Risk Controls

- Hard allowlist: BTC, ETH, and BNB only. Use `PREDICT_BOT_ASSETS` to narrow
  live trading to a subset, for example `BTC`.
- Hard per-outcome share cap: 101 shares.
- Max cumulative-loss pause: once realized PnL for new-strategy bot markets
  reaches `-20 USDT`, the bot latches a risk pause and stops creating new buy
  orders. The PnL baseline is stored in local state as `risk.pnlBaselineAt`, so
  old strategy fills and old positions are ignored. Sell orders for existing
  filled shares and cancellations for open buy orders are still allowed so
  exposure can be reduced. Override with `PREDICT_BOT_MAX_LOSS_USDT`.
- Start-window guard: new start orders are only generated during the configured
  buy window for that interval.
- Sell-window guard: none. Filled shares can generate sell orders at any time.
- End-window guard: unfilled buys are cancelled at `endsAt - 10 minutes`.
- Dry-run default: actions are recorded locally, not sent to Predict.
- Live signing only reads secrets from environment variables.
- Kill switch:
  - Set `PREDICT_BOT_DISABLED=1`, or
  - Create `.predict-bot-kill-switch` in the project root.
- Local state is stored in `.predict-bot-state.json`, which is ignored by git.
- Live order cancellation currently uses Predict's fast `/v1/orders/remove`
  endpoint to remove the order from the orderbook. Predict docs note this does
  not invalidate the order on-chain; use a dedicated low-balance bot wallet and
  periodically rotate it until on-chain batch cancellation is added.

## Run

Run once:

```bash
PREDICT_BOT_API_KEY='<redacted>' node scripts/predict-bot.mjs --once
```

Run continuously:

```bash
PREDICT_BOT_API_KEY='<redacted>' node scripts/predict-bot.mjs --loop --poll-seconds 20
```

Use a custom local state file:

```bash
PREDICT_BOT_API_KEY='<redacted>' node scripts/predict-bot.mjs --once --state-file /tmp/predict-bot-state.json
```

The script prints discovered markets and generated actions as JSON. In dry-run
mode, generated actions are also applied to the local state file so repeated runs
do not keep planning the same buy orders.

In live mode, the bot first reads the authenticated account, current OPEN orders,
and current positions from Predict, then syncs those rows into local state before
building the next actions. This is what lets a filled buy become a sell action on
the next poll.

Run live with an EOA private-key wallet:

```bash
PREDICT_BOT_API_KEY='<redacted>' \
PREDICT_BOT_WALLET_PRIVATE_KEY='<redacted>' \
PREDICT_BOT_RPC_URL='https://<your-bnb-rpc>' \
node scripts/predict-bot.mjs --once --live
```

`PREDICT_BOT_JWT` is optional. When omitted, the bot requests the dynamic auth
message from Predict, signs it with the EOA wallet, and uses the returned JWT in
memory only.

## Hourly Reports

Generate a report once:

```bash
source /Users/penghuihui/.predict-bot/live.env
node scripts/predict-bot-report.mjs
```

The local report scheduler runs after each hourly BTC market ends, at minute 2
of every hour, through
`~/Library/LaunchAgents/com.penghuihui.predictbot.report.plist`. Reports cover
the previous completed clock hour and include wallet balances plus simplified
buy-placement, buy-fill, sell-fill, and PnL summaries for BTC 1-hour and BTC
15-minute markets.
Reports are written to `/Users/penghuihui/.predict-bot/reports/`, with the
newest report at `/Users/penghuihui/.predict-bot/reports/latest.md`.

## Environment

| Name | Required | Purpose |
| --- | --- | --- |
| `PREDICT_BOT_API_KEY` | Yes | Predict API key for market search and orderbook reads. |
| `PREDICT_BOT_API_BASE` | No | Override API base URL. Defaults to `https://api.predict.fun`. |
| `PREDICT_BOT_ASSETS` | No | Comma-separated asset subset from `BTC,ETH,BNB`. Use `BTC` to disable ETH and BNB. |
| `PREDICT_BOT_STATE_FILE` | No | Local state path. Defaults to `.predict-bot-state.json`. |
| `PREDICT_BOT_DISABLED` | No | Set to `1` to disable all generated actions. |
| `PREDICT_BOT_KILL_SWITCH_FILE` | No | Kill-switch file path. Defaults to `.predict-bot-kill-switch`. |
| `PREDICT_BOT_MAX_LOSS_USDT` | No | Max realized loss before new buys pause. Defaults to `20`. |
| `PREDICT_BOT_POLL_SECONDS` | No | Loop interval. Defaults to `20`. |
| `PREDICT_BOT_LIVE` | No | Set to `1` to enable live mode without passing `--live`. |
| `PREDICT_BOT_REPORT_DIR` | No | Directory for local bot reports. Defaults to `/Users/penghuihui/.predict-bot/reports`. |
| `PREDICT_BOT_WALLET_PRIVATE_KEY` | Live only | EOA wallet private key for signing auth messages and orders. |
| `PREDICT_BOT_RPC_URL` | Live only | BNB mainnet RPC URL for SDK setup. |
| `PREDICT_BOT_JWT` | No | Optional bearer token. If omitted, the bot requests one dynamically. |

## Later Predict Account Inputs

These are not used by the current EOA adapter, but may be needed for a future
Predict-account adapter:

| Name | Purpose |
| --- | --- |
| `PREDICT_BOT_PRIVY_PRIVATE_KEY` | Privy wallet private key, only for a Predict-account signing flow. |
| `PREDICT_BOT_ACCOUNT_ADDRESS` | Predict account/deposit address for Predict-account signing. |
