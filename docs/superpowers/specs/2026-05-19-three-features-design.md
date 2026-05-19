---
title: 三项功能联合设计 — 策略最新运行时间 / 自选列表 CSV 导入 / 一键同步
date: 2026-05-19
status: draft
---

# 三项功能联合设计

本 spec 包含三项相互独立、可并行实施的小型功能。每项功能在文件层面互不相交，可分派给独立 agent 实现。

---

## 功能 1 — 策略条件管理「最新运行时间」列

### 1.1 目标

在策略条件列表中显示每条策略最近一次运行的时间，便于用户判断哪些策略长期未执行。

### 1.2 数据来源（无 migration）

- `strategy_conditions.lastRunId` → `strategy_condition_runs.id` 外键已存在
- `strategy_condition_runs` 表已有 `createdAt`（运行启动）、`completedAt`（运行完成）、`status`
- 列表 API 在查询时通过 `lastRunId` LEFT JOIN runs 表取出三列

### 1.3 后端改动

文件：`apps/server/src/strategy-conditions/strategy-conditions.service.ts`

- 列表查询（`list` / `findAll` 等返回多条 condition 的方法）增加 LEFT JOIN：
  ```ts
  qb.leftJoin('strategy_condition_runs', 'lr', 'lr.id = c.last_run_id')
    .addSelect(['lr.id', 'lr.status', 'lr.created_at', 'lr.completed_at']);
  ```
- 返回 DTO 新增字段：
  ```ts
  lastRun: {
    id: string;
    status: 'running' | 'success' | 'failed' | string;
    startedAt: string;       // UTC ISO 字符串（沿用 formatUTCDateTime）
    completedAt: string | null;
  } | null;
  ```
- 单条详情 endpoint 同步返回此字段（保持响应结构一致）
- **不**在 `strategy_conditions` 表上新增列，避免冗余与一致性维护成本

### 1.4 前端改动

文件：`apps/web/src/views/strategy/StrategyConditionsView.vue`

- 在「创建时间」列之前插入「最新运行时间」列：
  - 若 `lastRun` 为 `null` → 显示 `—`
  - 若 `lastRun.status === 'running'` → 显示 `<startedAt> · 运行中`（次要色，带脉冲点）
  - 若 `lastRun.completedAt` 存在 → 显示 `<completedAt>`（用 `formatUTCDateTime`）
- 列宽：120-160px，左对齐
- 不引入新的 store / 类型导入；扩展 `StrategyConditionListItem` 类型添加 `lastRun` 字段
- **保留**现有「状态」列（状态告诉「成功/失败/运行中」，时间告诉「什么时候」，二者互补）

### 1.5 验收

- 列表中新策略（从未运行过）显示 `—`
- 运行一条策略后立即刷新，时间列显示当前时间 + 「运行中」标记
- 运行完成后再次刷新，显示 `completedAt`
- 失败态（`status === 'failed'`）：若 `completedAt` 非空则显示 `completedAt`（红色 + 失败角标），否则回退到 `startedAt`
- 时间显示遵循项目 `formatUTCDateTime` 规范（UTC 墙钟字符串，不走 `toLocaleString`）

---

## 功能 2 — 自选列表 TAB 右键菜单「从 CSV 导入」

### 2.1 目标

允许用户通过 CSV 文件批量导入 A 股代码到指定 watchlist TAB，复用已有的 `upsert-by-name` 批量接口，零后端改动。

### 2.2 触发位置

文件：`apps/web/src/components/watchlist/WatchlistSidebar.vue`

在现有 `n-dropdown` 右键菜单中新增一项，插入到「从指数导入成员」之后、「删除」之前：

```ts
{ label: '从 CSV 导入…', key: 'import-csv' }
```

右键作用的 watchlist 即为导入目标（沿用现有 `重命名` / `删除` 的 target 解析逻辑）。

### 2.3 CSV 格式约定

- 编码：UTF-8（含/不含 BOM 均兼容）
- 列分隔符：英文逗号 `,`
- 必填列：`symbol`（如 `600519.SH`）
- 可选列：`name`（仅用于预览展示，不入库 — watchlist_items 表无 name 列）
- 首行允许为表头（自动识别：若首行第一格能匹配 `^\d{6}\.(SH|SZ|BJ)$` 则视为数据行，否则视为表头）
- 行尾兼容 CRLF / LF
- 字段允许引号包裹

