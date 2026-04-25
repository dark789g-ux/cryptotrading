# 策略参数配置 SPEC

> 面向 AI 编程助手。最后更新：2026-04-25

## 1. 概述

本 SPEC 汇总前端 `StrategyModal` 中**全部可提前配置的参数**，作为策略创建/编辑时的配置项完整清单。参数定义以前端代码为准，仅包含已在 UI 中暴露给用户编辑的字段。

## 2. 背景与上下文

- **相关文件**
  - `apps/web/src/composables/backtest/useStrategyForm.ts` — 参数模型与默认值定义
  - `apps/web/src/components/backtest/StrategyModal.vue` — 策略编辑弹窗主容器
  - `apps/web/src/components/backtest/strategy/StrategyCapitalSection.vue` — 资金与仓位
  - `apps/web/src/components/backtest/strategy/StrategyConfigSection.vue` — 基础配置
  - `apps/web/src/components/backtest/strategy/EntrySignalSection.vue` — 入场信号
  - `apps/web/src/components/backtest/strategy/StrategyStopExitSection.vue` — 止损与出场
  - `apps/web/src/components/backtest/strategy/ExitManagementSection.vue` — 阶段止盈子组件
  - `apps/web/src/components/backtest/strategy/CooldownParamsSection.vue` — 冷却期参数
  - `apps/server/src/backtest/engine/signal-scanner.ts` — 信号扫描与排序逻辑
- **数据库表**：`strategies`（参数以 JSON 存储于 `params` 字段）
- **依赖服务**：无

## 3. 参数清单

参数按前端 UI 的 **6 个 Tab** 分组。

### 3.1 基础信息（basics）

| 参数名 | 类型 | 默认值 | 取值范围 / 选项 | 业务含义 |
|--------|------|--------|----------------|----------|
| `name` | `string` | `''` | 任意，留空自动生成 | 策略名称 |
| `typeId` | `string` | `'ma_kdj'` | 后端返回的策略类型列表 | 策略类型 |
| `timeframe` | `string` | `'1h'` | `1h` / `4h` / `1d` | K 线时间周期 |
| `symbols` | `string[]` | `[]` | 多选标的池 | 回测标的列表 |

### 3.2 资金与仓位（capital）

| 参数名 | 类型 | 默认值 | 取值范围 | 业务含义 |
|--------|------|--------|---------|----------|
| `initialCapital` | `number` | `1000000` | `≥ 1000` | 初始资金 |
| `positionRatio` | `number` | `0.4` | `0.01 ~ 1`（步进 `0.0001`） | 单仓资金占比 |
| `maxPositions` | `number` | `2` | `1 ~ 20` | 最大同时持仓数 |
| `requireAllPositionsProfitable` | `boolean` | `false` | `true` / `false` | 仅当所有持仓止损已上移至成本之上才开新仓 |

#### 3.2.1 凯利公式参数

| 参数名 | 类型 | 默认值 | 取值范围 | 业务含义 |
|--------|------|--------|---------|----------|
| `enableKellySizing` | `boolean` | `false` | `true` / `false` | 启用凯利公式动态仓位管理 |
| `kellySimTrades` | `number` | `50` | `0 ~ 500` | 模拟期笔数：完成多少笔完整交易后进入实盘期 |
| `kellyWindowTrades` | `number` | `50` | `1 ~ 500` | 滑动窗口大小：计算胜率与赔率时考察的最近 N 笔交易 |
| `kellyStepTrades` | `number` | `1` | `1 ~ 100` | 统计更新步长：每完成 N 笔交易更新一次窗口统计 |
| `kellyFraction` | `number` | `0.50` | `0.10 ~ 1`（步进 `0.01`） | 凯利分数缩放：对原始凯利系数乘以该值进行保守修正 |
| `kellyMaxPositionRatio` | `number` | `0.50` | `0.01 ~ 1`（步进 `0.0001`） | 凯利仓位硬上限：即使凯利系数很高，单仓占比也不得超过该值 |

> **运行时行为**：`enableKellySizing = true` 时，`effectiveMaxPos` 强制为 `1`，与 `maxPositions` 无关。

#### 3.2.2 探针模式（Probe）参数

| 参数名 | 类型 | 默认值 | 取值范围 | 业务含义 |
|--------|------|--------|---------|----------|
| `enableKellyProbe` | `boolean` | `true` | `true` / `false` | 凯利系数 ≤ 0 且空仓时，是否启用虚拟探针交易以推动窗口更新 |

### 3.3 基础配置（config）

