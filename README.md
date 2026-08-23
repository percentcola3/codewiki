# codewiki

**面向前端仓库的知识库 CLI**：把一个 Vue/TS 前端模块扫描成「业务语义 + 架构导航 + 代码证据」三层知识库，提供检索 MCP 给 AI 编码助手（Claude Code / Codex / Cursor 等）自然问答，并用本地命中记录与用户评级做置信度评估。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)

```
                       ┌──────────────────────────────────────────┐
  前端源码 (Vue/TS) ──▶ │  codewiki scan   确定性 AST 管线          │
   .vue .ts .tsx        │  nav-parser → graph-cluster → deep-     │
   Pinia / API / IPC    │  analyzer → field-lineage               │
                       └───────────────┬──────────────────────────┘
                                       ▼
                       .codewiki/modules/<module>/   （本地知识库）
                       ├── product/    业务语义层（PM/QA 视角，Agent 撰写）
                       ├── frontend/   前端架构层（主链路/影响面/坑点）
                       └── navigation/ AST 导航层（图/字段血缘/绑定）
                                       │
             ┌─────────────────────────┼─────────────────────────┐
             ▼                         ▼                         ▼
   ┌───────────────────┐   ┌─────────────────────┐   ┌────────────────────┐
   │ codewiki mcp      │   │ codewiki preview    │   │ codewiki confidence│
   │ codewiki_explore  │   │ 交互式 HTML 站点     │   │ 置信度评级 A–E     │
   │ 语义→绑定→图游走   │   │ 搜索/折叠/评级徽章  │   │ 证据/覆盖/Gap      │
   └─────────┬─────────┘   └─────────────────────┘   └─────────▲──────────┘
             ▼                                                  │
   .codewiki/retrieval.jsonl（命中记录）  .codewiki/feedback.jsonl（用户评级）
             │                                                  │
             └──────────── /wiki-explore 差评反哺 ───────────────┘
                          codewiki case add → knowledge-overlay
```

## 为什么需要 codewiki

AI 编码助手在一个陌生前端仓库里面临的核心问题不是「找不到符号」，而是**业务语义缺失**：

- “这个按钮点了会发生什么？” —— 需要事件绑定 → handler → store action → API 的完整链路
- “什么情况下允许退款？” —— 业务规则散落在分支条件、状态机和后端契约里
- “改后端这个字段会影响哪些页面？” —— 需要 UI 字段 → store → 接口的反向血缘
- “这份 AI 生成的文档可信吗？” —— 需要证据校验分和真实检索命中记录

通用代码图工具（CodeGraph 等）解决符号级导航；嵌入检索（Cursor 等）解决相似度匹配。codewiki 补上第三块：**把确定性 AST 分析沉淀成带 `file:line` 证据的业务知识库，让 AI 的每次检索命中、每个用户评级都成为知识质量的度量**。

## 快速开始

```bash
npm i -g codewiki        # 或 npx codewiki

# 1. 初始化：安装 /wiki-scan、/wiki-explore 指令，注册 MCP，下发工作流文档
codewiki init

# 2. 在 Claude Code 中建立知识库（AST 扫描 + 撰写语义层 + 索引 + 自检）
/wiki-scan src/views/order

# 3. 用真实问题验证检索、并给回答评级（差评可一键反哺知识库）
/wiki-explore 退款什么情况下允许？

# 4. 浏览器查看交互式 HTML 知识库站点
codewiki preview

# 5. 置信度评估（证据分 + 场景覆盖 + 命中记录 + 用户评级）
codewiki confidence --days 30
```

不依赖 Claude Code 也可以直接用 CLI：

```bash
codewiki scan src/views/order          # AST 六阶段管线 → .codewiki/modules/order/navigation/
codewiki index                         # 构建检索索引
codewiki query "导出按钮怎么实现"        # 检索
codewiki evaluate --cases .codewiki/modules/order/retrieval-cases.json --repeat 5
```

### 接入 MCP

`codewiki init` 会自动把下面配置合并进项目 `.mcp.json`（也可手动配置）：

```json
{
  "mcpServers": {
    "codewiki": { "command": "npx", "args": ["-y", "codewiki", "mcp"] }
  }
}
```

AI 助手获得 `codewiki_explore` 工具：按问题自动选择 `semantic`（业务语义）或 `evidence`（代码证据）模式，返回语义文档摘要 + 置信度加权的图路径 + `file:line` 证据清单。无结构化命中时自动降级到 `navigation/index.yml` 文本检索。Claude Code 用户可额外启用陈旧检测 Hook（见 `integrations/claude-code/`）。

## 指令（Claude Code Commands）

`codewiki init` 安装两个指令到 `.claude/commands/`（模板源在 [commands/](commands/)）：

| 指令 | 作用 |
| --- | --- |
| `/wiki-scan [路径] \| --update` | 建立/更新模块知识库：跑 AST 管线 → 按 [agent 工作流](docs/agent-workflow.md) 撰写语义层 → `index` → 固定问题集验收 → `--validate` 证据自检 |
| `/wiki-explore` | 检索知识库回答业务/代码问题；**回答后必须邀请用户评级**；差评时梳理对话、经用户确认后 `case add` 增补知识并重建索引 |