### 2.4 解析与依赖

- 在 `apps/web` 引入 `papaparse@^5`（约 7KB gzip，浏览器友好）
- 解析在前端完成；后端无任何改动
- 添加 `papaparse` 类型：`@types/papaparse`

### 2.5 导入弹窗

新建组件：`apps/web/src/components/watchlist/WatchlistCsvImportModal.vue`

- 使用 `AppModal` 包裹（`#actions` slot 放确认/取消按钮）
- UI 区块：
  1. 文件选择按钮（隐藏 `<input type="file" accept=".csv,.txt">`）
  2. 文件信息（文件名、总行数）
  3. **校验摘要卡片**：合法 X 条 / 重复 Y 条 / 非法 Z 条 / 与现有重叠 W 条
  4. **预览表格**（`n-data-table` 紧凑模式，最多显示 100 行）：
     - 列：行号、symbol、name（如有）、状态（合法/重复/非法）
     - 非法行用红色背景、tooltip 显示原因
  5. **导入模式单选**：
     - `追加合并（默认）` — 调 `upsert-by-name` 的现有去重逻辑
     - `覆盖` — 先清空当前 watchlist 的 items，再批量插入
- 确认按钮在「合法行 > 0」且文件已加载时启用

### 2.6 校验规则

- A 股 symbol 软校验：`/^\d{6}\.(SH|SZ|BJ)$/i`，自动 toUpperCase
- 非法格式 → 标记为「非法」，**不阻塞**导入（允许用户继续，仅导入合法行）
- 行内重复（CSV 自身重复 symbol）→ 第二次出现起标记「重复」（保留第一次）
- 与现有 items 重叠 → 仅作提示，由后端 `upsert-by-name` 处理（追加模式下视为已存在跳过，覆盖模式下整体重建）

### 2.7 后端调用

**追加模式**：复用 `POST /watchlists/upsert-by-name`
```ts
{ name: <当前 watchlist.name>, symbols: <合法 symbol 列表> }
```
返回 `{ added, skipped }` → toast `已添加 X 个，跳过 Y 个`。

**覆盖模式**：复用 `PUT /watchlists/:id`
```ts
{ symbols: <合法 symbol 列表> }
```
该 endpoint 的 `updateWatchlist` 已实现全量替换语义（内部走 `setSymbols`），无需新增后端代码。

**Toast 文案**：根据后端返回的 `UpsertByNameResult` 区分两种情况：
- `created === false`（已有同名 watchlist）→ `已添加 X 个，跳过 Y 个`
- `created === true`（新建了 watchlist）→ `新建列表「<name>」并添加 X 个`（避免用户列表名拼错时无声创建新列表）

### 2.8 验收

- 导入合法 CSV 后 watchlist 中正确出现新 symbols
- 含 BOM、CRLF、引号包裹字段、表头/无表头四种文件均能正确解析
- 重复行/非法行在预览中明确标记，不计入导入数
- 「覆盖」模式正确清空旧 items
- 失败时 toast 显示原因，弹窗不被关闭以便用户重试

---

## 功能 3 — 数据同步「一键同步」（前端编排）

### 3.1 目标

在 `SyncView.vue` 顶部提供一个「一键同步」入口，让用户选一次日期范围、点一次按钮，依次完成 A 股 4 类核心数据集的同步，并提供清晰的进度可视化。

### 3.2 编排策略 — 方案 B+ 前端串行 + 适配层

不引入后端 orchestrator、不建 `sync_task` 表、不新增 endpoint。前端串行调用 4 个已有 sync composable，把它们各自的 SSE 状态聚合到一个总控视图。

**关键事实（已核实）**：4 个底层 composable 的对外接口**并非完全同构**：

