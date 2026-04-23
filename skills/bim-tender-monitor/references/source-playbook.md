# Source Playbook

Prefer this order:

1. Public JSON API
2. Page-embedded JSON
3. Firecrawl scrape for detail pages
4. Browser automation only when normal page rendering is required

## Current Source Map

- `szggzy`: public POST API, stable enough for list retrieval
- `szygcgpt`: public POST API, use `keyWords`
- `guangdong`: public POST API, rate-limited, keep request frequency low
- `gzebpubservice`: currently unstable due upstream WAF/502

## Firecrawl Policy

Use Firecrawl for:

- detail page markdown extraction
- cleaning noisy HTML
- preserving enough正文 for AI classification

Do not use Firecrawl as the first choice when a stable list API already exists.
