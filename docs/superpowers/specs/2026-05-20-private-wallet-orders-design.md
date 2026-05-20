# Private Wallet Orders Design

## Goal

Make the deployed Predict monitor private and add a self-wallet signing flow that can read the user's authenticated open Predict orders.

## Decisions

- The private production entrypoint is the Cloudflare Worker, not GitHub Pages.
- Login uses a site password stored as the Worker secret `SITE_PASSWORD`.
- Successful login sets a signed HttpOnly cookie with a seven day server-enforced lifetime.
- The browser never receives the Predict JWT after it is created.
- Wallet signing uses the official Predict auth message flow:
  - `GET https://api.predict.fun/v1/auth/message`
  - wallet `personal_sign`
  - `POST https://api.predict.fun/v1/auth`
- Wallet provider order in the UI is OKX Wallet, Binance Wallet, then MetaMask or another EIP-1193 browser wallet.
- The Worker stores the resulting Predict JWT in KV under `predict:auth:v1`, encrypted with a key derived from `SITE_PASSWORD`.
- The Worker uses the stored JWT to call `GET https://api.predict.fun/v1/orders?status=OPEN`.
- Markets referenced by open orders are fetched from `GET https://api.predict.fun/v1/markets/{id}` and auto-merged into favorites without duplicates.

## Private Site Behavior

`/health` stays public for deployment checks.

`/api/report/send` stays callable by the existing report token so scheduled Feishu reports continue to work.

All other API routes and all static site assets require a valid site session cookie in production. Local development through `server.mjs` remains unchanged.

If an unauthenticated browser requests a page, the Worker returns a compact password login page. After login, the browser is redirected back to the requested page.

GitHub Pages is no longer the formal production site. The Pages workflow is removed so the app is not redeployed publicly from GitHub Pages.

## Wallet Orders Behavior

The wallet monitor page adds a self-wallet panel:

- Connect OKX Wallet.
- Connect Binance Wallet.
- Connect MetaMask or another injected browser wallet.
- Fetch the dynamic Predict auth message through the Worker.
- Ask the selected wallet to sign the message with `personal_sign`.
- Send `signer`, `signature`, and `message` back to the Worker.
- Store the returned Predict JWT server-side.
- Auto-add the signer address to the monitored wallet list.
- Refresh the authenticated open orders list.

The current open orders table shows:

- market title and Predict market link,
- order id or hash,
- side,
- outcome,
- price,
- remaining quantity,
- filled quantity,
- status,
- strategy,
- reward earning rate,
- expiration.

If the Predict JWT is missing or expired, the UI asks the user to reconnect and sign again.

## Security Boundaries

The user must never paste a private key or seed phrase into this site.

Only the wallet extension performs signing. The app requests `personal_sign`; it does not request token approvals, EIP-712 order signatures, transaction signatures, transfers, or private keys.

The site password, Predict API key, Feishu secrets, report token, and Predict JWT are never committed to the repository.

## Testing

Worker tests cover:

- invalid site password rejection,
- valid site password creating a signed seven-day cookie,
- authenticated API access with that cookie,
- Predict auth message proxying,
- Predict JWT exchange and encrypted storage,
- authenticated open order fetching,
- open-order markets auto-merging into favorites.

Shared helper tests cover open-order formatting and market favorite conversion.
