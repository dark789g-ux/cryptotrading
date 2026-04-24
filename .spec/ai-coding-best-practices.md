# AI 编码最佳实践（本仓库）

> 面向后续 AI 会话的参考手册。沉淀自实际需求改动过程，针对本项目的架构与约束。

---

## 二、回测引擎改动套路

### 参数新增标准路径
仅需改两处（后端）+ 一处（前端），无需数据库迁移：

1. **[models.ts](../apps/server/src/backtest/engine/models.ts)**
   - `BacktestConfig` 接口加字段
   - `DEFAULT_CONFIG` 加默认值（**必须选择不改变历史回测结果的值**）
   - 如有范围约束，在 `validateConfig` 加校验（布尔字段无需校验）

2. **引擎消费点**（engine.ts / signal-scanner.ts / position-handler.ts 之一）
   - 从 `config.xxx` 读取，就地使用

3. **[StrategyModal.vue](../apps/web/src/components/backtest/StrategyModal.vue)**
   - `defaultParams()` 加默认值
   - 模板中加 Naive UI 控件（`n-switch` / `n-input-number` / `n-slider`）
   - `script` 顶部 import 补全 Naive 组件名

### 为什么无需改数据库 / backtest.service.ts
`backtest.service.ts` 使用 `{ ...DEFAULT_CONFIG, ...params }` 合并，历史 `StrategyEntity.params` 缺失字段时自动由 `DEFAULT_CONFIG` 兜底。**这是本项目的核心向后兼容机制，不要破坏它**：
- 新增字段默认值必须在 `DEFAULT_CONFIG` 中定义
- 不要为"历史记录迁移"写一次性 SQL
- 不要 `ALTER TABLE`

### 引擎主循环的关键节点（engine.ts `runBacktest`）
每根 K 线按此顺序处理，选择正确的插入点：

| 节点 | 位置 | 适合的改动 |
|---|---|---|
| 1. `executePendingBuys` | 执行上根挂的买单 | 开仓参数校验、实际建仓逻辑 |
| 2. `processPositions` | 处理止盈止损出场 | 持仓管理、出场规则 |
| 3. `calculatePortfolioValue` | 记录权益曲线与快照 | 快照字段扩展 |
| 4. `allowNew` 判定 + `scanSignals` | **开新仓门禁 + 信号扫描** | 开仓门禁（如"盈利才开新仓"）、信号条件 |
| 5. `forceClosePositions` | 回测结束平仓 | 结束行为 |

**开仓门禁**一律加在节点 4 的 `allowNew && ...` 条件中，与 `cash >= minOpenCash`、`!lossTracker.isInCooldown(...)` 并列。不要塞进 `executePendingBuys`（那里已经延迟一根，判定语义会错位）。

### pendingBuys 机制
信号在第 N 根扫描 → 挂单到 `pendingBuys` → 第 N+1 根 open 价执行。因此：
- 新仓在创建当下 `stopPrice < entryPrice`（止损线在成本价下方）
- 若门禁判定"持仓全部盈利"，刚开的新仓天然会阻断后续——**这是正确行为，不要绕过**

---

## 三、前端表单规范

### Naive UI 用法
- 禁自建组件（CLAUDE.md 硬约束）
- 表格：分页/排序/筛选全走后端（CLAUDE.md 硬约束）
- 开关类参数用 `n-switch`，数值用 `n-input-number`，带范围用 `n-slider` + 手动输入框
- import 必须同步更新（常漏：加了 `<n-switch>` 忘了 import `NSwitch`）

### 参数表单布局
StrategyModal 已有分组 `<n-divider>`：资金配置 / KDJ 参数 / 风控参数 / 回测区间。新参数按语义归入，不要新建分组，除非 ≥2 个同类参数一起加。

---

## 四、硬约束速查（CLAUDE.md 节选）

### 禁
- `any` → 用 `unknown` + 类型收窄
- 静默错误 → 必须反馈用户
- `git log` / `git diff` 查历史
- PowerShell 用 `&&`（用 bash）
- 原生 SQL 用 `::uuid[]`（ID 列是 `character varying`，用 `::text[]`）
- 500 静态分析猜错 → 开 TypeORM `logging: ['error','warn']` + `logger.error(err.stack)`
- 开 `synchronize`
- AI 自测（用户测试）
- PowerShell 文本处理 → 用 Edit/Write

### 必
- 所有文件 UTF-8，I/O 显式 `encoding='utf-8'`
- HTML `<meta charset="UTF-8">`
- DB 连接 `utf8mb4`
- 对象键名**英文**（避 Windows GBK 终端解析错误）
- 中文思考与回答
- 单文件 ≤500 行
- 前端装包：`cd apps/web && pnpm add ...`

### 回测默认假设
一根 K 线内价格路径：**O → H → L → C**

