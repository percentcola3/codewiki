# codewiki Agent 工作流 — 模块知识库生成

> 本文档面向 AI 编码助手（Claude Code / Codex / Cursor 等）：描述 codewiki Skills 如何调用内部 CLI 生成并维护 `.codewiki/modules/<module>/` 知识库。
> 用户 CLI 只负责 `init`、`upgrade`、`uninstall` 三个项目生命周期操作，其余操作由 Skills 编排。内部 CLI 负责确定性 AST 管线、检索索引与证据自检；product/developer 由 AI 助手基于证据撰写，quality 只保存已确认的缺陷、事故、决策和修正。

> **执行约束**：开始生成前先读取 `.codewiki/INSTRUCTIONS.md`。AST 阶段结束后以 `navigation/graph.jsonl` 作为统一机器索引，并按 `NO_IMPACT` / `INDEX_ONLY` / `KNOWLEDGE_IMPACT` 决定是否改写语义文档。Finalize 成功后才接受 Evidence 新指纹；任一校验或 Case 失败会回滚整个模块。

> **多语言执行补充**：业务模块与源码目录分离建模。一个模块可以包含多个 `source_units`，每个 Source Unit 独立记录 path、language、framework、framework_version 和 features。Vue/TypeScript 使用现有深度增强；React 使用 SWC JSX/TSX Profile；Java、Go 使用 Node Tree-sitter。跨语言 HTTP 链路只有 Method + 标准化 Path 精确匹配时才视为 verified。

> **反捏造硬约束（全产物适用，按事实类型分级）**
>
> - 不得猜测、推断、补全或杜撰代码、文档中不存在的逻辑、字段、流程、状态、调用、配置或业务规则。
> - 不同事实类型有不同证据要求（详见 Step 6）：
>   - **代码事实**（链路/字段/状态/超时值）：必须 `file:line`
>   - **用户体验事实**（文案/弹窗/提示）：必须 UI 触发点 + i18n key 或 literal + `file:line`
>   - **业务术语翻译**：必须来自 `manifest.business_terms` 或会话明确给出
>   - **产品限制/不可承诺项**：必须有 `deep-analysis.json#product_limits` 信号 OR 由外部依赖性质推导
>   - **业务规则 why**：优先代码注释/commit/用户输入；否则**先与用户沟通确认**，不要直接标占位符
>   - **工作量/影响面**：仅可数维度（文件数/IPC 数/状态数等），**严禁输出小时/天/人天/sprint 估算**
> - **调用链证据约束**：纳入主流程分析的每条调用链必须有明确调用证据（函数调用 / 事件触发 / IPC 通道 / 路由跳转，带 `file:line`）。代码存在但无法证明被实际调用的，标记为「⚠️ 未验证调用链」并在文档中单独列出提醒用户，不纳入主流程分析，不做全量展开。
> - **证据不足时优先与用户沟通**：提供 2-3 个理解选项让用户选择，而不是直接在文档中堆"待业务确认"占位符。只有用户明确说"先标占位符跳过"时，才在文档中标"待用户确认"。
> - 禁止用"通常""一般""应该""可能""推测"等措辞填补空白。
> - 当意识到正在基于"看起来合理"而非证据写内容时，立即停止——优先选择"提供选项让用户选择"，其次"提问澄清"，最后才是"留白"。

> **codewiki 专属约束**
>
> - 调用链、组件关系、接口、IPC 通道、Store 字段等结构事实，以 `source-units.json` / `framework-facts.json` / `graph.jsonl` 为统一来源；单前端 Source Unit 还可使用 `file-graph.json` / `func-dependencies.json` / `component-refs.json` 的深度增强。脚本未产出的关系，必须由 AI 助手继续读源码补证并给出 `file:line` 后才能写入文档。
> - `deep-analysis.json` 与 `_intermediate/api-payload-shapes.json` 只提供 candidate-evidence-only 候选信号；不能单独作为业务结论、接口契约或产品限制的强事实来源。
> - **Product 层（PM/QA 视角）严禁出现技术细节散落**：函数名、IPC 通道名、毫秒数、文件路径、英文状态名一律下沉到尾部"技术证据索引"章节。业务术语翻译只能用 `manifest.business_terms` 表中的项。
> - **Developer 层每篇必须有元数据头**：Summary / 适合读 / 不适合读 / 先读再读 / 证据入口。
> - **Navigation 层保留完整 AST 图**，并用稳定 `nav:*` ID 与语义文档关联。用户自然问答由 codewiki-query Skill 调用内部检索接口；`navigation/index.yml` 是纯文本后备入口。
> - **Quality 层只保存经确认且有来源的知识**：缺陷、事故和决策使用 `npx codewiki generate` 与 typed evidence；不得把未确认猜测写入共享知识。
> - 自检由 `npx codewiki generate <target> --module <module> --finalize` 完成；FAIL 时整批文档标 `> ⚠️ 状态：draft —— N/M 条结论缺少代码证据`。

codewiki 生成的 product / developer / quality / navigation 知识同时服务四类受众：

| 受众 | 入口 | 核心目标 |
|------|------|---------|
| PM/业务/QA | `README.md` → `product/` | 写 PRD、定验收口径、评估能力边界与不可承诺项 |
| 研发 | `README.md` → `developer/` | 建立实现心智模型（主链路/状态/分支/恢复/外部依赖） |
| AI/自动化 | `codewiki-query` Skill（后备：`navigation/index.yml`） | 用户自然提问，先命中业务语义，再展开完整、可追证的代码图 |

