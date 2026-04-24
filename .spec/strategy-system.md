# 策略系统架构说明

## 一、MA+KDJ 趋势策略入口

整个策略系统分为**注册层**、**信号层**、**持仓层**三层。目前引擎为**单策略硬编码**——`signal-scanner.ts` 和 `position-handler.ts` 直接实现的是 MA+KDJ 逻辑，回测引擎不做策略类型分发。

---

## 二、核心文件清单

### 后端（NestJS TypeScript）

| 职责 | 文件路径 |
|---|---|
| 策略类型注册（种子数据） | `apps/server/src/strategies/strategy-types.seed.ts` |
| 策略类型实体 | `apps/server/src/entities/strategy-type.entity.ts` |
| 策略实例实体 | `apps/server/src/entities/strategy.entity.ts` |
| 参数定义（DEFAULT_CONFIG） | `apps/server/src/backtest/engine/models.ts`（L152-L176） |
| **入场信号扫描（MA+KDJ 条件）** | `apps/server/src/backtest/engine/signal-scanner.ts` |
| **持仓出场逻辑** | `apps/server/src/backtest/engine/position-handler.ts` |
| 近期高低点计算 | `apps/server/src/backtest/engine/bt-indicators.ts` |
| 主回测循环 | `apps/server/src/backtest/engine/engine.ts` |
| 回测编排（参数合并） | `apps/server/src/backtest/backtest.service.ts` |
| 回测 API 控制器 | `apps/server/src/backtest/backtest.controller.ts` |
| 策略 CRUD 服务 | `apps/server/src/strategies/strategies.service.ts` |
| 策略 API 控制器 | `apps/server/src/strategies/strategies.controller.ts` |
| K 线加载服务 | `apps/server/src/backtest/engine/data.service.ts` |
| 指标计算（MA/KDJ/MACD/ATR） | `apps/server/src/indicators/indicators.ts` |

### 前端（Vue 3 TypeScript）

| 职责 | 文件路径 |
|---|---|
| 策略管理主视图 | `apps/web/src/views/BacktestView.vue` |
| **参数配置弹窗** | `apps/web/src/components/backtest/StrategyModal.vue` |
| 回测结果展示 | `apps/web/src/components/backtest/BacktestDetail.vue` |
| API 定义 | `apps/web/src/composables/useApi.ts` |
| SSE 进度推送 | `apps/web/src/composables/useSSE.ts` |

---

## 三、MA+KDJ 入场条件

位于 `signal-scanner.ts` 的 `scanSignals()`：

```typescript
// 条件 A: 均线多头排列
if (!(close > ma60 && ma30 > ma60 && ma60 > ma120 && close > ma240)) continue;

// 条件 B: KDJ 超卖区间
if (!(kdjK < config.kdjKMax && kdjD < config.kdjDMax && kdjJ < config.kdjJMax)) continue;

// 条件 C: 初始止损幅度
const initLoss = 1 - recentLow / close;
if (initLoss >= config.maxInitLoss) continue;

// 条件 D: 最小盈亏比
const rrRatio = reward / risk;
if (rrRatio <= config.minRiskRewardRatio) continue;
```

返回 `[symbol, rrRatio][]`，按盈亏比降序排序。

---

## 四、MA+KDJ 出场规则

位于 `position-handler.ts`：

- **阶段止盈**：`high >= pos.recentHigh` → 卖出 50%
- **止损**：`low <= pos.stopPrice`
- **MA5 破线**：`close < MA5 && MA5 <= prevMA5 && pos.brokeMa5`
- **阶段止盈后止损调节**：`newStop = (entryPrice + maxClose) / 2`
- **MA5 上升后止损调节**：同上

`processEntryCandle()` 处理买入当根 K 线的特殊执行顺序（高点先到 vs 低点先到）。

---

## 五、完整数据流

```
【新建策略】
前端 StrategyModal（参数配置）
  ↓ handleSubmit()
POST /api/strategies {typeId, params, symbols}
  ↓
StrategiesController.create() → StrategiesService.createStrategy()
  ↓ 合并: {...type.paramSchema, ...dto.params}
保存到 StrategyEntity
  ↓ 返回 strategyId

【启动回测】
前端 BacktestView（点击"运行回测"）
  ↓
POST /api/backtest/start/:strategyId {symbols: []}
  ↓
BacktestController → BacktestService.doBacktest()
  ├─ 加载 StrategyEntity
  ├─ 合并参数: {...DEFAULT_CONFIG, ...strategy.params}
  ├─ 加载 KlineEntity 数据
  └─ 运行 runBacktest(data, config)
     ├─ 每个时间步循环:
     │  ├─ executePendingBuys()     [执行上一步挂单]
     │  ├─ processPositions()        [出场逻辑]
     │  ├─ calculatePortfolioValue() [净值计算]
     │  └─ scanSignals()              [入场扫描 + 新仓]
     └─ 返回 trades, portfolioLog, posSnapshots
  ├─ calcStats()     [统计指标]
  └─ 保存 BacktestRunEntity + BacktestTradeEntity
     ↓ SSE 推送进度
前端接收 SSE events，更新进度条和结果
```

---

## 六、开发新策略类型的步骤

目前 `signal-scanner.ts` 和 `position-handler.ts` 是 MA+KDJ 硬编码，引擎不做策略分发。要新增策略类型，需要以下改造：

### 1. 注册策略类型

在 `apps/server/src/strategies/strategy-types.seed.ts` 中增加新 seed，给定唯一 `id`（如 `'rsi_bb'`）和 `paramSchema`（参数定义）。

### 2. 新建策略逻辑文件

建议目录结构改造为按策略分子目录：

```
apps/server/src/backtest/engine/
├── strategies/
│   ├── ma-kdj/
│   │   ├── signal-scanner.ts
│   │   └── position-handler.ts
│   └── rsi-bb/
│       ├── signal-scanner.ts
│       └── position-handler.ts
├── engine.ts
├── data.service.ts
└── models.ts
```

每个策略导出统一接口的 `scanSignals()` 和 `processCandle()` / `processEntryCandle()`。

### 3. 引擎增加策略分发

在 `engine.ts` 和 `backtest.service.ts` 中，根据 `strategy.typeId` 做 switch 或注册表分发：

```typescript
const strategyRegistry = {
  ma_kdj: { scanSignals: maKdjScan, processCandle: maKdjProcess, ... },
  rsi_bb: { scanSignals: rsiBbScan, processCandle: rsiBbProcess, ... },
};

const handler = strategyRegistry[strategy.typeId];
```

### 4. 前端适配动态参数表单

`StrategyModal.vue` 目前参数表单是硬编码的。改造建议：根据 `typeId` 读取 `paramSchema`，动态渲染参数表单（按字段类型生成 `n-input-number` / `n-slider` / `n-date-picker`）。

### 5. 指标依赖检查

若新策略使用新指标（如 RSI、Bollinger Bands），需要：
- 在 `apps/server/src/indicators/indicators.ts` 增加指标计算
- 在 `apps/server/src/entities/kline.entity.ts` 增加对应字段
- 数据同步时预计算并存入数据库

---

## 七、关键约束与注意事项

- 回测默认 K 线内部路径：**O → H → L → C**（见 CLAUDE.md）
- 所有参数通过 `BacktestConfig` 对象传递，避免显式策略类型判断
- 参数优先级：用户提交 params → StrategyTypeEntity.paramSchema → DEFAULT_CONFIG
- `RECENT_WINDOW = 9`（近期高低点窗口，见 `bt-indicators.ts`）
- 指标在数据同步时**预计算**，回测时直接读 DB 字段
