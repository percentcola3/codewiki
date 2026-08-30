# codewiki v0.3 融合方案

## 目标

v0.3 吸收 Understand Anything 的结构化代码图能力和 OpenWiki 的知识维护体验，但保持 codewiki 的核心边界：Markdown 是团队可读、可评审、可进 Git 的知识正文，结构化图只是机器索引。

本版本解决四个问题：

1. 影响面、调用链和字段血缘不能只靠 Markdown 关键词检索；
2. 同一问题不应因模型变化而走完全不同的检索路径；
3. 代码变化后，需要知道哪些知识已过期，而不是全量重写；
4. 生成失败时不能留下半成品知识库。

## 总体架构

```text
源码
  └─ AST 分析器 ──> 兼容 JSON ──> navigation/graph.jsonl
                                      │
Agent + INSTRUCTIONS.md ──> Markdown ─┼─> bindings.jsonl
                                      │
用户问题 ──> 确定性意图路由 ──> 文档/图/联合检索 ──> 反馈与 Gap
                                      │
代码更新 ──> 图差异 ──> 影响分类 ──> 定向更新 ──> Case 回归
```

## 关键设计

### 1. 统一图索引

每个模块生成 `navigation/graph.jsonl`。记录分为 `meta`、`node`、`edge`，写入前统一排序、去重，因此同样输入不会产生无意义 diff。

图承载文件、组件、函数、状态、字段、接口和 Knowledge/Evidence 关系，用于：

- 影响面分析；
- 调用链、组件链和字段血缘展开；
- 从技术节点反查语义知识；
- 增量更新时判断业务证据是否变化。

原有 `file-graph.json`、`func-dependencies.json` 等文件暂时保留，作为分析阶段输入和兼容接口，不再作为检索层的唯一事实来源。

### 2. 确定性查询路由

查询先归类为 `semantic`、`impact`、`chain`、`lineage`、`state` 或 `hybrid`：

- 业务规则、页面能力：文档优先；
- 影响面、链路、血缘：图优先；
- 状态和混合问题：文档与图联合。

每类意图只允许遍历相关边类型，并限制深度。路由结果会返回给调用方，也可由 Eval Case 的 `expected_intent` 约束。

### 3. Evidence 新鲜度

`bindings.jsonl` 为每条证据保存稳定指纹和当前指纹：

- `current`：证据语义未变化；
- `stale`：当前证据与上次 finalize 的指纹不同；
- `unverified`：没有可验证指纹。

指纹忽略单纯行号变化，但会识别节点语义和关系变化。只有成功 finalize 才会接受新指纹。置信报告和预览页独立展示新鲜度，不把它偷偷合并到原有综合分数。

### 4. 增量影响分类

`generate --update` 比较生成前后的图和绑定，输出：

| 分类 | 含义 | 行为 |
| --- | --- | --- |
| `NO_IMPACT` | 没有有效变化 | 不改语义文档，直接 finalize |
| `INDEX_ONLY` | 位置或机器索引变化 | 不改语义文档，直接 finalize |
| `KNOWLEDGE_IMPACT` | 业务证据变化 | 只更新列出的 Knowledge，并回归关联 Case |

若已存在的 Knowledge 被判定为受影响，但语义资产没有更新，finalize 会拒绝提交。

### 5. 生成事务

生成开始时在本地 `.codewiki/transactions/<module>/` 保存基线和源码指纹。Finalize 前再次校验源码，防止分析期间代码继续变化。

证据校验、索引构建或 Case 回归任一步失败，模块会恢复到生成前状态，失败现场保留在事务目录；全部通过后才记录历史并清理活动事务。

### 6. 团队上下文与自动更新

`npx codewiki init` 创建可提交的 `.codewiki/INSTRUCTIONS.md`，团队可以在其中维护重点模块、术语、关键问题和知识边界。初始化不会覆盖已有内容。

产品采用 Skill-first 集成：公开 CLI 只保留 `init`、`upgrade`、`uninstall` 三个项目生命周期命令；生成、查询、反馈、预览和置信检查分别由按需加载的 Agent Skills 编排，其他 CLI 只作为 Skills 与 CI 的内部执行引擎。`init` 和 `upgrade` 默认配置 MCP，查询 Skill 必须通过 `codewiki_explore` 完成结构化检索。

`examples/codewiki-update.yml` 提供定时更新模板。CI 可安全处理 `NO_IMPACT` 和 `INDEX_ONLY`；遇到 `KNOWLEDGE_IMPACT` 时停止并提示在 Claude Code 或 Codex 中完成语义更新，避免无人审阅的 LLM 内容直接进入 Git。

## 不做什么

- 不引入向量数据库或在线服务；
- 不把海量 JSON 当作用户文档；
- 不让查询时的 LLM 自由决定遍历全图；
- 不因任意代码 diff 全量重写知识库；
- 不在证据校验或 Case 失败后保留半完成结果。

## 兼容与演进

v0.3 保持既有内部执行接口和 Markdown 格式，但把用户入口收敛为三个生命周期命令 + Agent Skills。下一阶段可以在统一图之上增加跨模块影响分析和更完整的可视化，但必须继续满足稳定 ID、可追证、低成本和 Git 友好四个约束。