**当前能力**：
- **产物瘦身**：Product 层从 9 章 → 3 大块（业务全景 / 字段级页面逻辑 / 改动决策卡）；Developer 层统一为 3 个阅读入口（架构与调用图 / 变更影响导航 / 坑点与状态）
- **新增 Step 2.7.5 字段级溯源生成**：产 `field-lineage/{index,pages/*,reverse-index}.json`，作为产品层 §2 markdown 的**唯一 SSOT**（详见 `references/layers.md § Step 2.7.5`）
- **新增 5 个脚本能力**（`scripts/`）：
  - `nav-parser.mjs` 增强 template AST 字段绑定抽取（`template_bindings` 字段进 `component-refs.json`）
  - `pinia-tracker.mjs` 抽 store state/actions/getters（`_intermediate/pinia-stores.json`）
  - `data-shape-tracer.mjs` 升级 endpoint 抽取（`_intermediate/api-payload-shapes.json`）
  - `field-lineage.mjs` 融合中间产物产字段级溯源
  - `fingerprint.mjs` helper — `computeStructuralFingerprint` / `computeFieldFingerprint` / `classifyChange`
- **`--update` 增量升级为四档**：`NONE` / `STRUCTURAL 短路` / `FIELD_ONLY` / `COSMETIC` —— 改注释类变更（COSMETIC）零 LLM
- **中间产物落盘契约**：`_intermediate/*.draft.json` + `_intermediate/*.review.json`，主对话流只读窄字段（避免 Phase A/B/C 造成上下文膨胀）
- **反向索引结构化**：`field-lineage/reverse-index.json` 用数组格式（method/endpoint/raw_field/used_by 分离），grep 友好
- **语义文档与代码图双向绑定**：Product/Developer Markdown 使用稳定 `kb:*` ID，Navigation JSON 使用稳定 `nav:*` ID，统一写入 `navigation/bindings.jsonl`
- **自然问答检索入口**：codewiki-query Skill 调用内部查询，根据用户问题自动选择语义或证据检索，按“语义 Markdown → bindings → AST 图 2-3 跳 → 关联 Markdown”展开；派生索引写入 `.codewiki/cache/`。知识库本体位于 `.codewiki/modules/` 并随 Git 共享，预览由 codewiki-review Skill 生成
- **文档与质量约束**：README 角色路由器、按事实类型分级的反捏造规则、候选行为信号、待确认项收集、`business_terms`、`coverage_assertions` 与块级交互确认。

文档结构模板集中在 `references/role-templates.md`，本文仅描述执行流程。JSON schema 集中在 `references/output-schema.md`。

## 调用模式

```
「扫描 <path> 生成知识库」                  # 全量生成（path 优先），Agent 执行 npx codewiki generate + 撰写语义层
「更新知识库」(--update)                    # 无参增量：扫所有 .codewiki/modules/*/manifest.yml，
                                          #   先对比 base_commit ↔ 工作区并列出代码增量，
                                          #   再只更新受影响的 module
「更新知识库」--bugfix [--id <DEF>]         # 缺陷修复后的增量更新；除 update 常规产物外，
                                          #   额外生成 .codewiki/modules/<module>/quality/defects/<id>-<topic>.md
--rewrite <layer>                          # 重写某层: product|developer|navigation
--patch <file>                             # 更新单个文件
多入口/多模块                               # 每个路径独立生成
基于意图推断                                # 未给路径时，基于用户意图推断目标
```

**知识库更新统一入口**：`.codewiki/modules/<module>/{product,developer,quality,navigation}/`、`manifest.yml`、`retrieval-cases.json` 和 `revisions/` 都是共享资产；quality 只能在证据和用户确认齐备后写入。

未提供明确 `<path>` 且不是 `--update` 时，不要默认使用 `.`，也不要直接执行 AST。必须先根据用户业务意图、最近对话、当前项目结构和路由/菜单/页面文件推断候选入口；业务意图必须先输出候选入口清单，用户确认后才进入 Step 1.5 和 AST 管道。只有用户明确说"你判断后直接执行"时，才允许自动采纳一个 high confidence 入口，并在 manifest 中标 `entry_review.mode: auto-adopted`。

**无参 `--update` 行为**：
1. 扫描 `.codewiki/modules/*/manifest.yml`（递归一层），列出所有已建知识库的 module
2. 对每个 module 先读取 `manifest.yml#base_commit`，再计算增量：
   - `git diff --name-status <base_commit>`：覆盖已提交、暂存、未提交的已跟踪文件
   - `git ls-files --others --exclude-standard`：补齐未跟踪新增文件
3. 先输出本次代码增量摘要（added / modified / deleted / renamed / untracked），再进入知识库更新
4. 仅对 diff 非空的 module 进入增量管道；其余跳过并报告"无变更"
5. 若工作区有未提交或未跟踪改动，提醒用户：当前增量已包含这些内容，commit/stash 与否取决于用户是否希望此版本进入 `manifest.base_commit`

**整项目扫描警告**：如果 `<path>` 指向项目根目录，警告耗时和 token 消耗，等待用户明确确认后才执行。

## 执行流程概览