| composable | 触发方法 | 完成信号 | syncMode 取值 |
|---|---|---|---|
| `useASharesSync` | `syncAShares()` | 内部 `syncSse.start` 的 `onDone` 回调；不暴露 `finished` ref | `'incremental' \| 'overwrite'` |
| `useMoneyFlowSync` | `confirmSync()` | 暴露 `finished` ref（`{ result }` 结构） | `'incremental' \| 'overwrite'` |
| `useThsIndexDailySync` | `confirmSync()` | 暴露 `finished` ref（`{ result }` 结构） | `'incremental' \| 'overwrite'` |
| `useOamvSync` | `confirmSync()` | 暴露 `finished` ref（`{ result }` 结构） | `'incremental' \| 'overwrite'` |

**因此 `useOneClickSync` 内部必须包一层适配器**（参见 §3.3.1），不要试图统一改 4 个 composable 的对外签名（影响面太大，破坏现有 SyncView.vue 调用方）。

**编排步骤（固定顺序）**：

| # | 步骤名 | 适配 composable | 失败影响 |
|---|---|---|---|
| 1 | A 股数据 | `useASharesSync` | 不阻塞 |
| 2 | 资金流向 | `useMoneyFlowSync` | 不阻塞 |
| 3 | 指数日线 ths_daily | `useThsIndexDailySync` | 不阻塞 |
| 4 | 活跃市值 0AMV | `useOamvSync` | 不阻塞 |

**syncMode 固定取 `'incremental'`**（4 个 composable 都没有 `'range'` mode；spec 早期措辞「强制 mode='range'」是错误的，应删除）。日期范围通过各 composable 的 `syncDateRange` ref 写入。

**失败语义**：单步骤失败 → 标记 `failed`，继续下一步，最终 summary 汇总所有 errors（与项目「数据集为空必须 warn」规范对齐）。

### 3.3 新增前端文件

#### 3.3.1 `apps/web/src/components/sync/useOneClickSync.ts`

封装编排逻辑的 composable，对外暴露：

```ts
interface OneClickStepState {
  step: 'a-shares' | 'money-flow' | 'ths-index-daily' | 'oamv';
  label: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  percent: number;           // 0-100
  phase: string;             // 当前子阶段（来自底层 SSE）
  message: string;           // 当前消息
  rowsWritten: number;       // 已写入行数（来自 finished.result.success 等字段）
  errors: unknown[];         // 收集的错误/warn 项
  startedAt: number | null;
  finishedAt: number | null;
}

export function useOneClickSync(message: MessageApi) {
  const dateRange = ref<[number, number] | null>(null);  // 本地午盘 ms（按 CLAUDE.md 日期选择器规范）
  const running = ref(false);
  const steps = ref<OneClickStepState[]>([...4 个初始 state]);
  const currentStepIndex = ref(-1);
  const totalPercent = computed(...);   // 已完成步骤 100% + 当前步骤 percent，再除以 4
  const elapsedMs = ref(0);
  const logEntries = ref<LogEntry[]>([]);   // 滚动日志
  const summary = ref<Summary | null>(null);  // 全部完成后填入

  async function start(): Promise<void>;     // 串行 await 4 步
  function cancel(): void;                   // 中止当前步骤（best-effort：仅中断当前 SSE，不回滚已写入数据）

  return { dateRange, running, steps, currentStepIndex, totalPercent, elapsedMs, logEntries, summary, start, cancel };
}
```

**编排实现要点**：

1. **实例化 4 个底层 composable**（注意第 1 个签名不同）：
   ```ts
   const noopReload = async () => {};
   const aSharesCtrl   = useASharesSync(message, noopReload);   // 注意：2 个参数
   const moneyFlowCtrl = useMoneyFlowSync(message);
   const thsIndexCtrl  = useThsIndexDailySync(message);
   const oamvCtrl      = useOamvSync(message);
   ```

2. **配置统一参数**：把 `dateRange.value` 赋给各 `syncDateRange.value`；把 `syncMode.value` 都置为 `'incremental'`。

