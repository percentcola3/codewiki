# 从 v0.1 迁移到 v0.2

v0.2 继续把共享知识保存在仓库根目录的 `.codewiki/modules/`，无需搬迁已有模块。主要变化是：不再忽略整个 `.codewiki/`，只忽略缓存、日志、反馈和站点等本地运行产物。

## 兼容行为

- 已有 `.codewiki/modules/` 直接沿用，不移动、不删除。
- `knowledge-overlay/*.jsonl` 仍可被索引，建议确认后转为 `quality/manual/*.md`。
- 没有 `id` 的旧 Eval Case 会按内容生成稳定 ID；后续通过 `generate` 补充知识时会固化新 Case。

## 迁移步骤

1. 确认工作区干净或先备份当前改动。
2. 运行 `codewiki init`。它会生成 `codewiki.yml`，删除旧的整目录 `.codewiki/` ignore 规则，并加入精确的运行产物规则。
   新版不再安装 `.claude/commands/`；确认没有自定义内容后，可手工删除旧的 `wiki-scan.md`、`wiki-explore.md` 以及旧 `codewiki-scan`、`codewiki-explore` Skill 目录。
3. 检查 `.codewiki/modules/` 未被 Git 忽略：

   ```bash
   git check-ignore -v .codewiki/modules/<module>/manifest.yml
   ```

   没有输出表示该文件可以被 Git 跟踪。

4. 将有长期价值的本地补充知识提升为共享 Markdown：

   ```text
   .codewiki/knowledge-overlay/*.jsonl
                    ↓ 人工确认、补充证据
   .codewiki/modules/<module>/quality/manual/*.md
   ```

5. 重建索引并执行回归：

   ```bash
   codewiki generate <target> --module <module> --finalize
   codewiki confidence --module <module>
   ```

6. 提交团队共享资产：

   ```text
   codewiki.yml
   .codewiki/modules/
   .agents/skills/
   .claude/skills/
   .mcp.json
   .codex/config.toml
   ```

   不提交 `.codewiki/cache/`、`retrieval.jsonl`、`feedback.jsonl`、`gaps.jsonl`、`evaluation-runs/`、`knowledge-health/` 和 `site/`。

## 推荐配置

```yaml
knowledge_root: .codewiki/modules
state_root: .codewiki
```

两个路径位于同一个根目录时，`codewiki init` 会保留 `modules/`，只为明确的运行产物生成 `.gitignore` 规则。

## 命令变化

| 旧入口 | 新入口 | 说明 |
| --- | --- | --- |
| `scan` / `index` / `knowledge add` / `eval add` / `evaluate` | `codewiki generate` | 新建、更新、补充、索引和回归统一入口 |
| `feedback record` | `codewiki query --feedback` | 检索和用户反馈统一入口 |
| `site` / `preview` | `codewiki preview` | 只保留浏览入口 |
| `report` / `confidence` | `codewiki confidence` | 知识健康和使用质量统一报告 |

迁移过程不会自动移动或删除知识文件。