```
Step 1 确定业务模块与 Source Units
  ↓
Step 1.2 候选入口审阅 → 校准分析边界
  ↓
Step 1.5 反向追踪 → 扩展 target（可能迭代）
  ↓
Step 2 AST/Profile 管道（对扩展后的全部 Source Units 执行）
  ↓
Step 2.3 AI 助手动态链路补证 → 发现 target 外调用者时回到 Step 1.5 扩展
  ↓
Step 2.5 高频项识别
  ↓
Step 2.6 候选行为信号抽取 → 行为索引文件（state/ui/timeout/branch/product-limits + 默认 api-payload-shapes）
  ↓
Step 2.7 业务流识别 → 显式产 _intermediate/flows.json
  ↓
Step 2.7.5 字段级溯源生成
  ├─ node scripts/pinia-tracker.mjs → _intermediate/pinia-stores.json
  ├─ node scripts/data-shape-tracer.mjs → _intermediate/api-payload-shapes.json
  ├─ node scripts/field-lineage.mjs → field-lineage/{index,pages/*,reverse-index}.json + 回填 graph-index.json fieldFingerprint
  ├─ 若 pending_llm_verification > 0：主 skill 分批派 subagent 补证 → 深合并 patch → field-lineage --reindex
  ↓
Step 2.8 活跃度验证 → 标记 deprecated
  ↓
Step 2.9 待确认项收集与审阅 → 确认业务术语/业务流命名后继续
  ↓
Step 3 生成 Layer 1（Product，PM 视角，3 大块：业务全景 / 字段级页面逻辑 / 改动决策卡）
  ├─ Phase A 一次性对齐（主链路+field-lineage 待补证项+产品限制）
  ├─ Phase B 每个 flow 先写 _intermediate/product-<flow>.draft.json
  ├─ 独立 review pass 只写 product-<flow>.review.json；主对话只读 review，不读 draft 全文
  ├─ review=pass 后从 draft 渲染三大块（§2 从 field-lineage/pages/*.json 渲染，禁 LLM 手写字段行）
  ├─ review=needs_confirm 时只展示 confirm_asks，确认并更新 draft 后重新 review
  ├─ Phase C 完成后回顾
  ↓
Step 4 生成 Layer 2（Developer；单前端沿用 3 文件模板，多语言模块按跨端链路 / 服务边界 / 影响风险组织）
  ├─ Phase A 一次性对齐（架构分层 + hub 组件 + 接口语义 + 状态机边界 + 核心链路 medium 项）
  ├─ Phase B 每文件先写 _intermediate/layer2-<nn>-<name>.draft.json
  ├─ 独立 review pass 写对应 .review.json；主对话只读 review，不读 draft 全文
  ├─ review=pass 后从 draft 渲染三文件；needs_confirm 先确认再重审
  ├─ Phase C 完成后回顾
  ↓
Step 4.5 生成语义元数据 + bindings.jsonl + 检索索引 + README（index.yml 作为后备入口）
  ↓
Step 5 写 manifest（含 business_terms + coverage_assertions + confirmation_checkpoint）
  ↓
Step 6 证据自检与 Case 回归（npx codewiki generate --finalize）→ FAIL 时整批文档标 draft
```

## Step 1: 确定目标和模式

- **单 Source Unit**：业务模块集中在一个前端或后端目录 → 单个 `.codewiki/modules/<module>/`
- **多 Source Unit**：同一业务模块横跨多个前后端 Workspace → 在同一个模块下配置多个 `source_units`
- **多业务模块**：代码父目录包含多个独立业务域 → 每个业务域生成独立 `.codewiki/modules/<module>/`，不要仅因位于同一 Monorepo 就合并
- 记录 `git rev-parse HEAD` 作为 base_commit
- `--update` 模式：从 manifest.yml 读取 base_commit，用 `git diff --name-status <base_commit>` + `git ls-files --others --exclude-standard` 先确认代码增量，再更新知识库
- 如果存在 `.codewiki/modules/<module>/context/snapshot-*.md`，先读取最近相关文档，把其中的主链路、数据流转、调用链路、待确认项作为 Layer 1/2 的补充输入；仍以 AST 输出和源码证据为准，不直接照抄 snapshot 结论。

### 意图推断目标

当用户只描述业务意图（例如"扫描订单设置""看下会员导入链路""分析打印相关代码"）但没有给路径时，按顺序识别候选目标：

1. 从用户关键词提取业务名、菜单名、路由名、页面标题、组件名、API 关键词。
2. 用 `rg` 在 `src/`、`electron/`、`packages/`、`apps/` 内查找路由、菜单、页面入口、`defineAsyncComponent`、动态 import、`router` 配置、Electron window preload/main 入口。
3. 优先选择同时命中路由/菜单和页面组件的目录；其次选择包含 `components/`、`pages/`、`views/`、`route.ts`、`index.vue` 的目录。
4. 输出候选清单和置信度，进入 Step 1.2 做候选入口审阅；业务意图必须先输出候选入口清单，用户确认后才进入 Step 1.5。

常用命令示例：

```bash
rg -n "<keyword>|<menu>|<route>" src electron packages apps
rg -n "path:|name:|component:|defineAsyncComponent|import\\(" src
rg -n "BrowserWindow|loadURL|loadFile|preload" electron src
```

### 多 Source Unit 和多模块处理

- 同一业务模块的多个路径写入 `codewiki.yml#modules[].source_units`，一次生成统一图，不逐个生成互相覆盖的模块。
- 每个 Source Unit 单独识别语言、框架和版本；显式配置优先，lockfile 和构建清单次之，源码特征只作候选。
- 从意图推断出多个入口时，先按业务边界分组；跨业务模块必须拆分，跨语言不是拆分理由。
- 模块名优先使用稳定业务域名；Source Unit 名使用部署单元或 Workspace 名，避免 `src`、`app` 这类弱名称。

## Step 1.2 / Step 1.5 — 候选入口审阅与范围扩展

主文件不展开。详见 [`references/scope-and-targets.md`](references/scope-and-targets.md)：候选入口清单、审阅策略、manifest 记录格式、范围扩展规则、关联文件发现方法。

## Step 2: 生成 Layer 3（AI Navigation）

前置条件：目标项目已运行 `npx codewiki init`，Skill 内部通过 `npx codewiki` 调用执行接口。

`npx codewiki generate` 先执行 Source Unit/Profile 事实提取。单个前端 Source Unit 继续执行 nav-parser、graph-cluster、data-shape-tracer、pinia-tracker、deep-analyzer、field-lineage 深度增强；多 Source Unit 模块使用统一事实图，避免把无关 Workspace 扫入：

```bash
npx codewiki generate <target> --module <module> [--update]
```

`codewiki.yml` 已声明 Source Units 时可以省略 `<target>`：

```bash
npx codewiki generate --module <module> [--update]
```

字段溯源包含在 generate 管线内；语义文档完成后统一收尾：

```bash
npx codewiki generate <target> --module <module> --finalize
# 已配置多 Source Unit 时：
npx codewiki generate --module <module> --finalize
```

产出 `.codewiki/modules/<module>/navigation/`：

