# codewiki

把前后端代码编译成可检索、可评测、可通过 Git 共享的业务知识。

codewiki 面向复杂生产仓库和 Monorepo。它使用 SWC、Vue Compiler 与 Node Tree-sitter，从 Vue、React、Java、Go 中提取组件、接口、调用、状态和跨语言链路，再由 Agent 基于这些确定性事实生成带证据的 Markdown。Claude Code、Codex 等 Agent 先检索稳定的业务主脉络，必要时再回到代码补充细节。

它不是在线 RAG 服务，也不需要向量数据库。核心思路是：把高成本、易漏项、受模型能力影响明显的“每次重新读代码”，前移为一次生成、多次复用的知识编译过程。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)

## 为什么这样做

生产级仓库里，自然语言和代码之间存在明显语义差距：

- 用户问“什么情况下允许退款”，代码里可能只有状态枚举、分支条件和接口字段。
- Agent 一次性分析长链路容易漏项，不同模型的检索和归纳结果波动很大。
- 在线 RAG 引入索引服务、embedding、更新和权限成本。
- 产品、测试和新人需要稳定的业务脉络，而不是每次重新拼接代码片段。

codewiki 选择中间路线：AST 提供确定性骨架，Markdown 抹平语义差距，Agent Skills 负责按需生成和检索，Eval Case 与真实用户反馈负责发现并修复知识缺口。

```text
前端/后端 Source Units → AST/Profile → 统一图索引 → Markdown 业务知识 → Git 共享
                                              ↕                  ↓
用户问题 → 意图路由 → 文档/图检索 → 用户反馈 → Gap → 知识补充 + Eval Case → 回归
```

## 快速开始

要求 Node.js 18+：

```bash
cd your-repo
npx codewiki init
```

`init` 会：

- 创建 `codewiki.yml`；
- 创建可提交且不会被重复初始化覆盖的 `.codewiki/INSTRUCTIONS.md`，用于记录重点模块、业务术语和边界；
- 安装 `codewiki-generate`、`codewiki-query`、`codewiki-review` 到 `.claude/skills/` 和 `.agents/skills/`；
- 为 Claude Code 和 Codex 配置 codewiki MCP，作为知识检索通道；
- 精确忽略 `.codewiki/` 中的本地运行产物，保留 `.codewiki/modules/` 可提交。

重启 Claude Code 或 Codex 后，直接使用自然语言：

```text
为 src/views/order 的订单模块生成知识库
为 Monorepo 中的订单模块生成全栈知识库，包含 Web 和后端服务
更新订单模块知识库
什么情况下允许退款？
预览订单知识库
检查订单模块的知识置信度
```

Skills 只在相关任务出现时加载；检索 Skill 通过初始化时配置的 MCP 获取结构化结果。

## CLI 只负责项目生命周期

公开 CLI 只保留三个命令：

| 命令 | 作用 | 数据安全 |
| --- | --- | --- |
| `npx codewiki init` | 初始化配置并安装 Claude Code/Codex Skills 与 MCP | 不覆盖已有团队说明 |
| `npx codewiki upgrade` | 刷新 Skills、工作流和集成规则 | 保留配置和全部知识资产 |
| `npx codewiki uninstall` | 移除 Skills、工作流和 codewiki MCP 配置 | 保留 `codewiki.yml`、`INSTRUCTIONS.md` 和 `modules/` |

`upgrade` 适合升级 npm 包后同步项目内的 Skills，并清理旧版 `fe-scan`、`/wiki-scan`、`/wiki-explore` 入口。`uninstall` 只卸载工具集成，不删除团队知识；确认不再需要知识时再手动删除保留内容。

初始化还会写入最小权限集：Claude Code 的本地项目权限仅放行仓库读取、配置的知识目录写入、`codewiki_explore` MCP 和四个 CodeWiki 内部命令；Codex 的项目规则只放行 `generate/query/preview/confidence`。它不会启用 `bypassPermissions`、`approval_policy = "never"`，也不会放行任意 shell、源码写入或仓库外路径。组织级安全策略仍可覆盖这些本地权限。

生成、查询、预览和质量检查通过 Skill 使用：

