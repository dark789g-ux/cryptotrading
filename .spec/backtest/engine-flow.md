# 回测全流程规范

> 本文档描述回测从 HTTP 触发到结果落库的完整执行路径，作为引擎迭代的参考基准。

---

## 入口

HTTP 请求 → [backtest.controller.ts](../../apps/server/src/backtest/backtest.controller.ts) → [`BacktestService.startBacktest()`](../../apps/server/src/backtest/backtest.service.ts#L155)

- **立即返回** `{ ok: true }`，不阻塞请求
- 进度通过 `GET /backtest/progress/:strategyId` 轮询 [`getProgress()`](../../apps/server/src/backtest/backtest.service.ts#L142) 获取
- 全局互斥锁 `isRunning`：同一时刻只允许一个回测任务运行

---

## 总体管道

```
startBacktest()                           backtest.service.ts
  └─ doBacktest()
       └─ executeBacktestPipeline()       backtest-execution.pipeline.ts
            │
            ├─ Phase 1: 加载策略配置
            ├─ Phase 2: 加载 K 线数据
            ├─ Phase 3: 运行引擎主循环   engine/engine.ts
            ├─ Phase 4: 计算统计指标
            └─ Phase 5: 持久化结果
```

---

## Phase 1 — 加载策略配置

**文件**：[backtest-execution.pipeline.ts](../../apps/server/src/backtest/backtest-execution.pipeline.ts#L24)

1. 从 `StrategyEntity` 查询策略，不存在则终止并报错
2. 合并 [`DEFAULT_CONFIG`](../../apps/server/src/backtest/engine/models.ts)（`engine/models.ts`）+ `strategy.params` → `BacktestConfig`
3. [`validateConfig(config)`](../../apps/server/src/backtest/engine/models.ts) 校验必填字段
4. 确定标的池：优先用请求传入的 `symbols`，否则取 `strategy.symbols`；为空则终止

---

## Phase 2 — 加载 K 线数据

**文件**：[engine/data.service.ts](../../apps/server/src/backtest/engine/data.service.ts)

- 调用 `dataService.loadKlines(symbols, timeframe, config)`
- 返回：
  - `data: Map<symbol, KlineBarRow[]>` — 每个品种按时间正序排列的 K 线数组
  - `backtestStart: Map<symbol, number>` — 每个品种实际开始回测的行索引（前部为预热数据，用于指标计算）
- 数据为空则终止

---

## Phase 3 — 引擎主循环

**文件**：[engine/engine.ts](../../apps/server/src/backtest/engine/engine.ts) → `runBacktest()`

### 初始化

| 项目 | 说明 |
|---|---|
| `tsToIdx` | `Map<symbol, Map<ts, rowIndex>>`，O(1) 查询指定品种某时间戳的 K 线行 |
| `precomputedKdj` | 仅当 `kdjN/M1/M2 ≠ 9/3/3` 时预计算（[bt-indicators.ts](../../apps/server/src/backtest/engine/bt-indicators.ts)），主循环复用 |
| `brickMap` | 仅当 `brickXgEnabled=true` 时预计算砖图（[bt-indicators.ts](../../apps/server/src/backtest/engine/bt-indicators.ts)） |
| `timestamps` | 全局时间轴：所有品种 K 线时间戳去重后升序排列（[steps/engine.timeline.ts](../../apps/server/src/backtest/engine/steps/engine.timeline.ts)） |
| `cash` | 初始资金 = `config.initialCapital` |
| `cooldownState` | 账户级冷却状态（[engine/cooldown.ts](../../apps/server/src/backtest/engine/cooldown.ts)），替代旧的 per-symbol cooldownUntil |

### 每根 K 线执行顺序（barIdx 循环）

**Step 0** — [`calculateOpenEquity()`](../../apps/server/src/backtest/engine/steps/engine.portfolio-marks.ts)
用当根 open 价格估算持仓市值 + cash，作为本根开盘权益

**Step 1** — [`executePendingBuys()`](../../apps/server/src/backtest/engine/steps/engine.pending-execution.ts)
执行上一根挂入 `pendingBuys` 的买单：
- 以当根 open 价成交（T+1 机制）
- 计算仓位大小：`cash × positionRatio / open`
- 返回 `entryEvents`（本根成交记录）、更新 `cash / positions`

**Step 2** — [`processPositions()`](../../apps/server/src/backtest/engine/steps/engine.position-processing.ts)
遍历所有持仓，按 close 价逐一检查出场条件：
- 止损触发（`stopPrice > close`）
- 分批止盈（`takeProfitTargets`）
- 阶段止盈（`halfSold` + 高点）
- 移动止盈（`trailingProfit`）
- MA5 收盘规则
- 移动止损 / 保本止损（更新 `stopPrice`）

连续亏损达阈值时通过 [cooldown.ts](../../apps/server/src/backtest/engine/cooldown.ts) 激活冷却；返回 `exitEvents`、更新 `cash / positions / allTrades`

**Step 3** — [`calculatePortfolioValue()`](../../apps/server/src/backtest/engine/steps/engine.portfolio-marks.ts)
以当根 close 价重估持仓市值 + cash = `portfolioVal`；记录 `portfolioLog[ts, portfolioVal]` 与 `posSnapshots`

**Step 4** — [`scanSignals()`](../../apps/server/src/backtest/engine/signal-scanner.ts)

开仓门禁（全部满足才扫描）：
- `positions.length < maxPositions`（或全部半仓）
- `cash ≥ minOpenCash`
- `!inCooldown`（账户级冷却状态）
- `requireAllPositionsProfitable` 门禁（若开启）

信号条件（AND 逻辑）：
- KDJ J 超卖（`J < kdjJOversold` 且 `J < kdjJMax`）
- KDJ K/D 阈值（`kdjKMax / kdjDMax`）
- MA 动态条件（`maConditions`，空列表回退硬编码条件）
- 距阶段低点不超过 `entryMaxDistFromLowPct`
- 最小盈亏比 `minRiskRewardRatio`

信号成立时将 `[symbol, ts, rr, 0]` 推入 `pendingBuys`（下根执行）；每根最多挂 1 单

**Step 5** — `candleLog.push()`
记录本根完整事件快照：`openEquity / closeEquity / posCount / entries / exits / openSymbols / inCooldown / cooldownRemaining`

### 循环结束后

[`forceClosePositions()`](../../apps/server/src/backtest/engine/steps/engine.force-close.ts)：以最后一根 K 线 close 价强制平仓所有剩余持仓，产生的交易写入 `allTrades`

### 返回值

```typescript
{ trades: TradeRecord[], portfolioLog: [string, number][], posSnapshots, candleLog }
```

---

## Phase 4 — 统计与报告

**文件**：[engine/report.ts](../../apps/server/src/backtest/engine/report.ts)

| 函数 | 说明 |
|---|---|
| `calcStats()` | 计算总收益率、年化收益率、最大回撤、夏普比率、胜率、平均持仓根数等 |
| `prepareReportData()` | 整合 trades / portfolioLog / stats / posSnapshots，生成前端报告所需的结构化数据 |

---

## Phase 5 — 持久化

**文件**：[backtest-execution.pipeline.ts:105](../../apps/server/src/backtest/backtest-execution.pipeline.ts#L105)

| 实体 | 内容 | 说明 |
|---|---|---|
| `BacktestRunEntity` | stats / configSnapshot / symbols / timeframe / dateStart / dateEnd | 一次回测的汇总记录 |
| `BacktestTradeEntity` | 每笔交易的入场时间/价、出场时间/价、pnl、holdBars | 按 runId 关联 |
| `BacktestCandleLogEntity` | 逐根 K 线事件日志 | 500 条一批批量写入，避免单次 INSERT 过大 |
| `StrategyEntity` | 更新 `lastBacktestAt` / `lastBacktestReturn` / `symbols` | — |

---

## 进度状态机

```
running → done
running → error
```

[`progressMap`](../../apps/server/src/backtest/backtest.service.ts#L33) 存于内存，key 为 `strategyId`。完成或失败后保留 `PROGRESS_RETENTION_MS`（[backtest.types.ts](../../apps/server/src/backtest/backtest.types.ts)）再自动清除。

进度百分比映射：

| 阶段 | percent |
|---|---|
| 初始化 | 0 |
| 加载 K 线数据 | 2 |
| 引擎主循环启动 | 5 |
| 引擎主循环进行中 | 5–90（按时间轴比例线性插值） |
| 计算统计指标 | 92 |
| 保存结果 | 96 |
| 完成 | 100 |

---

## 关键设计约束

- **T+1 成交**：信号当根发现，下一根 open 价格执行，模拟真实买单延迟（[engine.pending-execution.ts](../../apps/server/src/backtest/engine/steps/engine.pending-execution.ts)）
- **账户级冷却**：连续亏损触发冷却，冷却期内全账户禁止开新仓（[cooldown.ts](../../apps/server/src/backtest/engine/cooldown.ts)）
- **预热数据**：`backtestStart` 之前的 K 线仅用于指标预热，不参与回测逻辑（[data.service.ts](../../apps/server/src/backtest/engine/data.service.ts)）
- **自定义 KDJ 预计算**：kdjN/M1/M2 偏离默认值时，引擎启动前一次性预计算全量 KDJ，主循环 O(1) 查表（[bt-indicators.ts](../../apps/server/src/backtest/engine/bt-indicators.ts)）
- **事件循环让出**：每 100 根 K 线执行一次 [`yieldToEventLoop()`](../../apps/server/src/backtest/engine/steps/engine.async.ts)，确保进度轮询请求能被 Node.js 处理
