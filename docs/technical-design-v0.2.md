# codewiki v0.2 技术方案：共享知识与质量闭环

> 状态：已实施（2026-08-23；第一章“当前实现”保留为 v0.1 基线）
>
> 日期：2026-08-23
>
> 范围：知识资产边界、Case 评测、反馈闭环、缺陷知识、Claude Code / Codex 接入

## 第一章：背景与现状

### 1.1 项目定位

codewiki 面向生产级前端仓库，在代码与自然语言问题之间增加一层可版本化的业务知识：

1. AST 管线提取组件、事件、调用、状态和字段血缘等确定性事实。
2. AI 基于这些事实撰写业务语义与前端架构文档，并绑定 `file:line` 证据。
3. Claude Code、Codex 等 Agent 先检索稳定的主脉络，再按需回到源码补充细节。
4. 真实问题、用户评级和回归用例用于发现并修正知识缺口。

它不是在线 RAG 服务，也不是通用符号导航工具。核心价值是把高成本、易波动的“每次从代码重新理解业务”，前移为一次生成、多次复用、可以评审的知识编译过程。

### 1.2 当前已经实现的能力

| 能力 | 当前实现 | 代码入口 |
| --- | --- | --- |
| 确定性代码分析 | Vue/TS AST、组件关系、函数依赖、深度行为候选、字段血缘 | `src/cli.mjs`、`src/scan/` |
| 三层知识 | `product/`、`frontend/`、`navigation/` | `docs/agent-workflow.md` |
| 本地检索 | 语义倒排、bindings、图展开、MCP/CLI 查询 | `src/scan/knowledge-retrieval.mjs` |
| 固定问题集评测 | Top-3 知识命中、证据召回、延迟、无答案检查 | `src/scan/knowledge-retrieval.mjs:1175` |
| 真实使用记录 | 查询命中写入 `retrieval.jsonl` | `src/scan/mcp-server.mjs` |
| 用户评级 | `good` / `bad` 记录并关联 `retrieval_id` | `src/feedback.mjs:28` |
| 差评后补充知识 | `case add` 写入本地 knowledge overlay | `src/feedback.mjs:54` |
| 置信度 | 证据、场景覆盖、Gap、使用统计 | `src/confidence.mjs` |
| Claude Code 接入 | `.claude/commands/`、`.mcp.json`、可选 Hook | `src/init.mjs`、`commands/`、`integrations/` |

### 1.3 当前主要问题

#### 问题一：共享知识与本地状态边界冲突

`codewiki init` 默认把整个 `.codewiki/` 加入 `.gitignore`（`src/init.mjs:45-50`），而默认知识根目录又是 `.codewiki/modules/`。用户差评后新增的知识也写入 `.codewiki/knowledge-overlay/`（`src/feedback.mjs:81-94`）。

这意味着“一个人生成，全团队通过 Git 受益”目前依赖用户主动指定 `--output docs/...`，反馈修正也不会自然进入团队知识库。产品主张与默认行为不一致。

#### 问题二：`case` 同时表示知识和测试

当前存在两类完全不同的 Case：

- `case add`：一条可检索的问答知识，实际属于 Knowledge Entry。
- `retrieval-cases.json`：带期望命中结果的回归用例，实际属于 Eval Case。

两者生命周期不同。知识条目需要审阅、证据和版本管理；评测用例需要稳定 ID、期望结果和回归历史。继续共用一个概念会让报告、CLI 和贡献流程越来越难解释。

#### 问题三：Gap 不能形成稳定闭环

`src/confidence.mjs:114-135` 根据“Top 未命中/差评”的当前排序临时生成 Gap ID，并且一律标记为 `open`。`case add` 没有保存来源 `feedback_id`、`retrieval_id` 或 `gap_id`，所以系统无法证明哪次知识修正关闭了哪个问题。

结果是：系统能发现差评，却不能稳定回答“修了多少、还剩多少、修完是否通过回归”。

#### 问题四：缺陷知识有生成约定，但没有进入检索主链路

`commands/wiki-scan.md:15` 与 `docs/agent-workflow.md` 已约定把缺陷写入 `quality/defects/`，但检索器当前只扫描 `product` 和 `frontend`（`src/scan/knowledge-retrieval.mjs:14`）。因此缺陷文档即使生成，也无法成为一等检索资产。

同时，现有 `case add` 强制所有知识提供 `file:line`。缺陷、事故和业务决策经常还需要 commit、Issue、测试、用户确认等代码外证据，当前证据模型无法准确表达。

