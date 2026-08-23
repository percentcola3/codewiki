# codewiki · 深度分析（Step 2.6 / 2.8 / 2.9）

主文件在 Step 2 输出 navigation 后转入本文件，依次完成行为信号抽取、动态链路验证、待确认项收集，再回到主文件 Step 3 继续。

## Step 2.6: 候选行为信号生成

deep-analyzer 在 `deep-analysis.json` 中产出 5 个候选行为视角 section；data-shape-tracer 产出 `_intermediate/api-payload-shapes.json`。检索器直接按 section 建索引，不再原样复制 5 份 JSON。所有候选信号的契约都是 `candidate-evidence-only`：只能提示 Claude Code 去读码，不得直接变成业务结论。

### 行为索引文件

| section / 文件 | 来源 | 用途 |
|------|------|------|
| `deep-analysis.json#state_machines` | deep-analyzer | 候选状态机实体 → 状态集 → 迁移边 → trigger → evidence |
| `deep-analysis.json#ui_feedback` | deep-analyzer | 候选 UI 提醒/弹窗/i18n 触发点 + 条件 |
| `deep-analysis.json#timeout_recovery` | deep-analyzer | 候选超时常量 ↔ handler ↔ 状态变化 ↔ UI/消息副作用 |
| `deep-analysis.json#branch_routes` | deep-analyzer | 候选分支字段 → 字段值 → 后续链路 |
| `_intermediate/api-payload-shapes.json` | data-shape-tracer | payload 形状候选演变 + endpoints_by_file |
| `deep-analysis.json#product_limits` | deep-analyzer | 候选产品限制信号（外部调用/时序敏感/环境依赖/推送丢失）|

`deep-analysis.json` 保留 `signal_contract: candidate-evidence-only`。只有明确需要兼容旧消费者时，才保留独立行为 JSON 或给 data-shape-tracer 传 `--legacy-copy`；新知识库默认不生成这些副本。

### 消费门禁（决定下游文档是否生成对应章节）

| 行为视角 | Layer 1 消费 | Layer 2 消费 |
|---------|-------------|-------------|
| state-machines | §1 主链路术语参考；§3 异常/验收输入 | **`03-坑点与状态.md` 必须消费** |
| ui-feedback | §3 异常场景与用户感知 | `03-坑点与状态.md` 必须引用 |
| timeout-recovery | §3 恢复行为与验收口径 | `03-坑点与状态.md` 必须引用 |
| branch-routes | §1 主链路差异说明 | `02-变更影响导航.md` 必须覆盖主要分支 |
| data-shapes | §2 字段溯源候选 + §3 接口影响面 | `01-架构与调用图.md` / `02-变更影响导航.md` 按需引用 |
| product-limits | §3 能力边界与不可承诺项 | `03-坑点与状态.md` 的潜在风险段必须引用 |

### 不要做的事

- **不要捏造行为**：scripts 没产出 state_machines / ui_feedback 时，对应文档章节标 N_A 或"未在代码中找到证据"，不要凭直觉补写
- **不要忽略 N_A**：`coverage_assertions` 中状态为 N_A 的 topic 必须在 README 的"文档可信状态"中列出原因
- **不要复制同一事实**：状态/UI/超时/分支/限制只保留在 `deep-analysis.json` 对应 section；语义文档通过 `bindings.jsonl` 引用证据 ID


## Step 2.8: 动态链路/API 活跃度验证

在完成动态链路补证后，必须验证每条链路是否仍被实际调用。AST 分析只能看到结构（注册存在、函数定义），无法判断运行时是否活跃。

### 执行方法

对 Step 2.3 收集的每条动态链路，执行以下验证：

0. **先确定搜索锚点**：
   - 优先使用 preload 暴露名、bridge 方法名、API 导出名做搜索
   - channel 名是字符串常量时，先定位常量定义，再搜索常量引用
   - 统计调用点时排除定义文件本身、类型声明、纯注释和文档

1. **调用方→接收方链路**（RPC/IPC/API/event）：
   ```bash
   # 先搜 bridge/API 暴露名，再按 channel 名补证
   rg -n "<bridge_method>|<api_method>" render/ --glob '*.{vue,ts,tsx,js,jsx}'
   rg -n "invoke\(|send\(|onMessage\(" render/ | rg "<channel_name>"
   ```
   - 0 个调用点 → deprecated
   - 调用点仅在 mock/test/**/*.ts 中 → deprecated
   - 调用点在注释/文档(.md)中 → deprecated

2. **推送/订阅链路**（webContents.send / WebSocket / event bus / BroadcastChannel）：
   ```bash
   # 对每个推送 channel，搜索渲染进程的监听点
   rg -n "onMessage\(|on\(" render/ | rg "<channel_name>"
   ```
   - 0 个监听点 → deprecated

3. **HTTP API 端点**：
   ```bash
   # 对 target 中定义的每个 API 函数名，搜索调用点
   rg -n "<api_function_name>" render/ --glob '*.{vue,ts}'
   ```
   - 0 个调用点（函数定义文件之外）→ deprecated

