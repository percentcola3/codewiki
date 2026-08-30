---
name: codewiki-query
description: Answer full-stack business and code questions through codewiki, collect feedback, and turn confirmed misses into regression-protected knowledge. Use for questions about product behavior, implementation, impact, state, field lineage, or cross-service chains.
---

# Query and improve codewiki knowledge

The user interacts through this Skill. Retrieval must use the project codewiki MCP server and its `codewiki_explore` tool. `npx codewiki init` or `npx codewiki upgrade` configures this server for Claude Code and Codex.

1. Preserve the user's business terms. Call `codewiki_explore` with the original question, adding `module` only when it is known. Do not replace MCP retrieval with direct file search or the internal query CLI.
2. Answer from the MCP result's semantic knowledge and code evidence. Cite `file:line` for code claims. If knowledge is missing or stale, state that clearly and inspect source only as needed.
3. Every answer that used `codewiki_explore` must end with this visible feedback request, even when the answer is incomplete or reports a miss: `这次 CodeWiki 检索有帮助吗？回复“有帮助”，或“没帮助：原因”。` Never rate it on the user's behalf or infer a rating when the user asks a new question.
4. Record confirmed feedback with `npx codewiki query --feedback <good|bad> --retrieval-id <id> [--comment "..."]`.
5. A bad rating returns a Gap ID. Re-read the relevant source, show the proposed correction, and wait for user confirmation.
6. After confirmation, follow the codewiki-generate workflow to add the corrected knowledge with the Gap ID. Generation automatically creates the Eval Case, rebuilds the index, and runs regression; the Gap closes only when the linked Case passes.

If `codewiki_explore` is unavailable, tell the user to run `npx codewiki upgrade` and restart the Agent. Do not present an untracked fallback as a codewiki retrieval result.