| 参数名 | 类型 | 默认值 | 取值范围 | 业务含义 |
|--------|------|--------|---------|----------|
| `recentLowWindow` | `number` | `9` | `1 ~ 200` | 向前取最近 N 根 K 线最低价作为阶段低点候选 |
| `recentLowBuffer` | `number` | `5` | `0 ~ 500` | 窗口外继续向前追溯最多 Y 根 K 线找更低点 |
| `recentHighWindow` | `number` | `9` | `1 ~ 50` | 向前取最近 N 根 K 线最高价作为阶段高点候选 |
| `recentHighBuffer` | `number` | `5` | `0 ~ 500` | 窗口外继续向前追溯找更高连续高点 |

### 3.4 入场信号（entry）

#### 3.4.1 KDJ 参数

| 参数名 | 类型 | 默认值 | 取值范围 | 业务含义 |
|--------|------|--------|---------|----------|
| `kdjN` | `number` | `9` | `1 ~ 99` | KDJ 周期 N |
| `kdjM1` | `number` | `3` | `1 ~ 99` | KDJ 平滑周期 M1 |
| `kdjM2` | `number` | `3` | `1 ~ 99` | KDJ 平滑周期 M2 |
| `kdjJOversold` | `number` | `0` | `-200 ~ 200` | J 值低于此阈值视为超卖（建议 10~20） |
| `kdjOversoldJOffset` | `number` | `0` | `0 ~ 99` | J 取值偏移：0 = 当前 K 线，1 = 上一根，以此类推 |

#### 3.4.2 MA 条件

| 参数名 | 类型 | 默认值 | 取值范围 | 业务含义 |
|--------|------|--------|---------|----------|
| `maConditions` | `MaCondition[]` | `[]` | 见下 | MA 多空排列条件（AND 连接） |

```ts
interface MaCondition {
  left: 'close' | 'ma5' | 'ma30' | 'ma60' | 'ma120' | 'ma240'
  op: '>' | '>=' | '<' | '<=' | '=' | '!='
  right: 'close' | 'ma5' | 'ma30' | 'ma60' | 'ma120' | 'ma240'
}
```

- 内置 1 套 MA 预设：**多头排列**（`CLOSE > MA60 AND CLOSE > MA240 AND MA30 > MA60 AND MA60 > MA120`）。

#### 3.4.3 入场距低点限制

| 参数名 | 类型 | 默认值 | 取值范围 | 业务含义 |
|--------|------|--------|---------|----------|
| `entryMaxDistFromLowPct` | `number` | `0` | `0.1 ~ 50`（步进 `0.5`） | 最大初始止损%，超过该值的信号被过滤 |

#### 3.4.4 最小盈亏比

| 参数名 | 类型 | 默认值 | 取值范围 | 业务含义 |
|--------|------|--------|---------|----------|
| `minRiskRewardRatio` | `number` | `0` | `0.1 ~ 20`（步进 `0.5`） | 最小盈亏比，`(高点 - 入场价) / (入场价 - 止损价)` |

#### 3.4.5 砖型图 XG 转折

| 参数名 | 类型 | 默认值 | 取值范围 | 业务含义 |
|--------|------|--------|---------|----------|
| `brickXgEnabled` | `boolean` | `false` | `true` / `false` | 是否启用砖型图 XG 转折信号 |
| `brickDeltaMin` | `number` | `0` | `0 ~ 10`（步进 `0.1`） | 砖型图 DELTA 加速阈值 |

#### 3.4.6 信号添加时的 UI 默认值

| 信号类型 | 添加时默认参数 |
|----------|---------------|
| KDJ 超卖 | `kdjJOversold: 10`，其余周期默认 |
| MA 条件 | `maConditions: [{ left: 'close', op: '>', right: 'ma60' }]` |
| 入场距低点 | `entryMaxDistFromLowPct: 5` |
| 最小盈亏比 | `minRiskRewardRatio: 4.0` |
| 砖型图 XG | `brickXgEnabled: true`，`brickDeltaMin: 0` |

### 3.5 入场信号排序（entrySorting）

符合入场信号过滤条件的候选标的，按本分组规则排序后，取 Top 1 进入挂单队列。

#### 3.5.1 排序模式

| 参数名 | 类型 | 默认值 | 取值范围 | 业务含义 |
|--------|------|--------|---------|----------|
| `entrySortMode` | `'single' \| 'composite'` | `'single'` | `single` / `composite` | 排序模式：`single` = 单因子排序；`composite` = 多因子加权综合得分排序 |

#### 3.5.2 排序因子

