# codewiki · 三层文档生成（Step 2.7.5 / 3 / 4 / 4.5）

主文件确认深度分析结果后，按本文件生成 Layer 1（Product）/ Layer 2（Frontend）/ navigation 入口，再回到主文件 Step 5 写 manifest 与自检。

**v3.6 变化**：产品层从 9 章 → 3 大块；技术层从 6 文件 → 3 文件；新增 Step 2.7.5 字段级溯源生成（field-lineage/*）。

## Step 2.7.5: 字段级溯源生成（v3.6 新增）

Step 2.7 输出 `_intermediate/flows.json` 后进入本步，产 `field-lineage/{index,pages/*,reverse-index}.json`。此产物是**产品层 §2 字段级页面逻辑 markdown 的唯一 SSOT**，同时供 AI 检索 `raw_field / endpoint / coverage`。

### 2.7.5.1 输入依赖（结构化 JSON，不依赖任何 markdown）

- `_intermediate/field-candidates.json`（nav-parser 产）— 组件 template_bindings
- `_intermediate/pinia-stores.json`（pinia-tracker 产）— store state / actions / getters
- `_intermediate/api-payload-shapes.json`（data-shape-tracer 产）— endpoints_by_file
- `_intermediate/flows.json`（Step 2.7 产，可选）— main_flow 里 fields_referenced 是关键字段判定输入

### 2.7.5.2 脚本执行序（严格顺序）

```
1. codewiki scan 内置（nav-parser 阶段）          # 产 _intermediate/field-candidates.json + graph-index.json (含 structuralFingerprint)
2. codewiki scan 内置（pinia-tracker 阶段）       # 产 _intermediate/pinia-stores.json
3. codewiki scan 内置（data-shape-tracer 阶段）            # 产 _intermediate/api-payload-shapes.json
4. Step 2.6/2.7/2.9 主 skill 编排 → 主 skill 显式落 _intermediate/flows.json
5. codewiki scan 内置（field-lineage 阶段）       # 产 field-lineage/* 并回填 graph-index.json 的 fieldFingerprint
```

若某中间产物缺失，`field-lineage.mjs` 会降级：无 `pinia-stores.json` → 全部字段标 `coverage: static`；无 `api-payload-shapes.json` → 全部字段 `source_apis: []` `coverage 至多 short`；无 `flows.json` → `coverage: full` 判定条件（a）失效但其他条件仍生效。

### 2.7.5.3 coverage / confidence 判定

由 `field-lineage.mjs` 自动判：

| 档 | 判定 | 处理成本 |
|---|---|---|
| **full** | v_model / 状态类字段名 / flows.fields_referenced 命中 / (store 匹配 + endpoints) | AST + LLM 补证 |
| **short** | 有 store 匹配但无 endpoints | 只 AST |
| **static** | 无 store 匹配 | 只 AST（一行标记） |

confidence：`A`（AST 逐字段直证）/ `B`（AST 候选经 LLM 读码补证一致）/ `C`（store/endpoint 文件级候选，尚未逐字段补证）/ `D`（未归属）/ `E`（无证据）。字段为 C/D/E，或任一 `source_apis[]` 非 A/B，均计入 `pending_llm_verification`。

### 2.7.5.4 LLM 补证 hook（主 skill 责任）

`field-lineage/index.json#metadata.pending_llm_verification` 大于 0 时，主 skill 分批（每批 ≤ 20 字段）派 subagent 补：
- `display_name`（字段的中文业务名）
- `display_position`（页面上位置描述）
- `chinese_name`（页面级）
- `transforms[]` 的 `subkind` + `description`
- `abnormal_states[]`
- `raw_field`（若能通过 API 定义或类型推导得到）+ 对应 `source_apis[].confidence`（补证一致后升为 A/B）

subagent 返回结构化 JSON（对齐 output-schema.md 的 `field_lineage_llm_patch` 契约），主 skill 合并写回 `field-lineage/pages/<page-id>.json`。`source_api_patches` 必须按 `protocol + method + endpoint` 合并进 `source_apis[]`。合并后运行：

```bash
codewiki scan <target> --output .codewiki/modules/<module>（增量含 --reindex 语义）
```

该命令只读取补证后的 pages JSON，重建 A/B 级权威反向索引、`pending_llm_verification` 和 `graph-index.json` 字段指纹，不覆盖 LLM patch。

## Step 3: 生成 Layer 1（Product，PM/QA 视角）

**受众：PM、业务、QA。** 每个业务流一份 `product/<n>-<flow>-flow.md`，**3 大块结构**（v3.6 从 9 章精简）。

每篇先写稳定语义 frontmatter（字段定义见 `output-schema.md`），至少包含 `id`、`kind`、`title`、`aliases`、`questions`、`entities`、`evidence`。`id` 发布后不可随文件名或标题变化。

### 3 大块结构（严格顺序）

| 块 | 章节 | 数据源 |
|---|---|---|
| **§1 业务全景** | 一句话业务目的 · 主链路 mermaid（业务语言）· 关键角色 · 能承诺 vs 不能承诺 | `flows.json` + `business_terms` + `deep-analysis.json#product_limits` |
| **§2 字段级页面逻辑** | 每页面字段表（详见下方模板）| `field-lineage/pages/*.json`（渲染，不 LLM 生成）|
| **§3 改动决策卡** | 异常场景+用户感知 · 影响面速查 · 能力边界 · 验收口径 | `deep-analysis.json#timeout_recovery/#ui_feedback/#product_limits` + `file-graph.json` |

尾部保留"技术证据索引"。**§2 markdown 不 LLM 手写，从 field-lineage JSON 渲染**（详见 role-templates.md § 2.5）。

### 交互确认原则（简化版）

**块级确认**（不再逐 flow 逐章确认）：

```
每个 flow：
  ├─ Phase A: 生成前对齐（一次性）
  │   ├─ 主链路业务描述确认
  │   ├─ field-lineage 里 confidence=D 的字段是否需要补证
  │   └─ 产品限制条目确认
  ├─ Phase B: 写 product-<flow>.draft.json → 独立 pass 写 .review.json
  │   ├─ 主对话只读 review；needs_confirm 先确认并更新 draft
  │   └─ review=pass 后从 draft 渲染三大块（§2 只读 field-lineage）
  └─ Phase C: 完成后回顾（关键结论摘要）
```

Phase A 提问时提供 2-3 个选项 + 1 个"我来补充"入口。

### Product 层硬约束（沿用 v3.5）

**禁出现**（第 §1 / §3 正文）：函数名 · IPC 通道名 · 毫秒数 / 字节数 · 文件路径 · 未翻译英文状态名。**§2 字段表允许出现原始接口字段名**（因为它是产品需要的：接口后端命名 vs 组件命名双列展示）。所有其他技术细节下沉到尾部证据索引。

**业务术语翻译**：所有翻译必须来自 `manifest.business_terms`。表中没有的术语按 Step 2.9 待确认清单等待用户确认。

**详细模板见 `references/role-templates.md` § 2。**

## Step 4: 生成 Layer 2（Frontend，前端 + AI 视角）

**受众：前端开发 + AI。** **3 个文件**（v3.6 从 6 文件精简）。

每篇同样写稳定语义 frontmatter。正文继续保持人类可读；代码关联只在 `evidence` 中引用 `nav:*` ID，不复制整段 Navigation JSON。

### 3 文件结构

| # | 文件 | 承接 v3.5 | 关键变化 |
|---|------|----------|---------|
| 01 | `01-架构与调用图.md` | 原 01 架构总览 + 02 组件地图 + 03 接口通信 | 组件地图弱化到"关键组件职责表 + hub 标记"；跨进程通信图放这里 |
| 02 | `02-变更影响导航.md` | 原 04 变更指南 + 06 任务类型对比 | **不再预列变更场景**。改成三张事实索引：改动位置 → 上下游 / 接口 → 调用者+核心链路 / 状态字段 → 产生+消费；**新增复用清单**（读 `field-lineage/reverse-index.json`）；**新增核心链路图** |
| 03 | `03-坑点与状态.md` | 原 05 状态与时序 + 01 § 已知陷阱 + 03 § 失败路径时序 | 四段：状态机图 · 超时+恢复表 · 已知陷阱 · 潜在风险 |

每篇元数据头压缩到一行"何时来读 + 前置文档"（不再 6 段）。

### 交互确认原则（简化版）

同 Step 3：Phase A 一次性对齐 → Phase B 每文件写 `.draft.json` 并独立生成 `.review.json` → 主对话只读 review → pass 后渲染 → Phase C 回顾。不再"逐文件 6 次 Phase A"。

Phase A 关键确认点（合并到一次交互）：
1. 架构分层归类
2. Hub 组件识别（引用 ≥ 3 次）
3. 接口业务语义（IPC / API 参数含义不明处）
4. 状态机实体边界
5. 核心链路自动打分（`is_core_path: high/medium`）里的 medium 项由用户确认

### Frontend 层硬约束

**每篇一行元数据头**（v3.6 新格式）：

```markdown
> 何时来读：<具体触发场景，一句话>；先读：<前置文档>；证据：<主要 navigation JSON>
```

**详细模板见 `references/role-templates.md` § 3。**

## Step 4.5: 建立语义文档与代码图绑定，并生成入口

按顺序完成以下产物：

### 4.5.1 保留 `deep-analysis.json` 单一候选信号源

新知识库不再把 `state_machines`、`ui_feedback`、`timeout_recovery`、`branch_routes`、`product_limits` 原样复制成 5 份 JSON；检索器直接按 section 索引 `deep-analysis.json`。升级旧知识库时，可在确认内容完全相同后移除这些兼容副本。

`_intermediate/api-payload-shapes.json` 是唯一 data-shape 产物；只有兼容旧消费者时才给 `data-shape-tracer.mjs` 传 `--legacy-copy`。

### 4.5.2 `navigation/bindings.jsonl` + 派生检索索引

Product/Frontend Markdown 的 `kb:*` ID 与 Navigation JSON 的 `nav:*` ID 通过一行一个 JSON 的多对多关系关联。运行：

```bash
codewiki index --project <project-root> --module .codewiki/modules/<module>
codewiki evaluate --project <project-root> \
  --cases .codewiki/modules/<module>/retrieval-cases.json --repeat 5 \
  --output .codewiki/codewiki-evaluation-<module>.json
```

构建命令会校验所有显式 ID、补充正文 `file:line` 对应的精确证据节点、写 `navigation/bindings.jsonl`，并把派生倒排索引写入 `.codewiki/cache/codewiki/`。重复/错层 Knowledge ID、空语义字段、非法 Binding 枚举、悬空 ID 或缺少 `verified/ast` 证据都会失败。缓存不属于知识库产物，不提交。

评测文件从 `references/retrieval-cases.example.json` 复制后替换真实 ID，覆盖 UI 入口、业务规则、用户反馈、字段血缘、影响分析、状态路径和无答案七类。首次生成和 STRUCTURAL/FIELD_ONLY 更新必须通过；COSMETIC 可复用最近一次结果。

`navigation/business-index.yml` 仅为旧版本兼容；新文档不再生成，业务概念由 Markdown 的 `title/aliases/questions/entities` 直接承载。

### 4.5.3 `navigation/index.yml`（AI 检索路由，v3.6 增强）

它是无 MCP 时给 `rg` 使用的后备路由，固定字段：`query_routes` / `files` / `must_answer`。Claude Code 正常路径是调用 `codewiki_explore`：

1. 语义匹配 Product/Frontend Markdown；
2. 经 `bindings.jsonl` 找到代码证据节点；
3. 在完整 AST 图上展开 2 跳，技术问题展开 3 跳；
4. 反向绑定回相关语义文档，输出答案上下文。

**v3.6 新增 query_routes**：

```yaml
"查字段是怎么显示的":
  primary: field-lineage/pages/<page-id>.json
  secondary: [field-lineage/index.json]
"查改后端字段影响哪些前端字段":
  primary: field-lineage/reverse-index.json
"查某个字段的完整链路":
  primary: field-lineage/pages/<page-id>.json
  match_by: field.id
"查某接口被哪些字段消费":
  primary: field-lineage/reverse-index.json
```

**v3.6 新增 must_answer**：
- 某字段的完整来源链是什么？（组件 → store → 接口 → 原始字段 → 加工规则）
- 改某接口字段影响哪些页面字段？
- 某页面上所有字段的溯源清单？

### 4.5.4 `.codewiki/modules/<module>/README.md`（角色路由器，v3.6 更新阅读路径）

固定 6 节。角色阅读路径改为：

| 角色 | 先读 | 跳过 | 重点关注 |
|------|------|------|----------|
| PM/业务 | `product/*-flow.md` §1 §2 | `frontend/`, `navigation/` | 业务全景 + 字段级页面逻辑（评估新需求"字段现状"）|
| QA | `product/*-flow.md` §3 改动决策卡 | `frontend/02-*` | 异常路径、边界条件、不可承诺项 |
| 前端（新人） | `frontend/01-架构与调用图` → `03-坑点与状态` | `product/` | 主链路、状态归属、外部依赖限制 |
| 前端（变更评估） | `frontend/02-变更影响导航` + `field-lineage/reverse-index.json` | 其余 | 上下游影响、复用清单、核心链路 |
| AI/工具 | `codewiki_explore`（后备：`navigation/index.yml`） | 无需手工遍历全部文档 | 语义答案 + 字段溯源 + AST 关联证据 |

**详细模板见 `references/role-templates.md` § 1（README）+ § 4（index.yml）。**