| 文件 | 来源 | 内容 |
|------|------|------|
| source-units.json | fact-extractor | 当前业务模块的语言、框架、版本、能力和目录边界 |
| framework-facts.json | SWC/Vue Profile/Tree-sitter | Vue、React、Java、Go 的统一节点、关系、Endpoint 和跨语言链路 |
| file-graph.json | nav-parser | 文件节点 + 多类型依赖边 |
| func-dependencies.json | nav-parser | 导出函数及其调用关系 |
| component-refs.json | nav-parser | Vue 组件使用、条件、事件；含 `template_bindings` |
| graph-index.json | nav-parser + field-lineage 回填 | 文件级索引；含 `structuralFingerprint`、`fieldFingerprint` 与顶层 `page_fingerprints` |
| graph-quality.json | nav-parser | 图质量报告（覆盖率/低置信/unresolved）|
| clusters.json | graph-cluster | Louvain 聚类、hub、PageRank、betweenness |
| deep-analysis.json | deep-analyzer | 候选派生信号（pipelines/rendering/calculation/event/runtime/flows/validation **+ state_machines / ui_feedback / timeout_recovery / branch_routes / product_limits**）|
| _intermediate/field-candidates.json | nav-parser | 组件 template_bindings 汇总 |
| _intermediate/pinia-stores.json | pinia-tracker | store state/actions/getters 结构 |
| _intermediate/api-payload-shapes.json | data-shape-tracer | hop 追踪 + endpoints_by_file |
| _intermediate/flows.json | 主 skill (Step 2.7 后) | main_flow + branch_flows + fields_referenced |
| field-lineage/index.json | field-lineage | 全模块字段级溯源元信息 |
| field-lineage/pages/<page-id>.json | field-lineage (+ LLM 补证) | 每页面字段完整链路（组件 → store → 接口 → 加工规则 → 异常态）|
| field-lineage/reverse-index.json | field-lineage | 接口 → 字段反查（结构化数组，grep 友好）|
| bindings.jsonl | generate --finalize | `kb:*` 语义文档与 `nav:*` 代码证据的稳定多对多绑定 |
| graph.jsonl | generate / generate --finalize | 稳定、去重的统一图索引，用于影响面、链路、血缘和检索；不是面向人的正文 |
| data-shapes.json | data-shape-tracer `--legacy-copy` | 仅兼容旧消费者时生成；默认不产出 |

**脚本执行后必须先读取 `source-units.json`、`framework-facts.json` 和 `graph.jsonl`**。单前端 Source Unit 再读取 `graph-quality.json` 和深度增强产物。Tree-sitter 的语法定义是确定性结构事实，但重载、Interface 动态分派等目标解析仍可能是 candidate；`deep-analysis.json` 只含候选行为视角，必须经 AI 助手读码补证后才能进入 Layer 1/2 结论。

更新时优先读取 CLI 输出的影响分类。`NO_IMPACT` 和 `INDEX_ONLY` 不改 `product/`、`developer/`；`KNOWLEDGE_IMPACT` 只审阅列出的 Knowledge ID 与 Eval Case。不要因为结构化索引文件数量多而把它们全部转写成 Markdown。

## Step 2.3: AI 助手动态链路补证

AST 导入图无法完整覆盖动态 import、运行时分发、事件总线、RPC/IPC、插件加载和跨进程桥接。此步骤由 AI 助手基于脚本输出和源码继续补证，而不是依赖写死正则直接下结论。

识别信号：

- `graph-quality.json` 中存在 low confidence / unresolved 边
- `file-graph.json` 中存在 `async-import`、`dynamic-require`、`dynamic-dispatch`、`ipc`、`webcontents-send`、`broadcast-channel` 等边
- 源码中存在 API 封装、事件订阅、插件加载、跨进程桥接、store/composable 间接调用
- 用户问题本身指向动态行为，例如“运行时”“推送”“跨进程”“插件”“页面不刷新”

补充步骤：

1. 先读 `graph-quality.json` 和对应 edge 的 `evidence`，列出需要人工补证的候选点。
2. 用 `rg` 找入口和引用后，继续打开源码读完整调用链；不要只凭命名或 channel 字符串判断。
3. 每条动态链路必须串起“发起方 → 中间封装/桥接 → 接收方/handler → 最终业务函数或副作用”，并带 `file:line`。
4. 如果发现 target 外的核心调用者，回到 Step 1.5 扩展范围并重新执行 AST 管道。
5. 将补证后的链路写入 `.codewiki/modules/<module>/navigation/dynamic-flows.md`；Electron 项目可额外生成 `ipc-flows.md` 作为 profile-specific 补充。

常用命令示例：

```bash
rg -n "ipcRenderer\\.(invoke|send|on)|window\\.(electron|api)|contextBridge\\.exposeInMainWorld" <target> electron src
rg -n "ipcMain\\.(handle|on)|BrowserWindow|preload" electron src
rg -n "\"[a-zA-Z0-9:_-]+\"" electron src | rg "ipc|invoke|send|handle|channel"
```

如果 `rg` 不可用，使用 `grep -RIn` 降级。动态链路结论必须带 `code_refs`，不能只凭 channel 名、函数名或正则命中猜测。

**重要：动态链路补证结果必须反馈到范围扩展**。如果补证过程中发现核心调用者不在当前 target 内，必须将这些文件加入扩展范围（参见 Step 1.5），并重新执行 AST 管道。这意味着 Step 2.3 可能触发 Step 1.5 的二次扩展。

## Step 2.5: 高频项识别

从 clusters.json 识别：
- **Hub 文件** — degree > mean + 2*stddev，最高 PageRank
- **Critical nodes** — 最高 betweenness centrality，架构瓶颈
- **大聚类** — 节点最多的聚类 = 核心功能区

**规则：高频项在所有文档中获得更深入的解释** — 读取源码、添加 Mermaid 图、解释算法、在描述中标注频率。

## Step 2.6: 候选行为信号抽取（行为索引）

详见 [`references/deep-analysis.md`](references/deep-analysis.md) 「Step 2.6 候选行为信号」。

