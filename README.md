# codewiki

**面向前端仓库的知识库 CLI**：把一个 Vue/TS 前端模块扫描成「业务语义 + 架构导航 + 代码证据」三层知识库，提供检索 MCP 给 AI 编码助手（Claude Code / Codex / Cursor 等）自然问答，并用本地命中记录做置信度评估。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)

```
                       ┌──────────────────────────────────────────┐
  前端源码 (Vue/TS) ──▶ │  codewiki scan   确定性 AST 管线          │
   .vue .ts .tsx        │  nav-parser → graph-cluster → deep-     │
   Pinia / API / IPC    │  analyzer → field-lineage               │
                       └───────────────┬──────────────────────────┘
                                       ▼
                       docs/<module>/  （可提交、可 Code Review）
                       ├── product/    业务语义层（PM/QA 视角，Agent 撰写）
                       ├── frontend/   前端架构层（主链路/影响面/坑点）
                       └── navigation/ AST 导航层（图/字段血缘/绑定）
                                       │
                                       ▼
                       ┌──────────────────────────────────────────┐
  AI 助手自然提问 ─────▶│  codewiki mcp    codewiki_explore 工具   │
  “退款什么条件允许？”    │  语义文档 → bindings → 图 2-3 跳展开      │──▶ 答案 + file:line 证据
                       └───────────────┬──────────────────────────┘
                                       ▼
                       .codewiki/retrieval.jsonl（本地命中记录）
                                       │
                                       ▼
                       codewiki confidence  置信度评估（A–E 评级）
```

## 为什么需要 codewiki

AI 编码助手在一个陌生前端仓库里面临的核心问题不是「找不到符号」，而是**业务语义缺失**：

- “这个按钮点了会发生什么？" —— 需要事件绑定 → handler → store action → API 的完整链路
- “什么情况下允许退款？" —— 业务规则散落在分支条件、状态机和后端契约里
- “改后端这个字段会影响哪些页面？" —— 需要 UI 字段 → store → 接口的反向血缘
- “这份 AI 生成的文档可信吗？" —— 需要证据校验分和真实检索命中记录

通用代码图工具（CodeGraph 等）解决符号级导航；嵌入检索（Cursor 等）解决相似度匹配。codewiki 补上第三块：**把确定性 AST 分析沉淀成带 `file:line` 证据的业务知识库，并让 AI 的每次检索命中都成为知识质量的度量**。

## 快速开始

```bash
npm i -g codewiki        # 或 npx codewiki

# 1. 扫描一个模块（产出 docs/<module>/navigation/ 代码图与字段血缘）
codewiki scan src/views/order --output docs/order

# 2. （AI 助手按 docs/agent-workflow.md 撰写 product/ frontend/ 语义层后）构建检索索引
codewiki index

# 3. 检索验证
codewiki query "退款什么情况下允许"

# 4. 固定问题集评估检索质量（Top-3 命中率 / 证据召回率 / 冷热延迟 P95）
codewiki evaluate --cases docs/order/retrieval-cases.json --repeat 5

# 5. 置信度评估（证据分 + 场景覆盖 + 检索命中记录）
codewiki confidence --days 30
```

### 接入 MCP

```json
{
  "mcpServers": {
    "codewiki": { "command": "npx", "args": ["-y", "codewiki", "mcp"] }
  }
}
```

AI 助手获得 `codewiki_explore` 工具：按问题自动选择 `semantic`（业务语义）或 `evidence`（代码证据）模式，返回语义文档摘要 + 置信度加权的图路径 + `file:line` 证据清单。无结构化命中时自动降级到 `navigation/index.yml` 文本检索。Claude Code 用户可额外启用陈旧检测 Hook（见 `integrations/claude-code/`）。

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `codewiki scan <target> [--output docs/<module>] [--incremental]` | AST 六阶段管线：nav-parser → graph-cluster → data-shape-tracer → pinia-tracker → deep-analyzer → field-lineage |
| `codewiki scan <target> <output-dir> --validate` | 证据自检：校验全部 `file:line` 引用、弱措辞、占位符，输出逐文件置信评分 |
| `codewiki index [--module <m>]` | 构建检索索引（语义倒排 + bindings + 导航图），写入 `.codewiki/cache/` |
| `codewiki query "<问题>" [--detail semantic\|evidence]` | 检索知识库 |
| `codewiki evaluate --cases <file.json>` | 固定问题集回归（七类问题模板见 `docs/references/retrieval-cases.example.json`） |
| `codewiki confidence [--days 30] [--json]` | 模块置信度评估 |
| `codewiki mcp` | 启动 stdio MCP Server |

