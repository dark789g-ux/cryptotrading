# 凯利公式动态仓位管理 SPEC（含模拟期、探针模式与滑动窗口）

> 面向 AI 编程助手。最后更新：2026-04-25

## 1. 概述

将 **凯利公式（Kelly Criterion）** 引入回测引擎，实现基于滑动窗口统计的动态仓位管理。引擎运行期存在三种互斥阶段，统一由三元字段 `TradePhase` 标识：

- **模拟期（`simulation`）**：前 N 笔完整交易作为纯观察期，单独维护影子持仓与影子记录，不影响实际净值与现金。
- **探针期（`probe`）**：实盘期内当凯利系数 ≤ 0 且空仓时，自动启用虚拟交易持续采样，以推动滑动窗口更新、打破死锁。
- **实盘期（`live`）**：正常交易阶段，基于模拟期+探针期+实盘期的滑动窗口统计胜率 `p` 与收益率赔率 `b`，动态计算每笔交易的最优仓位比例。

## 2. 背景与上下文

- **相关文件**
  - `apps/web/src/composables/backtest/useStrategyForm.ts` — 前端参数模型
  - `apps/web/src/components/backtest/strategy/StrategyCapitalSection.vue` — 资金与仓位配置 UI
  - `apps/server/src/backtest/engine/models.ts` — 后端配置接口与数据模型
  - `apps/server/src/backtest/engine/engine.ts` — 回测引擎主循环
  - `apps/server/src/backtest/engine/steps/engine.pending-execution.ts` — 挂单执行与仓位计算
  - `apps/server/src/backtest/engine/steps/engine.position-processing.ts` — 持仓处理与交易记录生成
  - `apps/server/src/backtest/engine/position-handler.ts` — 止损/止盈/平仓逻辑
  - `apps/server/src/backtest/engine/cooldown.ts` — 冷却期管理
  - `apps/server/src/backtest/engine/signal-scanner.ts` — 信号扫描（产出 `rrRatio`）
- **数据库表**：`strategies`（参数以 JSON 存储于 `params` 字段）、`backtest_trades`（`trade_phase` 字段）
- **依赖服务**：无

## 3. 功能需求

### 3.1 交易阶段三元状态

回测引擎中的每一笔交易、每一条 candleLog 记录，必须携带一个三元字段标识其所属阶段：

```ts
type TradePhase = 'simulation' | 'probe' | 'live'
```


| 阶段           | 触发条件                                                                               | 资金系统                          | 交易记入        | 统计影响                   |
| ------------ | ---------------------------------------------------------------------------------- | ----------------------------- | ----------- | ---------------------- |
| `simulation` | `completedTradeCount < kellySimTrades`                                             | `simCash` / `simPositions`    | `simTrades` | 参与凯利窗口更新，**不**计入报告核心指标 |
| `probe`      | `completedTradeCount ≥ kellySimTrades` 且 `kellyRaw ≤ 0` 且 `positions.length === 0` | 复用 `simCash` / `simPositions` | `simTrades` | 参与凯利窗口更新，**完全隔离**于报告统计 |
| `live`       | 其他情况                                                                               | `cash` / `positions`          | `allTrades` | 正常参与全部统计               |


> **数据库存储**：`backtest_trades` 表使用 `trade_phase VARCHAR(20)` 单字段存储，而非布尔组合。

### 3.2 模拟期（Simulation Phase）

- **模拟期笔数**：`kellySimTrades`，默认 `50`，范围 `0 ~ 500`。前 `kellySimTrades` 笔**完整平仓交易**属于模拟期。
- **完整平仓交易的定义**：一个 `Position` 从创建到 `shares <= 0`（完整平仓，非半仓）视为一笔完整交易。阶段止盈产生的半仓卖出**不计为**完整交易，仅当剩余仓位也全部平仓时才整体计入一笔。
- **模拟期独立维护影子状态**：
  - `simPositions`：影子持仓数组，与 `positions` 完全隔离
  - `simTrades`：影子交易记录数组，与 `allTrades` 完全隔离
  - `simPortfolioLog`：影子净值记录数组，与 `portfolioLog` 完全隔离
