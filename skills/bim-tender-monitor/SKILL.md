---
name: bim-tender-monitor
description: >
  Monitor BIM tender and procurement notices across Chinese public tender platforms, especially Shenzhen/Guangdong sources.
  Use when the task is to crawl tender notices, monitor BIM-related keywords, run the hot-monitor backend, classify tender relevance,
  enrich detail pages with Firecrawl, or route analysis through an OpenClaw agent instead of a direct LLM API.
---

# BIM Tender Monitor

Use this skill for BIM 招投标监控 and tender crawling work in `/Users/Weishengsu/dev/yupi-hot-monitor`.

## What This Skill Covers

- Running the backend monitor and manual tender searches
- Maintaining BIM keyword groups and source adapters
- Using `OpenClaw` as the AI provider bridge
- Using `Firecrawl` to enrich detail-page content
- Packaging the workflow so other agents can reuse it

## Core Files

- Backend AI provider: `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/services/llmProvider.ts`
- Backend AI analysis: `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/services/ai.ts`
- Tender sources: `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/services/tenderSources.ts`
- Firecrawl enrichment: `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/services/firecrawl.ts`
- Hotspot job: `/Users/Weishengsu/dev/yupi-hot-monitor/server/src/jobs/hotspotChecker.ts`

## Execution Flow

1. Search list pages through public source adapters in `tenderSources.ts`.
2. For tender sources, optionally enrich detail content with Firecrawl.
3. Send the merged text to the configured AI provider.
4. Save only relevant results through the existing hotspot pipeline.

## AI Provider Modes

Configure in `/Users/Weishengsu/dev/yupi-hot-monitor/server/.env`:

```env
AI_PROVIDER=openclaw
OPENCLAW_AGENT_ID=bim-tender
OPENCLAW_BIN=openclaw
FIRECRAWL_API_KEY=...
```

Rules:

- `AI_PROVIDER=openclaw`: use the local OpenClaw agent bridge
- `AI_PROVIDER=openrouter`: use direct OpenRouter API
- If no provider is available, the backend falls back to heuristic scoring

## Firecrawl Usage

Firecrawl is used as a detail-page enhancer, not as the primary list-source fetcher.

Why:

- Tender list pages already have stable public APIs
- Firecrawl is more useful on detail pages with messy HTML
- This reduces cost and lowers breakage risk

## Common Commands

```bash
cd /Users/Weishengsu/dev/yupi-hot-monitor/server
npm run build
npm run dev
```

```bash
curl -sS -X POST http://localhost:3001/api/hotspots/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"BIM咨询","sources":["szggzy","szygcgpt","guangdong"]}'
```

## When Extending Sources

Read `/Users/Weishengsu/dev/yupi-hot-monitor/skills/bim-tender-monitor/references/source-playbook.md`.