| 参数名 | 类型 | 默认值 | 取值范围 | 业务含义 |
|--------|------|--------|---------|----------|
| `entrySortFactors` | `SortFactor[]` | 见下 | 见下 | 排序因子列表。`single` 模式下仅生效第一个 `enabled: true` 的因子 |

```ts
interface SortFactor {
  /** 排序因子类型 */
  factor: 'risk_reward' | 'momentum' | 'freshness' | 'liquidity' | 'volatility'
  /** 权重，用于 composite 模式的加权得分 */
  weight: number
  /** 排序方向 */
  direction: 'asc' | 'desc'
  /** 是否启用 */
  enabled: boolean
  /** 因子专属参数（如 momentum 的 maPeriod、liquidity 的 window） */
  params?: Record<string, number>
}
```

**`entrySortFactors` 默认值**：
```ts
[
  { factor: 'risk_reward', weight: 1, direction: 'desc', enabled: true }
]
```

**各因子说明**：

| 因子 | 当前状态 | 含义 |
|------|---------|------|
| `risk_reward` | **已实现** | 盈亏比 `(recentHigh - close) / (close - recentLow)` |
| `momentum` | **已实现** | 短期动量得分 `(close - MA<maPeriod>) / ATR14`；MA 周期由 `params.maPeriod` 指定（默认 5，可选 5/30/60/120/240） |
| `freshness` | **已实现** | 信号新鲜度 `1 / (1 + barsSinceOversold)`；barsSinceOversold = 从当前 K 线向前扫描，J 值连续低于 `kdjJOversold` 的根数 |
| `liquidity` | **已实现** | 流动性得分，取最近 `params.window` 根 K 线 `quote_volume` 的均值；`window` 默认 `5`，范围 `1 ~ 50` |
| `volatility` | **已实现** | 波动率适配 `close / ATR14`，值越高表示波动率相对越低 |

> **当前阶段行为**：`entrySortMode = 'single'` 且仅启用 `risk_reward` 时，与后端现有硬编码逻辑完全等价——按盈亏比降序排列，每根 K 线取 Top 1。

### 3.6 止损与出场（stopExit）

| 参数名 | 类型 | 默认值 | 取值范围 | 业务含义 |
|--------|------|--------|---------|----------|
| `stopLossMode` | `'atr' \| 'fixed' \| 'signal_midpoint'` | `'atr'` | 三选一 | 止损类型：阶段低点 × 因子 / 固定百分比 / 信号 K 线中点价 |
| `fixedStopLossPct` | `number` | `2` | `0.1 ~ 50`（步进 `0.5`） | 固定止损百分比（仅 `fixed` 模式显示） |
| `stopLossFactor` | `number` | `1.0` | `0.5 ~ 2`（步进 `0.0001`） | 止损因子：`止损价 = 基准价 × 因子` |
| `enableProfitStopAdjust` | `boolean` | `true` | `true` / `false` | 阶段止盈后是否上调止损 |
| `profitStopAdjustTo` | `'midpoint' \| 'breakeven'` | `'midpoint'` | 中点价 / 保本价 | 阶段止盈后上调到何处 |
| `enableMa5StopAdjust` | `boolean` | `true` | `true` / `false` | MA5 首次转升后是否上调止损 |
| `ma5StopAdjustTo` | `'midpoint' \| 'breakeven'` | `'midpoint'` | 中点价 / 保本价 | MA5 上调到何处 |
| `enableLadderStopLoss` | `boolean` | `false` | `true` / `false` | 阶梯追踪止损（首次高于入场价保本，随后以每根 K 线最低点追踪） |
| `enablePartialProfit` | `boolean` | `false` | `true` / `false` | 是否开启阶段止盈 |
| `partialProfitRatio` | `number` | `0.5` | `0.1 ~ 0.9`（步进 `0.1`） | 触及阶段高点时减仓比例 |

> **固定出场规则（硬编码，无开关）**：MA5 破线出场——持仓期间收盘价曾站上 MA5 后，若出现 `收盘价 < MA5 且 MA5 ≤ 前根 MA5`，则全仓出场。

### 3.7 风控与回测（riskBacktest）

#### 3.7.1 冷却期参数

| 参数名 | 类型 | 默认值 | 取值范围 | 业务含义 |
|--------|------|--------|---------|----------|
| `enableCooldown` | `boolean` | `false` | `true` / `false` | 是否启用账户级全局冷却期 |
| `baseCooldownCandles` | `number` | `5` | `0 ~ 200` | 回测启动时冷却时长初始值 |
| `consecutiveLossesThreshold` | `number` | `3` | `1 ~ 20` | 连续亏损达到 N 次后触发全局冷却 |
| `maxCooldownCandles` | `number` | `20` | `1 ~ 10000` | 冷却时长上限 |
| `cooldownExtendOnLoss` | `number` | `1` | `0 ~ 10000` | 每次平仓亏损时冷却延长根数 |
| `cooldownReduceOnProfit` | `number` | `1` | `0 ~ 10000` | 每次平仓盈利时冷却缩短根数 |

