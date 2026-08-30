---
name: codewiki-generate
description: Generate, update, or supplement a codewiki business knowledge module from frontend, backend, or monorepo code. Use when the user asks to create or refresh a knowledge base, or to preserve a confirmed defect, incident, decision, or feedback correction.
---

# Generate and maintain codewiki knowledge

The user interacts through this Skill. Treat `npx codewiki generate` as an internal execution interface; do not ask the user to run it.

Use `codewiki.yml` for directory boundaries and `<state_root>/workflow/agent-workflow.md` for the document contract.

1. Identify the business module and all of its Source Units. Read `<state_root>/INSTRUCTIONS.md` when present. Do not assume a monorepo root has one framework version. Detect each workspace from its lockfile and package/build manifest. When one business module spans multiple directories, add or update `codewiki.yml#modules[].source_units`; keep `framework/version: auto` unless the user needs an explicit override. For an existing module, read `manifest.yml` and `navigation/source-units.json` and limit work to changed Source Units.
2. Run `npx codewiki generate <target> --module <module>` for a single target, or `npx codewiki generate --module <module>` when Source Units are declared in `codewiki.yml`. Add `--update` when refreshing an existing module. Read the detected Source Units and impact classification.
   - `NO_IMPACT` or `INDEX_ONLY`: do not rewrite semantic Markdown; continue directly to finalize.
   - `KNOWLEDGE_IMPACT`: update only the affected knowledge and cases.
3. Read `navigation/source-units.json`, `navigation/framework-facts.json`, and `navigation/graph.jsonl` before writing `product/`, `developer/`, or `quality/` Markdown. The graph is a machine index, not user-facing documentation. Treat Tree-sitter definitions and exact HTTP Method + Path links as structural evidence; ambiguous call targets remain candidates. Verify dynamic behavior in source code when generated facts are insufficient. `developer/` is the canonical cross-stack implementation-knowledge layer; do not create new `frontend/` or `backend/` top-level layers.
4. Every code claim must cite `file:line`. Do not turn candidate signals into business rules. Ask the user when business meaning cannot be proven.
5. Create or update `<knowledge_root>/<module>/retrieval-cases.json` with stable IDs. Every newly generated baseline Case must include `source: generated` and `created_at` (current ISO time). For a user-confirmed correction, preserve the retrieval/gap link with `source: feedback`, `source_ref: <retrieval_id>`, `gap_ids`, and `created_at`. Use `<state_root>/workflow/references/retrieval-cases.example.json` as the shape, replace placeholders with real Knowledge/Evidence IDs, and cover the module's important UI entry, backend endpoint, cross-language chain, business rule, field lineage, impact, state, feedback, and no-answer boundaries.
6. Run `npx codewiki generate <target> --module <module> --finalize`, or omit `<target>` for a configured multi-Source-Unit module. This validates evidence, refreshes Evidence fingerprints, rebuilds graph/retrieval indexes, and runs the module's active Eval Cases. If validation or regression fails, codewiki restores the pre-generation module and keeps the failed files under `<state_root>/transactions/` for diagnosis.
7. Report the module, changed Knowledge IDs, Case result, freshness, and any user decision still required. Do not expose internal command sequencing unless diagnosis requires it.

For a confirmed defect, incident, decision, or feedback correction, use the same command:

```bash
npx codewiki generate --module <module> --kind <feedback|defect|incident|decision> \
  --title "..." --question "..." --answer "..." \
  --evidence <type:ref> [--gap-id <gap:id>] [--retrieval-id <ret:id>]
```

The command writes shared quality knowledge, creates or updates its Eval Case, rebuilds the index, and immediately runs regression. For defects, preserve symptom, trigger, impact, confirmed root cause, fix, regression check, and boundary. Leave unknown facts explicitly unconfirmed.