`/wiki-explore` 的可信度闭环：

1. 检索命中自动记录到 `.codewiki/retrieval.jsonl`（query、命中 knowledge/evidence id、延迟、是否降级/过期）
2. 用户评级经 `codewiki feedback record` 写入 `.codewiki/feedback.jsonl`，并通过 `retrieval_id` 与命中记录关联
3. 评价不好时：Agent 梳理本轮对话、读源码补证 → 用户确认 → `codewiki case add` 写入 `knowledge-overlay`（source=user）→ `codewiki index` 后立即可检索
4. `codewiki confidence` 把上述信号计入评级：user case 提升场景覆盖分，未命中与差评构成 Gap

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `codewiki init` | 初始化项目：指令 + MCP 配置 + 工作流文档下发 + gitignore |
| `codewiki scan <target> [--output <dir>] [--incremental]` | AST 六阶段管线：nav-parser → graph-cluster → data-shape-tracer → pinia-tracker → deep-analyzer → field-lineage |
| `codewiki scan <target> <output-dir> --validate` | 证据自检：校验全部 `file:line` 引用、弱措辞、占位符，输出逐文件置信评分 |
| `codewiki index [--module <m>]` | 构建检索索引（语义倒排 + bindings + 导航图） |
| `codewiki query "<问题>"` | 检索知识库 |
| `codewiki evaluate --cases <file.json>` | 固定问题集回归（七类问题模板见 `docs/references/retrieval-cases.example.json`） |
| `codewiki confidence [--days 30]` | 模块置信度评估 |
| `codewiki feedback record --rating good\|bad --query "..."` | 记录 /wiki-explore 回答的用户评级 |
| `codewiki case add --module M --title ... --answer ... --evidence <file:line>` | 增补用户确认的知识（立即参与检索与置信度） |
| `codewiki site` | 渲染交互式 HTML 站点到 `.codewiki/site/` |
| `codewiki preview [--port 4173] [--no-open]` | 渲染站点 + 启动本地服务器 + 自动打开浏览器 |
| `codewiki mcp` | 启动 stdio MCP Server |

## 本地数据布局

知识库与全部状态都在项目内 `.codewiki/`（init 时加入 gitignore，纯本地、零上报）：

```
.codewiki/
├── modules/<module>/           知识库（scan 产物 + Agent 撰写的语义层）
│   ├── manifest.yml            base_commit、business_terms、coverage_assertions
│   ├── product/                Layer 1 业务语义：业务全景 / 字段级页面逻辑 / 改动决策卡
│   ├── frontend/               Layer 2 前端架构：架构与调用图 / 变更影响导航 / 坑点与状态
│   └── navigation/             Layer 3 AST 导航（确定性）
│       ├── file-graph.json / func-dependencies.json / component-refs.json
│       ├── clusters.json       Louvain + PageRank + betweenness（hub 识别）
│       ├── deep-analysis.json  状态机 / 分支路由 / 超时恢复 / 产品限制候选信号
│       ├── field-lineage/      字段级血缘：页面字段 → store → API → 加工规则
│       ├── bindings.jsonl      kb:* ↔ nav:* 稳定绑定
│       └── validation-report.json
├── site/                       HTML 站点（preview 消费）
├── cache/                      检索派生索引（fingerprint 缓存）
├── retrieval.jsonl             检索命中记录（case 命中 → 置信度输入）
├── feedback.jsonl              用户评级（good/bad，关联 retrieval_id）
├── knowledge-overlay/          用户确认后增补的知识（差评反哺产物）
└── knowledge-health/           置信度历史（只增不改）
```

希望知识库随 git 版本化时，用 `codewiki scan <target> --output docs/<module>` 显式输出到 `docs/` 即可。

## 检索模型

`codewiki_explore` 是混合检索，不是单一图遍历：

1. **语义层命中**：对 `product/` `frontend/` Markdown 的倒排索引打分（标题/别名/问题句/实体加权）
2. **绑定展开**：命中文档通过 `bindings.jsonl` 找到 `nav:*` 代码图节点
3. **图游走**：沿置信度 ≥ 0.4 的边扩展 2–3 跳，动态调用链、字段血缘、事件绑定都在图上
4. **证据输出**：按深度 + 置信度 + PageRank 排序输出 `file:line` 证据与关联路径

## 置信度评估

`codewiki confidence` 汇总四类信号，输出 A–E 评级：

| 信号 | 权重 | 来源 |
| --- | --- | --- |
| 证据分 | 50% | `validation-report.json` 逐文件 `file:line` 校验通过率 |
| 场景覆盖 | 30% | 确定性场景用例（分支/状态机/超时）被文档覆盖比例 + 用户确认知识（source=user） |
| Gap 闭环 | 20% | 真实检索未命中 + 用户差评构成的问题 Gap |
| 使用统计 | 参考项 | 查询量、found_rate、降级率、延迟、bad_rate、高频未命中问题 |

评估历史追加在 `.codewiki/knowledge-health/<module>/confidence-history.jsonl`，可观察知识库随代码演进的质量趋势。