#### 3.7.2 回测时间范围

| 参数名 | 类型 | 默认值 | 取值范围 | 业务含义 |
|--------|------|--------|---------|----------|
| `dateStart` | `string \| null` | `null` | 日期 / 日期时间 | 回测开始日期 |
| `dateEnd` | `string \| null` | `null` | 日期 / 日期时间 | 回测结束日期 |

## 4. 明确不做的事

- **不包含后端已实现、但前端 UI 未暴露的参数**。以下字段在 `useStrategyForm.ts` 的 `StrategyParams` 中存在默认值，但当前 Vue 组件中无任何 `<input>` 绑定，不属于本 SPEC 范围：
  - `enableTrailingStop` / `trailingDrawdownPct`
  - `enableBreakevenStop` / `breakevenTriggerR`
  - `takeProfitTargets`
  - `enableTrailingProfit` / `trailingProfitTriggerR` / `trailingProfitDrawdownPct`
  - `maxInitLoss`
- 所有排序因子均已实现后端计算逻辑，`composite` 模式下采用排名分法（Ranking Score）进行多因子加权排序。
- **不包含回测引擎内部运行时动态计算的字段**（如 `barIdx`、`stopPrice` 等运行期状态）。
- **不包含标的池本身的元数据**（如 `symbols` 表中的 `base_asset`、`quote_asset` 等）。

## 5. 技术方案

### 5.1 前端数据模型

全部参数由 `useStrategyForm.ts` 中的 `StrategyParams` 接口定义，并通过 `StrategyFormData` 封装：

```ts
interface StrategyFormData {
  id?: string
  name: string
  typeId: string
  symbols: string[]
  params: StrategyParams
}
```

### 5.2 校验规则

| 校验项 | 规则 | 触发时机 |
|--------|------|---------|
| `initialCapital` | `≥ 1000` | 表单提交前 |
| `positionRatio` | `0.01 ~ 1` | 输入时（滑块 + 数字输入联动） |
| `maxPositions` | `1 ~ 20` | 输入时 |
| `maConditions` | `left`、`op`、`right` 均非空 | 添加 MA 条件时 |
| `fixedStopLossPct` | 仅当 `stopLossMode === 'fixed'` 时必填且 `0.1 ~ 50` | 模式切换 + 提交前 |
| `dateStart` / `dateEnd` | `dateEnd` 不得早于 `dateStart` | 提交前 |
| `symbols` | 至少选择 1 个标的 | 提交前 |
| `entrySortFactors` | 至少包含 1 个 `enabled: true` 的因子；`weight` 必须在 `0 ~ 1` 之间（步进 `0.01`） | 提交前 |
| `entrySortMode` | 为 `composite` 时，`entrySortFactors` 中 enabled 的因子数必须 `≥ 2` | 提交前 |

### 5.3 持久化

- 创建/编辑策略时，前端将 `StrategyFormData` POST / PUT 到后端 `/api/strategies`。
- 参数以 JSON 形式存储于 `strategies.params` 字段。
- 回测运行时，后端将 `params` 完整透传至回测引擎。

### 5.4 UI 分组

弹窗采用 7 个 Tab 横向组织，Tab 顺序与上文 3.1 ~ 3.7 一致。

## 6. 验收标准

- [ ] `StrategyModal` 的 6 个 Tab 中，所有已绑定的 `<input>` / `<n-slider>` / `<n-switch>` / `<n-select>` 控件均在本 SPEC 参数清单中有对应条目。
- [ ] 每个参数的**类型、默认值、取值范围**与 `useStrategyForm.ts` 中的定义一致。
- [ ] 不存在前端已暴露但本 SPEC 遗漏的参数。
- [ ] 不存在本 SPEC 列出但前端 UI 中未实际暴露的参数。
- [ ] 信号添加时的 UI 默认值（3.4.6）与 `EntrySignalSection.vue` 中的 `addSignal` 逻辑一致。
- [ ] `entrySortMode = 'single'` 且仅启用 `risk_reward` 时，排序行为与后端现有硬编码逻辑等价。
- [ ] 新分组参数清单与 `useStrategyForm.ts` 中的 `StrategyParams` 定义一致。