### 补充判断

- bridge 方法仍被调用，但只落到兼容分支或 fallback 路径 → `partial`
- 仅主进程保留注册、渲染层没有业务代码入口 → `deprecated`
- 有调用点但全部来自历史兼容层，且新链路已替代 → `partial`，并注明替代链路

### 标记规则

| 活跃度 | 条件 | 标记 |
|--------|------|------|
| active | 渲染进程中存在 ≥1 个业务代码调用点 | 无特殊标记 |
| deprecated | 0 个调用点，或仅在 mock/test/注释中 | ⚠️ DEPRECATED |
| partial | 主进程有注册但渲染进程仅通过 fallback/兼容路径调用 | ⚠️ LEGACY |

### 输出

将验证结果写入 `navigation/liveness.json`：

```json
{
  "metadata": {
    "generated_at": "ISO8601",
    "base_commit": "SHA"
  },
  "channels": [
    {
      "channel": "submit-print-task",
      "status": "active",
      "callers": ["render/components/print-manager/index.vue:226"],
      "caller_count": 1
    },
    {
      "channel": "handle-print-receipt",
      "status": "deprecated",
      "callers": [],
      "registered_at": "electron/ipc/ipc-handler.ts:503",
      "note": "注册存在但渲染进程无业务代码调用"
    }
  ],
  "apis": [
    {
      "function": "getUnPrintList",
      "status": "active",
      "callers": ["render/components/print-manager/index.vue:268"]
    }
  ]
}
```

在 `ipc-flows.md` 中，deprecated 通道的标题加前缀 ⚠️ DEPRECATED，并在说明中注明废弃原因和最后已知调用版本。

在 Layer 2 的 `03-坑点与状态.md` 中，deprecated 通道单独归入「已废弃通道」分组。

在 Layer 1 的 flow 文件中，废弃流程仍然保留（作为历史参考），但在「提要」段明确标注，并在文档顶部添加 callout：

```markdown
> ⚠️ **废弃提醒**：本流程的 IPC 通道 `handle-print-receipt` 已无渲染进程调用点。
> 保留本文档仅供历史参考，新功能请使用图形打印流程。
```

## Step 2.9: 待确认项收集与审阅（文档生成前确认检查点）

> **本步骤的目的是避免在生成的文档中大量出现"待业务确认"占位符。**
>
> 在生成 Layer 1/2 文档前，必须先收集并展示需要用户确认的内容。不要等到文档写完才发现术语翻译不对、业务流拆分不合理。

### 确认项分级

| 级别 | 说明 | 处理方式 | 示例 |
|------|------|---------|------|
| **MUST_CONFIRM** | 影响文档核心内容，必须确认才能继续 | **停下等待用户确认** | 业务术语翻译、业务流命名、状态机实体命名 |
| **CAN_POSTPONE** | 可先标记，延后确认不影响核心结构 | 记录到待确认清单，文档中标注 | 某些业务规则why、边缘产品限制 |

### 需要收集的确认项

#### 1. 业务术语翻译（MUST_CONFIRM）

从代码中提取的英文常量/枚举/状态名，需要中文翻译时：

```yaml
确认项类型: 业务术语翻译
优先级: MUST_CONFIRM
收集来源:
  - deep-analysis.json#state_machines 中的状态名
  - 代码中的枚举值（如 OrderStatus.PENDING）
  - 表单字段名、按钮文案、菜单项
  - API 路径中的关键词

确认清单格式:
  - 英文: "pending" → 建议翻译: "等待处理" → 证据: src/types/order.ts:15
  - 英文: "submitPrintTask" → 建议翻译: "提交打印任务" → 证据: src/api/print.ts:42
```

**处理规则**：
- 如果 `manifest.business_terms` 已有，直接使用
- 如果没有，收集后展示给用户确认，**不要直接写"待业务确认"**
- 确认后更新 `manifest.business_terms`

#### 2. 业务流拆分与命名（MUST_CONFIRM）

从 Step 2.7 识别的业务流，需要确认：

```yaml
确认项类型: 业务流拆分与命名
优先级: MUST_CONFIRM
收集来源:
  - deep-analysis.json 的 flows.main_flow 和 branch_flows
  - deep-analysis.json#state_machines 的实体边界
  - 触发源差异（用户操作 vs 系统触发）

确认清单格式:
  - 流程1: 打印任务提交 → 建议名称: "打印提交流" → 涉及文件: 3个
  - 流程2: 打印状态轮询 → 建议名称: "打印状态监听" → 涉及文件: 2个
  - 疑问: 这两个流是否应该合并为一个"打印任务全流程"？
```

**处理规则**：
- 展示识别出的业务流边界和命名建议
- 如果存在边界模糊的情况，**停下来询问用户**
- 不要自己决定拆分/合并

#### 3. 产品限制/不可承诺项（CAN_POSTPONE）

