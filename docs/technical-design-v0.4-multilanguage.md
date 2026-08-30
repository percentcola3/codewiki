# codewiki v0.4 多语言与 Monorepo 方案

## 背景

一个业务模块可能同时由 Vue/React 前端、Java 服务和 Go 服务实现。业务知识不能按代码语言分裂，也不能用仓库根目录的框架版本覆盖所有 Workspace。

## 目标

1. 业务模块与代码目录分离：Module 包含一个或多个 Source Unit。
2. Vue、React、Java、Go 输出统一节点、关系、证据和置信度。
3. 使用 HTTP Method + 标准化 Path 建立前端请求到后端 Endpoint 的确定性链路。
4. 保留现有 Vue/TypeScript 深度分析，避免为统一解析器牺牲字段血缘等成熟能力。

## 架构

```text
Monorepo
  → Source Unit 发现
  → 语言/框架/版本 Profile
  → SWC + Vue Compiler / Node Tree-sitter
  → framework-facts.json
  → 跨语言协议关联
  → graph.jsonl
  → developer Markdown + Eval Case
```

单前端 Source Unit 继续运行原六阶段深度增强。多 Source Unit 模块只扫描显式边界并汇入统一事实图，避免把无关 Workspace 纳入。

## Source Unit

```yaml
modules:
  - name: orders
    source_units:
      - name: orders-web
        path: apps/orders-web
        framework: vue
        version: auto
      - name: orders-admin
        path: apps/orders-admin
        framework: react
        version: auto
      - name: orders-api
        path: services/orders
        language: java
        framework: spring
```

版本识别优先使用 lockfile，其次使用 `package.json`。显式配置只用于无法自动判断或必须固定兼容行为的场景。

## 支持矩阵

| Profile | 首期范围 |
| --- | --- |
| Vue 2.6 | Options API、Mixin、Filter、旧 `v-model`、`.sync` |
| Vue 2.7 | Vue 2 能力 + Composition API、`script setup` |
| Vue 3.x | Options/Composition API、SFC Macros、版本能力标记 |
| React 16.8/17 | Class、Function、Hooks、新旧 JSX Runtime |
| React 18 | Hooks、`createRoot`、Suspense 结构 |
| React 19 | Actions、`use`、Server/Client Component 指令 |
| Java | package、class/interface/record、method、call、Spring Endpoint |
| Go | package、struct/interface、function/method、call、Gin/HTTP Endpoint |

版本不会直接决定代码风格。例如 Vue 3 仍可能使用 Options API，React 18 仍可能包含 Class Component。因此 Profile 同时保存“版本支持能力”和“源码实际观察能力”。

## 事实与置信度

- AST 明确声明、精确 import、精确 HTTP Method + Path：verified。
- 只按名称解析且存在多个目标：candidate。
- Java 重载、Go Interface 动态分派等完整语义不由 Tree-sitter 强行推断。
- 所有事实保留 `file:line`、language、framework、framework_version 和 source_unit。

## 产物

- `navigation/source-units.json`：目录、语言、框架、版本和能力。
- `navigation/framework-facts.json`：统一节点、边和跨语言协议关系。
- `navigation/graph-index.json`：文件内容与结构指纹。
- `navigation/graph.jsonl`：与旧前端图合并后的规范检索视图。

原始 JSON 是机器索引，用户正文仍为 `product/`、`developer/` 和 `quality/` Markdown。

## 验证

1. 有明确依赖和 lockfile 时，框架主版本识别准确率 100%。
2. 基准项目的组件、定义、调用和 Endpoint 提取准确率不低于 90%。
3. 跨语言 HTTP Case 的 Top-3 证据召回率不低于 90%，现有 Vue/TypeScript 回归不得退化。