## 产物结构

```
docs/<module>/
├── manifest.yml          # 模块元信息：base_commit、business_terms、coverage_assertions
├── README.md             # 角色路由器
├── product/              # Layer 1 业务语义（PM/QA 视角）：业务全景 / 字段级页面逻辑 / 改动决策卡
├── frontend/             # Layer 2 前端架构：架构与调用图 / 变更影响导航 / 坑点与状态
└── navigation/           # Layer 3 AI 导航（脚本产物，确定性）
    ├── file-graph.json           # 文件依赖图（含 IPC / 动态 import 边）
    ├── func-dependencies.json    # 函数级调用关系
    ├── component-refs.json       # 组件使用/事件/模板字段绑定（Vue SFC template AST）
    ├── clusters.json             # Louvain 聚类 + PageRank + betweenness（hub 识别）
    ├── deep-analysis.json        # 状态机 / 分支路由 / 超时恢复 / 产品限制等候选信号
    ├── field-lineage/            # 字段级血缘：页面字段 → store → API → 加工规则
    ├── bindings.jsonl            # kb:*（语义文档）↔ nav:*（代码图节点）稳定绑定
    └── validation-report.json    # 证据自检报告（逐文件置信评分）
```

语义层由 AI 助手按 [`docs/agent-workflow.md`](docs/agent-workflow.md) 撰写——每条结论必须有 `file:line` 证据，`--validate` 不过关的文档会被标记为 draft。这个工作流同样适用于 Codex / Cursor 等任何能执行 CLI 的 Agent。

## 检索模型

`codewiki_explore` 是混合检索，不是单一图遍历：

1. **语义层命中**：对 `product/` `frontend/` Markdown 的倒排索引打分（标题/别名/问题句/实体加权）
2. **绑定展开**：命中文档通过 `bindings.jsonl` 找到 `nav:*` 代码图节点
3. **图游走**：沿置信度 ≥ 0.4 的边扩展 2–3 跳，动态调用链、字段血缘、事件绑定都在图上
4. **证据输出**：按深度 + 置信度 + PageRank 排序输出 `file:line` 证据与关联路径

每次检索写入 `.codewiki/retrieval.jsonl`（query、命中 knowledge/evidence id、延迟、是否降级、知识库是否过期）。**这是纯本地记录，不包含任何上报**；它作为 `codewiki confidence` 的输入，度量知识库在真实使用中的命中率。

## 置信度评估

`codewiki confidence` 汇总三类信号，输出 A–E 评级：

| 信号 | 权重 | 来源 |
| --- | --- | --- |
| 证据分 | 50% | `validation-report.json` 逐文件 `file:line` 校验通过率 |
| 场景覆盖 | 30% | 确定性场景用例（分支路由/状态机/超时恢复）被文档覆盖的比例 |
| Gap 闭环 | 20% | 真实检索未命中（`.codewiki/retrieval.jsonl`）形成的问题 Gap |

评估历史追加在 `.codewiki/knowledge-health/<module>/confidence-history.jsonl`，可观察知识库随代码演进的质量趋势。评级算法在 [`src/confidence.mjs`](src/confidence.mjs) 与 [`src/scan/knowledge-confidence.mjs`](src/scan/knowledge-confidence.mjs)，case 命中记录的深度利用（按 case 维度聚合命中率）在路线图中。

## 与其他方案对比