#### 问题五：Codex 还不是一等接入

README 宣称支持 Codex，但 `init` 只安装 `.claude/commands/`，也只写 `.mcp.json`。当前 Codex 支持仓库级 `.agents/skills/<name>/SKILL.md` 和项目级 `.codex/config.toml` MCP 配置，因此可以直接提供与 Claude Code 对等的接入，而不需要维护模型专用工作流。

## 第二章：WHAT

### 2.1 问题建模

v0.2 将系统中的资产拆成四类，避免继续混用：

| 对象 | 作用 | 是否进 Git | 是否参与检索 |
| --- | --- | --- | --- |
| Knowledge Entry | 可供人和 Agent 消费的业务、架构、缺陷、决策知识 | 是 | 是 |
| Eval Case | 验证某类问题能否命中正确知识与证据 | 是 | 否，只参与评测 |
| Feedback Event | 一次用户对回答的评价 | 默认否 | 否 |
| Gap | 从未命中、差评或失败用例中提取的待修问题 | 本地发现，确认后可进 Git | 否 |

这四类对象形成单向、可追踪的闭环：

```text
Query → Retrieval → Feedback Event → Gap
                                  ↓ 人工确认
                         Knowledge Entry + Eval Case
                                  ↓
                              Evaluate
                                  ↓
                         Gap closed / reopened
```

### 2.2 v0.2 要做的四件事

1. **统一共享知识根目录**：让默认生成结果可直接提交 Git，本地日志和缓存继续留在 `.codewiki/`。
2. **拆分 Knowledge、Eval Case、Feedback、Gap**：建立稳定 ID 和明确的引用关系。
3. **让缺陷、事故和决策成为一等知识**：纳入 `quality/` 语义层和检索索引，支持代码外证据。
4. **提供宿主无关工作流与双宿主安装**：同一份 Skill 源安装到 Claude Code 和 Codex，并分别生成可移植 MCP 配置。

### 2.3 核心成功指标

只保留三个能直接判断价值的指标：

| 指标 | 定义 | 观测方式 |
| --- | --- | --- |
| 有帮助率 | `good / (good + bad)` | 关联了 `retrieval_id` 的 Feedback Event；样本不足时显示 N/A |
| 真实问题 Case 覆盖率 | 可映射到至少一个 Eval Case 的有效真实问题数 / 有效真实问题总数 | `codewiki confidence --days N`，输出已覆盖与待补问题 |
| 回归通过率 | 通过的 Eval Case / active Eval Case | `codewiki confidence` 自动回归，同时展示 Top-3 命中和证据召回 |

失败信号：

- 知识生成后仍需大多数查询回退到全仓代码扫描。
- 有帮助率提高，但 Case 覆盖率长期不增长，说明反馈没有沉淀为资产。
- Case 数量增长但回归通过率下降，说明知识或检索器发生退化。

## 第三章：方案细节

### 3.1 共享知识根目录

#### 现状与目标

当前共享和本地数据都放在 `.codewiki/`。目标是默认做到“知识可提交，运行状态不提交”，并且兼容已有仓库。

#### 方案比较

| 方案 | 能力 | 实施成本 | 风险 | 适配度 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 整个 `.codewiki/` 继续被忽略 | 无迁移 | 低 | 知识无法通过 Git 共享 | 低 | 不选 |
| 整个 `.codewiki/` 全部提交 | 最简单 | 低 | 缓存、日志、站点和个人反馈污染 Git | 低 | 不选 |
| `.codewiki/modules/` 提交，其他运行产物精确忽略 | 保持根目录约定、Git 友好 | 中 | `.gitignore` 规则需要维护 | 高 | 推荐 |

#### 推荐目录

```text
.codewiki/
├── modules/<module>/                  # 可提交 Git
│   ├── manifest.yml
│   ├── product/
│   ├── frontend/
│   ├── quality/
│   │   ├── defects/
│   │   ├── incidents/
│   │   └── decisions/
│   ├── navigation/
│   └── retrieval-cases.json
├── cache/                             # 本地，gitignore
├── retrieval.jsonl                    # 本地，gitignore
├── feedback.jsonl                     # 本地，gitignore
├── gaps.jsonl                         # 本地，gitignore
├── evaluation-runs/                   # 本地，gitignore
├── knowledge-health/                  # 本地，gitignore
└── site/                              # 本地，gitignore
```

Navigation 中供检索使用的稳定图、bindings 和验证报告属于共享产物；可重建的 `_intermediate/`、cache 和 preview 站点不提交。

