# CodeWiki

> 将生产代码编译成可审查、可通过 Git 共享的业务知识，让 AI Agent 和团队从同一份主脉络开始工作。

[English](../README.md) | **中文**

CodeWiki 面向长期演进的业务仓库。它分析前后端代码，生成带代码证据的 Markdown 知识，并把真实用户提问、好评和差评转化为可复用的 Case 与 Gap。

## 是什么

复杂项目中，用户用业务语言提问，代码却分散在组件、状态、接口、事件、IPC 和服务中。每次让 Agent 从零读代码，容易遗漏，也会随模型和上下文变化而波动。

CodeWiki 的做法是：先用 AST 和代码图找出稳定事实，再生成团队可读、可提交的业务文档；提问时先检索文档主脉络，需要时才深入代码。

```text
代码 → AST / 代码图 → 业务 Markdown → Git 团队知识
                                  ↓
                         检索、反馈、Case、Gap
```

它不是在线 RAG 服务，不依赖向量数据库。

### 与其他工具的区别

| 工具 | 主要能力 | CodeWiki 的侧重点 |
| --- | --- | --- |
| [Understand Anything](https://github.com/rashidazarang/understand-anything) | 深度分析代码并产生结构化产物 | 输出以可读业务文档为主，可进入 Git，并由真实反馈持续修正。 |
| [CodeGraph](https://github.com/code-graph-dev/codegraph) | 精确定位符号与调用路径 | 代码图是证据和导航手段；CodeWiki 优先回答业务流程、规则、边界和影响。 |
| CodeWiki | 团队业务知识与评估闭环 | 适合把代码理解沉淀为长期团队资产。 |

三项核心价值：

1. **文档化、可 Git 管理**：`.codewiki/modules/` 下的知识可以审查、版本化、全团队共享。
2. **业务理解更强**：生成的不是函数清单，而是流程、规则、状态、边界与影响面。
3. **评估闭环完整**：好评沉淀为真实 Case；差评形成 Gap，补齐后再验证。

## 适合谁

适合长期迭代、多人协作的业务仓库，尤其是：

- 前后端、IPC、事件链路复杂的产品代码；
- 一个业务模块横跨多个应用或服务的 Monorepo；
- 研发、产品、测试和 AI Agent 经常重复询问“这个功能是怎么实现的”的团队；
- 希望把知识和代码一样走 Git 审查与协作的项目。

不适合一次性脚本、短期原型，或只需要按符号搜索代码的小仓库。

## 怎么用

### 初始化

需要 Node.js 18+：

```bash
cd your-repository
npx codewiki init
```

它会创建配置和可提交的 `.codewiki/` 知识目录，并为 Claude Code、Codex 安装 Skill 和检索 MCP。

公开 CLI 只有三个生命周期命令：

```bash
npx codewiki init
npx codewiki upgrade
npx codewiki uninstall
```

### 在 Claude Code 或 Codex 中生成和提问

重启 Agent 后直接说：

```text
为订单模块生成知识库：前端在 apps/order-web，Java 服务在 services/order-api。

更新订单模块知识库，只处理当前代码变更。

什么情况下允许退款？请基于 CodeWiki 和代码证据回答。
```

每次基于 CodeWiki 的回答末尾都会请求反馈：

- 回复“有帮助”：本次真实问题自动沉淀为 `feedback Case`；
- 回复“没帮助：原因”：建立 Gap，补充知识并验证后关闭。

### 查看健康报告

```text
检查订单模块的知识健康情况。
```

用户报告只展示四项：

| 项目 | 含义 |
| --- | --- |
| 知识状态 | 当前代码比知识生成基线领先多少提交。 |
| 历史检索问题 | 最近窗口内去重后的真实用户问题。 |
| Case | 已验证、待补和待复核的真实问题数量。 |
| Gap | 尚未解决的知识缺口数量。 |

不会展示自动题回归数、模型分数、检索耗时等内部指标。

## 实现与架构

```text
Source Units
  → AST 提取
  → 统一代码图
  → 业务流程与证据排序
  → Product / Developer / Quality Markdown
  → Git 审查和共享
```

- AST 提取组件、函数、事件、接口、状态、字段和依赖关系。
- 统一代码图连接多个前后端目录，并支持调用链、影响分析和字段血缘。
- LLM 只在确定性事实准备好后，负责把它们解释成业务语言；关键结论保留代码证据。

模块知识结构：

```text
.codewiki/modules/<module>/
├── product/       # 业务流程、规则、边界
├── developer/     # 架构、状态、影响面
├── quality/       # 已确认缺陷、决策、反馈知识
└── navigation/    # AST 与代码图证据
```

检索分两步：先用文档标题、别名、常见问题和实体匹配业务语义；需要技术细节时，再通过代码图扩展调用路径、状态关系或字段血缘。

Case 也分两类：

- **真实 Case**：来自用户好评、测试、缺陷、PRD 或人工整理，计入用户健康报告；
- **自动冒烟题**：只用于发现索引或证据链是否损坏，不作为业务质量结论。

更多原理说明见：[产品与架构说明](codewiki-explained.html)。

## 许可证

[MIT](../LICENSE)
