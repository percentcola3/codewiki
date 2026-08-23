---
description: 检索知识库回答业务/代码问题；回答后邀请用户评级，差评触发知识增补反哺
allowed-tools: mcp__codewiki__codewiki_explore, Bash(codewiki:*), Read, Grep
---

# /wiki-explore — 知识库问答 + 可信度反哺

用户提出的业务/代码问题（按钮行为、业务规则、字段来源、改动影响、状态流转等）按本流程处理。

## 1. 检索

调用 MCP 工具 `codewiki_explore`：

- `query`：用户问题（保留业务术语原文）
- `module`：可确定模块时限定；否则省略让检索器全库搜索
- `detail`：实现/调用链/字段来源/影响分析类问题用 `evidence`，其余省略自动判断

MCP 不可用时降级执行 `codewiki query "<问题>"`。
记录返回的 `structuredContent.retrieval_id`（后续评级关联用）。

## 2. 回答

- 基于命中的语义文档与代码证据作答；结论必须附 `file:line` 证据
- 知识库命中为空时明确说明"知识库未覆盖"，基于读源码谨慎回答并标注证据等级
- 返回 `stale: true` 时提醒用户：知识库可能过期（base/head commit 不一致），建议 `/wiki-scan --update`

## 3. 邀请评级（必须执行，不要跳过）

回答结束后询问用户：

> 这个回答有帮助吗？**好** / **不好**（一句话说明原因更好）

## 4a. 评价「好」

```bash
codewiki feedback record --rating good --query "<用户原问题>" --module <模块> [--retrieval-id <retrieval_id>]
```

若该问题此前从未命中且具有沉淀价值，提议把它固化为回归 case（写入模块 `retrieval-cases.json`，供 `codewiki evaluate` 使用），用户同意后再写。

## 4b. 评价「不好」

1. 记录差评：

   ```bash
   codewiki feedback record --rating bad --query "<用户原问题>" --module <模块> [--retrieval-id <retrieval_id>]
   ```

2. **梳理本轮对话**：重新读相关源码，列出值得增补进知识库的事实清单——每条必须带 `file:line` 证据；业务规则缺证据时向用户求证，不得杜撰
3. 把清单展示给用户，请用户确认哪些增补（提供 2-3 个理解选项，不要自作主张全加）
4. 用户确认后逐条执行：

   ```bash
   codewiki case add --module <模块> \
     --title "<知识标题>" \
     --question "<用户会怎么问>" \
     --answer "<带证据的结论>" \
     --evidence <src/path/file.vue:42> [--evidence <src/api/xx.ts:10>]
   ```

5. 刷新索引使新知识立即可检索：`codewiki index`
6. 告知用户：增补的知识已计入置信度评估，可运行 `codewiki confidence` 查看变化；若差评源于知识库过期而非缺失，建议 `/wiki-scan --update`

## 约束

- `case add` 的 `--answer` 必须可追证（`--evidence` 至少一条），证据不足先问用户
- 不要代替用户评级；不要在用户未确认前批量增补
- 命中记录与评级全部写在本地 `.codewiki/`，无上报