新增仓库级配置：

```yaml
# codewiki.yml
knowledge_root: .codewiki/modules
state_root: .codewiki
```

路径解析顺序：

1. `codewiki.yml#knowledge_root`。
2. 新默认 `.codewiki/modules`。

### 3.2 Knowledge Entry 与 Eval Case

#### CLI 边界

公开命令只保留 `init`、`generate`、`query`、`preview`、`confidence`。Knowledge 补充、索引、Eval Case 建立和回归由 `generate` 编排；反馈由 `query` 记录；使用情况、Case 覆盖、回归和 Gap 统一进入 `confidence` 报告。

#### Knowledge Entry

生成知识继续采用 Markdown + frontmatter。`quality/` 与现有 `product/`、`frontend/` 使用同一解析器：

```yaml
---
id: kb:orders:quality:defect:DEF-123
kind: defect
title: 重复提交导致订单状态回退
status: active
aliases: [重复提交, 状态回退]
questions:
  - 为什么重复点击提交后订单状态会回退？
entities: [订单, 提交]
source: user
closes_gaps: [gap:orders:8a42d2c1]
sources:
  - type: code
    ref: src/views/order/submit.ts:87
  - type: commit
    ref: 1a2b3c4
  - type: test
    ref: tests/order-submit.test.ts:42
---
```

证据规则：

- 代码行为、字段、状态与调用链仍必须有 `file:line`。
- 缺陷根因必须至少有 code、commit 或 test 证据之一。
- 业务背景和决策可以来自 issue、document 或 `user_confirmed`，但必须明确来源，不能伪装成代码事实。
- `user_confirmed` 记录确认时间和提交者标识；开源默认不写邮箱等个人信息。

缺陷正文固定为：现象、触发条件、影响、根因、修复、回归与边界。没有证据的根因保持“未确认”，不由 LLM 补齐。

#### Eval Case

沿用现有 `retrieval-cases.json`，只扩展字段，避免引入新存储格式：

```json
{
  "id": "eval:orders:refund-policy",
  "status": "active",
  "module": "orders",
  "query": "什么情况下允许退款？",
  "source": "feedback",
  "source_ref": "feedback:01K...",
  "expected_knowledge_ids": ["kb:orders:product:refund"],
  "required_evidence_ids": ["nav:condition:..."],
  "tags": ["business-rule"]
}
```

Eval Case 必须有稳定 `id`，禁止以数组位置作为身份。真实问题被确认有长期价值后，通过 `codewiki generate --retrieval-id <id> ...` 补充知识并自动生成 Case，用户确认的期望知识和证据写入共享文件。

### 3.3 Feedback、Gap 与报告

#### Gap 稳定性

Gap ID 使用以下字段生成稳定指纹：

```text
sha1(module + normalized_query + gap_kind).slice(0, 12)
```

不再把排行榜位置写入 ID。Gap 使用追加事件模型保存在 `.codewiki/gaps.jsonl`：

```json
{"at":"...","gap_id":"gap:orders:8a42d2c1","event":"opened","kind":"bad_rating","retrieval_id":"ret_..."}
{"at":"...","gap_id":"gap:orders:8a42d2c1","event":"linked_knowledge","knowledge_id":"kb:orders:product:refund"}
{"at":"...","gap_id":"gap:orders:8a42d2c1","event":"linked_eval_case","eval_case_id":"eval:orders:refund-policy"}
{"at":"...","gap_id":"gap:orders:8a42d2c1","event":"closed","evaluation_run_id":"evalrun_..."}
```

只有同时满足以下条件才能关闭 Gap：

1. 已关联 Knowledge Entry。
2. 已关联 active Eval Case。
3. 该 Eval Case 在最近一次评测中通过。

后续评测失败时记录 `reopened`，保留完整历史。

#### 真实问题如何映射 Case

为保持零服务、零 embedding，按以下确定性顺序匹配：

1. `retrieval_id` 已显式关联 `eval_case_id`。
2. 实际命中的 Knowledge ID 与 Case 的 `expected_knowledge_ids` 有交集。
3. 归一化 query 完全相同。
4. 复用当前 tokenizer，问题 token Jaccard 达到配置阈值。

第 4 类只标记为 `candidate`，不自动算作已覆盖；报告中等待用户确认。这样不同模型不会改变 Case 覆盖结果。

#### 报告输出

统一入口：

```bash
codewiki confidence --days 30
codewiki confidence --days 30 --json
```