- **模拟期现金与净值完全冻结**：模拟期内的虚拟交易无论盈亏，`cash` 不变，`portfolioLog` 不记录波动。模拟期结束后，按**模拟期结束时收盘价**强制平掉所有虚拟持仓，盈亏**不计入**实际现金。
- **模拟期不走冷却逻辑**：`registerExit` 在模拟期不被调用，`CooldownState` 保持初始值不变。
- **模拟期交易计入后续统计窗口**：`simTrades` 作为历史样本，在后续的滑动窗口统计中继续被使用，直到被新交易挤出窗口。

### 3.3 探针模式（Probe Phase）

探针模式用于解决「凯利系数 ≤ 0 且空仓时陷入永久死锁」的问题：没有新交易就无法更新窗口，窗口不更新就无法恢复开仓。

#### 3.3.1 触发条件（同时满足）

1. `enableKellySizing = true`
2. `enableKellyProbe = true`
3. 已完成模拟期：`completedTradeCount ≥ kellySimTrades`
4. 凯利系数非正：`kellyRaw ≤ 0`
5. 实盘空仓：`positions.length === 0`

#### 3.3.2 退出条件

每根 K 线处理完持仓后，重新计算 `kellyRaw`：

- **若 `kellyRaw > 0`**：下一根 K 线自动退出 Probe 模式，恢复 `live` 阶段。
- **退出时若 `simPositions` 仍有持仓**：以当前收盘价**强制清仓**，生成 exit 记录（`tradePhase: 'probe'`，原因标注 `"探针模式结束强平"`）。

#### 3.3.3 交易逻辑一致性

Probe 模式下的交易行为与实盘完全一致，仅差异点如下：


| 维度           | Probe 行为                                        |
| ------------ | ----------------------------------------------- |
| 信号扫描         | 共用 `scanSignals`，MA/KDJ/rrRatio 等过滤条件不变         |
| 持仓处理         | 共用 `processPositions`，止损止盈、MA5 调整等逻辑不变          |
| 持仓上限         | `effectiveMaxPos = 1`，有持仓时不开新虚拟仓                |
| **Cooldown** | **不走**账户级冷却逻辑（虚拟亏损不冻结实盘）                        |
| 仓位大小         | 复用 `positionRatio`，与实盘单仓比例一致                    |
| 资金影响         | 使用 `simCash`，**不影响**实盘的 `cash` 与 `portfolioLog` |


#### 3.3.4 窗口更新机制

Probe 交易的盈亏正常进入 `simTrades`，并通过 `updateKellyStats(simTrades, allTrades, kellyWindowTrades)` 参与滑动窗口计算。这是 Probe 模式存在的唯一目的：**用极低成本持续采样，以新交易推动旧亏损交易滑出窗口，使凯利系数恢复正值**。

### 3.4 实盘期（Live Phase）

- 从第 `kellySimTrades + 1` 笔完整平仓交易开始，默认进入实盘期。
- 使用正常的 `positions`、`allTrades`、`portfolioLog`、`cash`。
- 初始现金 = 回测配置的 `initialCapital`，不受模拟期与探针期任何影响。
- 正常走冷却逻辑（`registerExit`、`isInCooldown`）。

### 3.5 凯利参数配置


| 参数名                     | 类型        | 默认值     | 取值范围             | 业务含义                                             |
| ----------------------- | --------- | ------- | ---------------- | ------------------------------------------------ |
| `enableKellySizing`     | `boolean` | `false` | `true` / `false` | 是否启用凯利公式动态仓位                                     |
| `kellySimTrades`        | `number`  | `50`    | `0 ~ 500`        | 模拟期完整交易笔数，仅用于统计不产生净值变化                           |
| `kellyWindowTrades`     | `number`  | `50`    | `1 ~ 500`        | 滑动窗口大小（笔数），统计最近 N 笔完整交易计算 b/p                    |
| `kellyStepTrades`       | `number`  | `1`     | `1 ~ 100`        | 统计更新步长（笔数），每完成 N 笔完整交易后重新计算 b/p。步长为 1 表示每笔交易后都更新 |
| `kellyMaxPositionRatio` | `number`  | `0.50`  | `0.01 ~ 1`       | 凯利计算结果的硬上限                                       |
| `kellyFraction`         | `number`  | `0.50`  | `0.10 ~ 1`       | 凯利分数，半凯利 = 0.5                                   |
| `enableKellyProbe`      | `boolean` | `true`  | `true` / `false` | 凯利系数 ≤ 0 且空仓时，是否启用虚拟探针交易以推动窗口更新                  |