| 维度 | **codewiki** | [CodeGraph](https://github.com/colbymchenry/codegraph) 等代码图 MCP | Sourcegraph SCIP / LSIF | Cursor / Greptile 嵌入检索 | Aider repo-map | Repomix |
| --- | --- | --- | --- | --- | --- | --- |
| 回答的问题 | “退款什么条件允许”“这个字段从哪来”“改 X 影响哪些页面” | “X 在哪定义”“谁调用 Y” | 符号定义/引用/跳转 | 相似代码片段 | 文件级上下文挑选 | 整仓打包喂 LLM |
| 业务语义层 | ✅ product/frontend 两层 Markdown（PM/QA 也可读） | ❌ 只有符号图 | ❌ | ⚠️ 依赖嵌入命中 | ❌ | ❌ |
| 前端深度解析 | ✅ Vue SFC template AST 字段绑定、Pinia store 结构、API/IPC/WS endpoint、字段级血缘 | ⚠️ tree-sitter 通用 AST，模块级 | ⚠️ 语法级 | ⚠️ 文本/分块 | ⚠️ 文件级 | ❌ |
| 证据保障 | ✅ 每条结论强制 `file:line`，脚本自检 FAIL 即标 draft | ⚠️ 图本身可信，结论无门禁 | ✅ 索引精确 | ❌ | ❌ | ❌ |
| 知识质量度量 | ✅ 固定问题集回归 + 置信度评级 + 本地命中记录 | ❌ | ❌ | ❌ | ❌ | ❌ |
| 过期检测 | ✅ manifest base_commit ↔ HEAD 比对，检索时提示陈旧 | ✅ 自动重索引 | ⚠️ 需服务端 | ✅ 后台重建 | 每次现算 | 每次重打包 |
| 产物形态 | ✅ 可提交的 docs/，可 Code Review、随 git 版本化 | ⚠️ 本地数据库 | ⚠️ 索引上传服务端 | ⚠️ 私有服务 | 运行时生成 | 运行时生成 |
| 基础设施 | **零服务**，纯 Node 本地 | 本地（Kuzu + SQLite） | 需 Sourcegraph 服务 | 需云端嵌入 | 无 | 无 |
| 适用语言 | 前端为主（Vue 优先，TS/JS/JSX） | 多语言 | 多语言 | 多语言 | 多语言 | 任意 |

**选型建议**：三者互补而非互斥——

- 团队/AI 需要**符号级精确导航**（重构、找引用）→ CodeGraph / SCIP / IDE LSP
- AI 需要**海量模糊语义匹配**（“类似的实现”）→ 嵌入检索
- AI 需要回答**业务规则、字段血缘、改动影响**，且要求**可审计的证据与质量度量** → codewiki

codewiki 的不可替代点是**证据治理**：AST 脚本只输出确定性事实，语义文档强制携带稳定 ID 与代码绑定，`--validate` 门禁挡住无证据结论，检索命中记录反过来度量知识库质量——这套闭环在上述任何方案中都不存在。

## 设计原则

1. **确定性优先**：结构事实全部由 AST 脚本产出；LLM 只做语义转述，不做结构判断
2. **证据强制**：反捏造分级约束（代码事实/UI 文案/业务术语/产品限制各有证据要求），弱措辞与占位符扣分
3. **本地优先、零上报**：检索命中、置信度历史全部落本地 `.codewiki/`（建议 gitignore），无遥测
4. **产物可评审**：知识库是仓库内的一等公民，走 PR 审查，`manifest.base_commit` 锚定代码版本
5. **增量友好**：结构指纹三档判级（NONE/COSMETIC/STRUCTURAL/FIELD_ONLY），注释级变更零 LLM 成本

## 仓库结构

```
bin/codewiki.js        CLI 入口
src/cli.mjs            命令分发 + scan 管线编排
src/confidence.mjs     置信度评估命令
src/scan/              AST 管线与检索（可独立 node 直跑）
  nav-parser.mjs       SWC/WASM + @vue/compiler-sfc 解析
  graph-cluster.mjs    Louvain / PageRank / Brandes 介数
  deep-analyzer.mjs    行为信号 + 证据自检（--validate）
  field-lineage.mjs    字段级血缘融合
  pinia-tracker.mjs    Pinia store 结构
  data-shape-tracer.mjs API/IPC/WS endpoint 抽取
  fingerprint.mjs      结构指纹（增量判档）
  knowledge-retrieval.mjs  混合检索引擎
  knowledge-confidence.mjs 置信度算法
  mcp-server.mjs       stdio MCP Server
docs/                  Agent 工作流 + 产物 schema + 模板
integrations/          Claude Code Hook 等宿主集成
```

依赖刻意保持极简：`@swc/wasm`（纯 WASM 解析，无原生编译）、`@vue/compiler-sfc`、`jlouvain`、`yaml`。TypeScript 解析为可选降级路径（从目标项目解析）。

## 开发

```bash
npm install
npm test        # node --test tests/
```

## Roadmap

- [ ] confidence v2：case 维度命中率聚合（把检索命中记录升级为回归用例）
- [ ] 置信度趋势看板（`confidence-history.jsonl` 可视化）
- [ ] React/JSX 模板字段绑定
- [ ] 多仓库联合检索

## License

[MIT](LICENSE)
