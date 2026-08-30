# codewiki 用户指南

codewiki 采用 Skill-first 交互。CLI 只负责项目的初始化、升级和卸载；日常生成、查询、预览和报告都在 Claude Code 或 Codex 中通过自然语言完成。

## 1. 安装和初始化

```bash
cd your-repo
npx codewiki init
```

初始化会把同一套 Skills 安装到：

- Claude Code：`.claude/skills/`
- Codex：`.agents/skills/`

同时创建 `.codewiki/INSTRUCTIONS.md`，并为 Claude Code 和 Codex 配置 codewiki MCP。建议先补充重点模块、业务术语、关键问题和不能进入知识库的内容，然后重启 Claude Code 或 Codex。查询 Skill 必须通过 MCP 完成知识检索。

## 2. 升级和卸载

升级 codewiki 项目集成：

```bash
npx codewiki upgrade
```

它会刷新 Claude Code/Codex Skills、MCP、工作流参考和集成规则，并清理旧版 `fe-scan`、`/wiki-scan`、`/wiki-explore` 入口；不会覆盖 `.codewiki/INSTRUCTIONS.md` 或任何模块知识。

`init/upgrade` 同时安装最小权限集，避免读取仓库、写入配置的知识目录、调用 CodeWiki MCP 和运行内部知识命令时反复审批。权限不会覆盖源码写入、任意 shell、仓库外路径或生命周期命令；项目首次被 Agent 信任以及组织安全策略要求的审批仍然保留。

卸载项目集成：

```bash
npx codewiki uninstall
```

它会移除 codewiki 安装的 Skills、本地工作流和 MCP 配置，但保留：

- `codewiki.yml`
- `.codewiki/INSTRUCTIONS.md`
- `.codewiki/modules/`

这些是团队知识资产，只有确认不再需要时才手动删除。

## 3. 生成知识库

在 Agent 中说：

```text
为 src/views/order 的订单模块生成知识库。
```

`codewiki-generate` 会分析代码、生成带证据的业务和技术文档、建立检索 Case，并在校验失败时自动恢复原知识库。

如果没有提供路径，可以说：

```text
为订单设置功能生成知识库，先帮我确认代码入口。
```

Monorepo 中同一业务模块横跨多个前后端目录时，可以直接说明：

```text
为订单模块生成全栈知识库：Vue 前端在 apps/order-web，React 管理端在 apps/order-admin，Java 服务在 services/orders。
```

Agent 会把它们记录到 `codewiki.yml#modules[].source_units`，分别识别 Vue/React 版本与 Java/Go Profile，再生成统一调用图。一个 Source Unit 使用一个明确的 Workspace 边界；不要把整个 Monorepo 当成同一种语言或框架。

## 4. 更新知识库

代码变化后说：

```text
更新订单模块知识库，只处理受本次代码变化影响的内容。
```

Agent 会根据 `NO_IMPACT`、`INDEX_ONLY`、`KNOWLEDGE_IMPACT` 判断是否需要修改语义文档，不会默认全量重写。

## 5. 查询和反馈

直接提出业务或技术问题：

```text
什么情况下允许退款？
修改订单状态字段会影响哪些页面？
导出按钮到接口之间经过了哪些调用？
```

`codewiki-query` 会按问题类型选择文档、统一图或联合检索，并引用必要的代码证据。

回答后直接反馈：

```text
有帮助。
```

或者：

```text
没帮助，没有说明未发货限制。
```

差评会建立 Gap。Agent 补证并得到确认后，会把修正内容和对应 Case 写入共享知识库。

## 6. 预览和检查质量

在 Agent 中说：

```text
预览订单知识库。
```

或者：

```text
检查订单模块的知识置信度，列出过期知识、缺少的 Case 和重复差评问题。
```

`codewiki-review` 会生成静态预览或置信报告，并把机器指标整理成可执行的结论。

## 7. 团队协作

建议提交 Git 的内容包括：

- `.codewiki/INSTRUCTIONS.md`
- `.codewiki/modules/`
- `codewiki.yml`
- 项目级 `.claude/skills/` 和 `.agents/skills/`（如果团队希望固定版本）

本地查询记录、反馈、Gap、缓存、事务和预览站点默认不会提交。

## 常见问题

### Agent 没有自动使用 codewiki

确认已经在项目根目录运行 `npx codewiki init` 并重启 Agent。也可以在请求中明确说“使用 codewiki-generate / codewiki-query / codewiki-review Skill”。

### 是否必须配置 MCP

需要。Skills 负责编排生成、反馈、预览和质量检查；知识查询必须通过初始化时配置的 codewiki MCP 完成结构化检索，避免把完整图和全部文档直接塞入上下文。`init` 和 `upgrade` 都会自动维护该配置。

### 为什么仓库里仍有 generate/query 等实现

它们是 Skills、CI 和自动化使用的内部执行接口，不是要求用户学习的产品入口。