> `positionRatio` 在凯利模式下同时承担两个角色：
>
> - 关闭凯利时：固定仓位比例（现有行为）
> - 开启凯利时：与 `kellyMaxPositionRatio` 取较小值，作为最终仓位的硬封顶；探针模式下直接复用该值作为虚拟仓位比例
>
> **凯利模式下的持仓限制**：`enableKellySizing = true` 时，`maxPositions` 强制视为 `1`，即**最多同时持有 1 个仓位**。凯利公式基于"单笔交易占总资产的最优比例"设计，多持仓会分散现金、扭曲比例，因此限制为单仓位策略。半仓状态（`halfSold = true`）也属于一个持仓，不可在开新仓。

### 3.6 滑动窗口统计

每笔完整平仓交易完成后，若满足步长条件（`completedTradeCount % kellyStepTrades === 0`），更新 b/p：

**样本来源**：从 `simTrades` 尾部 + `allTrades` 中筛选完整平仓交易，取最近 `min(kellyWindowTrades, totalCompletedTrades)` 笔作为统计样本。

**胜率 `p`**：

```
p = 盈利交易笔数 / 样本总笔数
盈利判定：交易整体 pnl > 0
```

**收益率赔率 `b`**：

```
avgWin = 盈利交易的 overallReturnPct 的算术平均
avgLoss = |亏损交易的 overallReturnPct 的算术平均|
b = avgWin / avgLoss   （若 avgLoss <= 0，则 b = 0）
```

> `overallReturnPct` 定义：一个 Position 完整平仓时，`sum(该 Position 所有 TradeRecord.pnl) / pos.allocated * 100`。在生成最后一笔平仓的 `TradeRecord` 时，同步计算并写入 `TradeRecord.overallReturnPct`。

**边界处理**：

- 样本中无亏损交易：若存在盈利交易，`b = +Infinity`（实际实现取一个极大值如 `999`）；若无盈利交易，`b = 0`
- 样本中无盈利交易：`b = 0`，`p = 0`
- 样本不足窗口大小时：用全部已有样本计算

### 3.7 动态仓位计算

实盘期每次执行挂单时：

```ts
let positionRatio = config.positionRatio;

if (config.enableKellySizing && completedTradeCount >= config.kellySimTrades) {
  const b = currentWindowOdds;      // 当前滑动窗口赔率
  const p = currentWindowWinRate;   // 当前滑动窗口胜率
  const q = 1 - p;

  let kellyRaw = 0;
  if (b > 0 && p > 0) {
    kellyRaw = (b * p - q) / b;
  }
  const kellyAdjusted = Math.max(0, kellyRaw * config.kellyFraction);
  positionRatio = Math.min(kellyAdjusted, config.kellyMaxPositionRatio, config.positionRatio);
}

const positionSize = lastNav * positionRatio;
```

- 若 `kellyRaw <= 0` 且**有实盘持仓**：该信号**不入场**（`positionSize = 0`，跳过挂单），已有持仓不受影响。
- 若 `kellyRaw <= 0` 且**实盘空仓**：且 `enableKellyProbe = true`，则进入 **Probe 模式**，使用 `positionRatio` 执行虚拟交易。
- 模拟期内固定使用 `config.positionRatio`（或用户关闭凯利时的固定逻辑）。

### 3.8 统计隔离规则

报告层（`prepareReportData`）在生成最终统计数据时，必须严格区分 `tradePhase`：


| 统计项                                      | 包含 `simulation` | 包含 `probe` | 包含 `live`                          |
| ---------------------------------------- | --------------- | ---------- | ---------------------------------- |
| `totalReturnPct` / `finalValue`          | ❌               | ❌          | ✅ 仅基于 `portfolioLog`               |
| `sharpeAnnualized` / `maxDrawdownPct`    | ❌               | ❌          | ✅ 仅基于实盘权益曲线                        |
| `winRate` / `avgReturn` / `profitFactor` | ❌               | ❌          | ✅ 仅统计 `allTrades`                  |
| `fullTradeCount` / `halfTradeCount`      | ❌               | ❌          | ✅ 仅统计 `allTrades`                  |
| `monthly` 月度收益                           | ❌               | ❌          | ✅ 仅基于 `live` 交易                    |
| `symbols` 标的统计                           | ❌               | ❌          | ✅ 仅基于 `live` 交易                    |
| **凯利窗口统计**（`updateKellyStats`）           | ✅               | ✅          | ✅ `simTrades` 与 `allTrades` 合并后取窗口 |
| **回测明细表格展示**                             | ✅ 显示            | ✅ 显示（带标签）  | ✅ 显示                               |


