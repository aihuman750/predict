# GPT Market Impact Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate the daily favorite-market impact brief with GPT web search using fixed market profile inputs.

**Architecture:** Add a focused market-profile helper for deterministic title-to-brief inputs. Update report markdown helpers to render impact rows. Update the Worker report flow to call OpenAI Responses API with `web_search`, parse structured JSON, and fall back without breaking Feishu reports.

**Tech Stack:** Cloudflare Worker ESM, Node test runner, OpenAI Responses API over `fetch`, Feishu interactive card webhook.

---

### Task 1: Report Markdown Contract

**Files:**
- Modify: `test/report-core.test.mjs`
- Modify: `scripts/report-core.mjs`

- [ ] Write a failing test that expects `buildReportMarkdown()` to render `价格影响简报` with market, key information, likely impact, strength, confidence, and source.
- [ ] Run `npm test -- test/report-core.test.mjs`; expected failure: impact table text is missing.
- [ ] Update `buildReportMarkdown()` to accept `impactRows`.
- [ ] Re-run `npm test -- test/report-core.test.mjs`; expected pass.

### Task 2: Fixed Market Brief Inputs

**Files:**
- Create: `scripts/market-profile-core.mjs`
- Create: `test/market-profile-core.test.mjs`

- [ ] Write failing tests for FDV-after-launch and sports-match market profiles.
- [ ] Run `node --test test/market-profile-core.test.mjs`; expected failure: module missing.
- [ ] Implement deterministic profile generation plus exact-key overrides.
- [ ] Re-run `node --test test/market-profile-core.test.mjs`; expected pass.

### Task 3: GPT Report Flow

**Files:**
- Modify: `worker/index.mjs`
- Modify: `test/worker.test.mjs`

- [ ] Write a failing Worker test that mocks OpenAI Responses API and expects the Feishu card to include the GPT impact brief.
- [ ] Run `node --test test/worker.test.mjs`; expected failure: OpenAI is not called and old progress text is used.
- [ ] Add OpenAI request construction, response-text extraction, JSON normalization, and fallback rows.
- [ ] Re-run `node --test test/worker.test.mjs`; expected pass.

### Task 4: Deployment Docs

**Files:**
- Modify: `.github/workflows/cloudflare-worker.yml`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/integration-guide.md`
- Modify: `docs/operator-runbook.md`
- Modify: `AGENTS.md`

- [ ] Add `OPENAI_API_KEY` to deployment secret propagation.
- [ ] Document that the daily report sends the favorite list plus fixed briefs to GPT for a sourced price-impact brief.
- [ ] Document fallback behavior and the new secret.

### Task 5: Verification

**Files:**
- No new files.

- [ ] Run `npm test`.
- [ ] Run `node --check public/app.mjs`.
- [ ] Run `node --check worker/index.mjs`.
- [ ] Run `node --check scripts/report-core.mjs`.
- [ ] Run `node --check public/wallet-core.mjs`.
- [ ] Run `git diff --check`.
