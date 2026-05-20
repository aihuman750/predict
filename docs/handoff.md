# Handoff

## Current State

As of 2026-05-20, the project is deployed and functional.

Production:

- Site: https://aihuman750.github.io/predict/
- Worker: https://predict-favorites.aihuman750.workers.dev

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

## Important Commits

- `d869fa0` - Add favorite list and manual report push.
- `653e23c` - Use Node 22 for Worker deployment.
- `91f46ce` - Add favorite markets and daily Feishu reports.

## Verification Already Done

- `npm test` passes with 16 tests.
- GitHub Pages deployment passed after commit `d869fa0`.
- Cloudflare Worker deployment passed after commit `d869fa0`.
- Worker health check returned `{"ok":true}`.
- Online search verification: typing `nexus` preserved focus and returned matching rows.
- Online favorite verification: adding and removing a favorite preserved scroll position.
- Online manual report verification: the page returned `已推送 23:51 · 15 个市场` on 2026-05-19 Asia/Shanghai.

## Known Limitations

- Event progress is based on Google News RSS token overlap over a 48 hour window. It does not monitor project Discord, X posts, or official blogs directly.
- Browser-origin writes are restricted to origins listed in `ALLOWED_ORIGINS` in `worker/index.mjs`.
- The static Pages rewards snapshot only updates when the Pages workflow runs successfully.
- Wallet open orders are shown as unavailable because Predict's documented orders API requires authenticated user context and does not expose arbitrary-address open orders.

## Next Useful Improvements

- Add a favicon to avoid the harmless `favicon.ico` 404 in browser console.
- Add a direct official-source watcher for X/blog/TGE announcements if report quality becomes important.
- Add a lightweight UI test for search focus and favorite scroll preservation.
- Consider rotating the Feishu webhook/signing secret because the values were shared in the chat on 2026-05-19.