| 用户意图 | 触发的 Skill | Skill 内部完成 |
| --- | --- | --- |
| 生成、更新或补充知识 | `codewiki-generate` | AST 分析、文档生成、证据校验、Case 回归 |
| 提问并反馈回答质量 | `codewiki-query` | 通过 MCP 完成文档/图检索，记录反馈并建立 Gap |
| 预览或检查知识质量 | `codewiki-review` | 静态预览、置信报告、新鲜度和覆盖分析 |

底层仍保留稳定的内部执行接口，供 Skills、CI 和自动化调用，但用户不需要记忆这些参数。

## 通过 Skill 生成、更新和补充

首次生成时，对 Claude Code 或 Codex 说：

```text
为 src/views/order 的订单模块生成知识库
```

Monorepo 中一个业务模块跨多个目录时，直接说明业务边界：

```text
为订单模块生成知识库：前端在 apps/order-web，Java 服务在 services/order-api，Go 服务在 services/payment。
```

Skill 会把这些目录记录成独立 `source_units`。框架版本按每个 Workspace 的 lockfile 和 `package.json` 分别识别，不会用仓库根版本覆盖所有子项目。

代码变化后说：

```text
更新订单模块知识库，只处理受代码变化影响的内容
```

`codewiki-generate` Skill 会在内部运行分析、撰写 `product/` 和 `developer/`、建立 Case 并完成收尾。每次生成都会先建立可回滚快照，并根据图变化判断：

- `NO_IMPACT`：没有有效变化，语义文档无需改写；
- `INDEX_ONLY`：只有位置或索引变化，直接 finalize；
- `KNOWLEDGE_IMPACT`：业务证据发生变化，只更新列出的 Knowledge 与 Case。

收尾阶段自动执行四件事：

1. 校验 Markdown 中的 `file:line` 证据；
2. 重建语义文档、bindings 和统一图索引；
3. 运行该模块所有 active Eval Case；
4. 成功后提交本次生成事务，失败则恢复生成前知识库并保留失败现场。

用户确认过的反馈、缺陷、事故或决策也通过同一个 Skill 补充。例如：

```text
把“重复提交导致状态回退”这个已确认缺陷沉淀到订单知识库。
根因是旧请求晚于新请求返回并覆盖状态，证据在相关代码、提交和回归测试中。
```

Skill 会确认事实和证据后写入共享 `quality/` 文档，自动创建对应 Eval Case、重建索引并立即回归。支持的证据类型为 `code`、`commit`、`test`、`issue`、`document`、`user_confirmed`；缺陷至少需要 `code`、`commit` 或 `test` 之一。

## 检索与用户反馈

直接向 Claude Code 或 Codex 提问：

```text
什么情况下允许退款？请基于订单知识库和代码证据回答。
```

`codewiki-query` Skill 会检索相关知识和代码图，并把命中知识、证据、延迟和模块记录在本地 `.codewiki/retrieval.jsonl`。

检索器会从问题中确定一种意图，并选择对应路径：

| 意图 | 示例 | 检索路径 |
| --- | --- | --- |
| `semantic` | “什么情况下允许退款” | Markdown 优先 |
| `impact` | “修改这个接口会影响哪些页面” | 统一图优先 |
| `chain` / `lineage` | “调用链是什么”“字段从哪里来” | 统一图优先 |
| `state` | “处理中如何变成失败” | 文档与统一图联合 |
| `hybrid` | 同时包含业务语义和技术关系 | 文档与统一图联合 |

路由是确定性的，不依赖具体 LLM；结果会返回 `intent` 和 `route`，便于 Case 回归。

每次 CodeWiki 检索都会返回评价入口；Agent 回答后必须询问“有帮助 / 没帮助”，不能代替用户评分。用户直接回复即可：

```text
没帮助，没有说明未发货限制。
```

差评会产生稳定 `gap_id`。Agent 重新读代码、向用户确认修正内容后，调用生成 Skill 补充知识。补充生成的 Eval Case 通过后，Gap 才会关闭；后续回归失败会重新打开。

反馈、查询记录和 Gap 默认只保存在本地，不进入 Git。只有用户确认且有证据的知识和 Eval Case 才进入共享目录。

## Case 评估方法

### Case 是什么