从 `deep-analysis.json#product_limits` 推导的限制：

```yaml
确认项类型: 产品限制
优先级: CAN_POSTPONE
收集来源:
  - deep-analysis.json#product_limits 四类信号

确认清单格式:
  - 限制: 打印任务可能丢失 → 推导依据: WebSocket 推送无 ACK
  - 限制: 并发打印上限未知 → 推导依据: 未找到并发控制逻辑
```

**处理规则**：
- 可以先标记"推测：基于XXX信号推导"
- 在待确认清单中记录，用户可事后审阅

#### 4. 业务规则"为什么"（CAN_POSTPONE）

代码实现但注释未说明原因的业务规则：

```yaml
确认项类型: 业务规则原因
优先级: CAN_POSTPONE
收集来源:
  - 代码中的硬编码阈值
  - 特殊的分支逻辑
  - 异常处理策略

确认清单格式:
  - 规则: 打印队列最多缓存 10 条任务 → 证据: src/constants/print.ts:8
  - 疑问: 为什么是 10？是否有性能或产品限制原因？
```

**处理规则**：
- 如果有 commit/注释说明，直接使用
- 如果没有，标记"代码未说明原因，待业务确认"
- 不停下，但记录到待确认清单

### 确认流程

```
收集确认项
  ↓
按优先级分类（MUST_CONFIRM vs CAN_POSTPONE）
  ↓
如果有 MUST_CONFIRM 项：
  │
  ├─ 展示确认清单（结构化输出）
  ├─ 等待用户确认或修正
  └─ 更新 manifest.business_terms / 业务流列表
  ↓
如果有 CAN_POSTPONE 项：
  │
  ├─ 写入 .codewiki/modules/<module>/navigation/pending-confirmations.yml
  └─ 在对应文档章节中标注"待确认"
  ↓
进入 Step 3 生成文档
```

### 确认清单输出格式

停下来等待确认时，按以下格式输出：

```markdown
## 📋 待确认项清单（N 项需要确认）

### 🔴 必须确认（MUST_CONFIRM）

#### 1. 业务术语翻译（K 项）
| 英文 | 建议翻译 | 证据 | 需要确认 |
|------|---------|------|---------|
| pending | 等待处理 | src/types/order.ts:15 | ✓ |
| submitted | 已提交 | src/api/print.ts:42 | ? |

请确认：以上翻译是否准确？需要修正的请指出。

#### 2. 业务流拆分（M 项）
识别出以下业务流：
- 流程A: 打印任务提交（涉及 src/pages/print, src/api/print.ts）
- 流程B: 打印状态轮询（涉及 src/components/status-poll.vue）

请确认：这两个流应该合并还是拆分？有遗漏的流程吗？

### 🟡 可延后确认（CAN_POSTPONE）

- 产品限制：打印任务可能丢失（基于 WebSocket 无 ACK 信号）
- 业务规则：打印队列最多缓存 10 条任务（原因未在代码中说明）

这些已记录到 `navigation/pending-confirmations.yml`，可稍后审阅。
```

### pending-confirmations.yml 格式

```yaml
metadata:
  generated_at: "2025-01-18T10:00:00Z"
  base_commit: "abc123"

must_confirm:
  business_terms:
    - en: pending
      zh: "等待处理"
      evidence: "src/types/order.ts:15"
      status: confirmed  # confirmed | pending

  flows:
    - id: flow-1
      name: "打印提交流"
      files: ["src/pages/print", "src/api/print.ts"]
      status: confirmed

can_postpone:
  product_limits:
    - limit: "打印任务可能丢失"
      basis: "WebSocket 推送无 ACK 信号"
      evidence: "src/ipc/print-channels.ts:25"
      status: pending

  business_rules:
    - rule: "打印队列最多缓存 10 条任务"
      evidence: "src/constants/print.ts:8"
      reason: "代码未说明原因"
      status: pending
```

### 与 manifest 的关系

确认后的内容必须写入 `manifest.yml`：

```yaml
business_terms:
  pending: "等待处理"
  submitted: "已提交"
  # ...

confirmation_checkpoint:
  timestamp: "2025-01-18T10:05:00Z"
  must_confirm_count: 5
  can_postpone_count: 3
  all_confirmed: true  # 如果 false，文档顶部会添加提示
```

### 文档中的待确认标注

对于 `CAN_POSTPONE` 级别的内容，在文档中使用标准标注：

```markdown
> ⚠️ **待确认**：打印任务可能因 WebSocket 断开而丢失。推导依据：`src/ipc/print-channels.ts:25`。
```

### 不做的事情

- **不要在 MUST_CONFIRM 项上自己决定** — 必须停下来等用户确认
- **不要滥用"待业务确认"** — 能在生成前确认的就不要延后
- **不要忽略确认清单** — 即使用户说"你看着办"，也要输出清单供审阅
- **不要在确认阶段引入新问题** — 确认清单只列已有证据指向的疑问
