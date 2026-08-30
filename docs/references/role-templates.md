# role-templates.md — codewiki v3.6 角色化文档模板

本文件定义 codewiki 产物的固定模板：README（总入口）、Product 层（3 大块）、Developer 层（通用 3 文件）、Navigation 层（AI/工具）。

SKILL.md 在 Step 3/4/5 引用本文件，不在 SKILL.md 内重复模板细节。

## 1. `.codewiki/modules/<module>/README.md` — 模块总入口

README 是**角色路由器**（v3.6 沿用 v3.5 结构，仅路径更新）。固定 6 节：

```markdown
---
id: kb:<module>:overview
kind: business
title: "<模块中文名>"
aliases: ["<模块别名>"]
questions: ["<模块是做什么的>"]
entities: ["<核心业务实体>"]
related: []
evidence: []
---

> 提要：<5-8 行说明业务目的、当前实现现状、核心链路、能力边界、主要风险>

# <模块中文名>（<英文标识>）

## 模块 Summary
- **业务目的**：<一句话 — 用户/业务为什么需要这个模块>
- **当前实现现状**：<已上线/迭代中/废弃中 + 主要版本节点>
- **核心链路**：<3-5 个关键步骤的业务语言描述>
- **能力边界**：<本模块能做什么 / 不做什么 — 产品边界>
- **主要风险**：<外部依赖、运行环境、时序敏感、数据一致性等大类>

## 角色阅读路径
| 角色 | 先读 | 跳过 | 重点关注 |
|------|------|------|----------|
| PM/业务 | `product/*-flow.md` §1 §2 | `developer/`, `navigation/` | 业务全景 + 字段级页面逻辑 |
| QA | `product/*-flow.md` §3 改动决策卡 | `developer/02-*` | 异常路径、边界条件、不可承诺项 |
| 研发（新人）| `developer/01-架构与调用图` → `03-坑点与状态` | `product/` | 主链路、状态归属、外部依赖 |
| 研发（变更评估）| `developer/02-变更影响导航` + `field-lineage/reverse-index.json` | 其余 | 上下游影响、复用清单、核心链路 |
| AI/工具 | `codewiki_explore`（后备：`navigation/index.yml`） | 无需手工遍历全部产物 | 语义答案 + 代码证据链 |

## 常见任务入口
| 任务 | 推荐起点 |
|------|---------|
| 写新 PRD | `product/<flow>-flow.md` §3 改动决策卡 |
| 评估改动影响 | `developer/02-变更影响导航.md` + `field-lineage/reverse-index.json` |
| 查字段来源 | `field-lineage/pages/<page-id>.json` |
| 查接口影响面 | `field-lineage/reverse-index.json` |
| 查接口/IPC | `developer/01-架构与调用图.md` § 接口清单 |
| 排查异常/超时 | `developer/03-坑点与状态.md` + `navigation/deep-analysis.json#timeout_recovery` |
| 补知识库 | 重跑 `/codewiki <path> --update` |

## 文档可信状态
- **validation 状态**：<PASS / FAIL / DRAFT>
- **图谱覆盖**：<节点数 / 边数 / 低置信边数>
- **字段级溯源覆盖**：<total_fields / full / short / static>（来自 `field-lineage/index.json`）
- **待 LLM 补证**：<pending_llm_verification>（来自 `field-lineage/index.json`）
- **liveness**：<active / deprecated 通道数>

## 业务流索引
| 序号 | 文件 | 业务含义 | 适用场景 |

## AI 索引入口
- `codewiki_explore` — 主检索入口：语义文档 → 代码图 → 关联文档
- `navigation/index.yml` — 内部查询不可用时的文本检索后备路由
- `navigation/bindings.jsonl` — 语义文档与代码证据绑定
- `field-lineage/pages/<page-id>.json` — 字段级溯源（v3.6 核心）
- `field-lineage/reverse-index.json` — 接口 → 字段反查
- `navigation/deep-analysis.json` — 状态、UI、超时、分支、产品限制候选信号
- `navigation/liveness.json` — IPC/API 活跃度
- `navigation/validation-report.json` — 证据自检
```

## 2. Product 层 — 3 大块模板（v3.6 从 9 章重构）

每个 `product/<n>-<flow>-flow.md` 严格三大块 + 尾部证据索引。**§2 字段级页面逻辑不 LLM 手写**，从 `field-lineage/pages/*.json` 渲染。

```yaml
---
id: kb:<module>:product:<flow>
kind: business
title: "<用户会使用的业务流名称>"
aliases: ["<按钮/菜单文案>", "<业务同义词>"]
questions: ["<这个按钮是怎么工作的>", "<该流程失败时用户会看到什么>"]
entities: ["<业务实体>"]
related: [kb:<module>:developer:<topic>]
evidence:
  - id: nav:<kind>:<stable-key>
    role: entry
    confidence: verified
---
```

### 2.1 §1 业务全景

```markdown
## §1 业务全景

**业务目的**：<一句话 — 用户/业务为什么需要这个流程>

### 主链路
<mermaid sequenceDiagram，参与方用业务名称，如"下单界面/消息中心/推送服务"，不用进程名>

### 关键角色
- **<角色1>**：<职责/触发条件>
- **<角色2>**：<职责/触发条件>

### 能承诺 vs 不能承诺
| 类型 | 内容 |
|------|------|
| 可承诺（成功路径） | <可观察的成功结果> |
| 不能承诺（能力边界） | <关键限制项，详见 §3 改动决策卡 § 能力边界> |
```

数据源：`_intermediate/flows.json`（main_flow）+ `manifest.business_terms` + `deep-analysis.json#product_limits`（挑关键项）。

### 2.2 §2 字段级页面逻辑（**从 JSON 渲染，不 LLM 手写**）

**渲染规则**（对每一页 = `field-lineage/pages/<page-id>.json` 一份）：

```markdown
## §2 字段级页面逻辑

### 页面：<chinese_name>（`<page_file>`）

| 字段 | 显示位置 | 组件绑定 | 上游 store | 接口/事件来源 | 接口原始字段 | 加工规则 | 显示条件 | 异常态显示 |
|------|---------|---------|-----------|-------------|-------------|---------|---------|-----------|
| <display_name> | <display_position> | <path> `<component_binding.expr>` @<file:line> | <upstream_store.store_id>.<state_field> | <source_apis[0].method> `<endpoint>` | `<raw_field>` | <transforms[].description> | <display_conditions[]> | <abnormal_states[]> |
```

**渲染逻辑**：
- 遍历 `pages[i].fields[]`
- `display_name` / `display_position` 从 field JSON 取，`null` 时用 `path` 兜底 + 标 `⚠️ 待补充中文名`
- **接口原始字段列**：`raw_field` 为 null 时留空 + 灰色 "?"，等待 LLM 补证
- **可编辑字段**（`editable: true`）在字段名后加 ✏️ 图标；表格另一列附"写路径"（如 `PUT /api/order/{id}` payload.note）
- 按 `coverage` 排序：`full` 在前，`short` 中间，`static` 尾部（首版可选）

**双列展示**（P7 双列展示确认）：`组件字段名` = `path`（如 `order.status`）；`接口原始字段` = `raw_field`（如 `data.status_code`）。二者不同时并列展示。

**渲染完成后追加"字段级 SSOT 说明"**：

```markdown
> 本表由 `navigation/field-lineage/pages/<page-id>.json` 渲染。改字段展示需重跑 /codewiki --update；LLM 补证的中文名/加工规则由 subagent 写回同一 JSON。
```

### 2.3 §3 改动决策卡

```markdown
## §3 改动决策卡

### 异常场景 + 用户感知
| 异常类型 | 用户看到 | 持续时间 | 用户可执行响应 | 系统兜底 |
|---------|---------|---------|--------------|---------|

### 影响面速查（可数事实，严禁工时估算）
| 维度 | 触达范围 |
|------|---------|
| 页面 | <数量 + 业务名列表> |
| 接口（HTTP/WS/IPC）| <数量 + 列表> |
| 状态字段 | <数量 + 实体名> |
| 权限/角色 | <相关角色枚举> |
| 外部依赖 | <SDK/硬件/OS> |
| 兼容性 | <版本/平台范围> |

### 能力边界与产品限制
| 限制类型 | 不可承诺项 | 推导依据 | 用户可见后果 |

### 验收口径
| 路径 | 验收点 | 期望结果 |
|------|-------|---------|
| 正常路径 | ... | ... |
| 异常路径 N | ... | ... |
| 边界条件 | ... | ... |
```

数据源：§ 异常场景 = `deep-analysis.json#timeout_recovery` + `#ui_feedback`；§ 影响面 = `file-graph.json` + `field-lineage/reverse-index.json`（页面数 = 反向索引里出现的 page_id 去重）；§ 能力边界 = `deep-analysis.json#product_limits`；§ 验收口径 = 前三节的失败路径 + 边界。

### 2.4 尾部技术证据索引

```markdown
## 技术证据索引

> 本节集中所有 file:line 引用，前三大块避免技术细节散落。

- 状态机：`<file>:<line>`
- 主要 API：`<file>:<line>`
- 主要 IPC 通道：见 `navigation/ipc-flows.md`
- 关键常量：`<file>:<line>`
- 字段级溯源产物：`navigation/field-lineage/pages/<page-id>.json`
```

### 2.5 字段表渲染算法（供工具复现）

主 skill 或渲染脚本按以下步骤把 `field-lineage/pages/<page-id>.json` 转成 markdown 表：

```
1. 读 pages/<page-id>.json
2. 排序 fields[]: 按 coverage (full > short > static) → confidence (A>B>C>D>E) → path 字典序
3. 每 field 一行：
   col1 = field.display_name || field.path (加 ⚠️ 若 null)
   col2 = field.display_position || '—'
   col3 = f"{field.path} `{field.component_bindings[0].expr}` @{field.component_bindings[0].at}"
   col4 = f"{upstream_store.store_id}.{state_field || '?'}" if upstream_store else '—'
   col5 = source_apis 每条 f"{method} `{endpoint}`" 换行拼接
   col6 = source_apis 每条 raw_field (null → '?') 换行拼接
   col7 = transforms 每条 description (缺则 kind + expr) 换行拼接，无则 '—'
   col8 = display_conditions[].when 拼接，恒显示 → '恒显示'
   col9 = abnormal_states[] 每条 f"{case}: {display}" 换行拼接
4. 若 field.editable 在 col1 后加 ' ✏️'
```

## 3. Developer 层 — 通用 3 文件模板

单前端模块使用组件、状态和字段血缘组织；多语言模块保持同样的 3 个阅读入口，但必须补充 Source Unit 边界、前端请求 → 后端 Endpoint → Service/Repository 的跨端链路，以及不同语言的变更影响。不要按 `frontend/`、`backend/` 再拆顶层目录。

每篇一行元数据头（v3.6 新格式，替代原 6 行）：

```markdown
---
id: kb:<module>:developer:<topic>
kind: technical
title: "<技术主题>"
aliases: ["<组件/模块别名>"]
questions: ["<该功能如何实现>", "<改这里影响什么>"]
entities: ["<页面/组件/状态实体>"]
related: [kb:<module>:product:<flow>]
evidence:
  - id: nav:<kind>:<stable-key>
    role: implementation
    confidence: ast
---

> 何时来读：<触发场景一句话>；先读：<前置文档>；证据：<主要 navigation JSON>
```

### 3.1 `01-架构与调用图.md`

必含章节（合并原 01 架构总览 + 02 组件地图 + 03 接口通信）：

```markdown
> 何时来读：新接手模块 / 需要看整体架构 / 查跨端通信；先读：无；证据：navigation/source-units.json + framework-facts.json + graph.jsonl

## 模块概览
<3-5 行说明技术定位>

## 架构全景图
<Mermaid，跨进程时必须画>

## 核心目录结构
<Source Unit / 主要目录 + 语言框架版本 + 职责一句话>

## 关键实现单元职责表
| Source Unit | 类型 | 关键组件/服务 | 职责 | 上下游 |
|-------------|------|--------------|------|--------|
| <name> | Vue/React/Spring/Go | <组件/Controller/Handler/Service> | <一句话> | <调用关系> |

（原 v3.5 § 全局布局组件独立成段 + § 数据聚合算法 已挪至 field-lineage 产物；此处只列跳转链接）

## 接口清单（含活跃度）
按业务场景组织：

### 场景 <N>：<业务名>
- **HTTP**：<method endpoint> — <一句话>（active/deprecated）
- **跨语言实现**：<调用方> → <Endpoint> → <Handler/Service>
- **WS**：<event> — <触发方>
- **IPC**：<channel> — <方向>
- 时序图：<mermaid，含失败路径>

## 核心设计决策
每条带 file:line。

## 统计数字
文件数 / 组件数 / 接口数 / 状态机数。
```

### 3.2 `02-变更影响导航.md`

必含章节（**不再预列变更场景**，改为事实索引）：

```markdown
> 何时来读：拿到具体新需求要评估影响面 / 计划改动前查复用；先读：01-架构与调用图；证据：field-lineage/reverse-index.json + navigation/file-graph.json

## 三张事实索引

### 索引 A：改动位置 → 上下游 / 用户感知 / 失败模式 / 兼容风险
| 文件 | 上游依赖 | 下游依赖 | 用户感知触发点 | 失败模式 | 是否核心链路 | 兼容风险 |

### 索引 B：接口 → 调用者 / 是否核心链路 / 变更风险
| 接口 | 协议 | 调用者数 | 使用页面 | 是否核心链路 | 变更风险等级 |

（数据源 `field-lineage/reverse-index.json`，`使用页面` = `used_by` 里的 page_id 去重）

### 索引 C：状态字段 → 产生 / 消费 / 影响 UI / 影响业务规则
| 字段 | 产生（写路径）| 消费（读路径）| 影响的 UI | 影响的业务规则 |

## 复用清单（v3.6 核心新增）

### 已有可复用接口
| 协议 | Method | Endpoint | 已被哪些页面消费 | 是否可加字段 |
（数据源 `field-lineage/reverse-index.json` + `pinia-stores.json`）

### 已有可复用组件
| 组件 | 引用数 | 复用条件（例："仅当 status=xxx"）|

### 已有可复用工具函数 / hooks
| 名称 | 位置 | 用途 |

## 核心链路图
<Mermaid，标注 is_core_path=high 的文件；改这些文件必须谨慎>

## 变更风险速评矩阵
| 变更类型 | 涉及索引 | 建议流程 |
| 新增字段 | 索引 A + 复用清单 | 先查复用清单 → 定新增/复用 → 索引 A 查影响面 |
| 改现有字段 | 索引 C + 反向索引 | 先查反向索引影响面 → 索引 C 判影响 UI |
| 新增接口 | 复用清单 + 索引 B | 先查复用清单 → 若无复用则新增 |
| 改核心链路 | 核心链路图 + 索引 A | 影响面全查 |
```

### 3.3 `03-坑点与状态.md`

必含章节（合并原 05 状态与时序 + 01 § 已知陷阱 + 03 § 失败路径时序）：

```markdown
> 何时来读：改状态机 / 排查超时 / 评估外部依赖风险；先读：01-架构与调用图；证据：navigation/deep-analysis.json + graph-quality.json

## 状态机图（每实体一图）
<Mermaid，来自 deep-analysis.json#state_machines>

## 超时 + 恢复表
| 常量名 | 值 | 触发场景 | 恢复行为 | 用户感知 |

## 已知陷阱（历史踩坑清单）
每条：陷阱描述 + 触发条件 + 规避方式 + file:line

## 潜在风险
- **低置信边**：来自 `graph-quality.json`，需复核
- **Deprecated 通道**：来自 `liveness.json`，注意迁移
- **缺兜底逻辑**：识别自 `deep-analysis.json#product_limits` 且未在 `#timeout_recovery` 匹配到 handler 的项
- **外部依赖限制**：SDK / 硬件 / OS / 浏览器版本

## 长链路时序（含失败分支）
<Mermaid，只画核心 flow 的完整时序>
```

### Developer 层硬约束

- 每篇必须一行元数据头
- 每个"结论"必须带 `file:line` 证据
- 严禁工时/人天估算
- 复用清单和反向索引必须**从 JSON 派生**，不允许手写枚举

**详细模板见 `references/output-schema.md` § template-render-rules。**

## 4. Navigation 层 — bindings + index.yml 后备模板

主入口是 codewiki-query Skill；`.codewiki/modules/<module>/navigation/index.yml` 仅供内部查询不可用时的正则检索。

```yaml
version: "1.1"
purpose: "codewiki 内部查询不可用时的文本检索后备路由"

query_routes:
  # v3.6 新增
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
  # 沿用 v3.5
  "查业务概念对应的代码":
    primary: ../product/
    secondary: [bindings.jsonl, func-dependencies.json, component-refs.json]
  "查状态/迁移":
    primary: deep-analysis.json#state_machines
  "查异常/超时/恢复":
    primary: deep-analysis.json#timeout_recovery
    secondary: [deep-analysis.json#ui_feedback]
  "查用户提醒/文案":
    primary: deep-analysis.json#ui_feedback
  "查分支/类型差异":
    primary: deep-analysis.json#branch_routes
  "查 IPC/API 活跃度":
    primary: liveness.json
  "查图谱覆盖率/低置信":
    primary: graph-quality.json
  "查证据可信度":
    primary: validation-report.json
  "查产品限制":
    primary: deep-analysis.json#product_limits

files:
  # v3.6 新增
  - file: field-lineage/index.json
    use: "字段级溯源全模块元信息"
    when: "查字段总览/覆盖度"
  - file: field-lineage/pages/<page-id>.json
    use: "每页面字段级完整链路"
    when: "查字段显示逻辑/来源链"
  - file: field-lineage/reverse-index.json
    use: "接口 → 字段反查表"
    when: "查接口/字段变更影响"
  # 沿用 v3.5
  - file: file-graph.json
    use: "文件依赖图（多类型边）"
    when: "查跨文件依赖"
  - file: func-dependencies.json
    use: "导出函数 + 调用关系"
    when: "查函数链路"
  - file: component-refs.json
    use: "Vue 组件 / props / template_bindings（v3.6 新字段）"
    when: "查组件结构 + 字段绑定"
  - file: graph-index.json
    use: "增量索引 + 结构指纹（v3.6 新增 structuralFingerprint / fieldFingerprint）"
    when: "codewiki --update 判档"
  - file: graph-quality.json
    use: "图谱覆盖率 / 已知限制"
    when: "评估结论可信度"
  - file: clusters.json
    use: "Louvain 聚类 / hub / PageRank"
    when: "查模块结构 / hub 文件"
  - file: deep-analysis.json
    use: "派生分析（主流/分支/状态/超时/UI/限制）"
    when: "通用查询"
  - file: bindings.jsonl
    use: "语义文档 kb:* 与代码证据 nav:* 的稳定绑定"
    when: "从语义答案展开代码，或从代码反查文档"
  - file: liveness.json
    use: "通道/API 活跃度"
    when: "判断 deprecated"
  - file: _intermediate/api-payload-shapes.json
    use: "endpoints_by_file + shape 追踪（v3.6 迁移路径）"
    when: "查文件级 endpoint 归属"
  - file: validation-report.json
    use: "证据自检结果"
    when: "判断结论是否可信"

must_answer:
  # v3.6 新增
  - "某字段的完整来源链是什么？（组件 → store → 接口 → 原始字段 → 加工规则）"
  - "改某接口字段影响哪些页面字段？"
  - "某页面上所有字段的溯源清单？"
  # 沿用 v3.5
  - "某个业务概念对应哪些代码入口？"
  - "某个字段从哪里来，传到哪里，在哪里转换？"
  - "某个状态在哪里产生、转移、消费？"
  - "某个事件谁触发、谁订阅、影响什么 UI？"
  - "某个分支条件导向哪些链路？"
  - "某个异常/超时触发哪些恢复行为和用户反馈？"
  - "哪些链路 active/deprecated/partial？"
  - "哪些结论低置信或缺失？"
```

## 5. Manifest 扩展模板（v3.6 更新）

```yaml
version: "3.6"
module: <name>
target_dirs: [...]
expanded_targets: [...]
base_commit: <sha>
generated_at: <iso>

business_terms:
  pending: "等待处理"
  # ...

coverage_assertions:
  - topic: "核心主链路"
    status: PASS | MISSING | N_A
    source: <file 路径>
  - topic: "字段级溯源"    # v3.6 新增
    status: PASS | PARTIAL | MISSING
    source: navigation/field-lineage/index.json
    reason: "<pending_llm_verification 数量若非 0>"
  - topic: "字段级反向索引"  # v3.6 新增
    status: PASS | MISSING
    source: navigation/field-lineage/reverse-index.json
  - topic: "用户故事"
    status: ...
  # ...

layers:
  product: { flow_count: N, files: [...] }
  developer: { file_count: 3, files: [...] }
  navigation: { core_json_count: N, field_lineage_pages: N }
liveness: { ... }
```

## 6. 反捏造规则细化（v3.6 补充）

| 事实类型 | 证据要求 | 缺证据时的处理 |
|---------|---------|--------------|
| 代码事实（链路、字段、状态、超时值）| 必须 `file:line` | 删除或标注"未在代码中找到证据" |
| 用户体验事实（文案、弹窗、提示）| 必须 UI 触发点 + i18n_key 或 literal + `file:line` | 标注"待文案确认" |
| 业务术语翻译 | 必须来自 `manifest.business_terms` 或当前会话用户确认 | 写"<原始名>（待业务确认中文术语）" |
| 产品限制/不可承诺项 | 必须 `deep-analysis.json#product_limits` 信号 OR 由外部依赖性质推导 | 标注"由实现能力推导" |
| **字段级溯源产物**（v3.6）| 必须来自 `field-lineage/pages/*.json`，且 confidence ≥ B 才算高置信 | confidence C/D → 标注"待 LLM 补证"，PM 视为候选而非事实 |
| **接口原始字段名**（v3.6）| 必须 `raw_field` 非 null 且有 `at` 引用 | null → 显示 "?" 灰色，等待 LLM 补证 |
| 业务规则 why | 优先代码注释 / commit message / 用户输入 | 写"待业务确认" |
| 工作量/影响面 | 必须为可数维度（文件数、IPC 数、状态数等）| **严禁输出小时/天/人天/sprint 估算** |
