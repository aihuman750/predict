# Handoff

## Current State

As of 2026-05-20, the project is deployed and functional.

Production:

- Private site and Worker: https://predict-favorites.aihuman750.workers.dev

Implemented:

- Static Predict rewards-market dashboard.
- Market rows link to the matching Predict market page.
- Favorite stars for market rows.
- Favorite list showing all saved markets.
- Search input keeps focus during continuous typing.
- Favorite actions preserve scroll position.
- Manual Feishu report button.
- Daily 10:00 Asia/Shanghai Feishu report.
- Worker KV storage for favorites and price snapshots.
- Wallet monitor page for Predict wallet positions.
- Position markets from monitored wallets auto-merge into favorites.
- Password-protected Worker-hosted site with a seven-day HttpOnly session cookie.
- Wallet signing flow for OKX, Binance, MetaMask, and other EIP-1193 wallets.
- Authenticated self-wallet OPEN orders, with order markets auto-merged into favorites.

## Important Commits

- `d869fa0` - Add favorite list and manual report push.
- `653e23c` - Use Node 22 for Worker deployment.
- `91f46ce` - Add favorite markets and daily Feishu reports.
- `325e351` - Add wallet monitor page.

## Verification Already Done

- `npm test` passes with the current test count in the latest verification run.
- Cloudflare Worker deployment is the production deployment path.
- Worker health check returned `{"ok":true}`.
- Online search verification: typing `nexus` preserved focus and returned matching rows.
- Online favorite verification: adding and removing a favorite preserved scroll position.
- Online manual report verification: the page returned `已推送 23:51 · 15 个市场` on 2026-05-19 Asia/Shanghai.

## Known Limitations

- Event progress is based on Google News RSS token overlap over a 48 hour window. It does not monitor project Discord, X posts, or official blogs directly.
- Arbitrary-address open orders remain unavailable because Predict's documented orders API requires authenticated user context. Self-wallet open orders are supported after wallet signing.
- If the Predict JWT expires, reconnect and sign again from the wallet monitor page.

## Next Useful Improvements

- Add a favicon to avoid the harmless `favicon.ico` 404 in browser console.
- Add a direct official-source watcher for X/blog/TGE announcements if report quality becomes important.
- Add a lightweight UI test for search focus and favorite scroll preservation.
- Consider rotating the Feishu webhook/signing secret because the values were shared in the chat on 2026-05-19.