## Step 2.7: 业务流识别

在生成 Layer 1 之前，先从 deep-analysis.json 和源码中识别业务流拆分：

1. **从 flows.main_flow 和 branch_flows 识别核心流程**
2. **从状态机实体（状态转换模式）识别独立业务域**
3. **从触发源分离用户操作流 vs 系统触发流**
4. **从代码隔离度（cluster 边界）判断拆分合理性**

确定业务流列表后，为每个流命名（中文业务域名），生成对应的 `<中文业务域名>-flow.md`。

## Step 2.8 / Step 2.9 — 动态链路验证 + 待确认项收集

详见 [`references/deep-analysis.md`](references/deep-analysis.md)：API/IPC 活跃度验证规则、待确认项分级（MUST_CONFIRM / CAN_POSTPONE）、确认清单模板、与 manifest 的关系。

## Step 3 / 4 / 4.5 — 三层文档生成

详见 [`references/layers.md`](references/layers.md)：Layer 1（Product / PM-QA 视角）、Layer 2（Developer / 研发 + AI 视角）、稳定 ID/绑定、检索入口与 README 模板。Product/Developer 每篇 Markdown 必须带语义 frontmatter；`id` 必须匹配 `kb:<manifest.module>:<product|developer>:<topic>`，`aliases/questions/entities` 均非空，且至少有一条 `verified/ast` 绑定。生成正文后运行 `npx codewiki generate <target> --module <module> --finalize`，统一完成绑定校验、派生索引、证据自检和固定七类 Case 回归。

## Step 5: 写 Manifest（含 business_terms + coverage_assertions）

`.codewiki/modules/<module>/manifest.yml` 关键变化：

- `version: "3.6"`
- `business_terms`：业务术语翻译白名单（会话给出事实）。Product 层翻译只能用本表。
- `coverage_assertions`：原 9 个 topic + 字段级溯源/反向索引/结构指纹，共 12 个生成门禁。
- `layers.developer.files` 固定为 `01-架构与调用图.md` / `02-变更影响导航.md` / `03-坑点与状态.md`；内容按 Source Unit 和语言 Profile 调整。
- `layers.navigation` 追加 `field-lineage/`、`_intermediate/api-payload-shapes.json` 和带指纹的 `graph-index.json`。

### coverage_assertions 12 个 topic 判定

| topic | 判 PASS 条件 | 判 N_A 条件 |
|-------|------------|------------|
| 核心主链路 | `developer/01-架构与调用图.md` 含主调用图，product §1 有对应业务全景 | 单文件模块（无跨进程/跨组件链路）|
| 用户故事 | product §1 覆盖主成功路径和失败路径 | — |
| 用户反馈文案 | product §3 或 `developer/03-坑点与状态.md` 引用 `deep-analysis.json#ui_feedback` | 模块无 UI 反馈代码 |
| 状态与异常恢复 | `developer/03-坑点与状态.md` 引 `deep-analysis.json#state_machines` + `#timeout_recovery` | 无状态机且无超时常量 |
| 分支/类型差异 | `developer/02-变更影响导航.md` 覆盖主要分支，或 `branch_routes` 无显著分支 | branch_routes 顶层字段全部 < 2 个分支 |
| 实体/关联规则 | Markdown `entities/related/evidence` + `bindings.jsonl` 可交叉定位 | 模块无明显业务实体 |
| 外部依赖限制 | product §3 或 `developer/03-坑点与状态.md` 覆盖产品限制 | product_limits 信号为 0 |
| PRD 影响面 | product §3 列出可数维度且无工时估算 | — |
| AI 检索入口完整性 | `bindings.jsonl` 中 ID 全部有效，`codewiki_explore` 能返回语义文档与代码证据；`navigation/index.yml` 后备路由可用 | — |
| 字段级溯源 | `field-lineage/index.json` 存在且 `pending_llm_verification == 0` | 模块无可提取模板字段 |
| 字段级反向索引 | `field-lineage/reverse-index.json` 存在且无 orphan 条目 | 模块无 API/IPC/WS 字段来源 |
| 结构指纹 | `graph-index.json#metadata.fingerprint_version` 存在，结构指纹覆盖率 ≥ 90% | — |

**MISSING 项必须在 README 的"文档可信状态"节列出原因**，且在 `coverage_assertions[i].reason` 中说明。

manifest 完整模板见 `references/role-templates.md` § 5 和 `references/output-schema.md`。

## Step 6: 证据自检（按事实类型分级，必跑不可跳过）

Layer 1 / Layer 2 全部写完之后，**必须**运行：

```bash
npx codewiki generate <target> --module <module> --finalize
```

### 验证范围（按事实类型分级）

| 事实类型 | 验证规则 | 失败标记 |
|---------|---------|---------|
| 代码事实 | 引用形如 `<file>:<line>`，文件存在 + 行号有效 | FAIL |
| UI 文案事实 | 引用形如 `i18n_key + locale_file:line`，locale 文件存在 + key 在文件中可定位 | FAIL |
| 业务术语 | 凡是从英文/常量翻译来的中文术语，必须在 `manifest.business_terms` 中 | FAIL |
| 工时估算 | 全文搜索"小时/天/人天/sprint/工时/周"等估时词，必须为 0 | FAIL |
| 产品限制 | Product §3 每条限制必须能映射到 `deep-analysis.json#product_limits` 一个信号或标"由实现能力推导" | WARN |
| 字段级溯源 | evidence 非空；`full + D/E`、raw_field 无 at、unknown transform 无说明、反向索引 orphan 均失败 | FAIL |

### 路径解析规则（代码事实引用）

不限于 target 目录：项目根 → 常见源码前缀（`src/`/`render/`/`lib/`/`packages/`/`electron/`）→ target 目录及父级 → 递归搜索（深度 ≤ 4）。跨目录引用自动解析；只有真正不存在或行号无效才 FAIL。

### Per-file 置信评分（每篇 Layer 1/2）

