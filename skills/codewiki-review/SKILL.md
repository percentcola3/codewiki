---
name: codewiki-review
description: Preview a codewiki knowledge base or assess its evidence freshness, Case coverage, feedback, and gaps. Use when the user asks to browse, review, audit, or check knowledge quality.
---

# Review codewiki knowledge

The user interacts through this Skill. Treat preview and confidence commands as internal execution interfaces.

Choose the smallest operation that answers the request:

- To browse the knowledge base, run `npx codewiki preview --export [--module <module>]`. Return the generated `.codewiki/site/index.html` path. Start the long-running local server only when the user explicitly asks for a served preview.
- To assess quality, run `npx codewiki confidence [--module <module>]` **without `--json`**. Return its Markdown table unchanged; do not read, quote, summarize, compare, or explain the JSON fields. The table is the complete user-facing report: Git freshness, number of real questions, Case counts, and open Gap count. Never expose `current`/`stale` knowledge counts, evidence counts, `found_rate`, `fallback`, `bad_rate`, `stale_rate`, rating coverage, latency, regression, grades, deterministic scenarios, internal hints, or historical comparisons. If the user asks what a table row means, explain only that row in plain language.

Call out concrete stale Knowledge IDs, missing Cases, or repeated bad queries. Recommend regeneration only for affected modules; do not rewrite knowledge as part of a read-only review request.