报告固定包含：

1. 查询量、知识命中率、评级覆盖率、有帮助率。
2. 真实问题 Case 覆盖率，以及 matched / candidate / missing 三组问题。
3. Eval Case 回归通过率、Top-3 命中率、证据召回率。
4. Gap 新增、关闭、重开和当前未关闭数量。
5. 高频未覆盖问题与高频差评问题。

`confidence` 继续回答“知识本身是否可信”，`report` 回答“工具是否被使用、是否有用、质量是否在提升”。两者不再混成一个总分。

#### 与现有评测工具的比较

| 方案 | 能力 | 实施成本 | 风险 | 适配度 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 内建确定性评测 | Knowledge ID、Evidence ID、无答案、延迟；完全本地 | 低 | 不直接评价自然语言答案风格 | 高 | v0.2 主路径 |
| Promptfoo | 多模型、多断言、可做端到端答案评测 | 中 | 增加配置、依赖和模型成本 | 中 | 后续可选适配器 |
| Ragas | Context Precision/Recall 等 LLM 评测指标 | 高 | Python/模型依赖，与零服务目标冲突 | 低 | 不进核心依赖 |

v0.2 先把检索和证据做成确定性回归。自然语言回答质量保留用户评级；需要跨模型对比的团队可以后续导出 Promptfoo 配置，不把它加入核心运行时。

### 3.4 缺陷、事故与决策知识

#### 方案比较

| 方案 | 能力 | 实施成本 | 风险 | 适配度 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 继续放在普通 frontend 文档 | 无新 schema | 低 | 历史知识混入当前架构，容易误导 | 低 | 不选 |
| 只记录外部 Issue 链接 | 来源明确 | 低 | 无法本地检索，外部系统可能不可访问 | 中 | 只作为证据 |
| `quality/` 下结构化 Markdown | Git 友好、可检索、可审阅、能标状态 | 中 | 需要索引和模板支持 | 高 | 推荐 |

MADR/ADR 证明了“Markdown + 状态 + 决策上下文”适合在 Git 中保存长期决策。codewiki 不复制完整 ADR 体系，只复用它的简单原则：一个文件表达一个重要事实或决策，明确状态、上下文、结论、证据和替代项。

检索排序规则：

- active 缺陷/决策按正常知识参与检索。
- resolved 缺陷仍可命中“为什么曾经出错”类问题，但低于当前 product/frontend 事实。
- superseded 决策默认不作为当前结论，仅在问题含“历史、以前、为什么改”时返回。
- 任何历史知识与当前代码冲突时，回答必须标明时间和状态。

### 3.5 Claude Code 与 Codex 接入

#### 方案比较

| 方案 | 能力 | 实施成本 | 风险 | 适配度 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 分别维护 Commands 和 Codex Prompt | 可快速接入 | 中 | 两套流程持续漂移 | 低 | 不选 |
| 只依赖 MCP instructions | 工具统一 | 低 | 无 MCP 时没有生成与反馈工作流 | 中 | 不选 |
| 一份 Agent Skill 源，安装到两个宿主，CLI 为兜底 | 工作流统一、宿主差异小 | 中 | init 需处理两个目录 | 高 | 推荐 |

Claude Code 和 Codex 都支持 `SKILL.md` 工作流。包内保留两份宿主无关的源 Skill：

```text
skills/
├── codewiki-generate/SKILL.md
└── codewiki-query/SKILL.md
```

`codewiki init` 将相同源分别复制到：

```text
.claude/skills/codewiki-generate/SKILL.md
.claude/skills/codewiki-query/SKILL.md
.agents/skills/codewiki-generate/SKILL.md
.agents/skills/codewiki-query/SKILL.md
```

不再安装宿主专用 `.claude/commands/`，避免与统一 Skill 和五个公开 CLI 入口重复。

MCP 配置使用可移植命令，不再写当前机器的 Node 和包绝对路径：

```json
{
  "mcpServers": {
    "codewiki": { "command": "codewiki", "args": ["mcp"] }
  }
}
```

```toml
# .codex/config.toml
[mcp_servers.codewiki]
command = "codewiki"
args = ["mcp"]
```

Skill 统一遵循：优先调用 `codewiki_explore` MCP；MCP 不可用时执行 `codewiki query`。知识生成与补充使用 `generate`，反馈使用 `query`，评测和报告由 `generate --finalize` 与 `confidence` 自动编排。

### 3.6 实施阶段

#### P0：修正产品契约