### 3.9 每笔交易的统计展示

每笔完整平仓交易（包括模拟期与探针期）的 `TradeRecord` 需额外记录以下字段，供前端交易列表展示：


| 字段                  | 类型                                | 含义                            |
| ------------------- | --------------------------------- | ----------------------------- |
| `tradePhase`        | `'simulation' | 'probe' | 'live'` | 交易所属阶段                        |
| `overallReturnPct`  | `number`                          | 该笔交易整体收益率（%）                  |
| `cumulativeWinRate` | `number`                          | 从开始回测到本次交易时的累计胜率 p（包含模拟期与探针期） |
| `cumulativeOdds`    | `number`                          | 从开始回测到本次交易时的累计赔率 b（包含模拟期与探针期） |
| `windowWinRate`     | `number`                          | 当前滑动窗口内的胜率 p                  |
| `windowOdds`        | `number`                          | 当前滑动窗口内的赔率 b                  |


> 累计统计口径：用从开始到当前的所有完整交易（含模拟期与探针期）计算，不限制窗口大小。

**K 线记录状态区分**：

- `CandleEntryEvent` / `CandleExitEvent` 携带 `tradePhase` 字段
- 前端 K 线图表中，不同阶段的入场/出场标记用不同颜色/透明度区分。

## 4. 明确不做的事

- **不做多标的联合凯利**：每个标的独立计算仓位，不做组合层面的相关性调整。
- **不做做空/双向凯利**：当前策略仅做多，`b` 直接取正值；做空场景需重新定义赔率。
- **不做拉普拉斯修正或 Thorp 扩展**：采用标准凯利公式。
- **不做步长大于窗口的滑动逻辑**：若用户配置 `kellyStepTrades > kellyWindowTrades`，校验时拦截或自动取 `min(step, window)`。
- **不做模拟期浮盈浮亏的实时记录**：模拟期 `simPortfolioLog` 仅记录每根 K 线的 `closeEquity`（基于虚拟持仓的收盘价估值），不记录 `openEquity`，不追求与实盘完全一致的事件粒度。
- **不做探针模式的独立净值曲线**：Probe 交易的虚拟权益不单独绘制收益曲线，仅作为明细表格中的标记行存在。

## 5. 技术方案

### 5.1 后端数据模型扩展

#### `TradeRecord`

```ts
export interface TradeRecord {
  // ... 现有字段 ...
  tradePhase: 'simulation' | 'probe' | 'live';
  overallReturnPct: number;
  cumulativeWinRate: number;
  cumulativeOdds: number;
  windowWinRate: number;
  windowOdds: number;
}
```

> 历史兼容性说明：原 `isSimulation: boolean` 字段由 `tradePhase` 替代。`tradePhase === 'simulation'` 等价于原 `isSimulation = true`。

#### `CandleEntryEvent` / `CandleExitEvent`

```ts
export interface CandleEntryEvent {
  // ... 现有字段 ...
  tradePhase: 'simulation' | 'probe' | 'live';
}

export interface CandleExitEvent {
  // ... 现有字段 ...
  tradePhase: 'simulation' | 'probe' | 'live';
}
```

#### `BacktestConfig`

```ts
export interface BacktestConfig {
  // ... 现有字段 ...
  enableKellySizing: boolean;
  kellySimTrades: number;
  kellyWindowTrades: number;
  kellyStepTrades: number;
  kellyMaxPositionRatio: number;
  kellyFraction: number;
  enableKellyProbe: boolean;  // 新增
}
```

#### `BacktestResult`