`--validate` 同时为每篇 Layer 1/2 文件计算置信评分，写入 `validation-report.json` 的 `per_file_confidence` 字段。计分公式：

```
total    = passed_refs + failed_refs + weak_phrases + placeholders + unverified_flags
verified = passed_refs
ratio    = verified / total       (total > 0)
         = N_A                    (total == 0)
```

| 等级 | 阈值 |
|---|---|
| A | ratio ≥ 0.90 |
| B | ratio ≥ 0.70 |
| C | ratio ≥ 0.50 |
| D | ratio ≥ 0.30 |
| E | ratio < 0.30 |
| N_A | 文件无可评估事实 |

**扣分项识别**：
- weak_phrases：`通常 / 一般 / 应该 / 可能 / 推测 / 大概` 等弱措辞
- placeholders：`待业务确认 / 待用户确认 / TBD / TODO / 未在代码中找到证据`
- unverified_flags：含 `⚠️ 未验证调用链` 标记的行

评分由脚本计算，**AI 助手不要自评打分**。`navigation/_review.md` 自动渲染层级摘要 + 按文件细分。

#### v2 综合置信度

原证据分保留为 `evidence_confidence`，并新增 `scenario_coverage`（30%）和 `gap_closure`（20%）；综合权重为 50% / 30% / 20%。没有历史 Gap 时，证据与场景按 5:3 重新归一。只有静态分析、历史数据或用户确认的场景进入覆盖率分母，AI-only candidate 只列为待确认，不参与计分。人工补文档只有在对应 Case/Gap 有验证证据后才提升分数。

结果写入 `per_file_confidence[*].confidence_v2`，同步到当前分支 `quality-report-v2.json/knowledge_confidence[]`；`_review.md` 展示缺失 Case、开放 Gap 和综合分。

每次 `--validate` 同时尝试写入 `.codewiki/knowledge-health/<module>/confidence-history.jsonl`。该历史只记录审计结果和源码指纹，不改动知识文档正文；`npx codewiki confidence` 用于周期任务筛选代码已变更、审计逾期、Gap 多或缺失 Case 多的模块。稳定模块不因时间自动降分，只标记 `review_due`。

### `_review.md` 汇总文档（自动生成）

`--validate` 跑完后会在 `.codewiki/modules/<module>/_review.md` 生成模块级健康报告，包含 7 节：

1. **整体评分**（按 product / developer / quality 等层分组）
2. **按文件细分**（每篇 Layer 1/2 的综合置信度、证据分、场景覆盖、Gap 闭环和扣分点）
3. **待用户确认 (MUST_CONFIRM)** —— 来自 `manifest.yml/confirmation_checkpoint`
4. **待业务补充** —— 来自含占位符的位置
5. **未验证调用链** —— 来自 `navigation/dynamic-flows.md` 的 ⚠️ 标记
6. **Coverage Assertions Missing** —— 来自 `manifest.yml/coverage_assertions`
7. **真实检索与 Case** —— 来自 `.codewiki/retrieval.jsonl`、`feedback.jsonl` 与模块 `retrieval-cases.json`：展示可靠命中、候选和缺失问题，以及已评价/未评价和好评/差评数量。可靠命中仅限显式 Case 关联、反馈来源关联或问题完全一致；仅共享同一知识条目不算命中。

第 7 节是**反哺信号**：它揭示用户真实问过、但知识库尚不能可靠回答的问题。候选不自动变成 Case；Agent 只能把候选、缺失和差评整理为建议，待用户确认后再补 Case 或修正文档。

`_review.md` 每次 `--validate` 都会重写，**禁止手动编辑**——所有数据来自上游 JSON / YAML 文件，要修改请改源头。

### 强约束

- 自检 FAIL（`status === 'FAIL'` 或退出码 `1`）时，立即在所有受影响文档首段加 `> ⚠️ 状态：draft —— N/M 条结论缺少代码证据`，并向用户报告每条 fail 的引用。不修复、不掩盖。
- 自检 PASS 才能把 manifest 标 `base_commit` 与 `generated_at`；否则 manifest 也标 draft。
- `--update` / `--rewrite` / `--patch` 任何增量模式跑完后同样必须重跑 `--validate`。
- 不允许在 Agent 输出中假装做了"抽 N 条反查"——自检由脚本完成，引用清单读 `validation-report.json`。

### coverage_assertions 自检

除了 `--validate` 校验引用，Agent 在 Step 6 后必须核对 manifest 的 `coverage_assertions` 12 个 topic：
- 任一 topic 状态为 MISSING 但 README 没列出原因 → 阻断
- 任一 topic 状态为 PASS 但实际产物不符 → 改回 MISSING + 加 reason

## 增量/重写/补丁模式

- **--update**（升级为四档判定，基于 `graph-index.json` 三种指纹）：
  1. **NONE**（`prev.hash === curr.hash`，兼容输入别名 `contentHash`）：跳过整个模块，不重跑任何脚本
  2. **STRUCTURAL 短路**（`structuralFingerprint` 变）：走现有影响集扩展 + LLM 重写 Layer 1/2 + **全量重跑 field-lineage**（不进 FIELD_ONLY 判定，避免"结构变了+字段又变了"错判 —— P2 优化）
  3. **FIELD_ONLY**（无 STRUCTURAL 变化，但 `fieldFingerprint`/`page_fingerprints` 变，如接口 payload 字段名调整）：只重跑 Step 2.7.5 字段级溯源 + 只重写产品层 §2 字段级页面逻辑；跳过 §1 §3 和技术层
  4. **COSMETIC**（只有内容 `hash` 变，如格式化/注释）：只更新 mtime，跳过 LLM，`revisions/` 记一句"cosmetic-only"

  判档由 `scripts/fingerprint.mjs#classifyChange(prev, curr)` 实现；`--update` 主流程读旧 `graph-index.json` + 跑完 nav-parser + field-lineage 后拿到新指纹，逐 file / page 判档。

  基础增量比较逻辑：`git diff --name-status <base_commit>` 识别 added/modified/deleted/renamed，`git ls-files --others --exclude-standard` 纳入未跟踪；比较口径 `base_commit` 到当前工作区。先把代码增量写入 `navigation/file-graph.json#metadata.incremental`，再读取 `graph-index.json` / 旧 `file-graph.json` 扩展影响集（变更文件、1-2 跳反向依赖、同 IPC/event/store 对端）。只替换影响集文件的出边；只有删除/重命名才删除入边。影响集超过阈值或核心配置变更时自动全量重跑。graph-cluster 和 deep-analyzer 仍全量重跑。

  **Markdown 重写范围必须再经过 bindings 收窄**：把影响集转换为稳定 `nav:*` ID，在 Navigation 图上展开 2 跳，再从 `bindings.jsonl` 反查 `knowledge_id`；只重写这些 ID 对应的 Product/Developer 文件。若新增代码尚无绑定，只把最邻近的已绑定主题列为候选，不得因此全量重写。完成正文后运行 `npx codewiki generate <target> --module <module> --finalize` 重新校验绑定、缓存与 Case。Layer 1/2 仍按四档决定具体章节，最后更新 manifest base_commit。**update 后必须写一条 revision**（详见下文），revision 需标注每个 module 的最终判档等级。
