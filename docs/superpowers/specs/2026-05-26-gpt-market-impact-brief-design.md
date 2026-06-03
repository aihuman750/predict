# GPT Market Impact Brief Design

## Goal

Replace the daily report's news-title matching with a GPT-generated brief that identifies information likely to affect favorite-market prices.

## Behavior

The Worker keeps the existing price table. The second report section becomes `价格影响简报`.

Each favorite market is sent to GPT with:

- market key
- title
- fixed market brief
- Predict market URL
- optional expiry and latest Yes/No prices

GPT must use web search, prioritize official sources, and return one row per market:

- key information
- likely direction: `偏 Yes`, `偏 No`, `不明确`, or `无`
- impact strength: `高`, `中`, `低`, or `无`
- confidence: `高`, `中`, or `低`
- source links and publish times

If no source-backed market-moving update is found, GPT returns `未发现高影响更新`.

## Market Briefs

Market briefs are deterministic inputs generated before the daily GPT call. Exact key overrides can be maintained in code for markets whose settlement rules need special wording. Generic patterns cover common market types such as FDV after launch, token launch by date, sports matches, crypto up/down windows, and threshold markets.

This gives GPT a stable explanation of what each market is about without asking it to infer settlement intent from the title every day.

## Failure Handling

If `OPENAI_API_KEY` is missing, or the OpenAI request/JSON parse fails, the Worker still sends the price table and fills the impact section with a clear fallback row for each market. Feishu delivery remains the only hard failure after the report is built.

## Secrets

Add `OPENAI_API_KEY` as a GitHub Secret and Worker secret. Optional `OPENAI_MODEL` can override the default model.