## 与其他方案对比

| 维度 | **codewiki** | [CodeGraph](https://github.com/colbymchenry/codegraph) 等代码图 MCP | Sourcegraph SCIP / LSIF | Cursor / Greptile 嵌入检索 | Aider repo-map | Repomix |
| --- | --- | --- | --- | --- | --- | --- |
| 回答的问题 | “退款什么条件允许”“这个字段从哪来”“改 X 影响哪些页面” | “X 在哪定义”“谁调用 Y” | 符号定义/引用/跳转 | 相似代码片段 | 文件级上下文挑选 | 整仓打包喂 LLM |
| 业务语义层 | ✅ product/frontend 两层（PM/QA 也可读） | ❌ 只有符号图 | ❌ | ⚠️ 依赖嵌入命中 | ❌ | ❌ |
| 前端深度解析 | ✅ Vue SFC template AST 字段绑定、Pinia store、API/IPC/WS endpoint、字段级血缘 | ⚠️ tree-sitter 通用 AST，模块级 | ⚠️ 语法级 | ⚠️ 文本/分块 | ⚠️ 文件级 | ❌ |
| 证据保障 | ✅ 每条结论强制 `file:line`，脚本自检 FAIL 即标 draft | ⚠️ 图可信，结论无门禁 | ✅ 索引精确 | ❌ | ❌ | ❌ |
| 用户反馈闭环 | ✅ 回答评级 → 差评反哺知识 → 置信度提升 | ❌ | ❌ | ⚠️ 隐式 | ❌ | ❌ |
| 知识质量度量 | ✅ 固定问题集回归 + 置信度评级 + 命中/评级记录 | ❌ | ❌ | ❌ | ❌ | ❌ |
| 过期检测 | ✅ manifest base_commit ↔ HEAD 比对，检索时提示陈旧 | ✅ 自动重索引 | ⚠️ 需服务端 | ✅ 后台重建 | 每次现算 | 每次重打包 |
| 浏览体验 | ✅ 交互式 HTML 站点（preview） | ❌ | ⚠️ Web UI（服务端） | ⚠️ IDE 内 | ❌ | ❌ |
| 基础设施 | **零服务**，纯 Node 本地 | 本地（Kuzu + SQLite） | 需 Sourcegraph 服务 | 需云端嵌入 | 无 | 无 |
| 适用语言 | 前端为主（Vue 优先，TS/JS/JSX） | 多语言 | 多语言 | 多语言 | 多语言 | 任意 |

**选型建议**：三者互补而非互斥——符号级精确导航（重构、找引用）用 CodeGraph / SCIP / IDE LSP；海量模糊语义匹配用嵌入检索；**业务规则、字段血缘、改动影响 + 可审计证据与质量度量**用 codewiki。codewiki 的不可替代点是证据治理闭环：AST 只出确定性事实、语义文档强制绑定代码、`--validate` 门禁挡住无证据结论、检索命中与用户评级反哺置信度。

## 设计原则

1. **确定性优先**：结构事实全部由 AST 脚本产出；LLM 只做语义转述，不做结构判断
2. **证据强制**：反捏造分级约束（代码事实/UI 文案/业务术语/产品限制各有证据要求），弱措辞与占位符扣分
3. **本地优先、零上报**：知识库、命中记录、评级、置信度历史全部落 `.codewiki/`（gitignore），无遥测
4. **语义 Markdown 为源、HTML 为视图**：Agent 写 Markdown（frontmatter 供检索/校验消费），`preview` 渲染交互式 HTML 站点
5. **增量友好**：结构指纹四档判级（NONE/COSMETIC/STRUCTURAL/FIELD_ONLY），注释级变更零 LLM 成本

## 仓库结构

```
bin/codewiki.js        CLI 入口
src/cli.mjs            命令分发 + scan 管线编排
src/init.mjs           项目初始化（指令/MCP/工作流文档下发）
src/site.mjs           HTML 站点渲染（Markdown 源 → 交互式页面）
src/preview.mjs        本地服务器 + 自动开浏览器
src/confidence.mjs     置信度评估
src/feedback.mjs       评级记录 + 差评反哺（case add）
src/scan/              AST 管线与检索（可独立 node 直跑）
commands/              /wiki-scan、/wiki-explore 指令模板（init 下发）
docs/                  Agent 工作流 + 产物 schema + 模板
integrations/          Claude Code Hook 等宿主集成
```

依赖刻意保持极简：`@swc/wasm`（纯 WASM 解析，无原生编译）、`@vue/compiler-sfc`、`jlouvain`、`yaml`、`marked`（preview 时 Markdown→HTML 渲染）。TypeScript 解析为可选降级路径（从目标项目解析）。

## 开发

```bash
npm install
npm test        # node --test tests/
```

## Roadmap

- [ ] confidence v2：case 维度命中率聚合（把检索命中记录升级为回归用例）
- [ ] 置信度趋势看板（`confidence-history.jsonl` 可视化并入 preview 站点）
- [ ] React/JSX 模板字段绑定
- [ ] 多仓库联合检索

## License

[MIT](LICENSE)