Eval Case 不是知识正文，也不是一条普通问答。它描述“给定一个真实语义问题，检索器应该找到哪些稳定知识和代码证据”。每个模块的 Case 位于：

```text
.codewiki/modules/<module>/retrieval-cases.json
```

最小示例：

```json
{
  "cases": [
    {
      "id": "eval:orders:refund-rule",
      "status": "active",
      "module": "orders",
      "query": "什么情况下允许退款？",
      "expected_intent": "semantic",
      "expected_knowledge_ids": ["kb:orders:product:refund-rule"],
      "required_evidence_ids": ["nav:branch:refund-allowed"]
    },
    {
      "id": "eval:orders:no-answer",
      "status": "active",
      "module": "orders",
      "query": "订单模块不负责的问题",
      "expect_found": false,
      "forbidden_text": ["禁止出现的错误结论"]
    }
  ]
}
```

Case 使用稳定 ID，不依赖数组顺序。推荐覆盖七类问题：UI 入口、业务规则、用户反馈、字段血缘、影响分析、状态路径和无答案边界。

### Case 从哪里来

有两个来源：

1. 生成知识库时，Agent 根据模块主链路和确定性 AST 场景建立基础 Case。
2. 真实检索出现差评或缺失时，用户确认修正后，生成 Skill 自动把这个问题、修正知识 ID 和 Gap ID 固化成回归 Case。

因此 Case 不是一次性准备的测试集，而是随真实使用持续增长的团队资产。

### 单个 Case 如何判定

每次回归使用与日常查询完全相同的检索路径。一个 Case 需要同时满足其声明的约束才算通过：

- `expect_found`：结果是否应该命中；适合验证无答案边界。
- `expected_knowledge_ids`：声明的知识 ID 必须出现在检索结果中。
- `required_evidence_ids`：声明的 AST/代码证据 ID 必须被召回。
- `expected_intent`：可选；检索器识别出的意图必须一致，用于防止路由退化。
- `forbidden_text`：结果中不能出现已知错误结论。

报告同时给出：

- `pass_rate`：通过 Case 数 / active Case 数；
- `top3_knowledge_hit_rate`：期望知识进入前三的比例；
- `evidence_recall`：必需证据的召回比例；
- 冷启动、平均和 P95 延迟。

`pass_rate` 判断硬约束是否满足，Top-3 反映排序质量，两者不能混为一个指标。

### 如何评价真实问题是否被 Case 覆盖

回归通过只说明“已有 Case 没退化”，不能说明 Case 覆盖了用户真正关心的问题。因此 `confidence` 还会把最近真实查询映射到 Case：

- 显式 Case 关联、Case 的 `source_ref` 指向本次检索、或归一化问题完全一致：记为 `matched`。
- 只有 token 相似度达到阈值：记为 `candidate`，需要人工确认，不计入覆盖率。
- 没有可靠映射：记为 `missing`，表示应评估是否补充 Case 或知识。

命中同一篇通用 Knowledge 不能单独算作 `matched`，否则不同问题会被错误归入同一个基础 Case。

真实问题 Case 覆盖率为：

```text
matched 唯一问题数 / 最近窗口内唯一问题数
```

这种口径把“检索是否稳定”和“测试集是否覆盖真实需求”分开，避免 Case 全通过但用户问题大量缺失的假象。

### 什么时候运行

Case 回归不要求用户记住命令，会在以下时机自动运行：

- 生成或更新知识完成收尾时；
- 补充确认知识后；
- 用户要求检查知识置信度时。

回归结果保存在本地 `.codewiki/evaluation-runs/`。Case 文件和知识文档进入 Git，运行结果不进入 Git。

## 置信报告

```text
检查订单模块的知识置信度，并告诉我哪些知识过期、哪些真实问题缺少 Case。
```

`codewiki-review` Skill 会运行报告并把机器结果整理为可执行的结论。

报告包含：

- Knowledge 证据新鲜度：`current`、`stale`、`unverified`；
- 最近真实问题的可靠命中、候选命中与未覆盖数量，并列出每条问题对应的 Case；
- 用户评价覆盖率、有帮助率和未评价数量；
- Gap 的总数、待处理、关闭、重开、已关联/未关联 Case 数量；
- Active Case 的来源分布（自动生成、反馈沉淀、人工/PRD/测试等）与本周期新增数量；
- 最新 Case 回归通过率、Top-3 命中率和证据召回；
- 由 Agent 整理、但需要用户确认的补充或拆分 Case 建议。