3. **包装为统一 step runner**（适配层 — 这是修复 blocker A 的关键）：

   ```ts
   interface StepRunner {
     run: () => Promise<void>;          // 触发并 await 至完成或失败
     watch: () => void;                 // 安装对底层 SSE 状态的 watcher，更新 steps[i]
     unwatch: () => void;               // 卸载 watcher
   }
   ```

   - **A 股步骤（特殊）**：`useASharesSync` 不暴露 `finished` ref，通过 `syncSse` 的 `onDone` 回调完成。适配方案有两种，二选一在实现时确定：
     - **方案 1（推荐，零侵入）**：在 `useOneClickSync` 中用 `watch(aSharesCtrl.syncStatus, status => { if (status === 'done' || status === 'error') resolveStep1(...) })` 配合一个外层 `Promise` 实现"完成判定"。同时 watch `syncSse.message` 中的最终 summary 字符串作为 `rowsWritten` 的来源（或读取 `parseSyncResult` 暴露的数据 — 若不可达则只显示状态文本）。
     - **方案 2（轻度改造）**：在 `useASharesSync` 中增加一个可选的 `onFinished` 回调参数，`useOneClickSync` 传入解析后的回调。此方案需修改 `useASharesSync.ts` 第 87-89 行的 `onDone` 内部，向外暴露解析结果。
     - 默认采用方案 1。

   - **其它 3 个步骤（统一模式）**：调 `ctrl.confirmSync()`，然后 `await until(ctrl.finished.value !== null || ctrl.syncStatus.value === 'error')`。可用一个工具函数 `awaitFinished(ctrl)` 封装。

4. **SSE 状态 → step 状态映射**：
   ```ts
   watch([ctrl.syncPhase, ctrl.syncPercent, ctrl.syncStatus, ctrl.syncMessage], ([phase, pct, st, msg]) => {
     steps.value[i].phase = phase;
     steps.value[i].percent = pct;
     steps.value[i].status = st === 'running' ? 'running' : steps.value[i].status;
     steps.value[i].message = msg;
     pushLog({ step: stepKey, level: 'info', text: msg });
   });
   ```

5. **errors / warn 收集**：watch `ctrl.finished?.result?.errors`（其它 3 个步骤）或 A 股的 `parseSyncResult` 结果中 errors 字段；任一 `errors.length > 0` 时把它们逐条 `pushLog({ level: 'warn', ... })`，并加入 `steps[i].errors`。

6. **每一步用 `try/catch`**，失败 → `steps[i].status = 'failed'`、清理 watcher、继续 `i+1`。

7. **全部完成** → `summary = { steps: [...], totalMs, errors: [...] }`。

**日期参数处理（CLAUDE.md 规范）**：
- `n-date-picker` 取值用 `getFullYear/getMonth/getDate` 转 `YYYYMMDD`（本地日历日）
- 不用 `getUTC*`，避免 CST 用户漂前 1 天的 Bug

#### 3.3.2 `apps/web/src/components/sync/OneClickSyncPanel.vue`

可视化面板组件。结构：

```
┌────────────────────────────────────────────────────────────┐
│ 🚀 一键同步 A 股数据                                          │
│ 日期范围  [n-date-picker]            [开始同步 / 取消]        │
├────────────────────────────────────────────────────────────┤
│ 总进度  ████████░░░░  53%   2/4 步骤   耗时 01:23            │
├────────────────────────────────────────────────────────────┤
│ ✅ ① A 股数据         100%  写入 1234 行                     │
│ ⏳ ② 资金流向          47%  正在同步 2026-05-14 ...           │
│ ⚪ ③ 指数日线          —                                    │
│ ⚪ ④ 活跃市值 0AMV     —                                    │
├────────────────────────────────────────────────────────────┤
│ 📋 实时日志  [展开/折叠]                                      │
│  10:23:01  [a-shares] daily 2026-05-12 写入 5515 行          │
│  10:23:08  [a-shares] adj_factor 2026-05-12 写入 ...         │
│  10:23:15  ⚠ [money-flow] daily_empty 2026-05-14 当日数据未发布 │
└────────────────────────────────────────────────────────────┘
```