- **--update --bugfix**：在 --update 基础上额外生成缺陷深度文件（详见下文）
- **--rewrite \<layer\>**：navigation 重跑全部脚本；product/developer 重读 JSON + hub 源码后全量重写
- **--patch \<file\>**：不重跑脚本，读现有 JSON + 相关源码，只重写指定文件，保留 `# [manual]` 标记的手动添加内容

## --bugfix 模式（缺陷深度分析）

`npx codewiki generate --kind defect` 把缺陷上下文沉淀到 `.codewiki/modules/<module>/quality/defects/`，作为可检索的根因/修复历史。

### 触发方式

- **显式更新**：用户要求把已完成修复沉淀到知识库时，使用 codewiki-generate Skill，并调用 `npx codewiki generate --kind defect`。
- **可选更新**：`fe-code-review` 后如果用户确认需要补充缺陷知识库，可传入根因报告、修复证据和 DEF id。
- 外部缺陷 ID 不明确时先询问用户；不得自行编造。

### 输出

除 --update 常规产物外，每个缺陷生成一份：

```
.codewiki/modules/<module>/quality/defects/<DEF-id>-<short-topic>.md
```

短 topic 取缺陷标题前 4-6 个汉字或英文关键词，禁用空格和特殊字符。

### 缺陷文件结构

```markdown
# DEF-001 — <缺陷标题>

> 关联：issue <DEF-001> / commit <hash> / branch <name>

## 缺陷描述
<现象、影响范围、触发条件>

## 复现路径
<最小复现步骤>

## 深层原因
<不是"谁改错了"，而是设计/状态/契约/时序层面的根因，必须 file:line>

## 解决方案
<改了什么 + 为什么这样改 + diff 摘要 + commit hash 或工作区 diff 引用>

## 相关文件
- src/...:line — <锚点说明>

## Lesson
<可执行的、面向未来的经验。禁用"注意/小心/确保"开头>

## Tags
[状态同步, 支付, ...]
```

### 反捏造硬约束（缺陷文件适用）

- 深层原因每条必须 `file:line` 或标"待用户确认"
- 解决方案必须引 commit hash 或工作区 diff，不允许只描述"应该这样改"
- Lesson 字段不是反捏造对象（它是面向未来的判断），但必须可执行——禁用"注意/小心/确保"开头

### 索引一致性（自检）

`npx codewiki generate` 校验 quality 文档的稳定 `kb:*` ID、非空 aliases/questions/entities、typed `sources`，并要求 defect 至少包含 code、commit 或 test 证据。`--finalize` 同时校验正文中的 `file:line`。

## --update 收尾：写 revision

每次 `--update`（含 `--bugfix`）跑完且自检 PASS 后，必须在 `.codewiki/modules/<module>/revisions/<date>-<branch>-<topic>.md` 写一条 revision，记录知识库本次的演化。

revision 字段：

| 字段 | 内容 |
|---|---|
| from | 旧 base_commit / 旧关键规则的简要描述（可空） |
| to | 新 base_commit / 新关键规则 |
| evidence | 触发本次 update 的 diff 摘要、关联澄清/计划文档 |
| commit | 新 base_commit hash；工作区未提交时写 `working-tree` |
| updated_files | 本次 update 改写的 product/developer/navigation/manifest 文件清单 |
| related_defects | 关联缺陷 id（`--bugfix` 模式必填）；其它情况写"无" |

revision 文件名：`<YYYY-MM-DD>-<branch>-<topic>.md`，topic 由本次 update 主导意图决定（bug-fix 模式下用 DEF id；普通 update 用 hub 文件名或 commit subject 关键词）。

## 重要规则