自动基础 Case、确定性代码事实和用户确认 Case 会分开呈现。报告不会把它们混成一个“知识正确率”总分。

## 目录边界

```text
codewiki.yml                          # 可提交
.codewiki/
├── INSTRUCTIONS.md                  # 可提交：团队生成约束与业务词汇
├── modules/                          # 可提交：团队知识资产
│   └── orders/
│       ├── manifest.yml
│       ├── product/
│       ├── developer/               # 跨前后端研发实现知识
│       ├── quality/
│       ├── navigation/              # 含统一 graph.jsonl 与 bindings.jsonl
│       └── retrieval-cases.json
├── cache/                            # 本地，不提交
├── retrieval.jsonl                   # 本地，不提交
├── feedback.jsonl                    # 本地，不提交
├── gaps.jsonl                        # 本地，不提交
├── evaluation-runs/                  # 本地，不提交
├── knowledge-health/                 # 本地，不提交
├── transactions/                     # 本地，不提交：生成快照与失败现场
└── site/                             # 本地，不提交
```

默认配置：

```yaml
knowledge_root: .codewiki/modules
state_root: .codewiki
```

Monorepo 可按业务模块显式配置多个 Source Unit；未配置时会从 `package.json`、`pom.xml`、`build.gradle` 和 `go.mod` 自动发现：

```yaml
knowledge_root: .codewiki/modules
state_root: .codewiki

modules:
  - name: orders
    source_units:
      - name: orders-web
        path: apps/orders-web
        framework: vue
        version: auto
      - name: orders-admin
        path: apps/orders-admin
        framework: react
        version: auto
      - name: orders-api
        path: services/orders
        language: java
        framework: spring
      - name: payment-service
        path: services/payment
        language: go
```

首期兼容 Vue 2.6、Vue 2.7、Vue 3.x，以及 React 16.8、17、18、19 的常见组件模式。Java 和 Go 使用官方 Tree-sitter Grammar；Spring、Gin 和常见 HTTP 路由会进一步生成 Endpoint，并通过 HTTP Method + 标准化 Path 与前端请求建立跨语言关系。

## Agent Skills 与 MCP 检索

初始化后，Claude Code 从 `.claude/skills/` 加载，Codex 从 `.agents/skills/` 加载。两者共用包内同一份 `codewiki-generate`、`codewiki-query` 和 `codewiki-review`，避免维护两套工作流。

Skill 只在相关任务出现时加载，不把完整 `graph.jsonl` 或所有知识文档放进上下文。查询 Skill 调用 `codewiki_explore` MCP 工具；检索器识别语义、影响面、链路、血缘或状态意图，再选择 Markdown、统一图或两者联合。

`init` 和 `upgrade` 都会自动为 Claude Code 与 Codex 配置 MCP。MCP 只暴露必要的结构化检索工具；Skill 负责决定何时调用以及如何处理反馈。

CI 没有 Agent 交互时，可以直接调用内部执行接口；仓库提供了 `examples/codewiki-update.yml` 作为模板。

## 设计原则

1. 确定性优先：AST 负责结构事实，LLM 负责可读语义。
2. 证据优先：代码结论必须可追到 `file:line`，代码外事实必须注明来源。
3. 文档为源：Markdown 可评审、可 diff、可被产品和测试直接消费。
4. 本地优先：无服务、无 embedding、无遥测；运行状态默认不进 Git。
5. 质量可回归：反馈必须能落到 Knowledge、Eval Case 和稳定 Gap。
6. 索引不是正文：`graph.jsonl` 服务检索、链路和影响分析，人和 Git 评审仍以 Markdown 为主。

多语言与 Monorepo 架构见 [v0.4 技术方案](docs/technical-design-v0.4-multilanguage.md)，融合架构见 [v0.3 技术方案](docs/technical-design-v0.3-fusion.md)，升级说明见 [v0.2 → v0.3 迁移指南](docs/migration-v0.2-v0.3.md)。

完整操作方式见 [用户指南](docs/user-guide.md)。