1. 新增 `codewiki.yml` 和共享知识根目录解析，沿用 `.codewiki/modules`，并将运行产物改为精确忽略。
2. `quality/` 加入检索、索引、验证和 preview。
3. 新增 `knowledge add`，保留 `case add` 兼容别名。
4. 用 Agent Skills 替代 Claude 专用 Commands 作为主路径，同时安装 Codex Skill 与项目 MCP 配置。
5. 修复 README 与默认行为的差异。

#### P1：完成质量闭环

1. Feedback Event、Gap、Knowledge Entry、Eval Case 使用稳定 ID 并互相关联。
2. 将索引、Case 建立和回归收敛进 `generate`，将反馈收敛进 `query`。
3. Gap 只有在关联 Case 回归通过后关闭。
4. `confidence` 输出 Case 覆盖、Gap 和回归摘要；preview 展示 quality 知识。

#### P2：开源协作与扩展

1. CI 示例：PR 中运行 `codewiki confidence --module <module> --json`。
2. 输出 Promptfoo 适配配置，用于可选的跨模型端到端评测。
3. 再推进 React/JSX、多仓库联合检索等语言和规模能力。

### 3.7 影响面

| 模块 | 改动 |
| --- | --- |
| `src/init.mjs` | 共享目录配置、双宿主 Skill、Claude/Codex MCP 配置 |
| `src/cli.mjs` | 五个公开入口及生成、检索反馈编排 |
| `src/feedback.mjs` | 稳定事件 ID、typed evidence、Gap 关联 |
| `src/confidence.mjs` | 知识健康、真实问题覆盖、Case 回归与 Gap 报告 |
| `src/scan/knowledge-retrieval.mjs` | 读取配置根目录、索引 `quality/`、Eval Case 稳定 ID |
| `src/site.mjs` | quality 内容与报告页面 |
| `skills/` | `codewiki-generate`、`codewiki-query` 宿主无关工作流源 |
| `tests/` | 路径迁移、双宿主 init、闭环、报告和 quality 检索 |

### 3.8 验证方案

#### 单元测试

- 同一问题重复出现时生成相同 Gap ID。
- Knowledge Entry、Eval Case、Feedback Event ID 不因数组顺序或报告排名变化。
- typed evidence 校验不同知识类型的最低证据要求。
- query 到 Eval Case 的 exact、knowledge-intersection、candidate 匹配口径稳定。

#### 集成测试

- `init` 后同时生成 Claude Code 与 Codex Skill，MCP 配置不含机器绝对路径。
- 新仓库默认把知识写入 `.codewiki/modules/`，且 `.gitignore` 不再忽略整个 `.codewiki/`。
- 差评 → Gap → Knowledge Entry → Eval Case → evaluate PASS → Gap closed 全链路通过。
- `quality/defects/*.md` 能被 `query`、MCP 和 preview 命中。
- 只复制 Git 中的 `.codewiki/modules/` 到新工作区，不复制本地日志与缓存，仍能建立索引并查询。

#### 兼容测试

- 只有 `.codewiki/modules/` 的 v0.1 项目仍可 query、evaluate、confidence。
- `case add` 仍可执行，但输出迁移提示。
- 现有 `retrieval-cases.json` 没有 `id` 时使用内容指纹生成临时 ID，校验提示用户固化。

## 风险与约束

| 风险 | 应对 |
| --- | --- |
| 提交 Navigation 产物导致 Git diff 较大 | 输出稳定排序；忽略中间产物和缓存；后续再做体积阈值 |
| 用户反馈可能包含敏感业务信息 | 默认只保存在本地；进入共享知识前必须显式确认和编辑 |
| Case 覆盖匹配产生误判 | 只有显式关联和确定性命中算 covered；token 相似只算 candidate |
| 历史缺陷覆盖当前事实 | 使用 status、supersedes 和时间排序，默认降低历史知识权重 |
| 双宿主工作流漂移 | `skills/` 单一源，init 只复制，不分别维护正文 |

## 参考资料

- [OpenAI：Build skills](https://learn.chatgpt.com/docs/build-skills)
- [OpenAI：Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)
- [Anthropic：Extend Claude with skills](https://code.claude.com/docs/en/slash-commands)
- [Promptfoo：Evaluating RAG pipelines](https://www.promptfoo.dev/docs/guides/evaluate-rag/)
- [Ragas：Available metrics](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/)
- [MADR：Markdown Architectural Decision Records](https://adr.github.io/madr/)
