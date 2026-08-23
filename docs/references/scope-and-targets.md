# codewiki · 范围与候选入口

主文件 [SKILL.md](../SKILL.md) 在 Step 1 完成模式判断后，按本文件执行候选入口审阅与范围扩展，再回到主文件继续 Step 2。

## Step 1.2: 候选入口审阅（分析前校准）

在执行 Step 1.5 和 AST 管道前，先整理候选入口清单。用户未提供明确 path、或提供的是业务意图时，必须让用户确认分析范围。目标是在低成本阶段暴露漏扫风险，而不是做完文档后再返工。

### 候选入口清单

候选清单至少包含：

| 字段 | 说明 |
|------|------|
| path | 候选文件或目录 |
| role | page-entry / route / global-component / layout / composable / ipc-caller / ws-subscriber / api-caller 等 |
| confidence | high / medium / low |
| reason | 为什么认为它与本次扫描强相关 |
| planned_action | include / exclude / pending |

### 审阅策略

以下情况必须停下来等用户确认：

- 用户只给业务意图，没有给明确 path
- 候选入口不止一个，或多个入口边界接近
- 关键入口位于 page 目录之外
- 存在明显的跨目录 IPC / API / WebSocket / store / composable 链路
- 最近同类模块出现过漏扫或范围判断偏差

只有用户明确授权“你判断后直接执行”，且候选入口为 high confidence、单一边界，才允许自动通过。自动通过时仍必须输出入口采纳理由，并写入 manifest。

### 执行方式

1. 先从 Step 1 产出的候选目录/文件中整理入口清单。
2. 给每个候选标注角色、置信度和纳入理由。
3. 明确哪些是初始 AST target，哪些只是待观察候选。
4. 需要确认时，先展示候选清单和建议纳入项，等待用户确认。
5. 用户确认后才进入 Step 1.5，并将结论写入 manifest 的 `entry_review`。

### manifest 记录

```yaml
target_dirs: [render/pages/printer]
entry_review:
  mode: user-confirmed
  summary: "初始 target 外另发现全局打印任务入口，用户确认纳入后再继续扫描"
  candidates:
    - path: render/pages/printer
      role: page-entry
      confidence: high
      reason: "用户指定打印模块页面目录"
      decision: include
    - path: render/components/print-manager/index.vue
      role: global-component
      confidence: high
      reason: "打印任务提交与轮询的真实入口"
      decision: include
```

## Step 1.5: 范围扩展（关联文件发现）

初始 target 确定后，必须执行反向依赖追踪，发现 target 目录外但与模块强关联的文件。

### 为什么需要这一步

业务模块的代码经常不集中在单一目录。全局组件（注册在 App.vue）、布局组件（注册在 layout/）、共享 composables（在 composables/ 或 utils/）可能包含模块的核心逻辑。AST 管道只处理指定目录内的文件，target 外的关键文件会被完全忽略。

### 执行方法

从 target 目录内的结构化锚点出发，由 Claude Code 读码补证并反向追踪调用者和消费者。`rg` 只用于定位候选，不作为结论来源；任何纳入扩展范围的判断都必须带 `file:line` 证据。

1. **路由/页面入口**：确认路由、菜单、异步组件和页面文件是否同属一个业务边界
2. **API / RPC / IPC / 事件入口**：从调用点继续读到封装层、桥接层、handler 或服务函数；Electron 只是其中一种 profile，不写死为通用前提
3. **WebSocket / event bus / BroadcastChannel**：追踪生产者、消费者、订阅注册和补偿逻辑
4. **组件引用**：找全局组件、布局组件、slot 入口和跨目录业务组件
5. **Store/Composable**：找到定义文件和关键消费者，区分核心链路和共享工具

### 筛选规则

发现的外部文件按以下规则决定是否纳入：

| 条件 | 动作 |
|------|------|
| 文件是模块核心链路的一部分（如任务调度入口） | **必须纳入**，加入 AST target |
| 文件是共享工具（utils/、types/） | 记录但不纳入 AST，在 Layer 2 中引用 |
| 文件仅在测试/mock 中引用 | 不纳入 |
| 文件是其他模块的消费者（跨模块依赖） | 不纳入 AST，但在 Layer 2 中记录依赖关系 |

### 记录扩展范围

在 `manifest.yml` 中记录扩展后加入的目标。优先记录精确的文件或目录；目录摘要可选。

```yaml
target_dirs: [render/pages/printer]
expanded_targets:
  - path: render/components/print-manager/index.vue
    type: file
  - path: render/components/print-ticket
    type: dir
expanded_dirs: [render/components/print-ticket]
expansion_reason:
  - target: render/components/print-manager/index.vue
    type: file
    reason: "submitPrintTask 的调用者，打印任务WS监听和轮询总入口"
    evidence: "grep submitPrintTask → render/components/print-manager/index.vue:226"
```

### 验证

扩展完成后，检查以下断言：
- target 中每个 IPC 方法的调用者至少有一个被覆盖
- target 中每个 API 函数的调用者至少有一个被覆盖
- 扩展后的文件列表中不包含无关模块的文件