```ts
export interface BacktestResult {
  trades: TradeRecord[];
  simTrades: TradeRecord[];        // 模拟期 + 探针期交易记录
  portfolioLog: [string, number][];
  simPortfolioLog: [string, number][];  // 模拟期净值记录（探针期权益不单独记录）
  posSnapshots: Array<Array<{ ... }>>;
  candleLog: CandleLogEntry[];
}
```

### 5.2 后端 — 引擎主循环改造

`engine.ts` 的 `runBacktest` 中新增/调整状态：

```ts
let simPositions: Position[] = [];
let simTrades: TradeRecord[] = [];
let simPortfolioLog: [string, number][] = [];
let simCash = config.initialCapital;
let completedTradeCount = 0;
let currentWindowWinRate = 0;
let currentWindowOdds = 0;
```

主循环每次处理完 `processPositions` 后，检查是否有**完整平仓**的 Position：

- 若 `completedTradeCount < config.kellySimTrades`：
  - 将该 Position 的所有相关 `TradeRecord` 从 `allTrades` 移入 `simTrades`
  - 将该 Position 从 `positions` 移入 `simPositions`（或直接丢弃，仅保留交易记录）
  - 不调用 `registerExit`
  - `cash` 不变（不回流该 Position 的资金）
- 若 `completedTradeCount === config.kellySimTrades`（模拟期结束临界点）：
  - 按当前收盘价强制平掉 `simPositions` 中所有剩余虚拟持仓
  - 盈亏不计入 `cash`
  - 生成平仓记录写入 `simTrades`，标记 `tradePhase: 'simulation'`
- 若 `completedTradeCount >= config.kellySimTrades`：
  - 正常处理，`cash` 回流，调用 `registerExit`
  - 交易记录写入 `allTrades`，标记 `tradePhase: 'live'`

**探针模式的状态切换**：

```ts
const isSimPhase = config.enableKellySizing && completedTradeCount < config.kellySimTrades;
const kellyRaw = calcKellyRaw(currentWindowOdds, currentWindowWinRate, config.kellyFraction);
const isProbeMode = config.enableKellySizing && config.enableKellyProbe
  && !isSimPhase
  && kellyRaw <= 0
  && positions.length === 0;
```

每根 K 线处理完持仓后重新计算 `kellyRaw`：

- `kellyRaw > 0` 时，下一根 K 线退出 Probe 模式。若 `simPositions` 仍有持仓，以当前收盘价强制清仓，标记 `tradePhase: 'probe'`，原因 `"探针模式结束强平"`。

**凯利模式下的开新仓限制**：

在判断 `allowNew` 时，凯利模式下 `maxPositions` 强制视为 `1`：

```ts
const effectiveMaxPos = config.enableKellySizing ? 1 : config.maxPositions;
const allowNew = nPos < effectiveMaxPos;
```

- 凯利模式下，只要已有 1 个持仓（无论是否半仓），`allowNew = false`，不再扫描新信号。
- 原 `allHalf` 逻辑在凯利模式下不适用，直接移除。

**完整交易计数与统计更新**：

每次检测到完整平仓时 `completedTradeCount++`。若满足 `completedTradeCount % config.kellyStepTrades === 0`，调用 `updateKellyStats()`：

```ts
function updateKellyStats(
  simTrades: TradeRecord[],
  allTrades: TradeRecord[],
  windowSize: number,
): { p: number; b: number; cumP: number; cumB: number } {
  // 合并模拟期+探针期+实盘期的完整交易，按时间排序
  const allCompleted = [...simTrades, ...allTrades].filter(t => !t.isHalf);
  // 取最近 windowSize 笔作为窗口样本
  const windowSamples = allCompleted.slice(-windowSize);
  // 计算窗口内 b/p
  // 计算累计 b/p（全部样本）
  // 返回并同步写入每笔未写入统计的 TradeRecord
}
```

### 5.3 后端 — `engine.pending-execution.ts`

在计算 `positionSize` 前，判断当前阶段：

```ts
const isSimPhase = completedTradeCount < config.kellySimTrades;
let positionRatio = config.positionRatio;

if (!isSimPhase && config.enableKellySizing) {
  const b = currentWindowOdds;
  const p = currentWindowWinRate;
  // ... 凯利公式计算 ...
  const kellyAdjusted = Math.max(0, kellyRaw * config.kellyFraction);
  positionRatio = Math.min(kellyAdjusted, config.kellyMaxPositionRatio, config.positionRatio);
}

const positionSize = lastNav * positionRatio;
```

