---
description: 建立或更新模块知识库（AST 扫描 + 语义层撰写 + 检索索引 + 证据自检）
argument-hint: "[目标路径] | --update [--bugfix [--id DEF-xxx]]"
allowed-tools: Bash(codewiki:*), Read, Grep, Glob, Write, Edit
---

# /wiki-scan — 模块知识库建立/更新

按以下流程处理参数 `$ARGUMENTS`：

## 1. 确定目标与模式

- **给了路径**：以该路径为 target，module 名取路由名/目录名（避免 index、pages 这类弱名称）
- **`--update`（无路径）**：扫描 `.codewiki/modules/*/manifest.yml`，对每个 module 读 `manifest.yml#base_commit`，用 `git diff --name-status <base_commit>` + `git ls-files --others --exclude-standard` 计算代码增量；diff 为空的模块报告"无变更"跳过
- **`--update --bugfix`**：额外把缺陷沉淀到 `.codewiki/modules/<module>/quality/defects/`（缺 DEF id 时先询问用户）
- **既无路径也无 --update**：根据用户意图推断候选入口（rg 搜路由/菜单/页面），输出候选清单，**等用户确认后**再执行
- 目标是项目根目录时，先警告耗时与 token 消耗，等用户确认

## 2. 运行 AST 管线

```bash
codewiki scan <target> --output .codewiki/modules/<module>
```

## 3. 读取产物并撰写语义层

1. 读取 `.codewiki/modules/<module>/navigation/` 下的 `file-graph.json`、`func-dependencies.json`、`component-refs.json`、`graph-quality.json`、`clusters.json`、`deep-analysis.json`、`field-lineage/`
2. **完整工作流、产物模板与反捏造约束见 `.codewiki/workflow/agent-workflow.md`**（JSON schema 见同目录 `references/`）
3. 撰写 `product/`（业务语义，PM/QA 视角）与 `frontend/`（前端架构）Markdown：每篇必须带 frontmatter（`id: kb:<module>:<product|frontend>:<topic>`、非空 `aliases/questions/entities`），每条结论必须带 `file:line` 证据；脚本未产出的动态关系必须读源码补证
4. 结构事实以脚本 JSON 为准；`deep-analysis.json` 只是候选信号，不能单独作为结论

## 4. 构建检索索引并验收

```bash
codewiki index
# 首次生成或结构性更新时（COSMETIC 可跳过）：
codewiki evaluate --cases .codewiki/modules/<module>/retrieval-cases.json --repeat 5
```

评测集覆盖七类问题（模板：`.codewiki/workflow/references/retrieval-cases.example.json`）：UI 入口 / 业务规则 / 用户反馈 / 字段血缘 / 影响分析 / 状态路径 / 无答案。

## 5. 证据自检（不可跳过）

```bash
codewiki scan <target> .codewiki/modules/<module> --validate
```

FAIL 时：所有受影响文档首段加 `> ⚠️ 状态：draft —— N/M 条结论缺少代码证据`，逐条报告失败引用，不修复不掩盖。

## 6. 收尾汇报

向用户报告：模块名、语义文档数、导航节点数、绑定数、自检状态与逐文件评级、评测 Top-3 命中率/证据召回率、待确认项。然后建议：

- `/wiki-explore` 用真实问题验证检索
- `codewiki preview` 打开浏览器浏览知识库
- `codewiki confidence` 查看模块置信度
