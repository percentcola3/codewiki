# CodeWiki

> Compile production code into reviewable, Git-native business knowledge for AI agents and teams.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)

**English** | [中文](docs/README.zh-CN.md)

CodeWiki helps Claude Code and Codex answer business questions about a codebase without making every agent session rediscover the system from source code.

It analyzes frontend and backend code, produces evidence-backed Markdown knowledge, stores it in the repository, and turns real user feedback into reusable Cases and Gaps.

## What it is

Production repositories have a persistent gap between how people ask questions and how code is organized.

> “How does a designer send a message to AI?”

The answer may span a Vue component, a store, IPC, a Node process, streaming events, and an API provider. Reading that chain from scratch is slow, easy to miss, and highly dependent on the agent model and its context budget.

CodeWiki takes a different route:

```text
Code → AST facts and code graph → business Markdown → Git-shared team knowledge
                                               ↓
                                    retrieval, feedback, Cases, Gaps
```

It is not a hosted RAG service and does not require a vector database. The goal is to make the stable business backbone of a long-lived repository available before an agent starts reading source code for details.

### How it differs

| Project | Primary strength | Where CodeWiki is different |
| --- | --- | --- |
| [Understand Anything](https://github.com/rashidazarang/understand-anything) | Deep code analysis and structured artifacts for understanding a codebase | CodeWiki makes the main output human-readable business documents, keeps them in Git, and uses real questions and feedback to improve the knowledge over time. |
| [CodeGraph](https://github.com/code-graph-dev/codegraph) | Precise symbol and call-path navigation in source code | CodeWiki uses graph navigation as evidence, but starts with business workflows, rules, boundaries, and change impact rather than source symbols. |
| CodeWiki | Git-native business knowledge with evidence and evaluation | Best for sustained team use: explain the system, retrieve it consistently, collect feedback, and make verified questions reusable. |

These tools can coexist. CodeGraph is excellent for source-level navigation; Understand Anything can inspire richer analysis artifacts. CodeWiki focuses on the layer that teams review, share, and keep current.

### Three practical advantages

1. **Documentation first, Git native** — the useful output is Markdown under `.codewiki/modules/`, so it can be reviewed, versioned, and shared with the whole team.
2. **Business-oriented understanding** — AST and graph analysis provide facts; the generated knowledge explains workflows, rules, states, boundaries, and impact in the language users actually ask.
3. **A feedback-driven evaluation loop** — a helpful answer becomes a feedback Case; an unhelpful answer becomes a Gap. The knowledge base improves from real usage instead of only self-generated test questions.

## Who should use it

CodeWiki is designed for repositories that live for a long time and are changed by more than one person:

- Product repositories with complex frontend, backend, IPC, API, or event chains.
- Monorepos containing multiple applications and services for one business domain.
- Teams where developers, product managers, QA, and AI agents repeatedly ask the same “how does this work?” questions.
- Projects where generated knowledge should be reviewed and shared through Git.

It is less useful for a small throwaway script, a short-lived prototype, or a repository where source-level search is all the team needs.

## How to use it

### 1. Initialize once

Requirements: Node.js 18+.

```bash
cd your-repository
npx codewiki init
```

Initialization creates `codewiki.yml`, a Git-trackable `.codewiki/` knowledge area, project Skills for Claude Code and Codex, and the MCP retrieval connection they use.

The public CLI only manages this lifecycle:

```bash
npx codewiki init
npx codewiki upgrade
npx codewiki uninstall
```

`upgrade` refreshes the installed Skills and integrations without removing the team's knowledge. `uninstall` removes integrations but keeps the knowledge assets.

### 2. Generate knowledge in your agent

Restart Claude Code or Codex after initialization, then use natural language:

```text
Generate a knowledge base for the orders module in src/views/order.

Generate full-stack knowledge for the orders domain:
the web app is apps/order-web and the Java service is services/order-api.

Update the orders knowledge base for the current code changes only.
```

CodeWiki detects source units independently, including common Vue 2/3, React, Java, and Go projects. A single business module can span multiple source units in a monorepo.

### 3. Ask normal business questions

```text
How does a designer send a message to AI? Use CodeWiki and code evidence.

What happens if AI writes outside the workspace?

Which pages are affected if this API field changes?
```

The query Skill calls `codewiki_explore`, which retrieves relevant business documents first and expands into code evidence or graph paths only when needed.

Every CodeWiki-backed answer asks for feedback:

```text
Was this CodeWiki result helpful? Reply “helpful”, or “not helpful: reason”.
```

- **Helpful**: the question and its retrieved evidence become a `feedback` Case.
- **Not helpful**: CodeWiki opens a Gap. Once the missing knowledge is corrected and verified, the Gap can be closed.

### 4. Review knowledge health

Ask your agent:

```text
Check the knowledge health of the orders module.
```

The user-facing report stays intentionally small:

| Item | Meaning |
| --- | --- |
| Knowledge status | How many commits the code is ahead of the generation baseline. |
| Real questions | Unique user questions asked in the recent window. |
| Cases | Verified, missing, and review-needed real questions. |
| Gaps | Open knowledge problems that still need resolution. |

It does not expose internal latency, model scores, self-generated regression counts, or other implementation metrics to ordinary users.

## How it works

### Knowledge compilation

```text
Source units
  → AST extraction
  → unified graph
  → ranked business flows and evidence
  → Product / Developer / Quality Markdown
  → Git review and sharing
```

- **AST extraction** finds components, functions, events, APIs, state, fields, and imports.
- **Unified graph** connects those facts across frontend and backend source units.
- **Graph analysis** groups related code, identifies important entry points, and follows call, event, and field relationships.
- **LLM documentation** translates verified facts into readable business knowledge. It must link key claims back to code evidence.

The shared knowledge is organized by module:

```text
.codewiki/modules/<module>/
├── product/       # workflows, business rules, boundaries
├── developer/     # architecture, state, impact analysis
├── quality/       # confirmed defects, decisions, feedback knowledge
└── navigation/    # AST and graph evidence used by retrieval
```

### Retrieval

CodeWiki combines two paths:

1. **Document retrieval** matches titles, aliases, expected questions, entities, sections, and content to bridge business language and code terms.
2. **Graph retrieval** expands a semantic result into a focused call path, impact path, state relationship, or field lineage when the question requires it.

This keeps the default answer small and stable while preserving a route back to source code.

### Evaluation and improvement

There are two kinds of Cases:

- **Real Cases** come from helpful user feedback, tests, defects, PRDs, or deliberate team curation. They are the Cases counted in the user-facing health report.
- **Generated smoke Cases** are created from the generated knowledge only to catch broken indexes or evidence links. They are internal and never presented as proof of business value.

Real feedback is the important loop:

```text
Question → retrieval → answer → user feedback
                         ├─ helpful → feedback Case
                         └─ not helpful → Gap → fix knowledge → verify
```

This makes CodeWiki a shared learning system rather than a one-time documentation generator.

## More documentation

- [Product and architecture explanation](docs/codewiki-explained.html)
- [Chinese documentation](docs/README.zh-CN.md)
- [Example configuration](examples/codewiki-update.yml)

## License

[MIT](LICENSE)