---

## 五、常见陷阱回顾

1. **默认值改了历史回测结果** → 用户无法复现以前的回测。新参数默认值必须保持"开关关闭/等价于原行为"
2. **改动了 `backtest.service.ts` 的 params 合并逻辑** → 破坏向后兼容
3. **加字段忘同步 StrategyModal 的 `defaultParams()`** → 新建策略时字段缺失
4. **加 `<n-xxx>` 忘了顶部 import** → Naive UI 组件未注册报错
5. **把门禁塞进 `executePendingBuys`** → 判定时机错位（此时已是下一根 K 线）
6. **为"历史记录兼容"写数据库迁移** → 多余，`{ ...DEFAULT_CONFIG, ...params }` 已解决
7. **自行假设模糊需求** → 违反 CLAUDE.md，必须 AskUserQuestion
8. **`arr[i] \|\| {}` 再访问字段** → `row` 被推断为 `{}`，`vue-tsc` 报 `Property 'xxx' does not exist`。应先取元素再 `if (!item) return` 或显式标注类型
9. **从 naive-ui 猜导出名（如 `SortOrder`）** → 包未必导出，编译直接失败。用本地联合类型 `false \| 'ascend' \| 'descend'` 或从官方类型定义路径核实

---

## 六、TypeScript 与 vue-tsc 规范

> 目标：避免「运行时没问题、类型检查却红」或「合并进主分支后才发现 vue-tsc 全量失败」。本节针对本仓库已踩过的坑。

### 6.1 禁止用空对象兜底再读属性

**反例**（会把类型收窄成空对象 `{}`，后续 `.open` / `.trades` 全错）：

```ts
const row = data[idx] || {}
const x = row.open // Property 'open' does not exist on type '{}'
```

**正例**：

```ts
const row = data[idx]
if (!row) return ''
// 此处 row 为数组元素类型（如 KlineChartBar）
```

若业务上必须有默认值，应使用**与真实结构一致**的占位（或单独定义 `Partial<T>` 并在访问前逐项判断），而不是裸 `{}`。

### 6.2 第三方库类型：只信声明文件，不信记忆

- **Naive UI**：`n-data-table` 列的 `sortOrder` 类型为 `false | 'ascend' | 'descend'`（**没有** `true`）。不要从 `'naive-ui'` 根入口猜 `SortOrder` 等符号是否导出；以 `node_modules/naive-ui/es/**` 或 IDE「转到定义」为准。
- **ECharts / 回调 `params: unknown`**：进入函数后先用 `Array.isArray`、`seriesType` 等收窄，再访问 `dataIndex`；避免一大坨 `as any`。

### 6.3 远程表格与 `sortOrder`（与 CLAUDE.md 表格规范一致）

- 未点击表头时：各列 `sortOrder` 一律为 `false`（无假高亮），请求仍可带后端默认排序。
- 用 `explicitSort`（或等价状态）区分默认排序与用户点击；`headerOrder(key)` 的返回类型写清为 `false | 'ascend' | 'descend'`，避免推成 `boolean`（含 `true`）。

### 6.4 改完代码后的类型自检（推荐）

| 范围 | 命令（在对应 package 目录） | 说明 |
|------|-----------------------------|------|
| 后端 | `pnpm exec tsc --noEmit` | Nest / 纯 TS，无产物 |
| 前端 | `pnpm exec vue-tsc --noEmit` | 含 `.vue`，全量检查 |

- **新增/大改 PR**：至少保证**本次改动涉及文件**不再引入新的 `vue-tsc` / `tsc` 错误。
- 仓库中可能仍有**历史遗留**的 `vue-tsc` 报错：与本次无关时不要顺手大改；可单开「类型债」任务分批修。

### 6.5 `any` 与 `unknown`（与 CLAUDE.md 一致）

- 禁 `any`；对外部 JSON、回调参数用 `unknown`，再 `typeof` / `in` / 类型谓词收窄后再用。

---

## 七、文件定位索引

- 引擎主循环：[engine.ts](../apps/server/src/backtest/engine/engine.ts)
- 参数定义：[models.ts](../apps/server/src/backtest/engine/models.ts)
- 信号扫描：[signal-scanner.ts](../apps/server/src/backtest/engine/signal-scanner.ts)
- 持仓管理：[position-handler.ts](../apps/server/src/backtest/engine/position-handler.ts)
- 策略种子：[strategy-types.seed.ts](../apps/server/src/strategies/strategy-types.seed.ts)
- 策略表单：[StrategyModal.vue](../apps/web/src/components/backtest/StrategyModal.vue)
- 参数合并点：[backtest.service.ts](../apps/server/src/backtest/backtest.service.ts) L82-83

架构细节见 [strategy-system.md](./strategy-system.md)。