**视觉规范**：
- 步骤行图标映射：`pending → ⚪ / running → ⏳（带 spinner）/ success → ✅ / failed → ❌ / skipped → ⊘`
- 步骤行进度条：`n-progress type="line"`，紧凑高度（4px）
- 总进度条：高度 8px，颜色取项目主题色
- 实时日志区：等宽字体、按步骤前缀着色、最新行自动滚动到底部、可手动暂停滚动；保留最近 500 行
- 结束态：summary 卡片（4 行 ✅/❌ 计数 + errors 列表展开 + 总耗时 + 「重试失败步骤」按钮 — 重试仅重跑 failed 的步骤）

**响应式**：在窄屏（< 960px）折叠为单列，进度条铺满。

### 3.4 SyncView.vue 集成

在 `<div class="sync-grid">` 之前（页面顶部）插入：

```vue
<n-card class="one-click-card" title="一键同步" :bordered="false">
  <OneClickSyncPanel />
</n-card>
```

- 不影响下方 6 张原始数据源卡片（用户仍可单独同步任何一项）
- 一键同步运行期间，下方 4 张被卡片（A股 / 资金流向 / 指数日线 / 0AMV）的「开始同步」按钮自动 disabled（避免重复触发）
  - 实现：`OneClickSyncPanel` 通过 `provide('oneClickRunning', running)`，下方卡片 `inject` 并叠加到自身的 `disabled` 条件

### 3.5 错误与边界

- 用户未选日期 → 「开始同步」按钮 disabled
- 日期范围展开后无开盘交易日（如选了周末） → 立即弹消息「所选范围无交易日」，不发起任何同步
- 一键同步运行中关闭页面 → 进度丢失，已发起的后端 SSE 仍可能继续执行（与现有单项同步行为一致）
- 中途「取消」→ 中断当前底层 SSE 的 EventSource、把当前步骤标 `failed`、后续步骤标 `skipped`、跳到 summary

### 3.6 不做的事（YAGNI）

- 不新增后端 endpoint
- 不建 `sync_task` 表
- 不实现历史任务列表
- 不实现「失败后从断点继续」（重试按钮重跑整个失败步骤，不做粒度更细的恢复）
- 不并行 4 个步骤（避免 Tushare QPS 冲突与数据库写锁竞争）

### 3.7 验收

- 选一段含交易日的日期范围 → 点开始 → 看到 4 步骤依次推进、总进度从 0 走到 100
- 任意一步失败 → 该步骤标红、后续步骤照常执行、summary 显示完整 errors
- 中途取消 → 当前步骤停止、summary 出现
- 一键同步运行期间，下方 4 张相关卡片的开始按钮被禁用
- 选择「2026-05-16 ~ 2026-05-16」（周六）→ 提示「无交易日」，不发起请求
- 日期参数与 CLAUDE.md 日历日规范一致（CST 用户不漂日）

---

## 跨功能 — 文件分工与并行可行性

三项功能在文件层面互不相交，可分派给独立 agent 并行实现：

| 功能 | 后端文件 | 前端文件 |
|---|---|---|
| 1. 最新运行时间 | `apps/server/src/strategy-conditions/strategy-conditions.service.ts`（+ DTO） | `apps/web/src/views/strategy/StrategyConditionsView.vue`（+ 相关 type 文件） |
| 2. CSV 导入 | 无（仅复用既有接口） | `apps/web/src/components/watchlist/WatchlistSidebar.vue` + 新建 `WatchlistCsvImportModal.vue` + `apps/web/package.json`（papaparse） |
| 3. 一键同步 | 无 | `apps/web/src/views/sync/SyncView.vue` + 新建 `useOneClickSync.ts` + `OneClickSyncPanel.vue`（+ 局部 styles） |

唯一可能产生冲突的是 `apps/web/package.json`（功能 2 加 papaparse 依赖） — 功能 3 不动这个文件，无冲突。

---

## 验收清单总览

- [ ] 功能 1：策略列表展示「最新运行时间」列，三种状态正确显示
- [ ] 功能 2：右键 TAB → 「从 CSV 导入…」→ 弹窗校验 → 导入成功 + toast
- [ ] 功能 3：一键同步面板 4 步骤串行执行、进度可视化、失败不阻塞、取消可用
- [ ] 所有时间显示走 `formatUTCDateTime`，日期选择器走本地日历日规范
- [ ] 无新建数据库迁移，无新建后端 endpoint
