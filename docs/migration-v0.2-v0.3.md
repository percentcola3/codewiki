# v0.2 → v0.3 迁移指南

v0.3 不要求重写现有 Markdown。公开 CLI 收敛为 `init`、`upgrade`、`uninstall`，日常知识操作交给 Agent Skills。推荐按以下步骤升级。

## 1. 升级项目集成

```bash
npx codewiki upgrade
```

已初始化项目使用 `upgrade` 更新 Claude Code/Codex Skills、MCP 和工作流参考，不会覆盖 `.codewiki/INSTRUCTIONS.md` 或模块知识。尚未初始化时使用 `npx codewiki init`。升级会清理旧版 `/wiki-scan`、`/wiki-explore` 入口，并写入可移植的 codewiki MCP 配置，供查询 Skill 使用。

## 2. 更新现有模块

在 Claude Code 或 Codex 中说“更新 `<module>` 知识库，只处理 `<target>` 的变化”。

`codewiki-generate` Skill 会在内部生成稳定的 `navigation/graph.jsonl`，并判断 `NO_IMPACT`、`INDEX_ONLY` 或 `KNOWLEDGE_IMPACT`。

- 前两类无需改写 Markdown；
- `KNOWLEDGE_IMPACT` 只更新命令列出的知识和关联 Case。

Skill 会自动完成 Finalize，写入新版 bindings、确认 Evidence 指纹并执行 Case 回归。失败会自动恢复更新前模块。

## 3. 可选：加强 Case

影响面、链路和状态类 Case 可以增加 `expected_intent`：

```json
{
  "id": "eval:orders:impact",
  "query": "修改订单字段会影响哪些页面？",
  "expected_intent": "impact",
  "expected_knowledge_ids": ["kb:orders:developer:impact"]
}
```

支持值为 `semantic`、`impact`、`chain`、`lineage`、`state`、`hybrid`。该字段可选，不影响旧 Case。

## 4. 检查置信报告

在 Agent 中说“检查 `<module>` 的知识置信度”。

重点检查 `stale` 和 `unverified` 数量。旧模块首次升级时可能出现未验证证据，成功 finalize 后会建立基线。

## 5. CI 自动更新

复制 `examples/codewiki-update.yml` 到目标仓库的 `.github/workflows/codewiki-update.yml`，再按仓库目录调整 target/module。模板不会在 CI 中自动撰写业务 Markdown；遇到 `KNOWLEDGE_IMPACT` 会安全退出。

## 兼容说明

- 现有 `file-graph.json`、`func-dependencies.json` 等仍会生成；
- `graph.jsonl` 是新的统一机器索引，不替代 Markdown；
- `bindings.jsonl` 增加新鲜度字段，旧消费者可以忽略未知字段；
- `.codewiki/transactions/` 是本地状态，默认不提交；
- `codewiki-review` 可生成静态站点并检查知识质量；
- 新生成的实现知识使用 `developer/` 和 `kb:<module>:developer:*`；旧 `frontend/` 与 `kb:<module>:frontend:*` 仍可读取，建议在更新模块时逐步迁移；
- generate/query/preview/confidence CLI 仍保留，供 Skills、CI 和自动化作为内部执行接口。