- 若 `positionRatio <= 0` 且**空仓**且 `enableKellyProbe = true`：进入 Probe 模式，使用 `simPositions` 执行虚拟交易，仓位比例复用 `config.positionRatio`。
- 模拟期内的挂单执行复用现有逻辑，`positionRatio` 不受凯利公式影响。

### 5.4 后端 — `position-handler.ts`

在 `processCandle` 和 `processEntryCandle` 返回完整平仓（`action === 'exit_full'`）时，触发完整交易计数。具体实现上，由引擎主循环统一判断：若某 Position 在本次 K 线处理后从 `positions` 数组中移除且非半仓，则计为一笔完整交易。

### 5.5 后端 — 校验规则

在 `validateConfig` 中新增：

- `kellySimTrades`：`0 ~ 500` 的整数
- `kellyWindowTrades`：`1 ~ 500` 的整数
- `kellyStepTrades`：`1 ~ 100` 的整数，且必须 `<= kellyWindowTrades`
- `kellyMaxPositionRatio`：`(0, 1]`
- `kellyFraction`：`(0, 1]`
- 仅在 `enableKellySizing = true` 时校验以上 5 项
- `enableKellyProbe`：`boolean`，仅在 `enableKellySizing = true` 时生效

### 5.6 前端

#### `useStrategyForm.ts`

`StrategyParams` 与 `defaultParams` 同步新增 `enableKellyProbe` 字段（默认 `true`）。

#### `StrategyCapitalSection.vue`

在现有凯利公式折叠面板内新增：

- `enableKellyProbe`：`n-switch`「凯利系数 ≤ 0 且空仓时启用探针交易」

#### 交易列表展示

回测详情页的交易列表表格：

- 新增列 `tradePhase`，用标签区分（模拟 / 探针 / 实盘）
- 提供三元筛选控件（全部 / 只看实盘 / 只看探针 / 只看模拟）
- 默认展示全部三种阶段的交易
- `overallReturnPct`、`cumulativeWinRate` / `cumulativeOdds`、`windowWinRate` / `windowOdds` 保持展示

#### 收益曲线图

仅绘制实盘 `portfolioLog`，不绘制 `simPortfolioLog` 或探针虚拟权益。

## 6. 验收标准

- 关闭凯利开关时，回测行为与现有版本完全一致。
- 凯利开启且 `kellySimTrades = 50` 时，前 50 笔完整交易为模拟期：`cash` 不变、`portfolioLog` 不受模拟持仓波动影响、`CooldownState` 不被更新。
- 第 50 笔完整交易完成后，模拟期结束，剩余虚拟持仓按收盘价强平，盈亏不计入 `cash`。
- 第 51 笔起进入实盘期，`cash` 正常回流，冷却逻辑正常运作。
- 当 `kellyRaw <= 0` 且实盘空仓时，若 `enableKellyProbe = true`，自动进入 Probe 模式，使用 `simPositions` 执行虚拟交易。
- Probe 交易正常参与 `updateKellyStats` 滑动窗口计算，但**不**影响 `portfolioLog`、`allTrades` 与报告核心指标。
- `kellyRaw > 0` 时，Probe 模式自动退出；若仍有探针持仓，按当前价强制平仓，标记 `tradePhase: 'probe'`。
- `kellyStepTrades = 1` 时，每笔完整交易后 `currentWindowWinRate` / `currentWindowOdds` 均被更新。
- 滑动窗口统计样本正确包含模拟期与探针期交易（直到被挤出窗口）。
- `TradeRecord` 中 `tradePhase`、`overallReturnPct`、累计与窗口统计字段均正确填充。
- `CandleEntryEvent` / `CandleExitEvent` 的 `tradePhase` 字段正确标记。
- 高盈亏比信号的实际仓位 ≥ 低盈亏比信号的实际仓位（同一次回测中可观测）。
- 凯利开启时，无论 `maxPositions` 配置为多少，回测过程中同时持仓数始终不超过 1。
- 前端交易列表正确展示三阶段区分、筛选控件与统计列。
- 前后端类型检查无新增报错。

