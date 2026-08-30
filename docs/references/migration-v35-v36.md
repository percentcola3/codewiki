# codewiki v3.5 → v3.6 增量迁移

本流程用于 `/codewiki --update` 首次处理 v3.5 模块。目标是复用旧知识和可验证的 AST 产物，在旁路目录完成结构升级，并通过同题评测后切换。

## 1. 识别与只读盘点

满足以下条件时按 v3.5 迁移处理：

- `.codewiki/modules/<module>/manifest.yml#version` 不为 `3.6`；并且
- 旧 Frontend 仍包含 `01-架构总览-README.md`、`02-组件地图-component-map.md` 等 v3.5 命名，或 Navigation 缺少 v3.6 的 `field-lineage/`。

先只读收集：

- Product/Frontend 旧文件、标题、章节、正文 hash、人工修改痕迹和 `file:line`；
- manifest 的 target、base_commit、coverage_assertions；
- Navigation 文件的 schema、metadata、源码 fingerprint 和证据引用；
- 现有固定问题集；没有时，从旧文档生成覆盖七类问题的迁移评测集，但答案必须来自旧文档或代码证据。

将盘点结果写入 `.codewiki/codewiki-migration/<module>/migration-report.json`。报告至少包含：

```json
{
  "module": "<module>",
  "from_version": "3.5",
  "source_files": [{ "path": "...", "content_hash": "..." }],
  "section_mappings": [],
  "navigation_reuse": [],
  "unmapped_facts": [],
  "baseline_evaluation": {}
}
```

迁移报告属于本地过程产物，不提交。

## 2. 建立旁路副本

在 `.codewiki/modules/<module>.v36-stage/` 创建完整工作副本。所有结构转换、LLM 补充、AST 补跑、bindings 构建和评测都在旁路目录执行；验证通过前不要改写、重命名或删除 `.codewiki/modules/<module>/`。

归档是回滚措施，不是迁移输入。迁移始终从当前 v3.5 文件读取事实，避免遗漏人工维护但源码无法推导的规则。

## 3. 复用并转换语义文档

按“先保留、再归类、最后补充”的顺序转换：

1. 复制旧事实和证据，记录每个旧章节到新章节的映射与内容 hash。
2. 将旧 Frontend 内容迁入 Developer，并为 Product/Developer 文档生成稳定 ID：`kb:<manifest.module>:<product|developer>:<topic>`。topic 优先来自旧文件业务主题；发布后不随文件名变化。
3. 从旧标题、按钮文案、领域名词和真实问法补齐 `aliases/questions/entities`，不要改写原事实来迎合关键词。
4. 补充内容必须带旧知识引用或代码证据；源码无法证明的业务规则保持原文并标记来源为 `migrated-v35`。
5. 无法无损归类的内容放入目标文档的“迁移待确认”章节，并写入 `unmapped_facts`，禁止静默省略或概括掉约束条件。

旧 Frontend 六文件到 Developer 三文件的默认映射：

| v3.5 内容 | v3.6 目标 |
|---|---|
| 架构总览、组件地图、数据流主链路 | `developer/01-架构与调用图.md` |
| 组件改动索引、调用影响、字段入口 | `developer/02-变更影响导航.md` |
| 状态时序、异常恢复、坑点、兼容边界 | `developer/03-坑点与状态.md` |
| 无法判断归属的章节 | `developer/03-坑点与状态.md#迁移待确认` |

Product 继续按业务流组织。不要为了减少文件数合并不同业务流，也不要把人工确认事实改写成源码推断。

## 4. 增量复用 Navigation

对每类产物分别决定复用或补跑，不因版本号变化全量重建：

| 条件 | 动作 |
|---|---|
| 源码 hash 未变且 schema 已满足 v3.6 | 原样复用，并在报告中记录 `reused` |
| 源码未变但缺少新字段 | 只运行产生该字段的最小阶段 |
| 对应源码变化 | 只重跑受影响文件及其图邻居 |
| ID/schema 不兼容且无法确定映射 | 重建该产物，不扩大到无关阶段 |

最小补跑参考：

- 缺少 `template_bindings`、结构/字段 fingerprint：运行 `nav-parser.mjs`。
- 缺少 Pinia 暴露成员或 API payload：分别运行 `pinia-tracker.mjs`、`data-shape-tracer.mjs`。
- 缺少 `field-lineage/`：复用前述中间产物后运行 `field-lineage.mjs`。
- file graph 节点变化时才运行 `graph-cluster.mjs`。
- `deep-analysis.json` 缺少必需 section 或其输入 hash 变化时才运行 `deep-analyzer.mjs`。

兼容副本如 `data-shapes.json`、`business-index.yml` 暂时保留。只有确认与新主产物内容一致、且检索评测无退化后才标记 deprecated；迁移过程不主动删除。

## 5. 构建 Bindings 与验证

在旁路模块上执行严格构建：

```bash
npx codewiki generate <target> --module <module> --finalize
```

必须满足：

- 所有 Product/Developer 文档具有稳定 ID 和非空语义字段；
- 每篇文档至少存在一条 `verified/ast` 代码绑定；纯业务事实无法绑定时，保留迁移来源并进入待确认清单，不伪造代码证据；
- `bindings.jsonl` 不含悬空 Knowledge ID、Navigation ID 或非法枚举；
- 每个旧章节都存在目标映射，或明确列在 `unmapped_facts`。

使用完全相同的问题集分别评测旧模块与旁路模块。切换门槛：

- 固定问题没有新增失败；
- Top-3 knowledge hit rate 不低于旧模块；
- evidence recall 不低于旧模块；
- forbidden text 无新增命中；
- 高风险业务事实没有未确认冲突。

纯业务事实找不到真实 Navigation 证据时，旁路迁移保持未完成状态，旧模块继续服务；不要为了通过严格构建伪造绑定或提前切换。

延迟只作为告警：warm P95 比旧模块增加超过 20% 时先定位索引或输出膨胀问题，不因为轻微机器波动直接判定知识迁移失败。

## 6. 原子切换与回滚

验证通过后再切换：

1. 将当前 `.codewiki/modules/<module>/` 移到同级临时备份目录。
2. 将 `.codewiki/modules/<module>.v36-stage/` 移到 `.codewiki/modules/<module>/`。
3. 确认新模块可严格构建和检索后，将临时备份移动到 `.codewiki/modules/<module>/.archive/v3.5-<date>/`。
4. 写 revision，记录复用文件、补跑阶段、语义映射、待确认项、评测前后指标和新 base_commit。

任一步失败都停止后续操作：如果旧模块已经移走而新模块未就位，立即把旧模块移回原路径。不要使用 `rm -rf` 清理旧模块或备份。

建议在项目 `.gitignore` 增加：

```gitignore
.codewiki/modules/*/.archive/
.codewiki/modules/*.v36-stage/
.codewiki/codewiki-migration/
```

## 7. 迁移结果输出

向用户输出一段简洁摘要：

- 复用的旧知识文件数和章节数；
- 原样复用、增量补跑、重建的 Navigation 产物数；
- 自动归类与待确认事实数；
- Top-3 命中率、证据召回率和 warm P95 的迁移前后对比；
- 新模块路径和回滚归档路径。

只有 `unmapped_facts` 中包含高风险业务事实，或新旧证据明确冲突时才请求用户确认。