1. **所有文档必须中文**，技术术语（函数名、文件路径、枚举值）保留英文
2. **每个文档首段必须是 `> 提要：...`**——1-3 句话说明内容范围和阅读对象
3. **Developer 文档必须有一行元数据头**（Summary / 适合读 / 不适合读 / 证据入口）
4. **Product 文档 §1 §3 正文严禁出现技术细节散落**（函数名/IPC/毫秒/路径/英文状态名），全部下沉到尾部"技术证据索引"；**§2 字段级页面逻辑允许接口原始字段名**（因为它是产品需要的双列展示：组件字段名 vs 接口原始字段名）
5. **业务术语翻译必须经 Step 2.9 确认**——不在 `manifest.business_terms` 中的术语，必须通过 Step 2.9 确认检查点收集并等待用户确认；严禁在文档中直接写"待业务确认"占位符
6. **严禁工时估算**——PRD 影响面只输出可数维度（页面数/接口数/状态数/外部依赖数），禁止出现小时/天/人天/sprint/工时/周等估时词
7. **所有 `.md` 文件使用 `序号-中文前缀-英文标识.md` 命名**
8. Layer 1 flow 文件：`<序号>-<业务流名>-flow.md`，按主链路权重排序
9. **Layer 1 文件**：3 大块合并到一份 `<序号>-<业务流名>-flow.md`，严格顺序 §1 业务全景 / §2 字段级页面逻辑 / §3 改动决策卡 + 尾部技术证据索引
10. **Layer 2 文件**：3 个固定（`01-架构与调用图.md` / `02-变更影响导航.md` / `03-坑点与状态.md`），每篇一行元数据头（不再 6 行）
11. 文件路径相对于项目根目录
12. 遵循 `references/output-schema.md` 的 schema + `references/role-templates.md` 的章节模板
13. **不生成占位内容**——每条记录必须来自实际代码或 navigation JSON
14. YAML/JSON 必须合法，正确引用
15. 尽量包含 `code_refs`（代码事实）+ `i18n_key`（UI 文案事实）
16. Hub 和 critical nodes 获得更深解释 + Mermaid 图
16. 优先使用脚本输出定位结构事实；动态链路和候选行为信号必须读码补证
17. 按权重优先级文档化：main flow 优先
18. 动态链路必须由 AI 助手读码补证，覆盖发起方 → 中间封装/桥接 → 接收方/handler → 业务函数或副作用；Electron IPC 只是可选 profile
19. 多入口/多模块必须拆分 target 执行
20. 目录结构：Layer 1 = `product/`，Layer 2 = `developer/`，Layer 3 = `navigation/`
21. Step 1.2 候选入口审阅不可省略；用户只给业务意图时，必须等用户确认后才执行 AST
22. Step 1.5 范围扩展不可跳过——即使 target 看起来完整，仍需执行反向追踪验证
23. **Step 2.6 候选行为信号不可跳过**——5 个行为视角保留在 `deep-analysis.json` 对应 section（无信号时空数组）；默认生成 `_intermediate/api-payload-shapes.json`，不再复制独立行为 JSON 或 `data-shapes.json`
24. Step 2.8 活跃度验证不可跳过——废弃代码必须在所有文档中明确标记
25. **Step 2.9 待确认项收集与审阅不可跳过**——生成 Layer 1/2 前必须先收集确认项（业务术语翻译、业务流命名）；MUST_CONFIRM 项必须停下等待用户确认；CAN_POSTPONE 项写入 `navigation/pending-confirmations.yml`
25a. **Step 3 / Step 4 必须块级交互生成**——Product 三大块一次对齐，Developer 当前 profile 的三文件一次对齐；均按 Phase A（生成前确认）→ Phase B（生成）→ Phase C（回顾）推进
25b. **遇到疑点必须提供选项**——证据不充分、含义模糊、归类不清时，提供 2-3 个理解选项 + "我来补充" 入口给用户，不要靠"待业务确认"占位符填补
26. **检索绑定必须可用**——`navigation/bindings.jsonl` 中所有 `knowledge_id` / `navigation_id` 必须存在；codewiki-query Skill 是用户主入口，`navigation/index.yml` 必须存在但仅作文本后备
27. **`coverage_assertions` 12 个 topic 必须填全**——MISSING/PARTIAL 项要给出 reason
28. 扩展范围的证据必须记录在 manifest.yml 的 expansion_reason 中
29. 废弃动态通道和废弃 API 必须在 dynamic-flows.md（Electron 项目可补 ipc-flows.md）、`03-坑点与状态.md` 和对应 flow 文件中同时标记
30. **确认后的内容必须更新 manifest**——Step 2.9 确认的业务术语、业务流命名必须写入 `manifest.yml` 的 `business_terms` 和 `confirmation_checkpoint`
31. **字段级溯源产物（field-lineage/*）是产品层 §2 markdown 的唯一 SSOT**——§2 表格必须从 `field-lineage/pages/<page-id>.json` 渲染；不允许手写字段行。
32. **LLM 补证结果必须先 patch 到 field-lineage JSON**，再运行 `field-lineage.mjs ... --reindex` 并重新渲染 markdown，保证 pages、reverse-index 与 fingerprint 同源。
33. **`field-lineage/reverse-index.json` 是后端字段影响页面的权威索引**——技术层复用清单必须从此 JSON 派生。
34. **Step 2.7 后必须显式产出 `_intermediate/flows.json`**——它是 Step 2.7.5 判定关键字段（coverage=full）的输入契约。
35. **`--update` 按四档判定**——NONE / STRUCTURAL / FIELD_ONLY / COSMETIC，判定结果必须写入 revision。


## 检索反馈闭环（codewiki-query Skill）

知识库的可信度来自真实使用的反哺；`npx codewiki init` 会把同一份 codewiki-query Skill 安装到 Claude Code 和 Codex：

1. **检索**：codewiki-query Skill 调用 codewiki MCP 的 `codewiki_explore`，命中记录自动写入 `.codewiki/retrieval.jsonl`（含 retrieval_id、命中 knowledge/evidence id、延迟）
2. **评级**：回答后 Agent 必须邀请用户评级；评级通过 `npx codewiki query --feedback good|bad --retrieval-id ...` 写入 `.codewiki/feedback.jsonl`
3. **Gap**：结构化未命中或 bad 评级打开稳定 Gap；同一模块、归一化问题和类型生成相同 ID
4. **差评反哺**：Agent 读源码补证并向用户展示修正内容；确认后用 `npx codewiki generate --gap-id ...` 写入共享 quality Markdown
5. **回归闭环**：generate 自动新增共享 Case、重建索引并回归；只有关联 Case 通过，Gap 才关闭
6. **度量**：codewiki-review Skill 调用内部置信报告，汇总证据、真实问题 Case 覆盖、回归、用户反馈和 Gap

本地浏览：codewiki-review Skill 把 `.codewiki/modules/` 渲染成交互式 HTML 站点（模块总览、评级徽章、全文搜索、折叠章节、mermaid 图）。
