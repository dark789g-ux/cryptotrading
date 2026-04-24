# 回测数据断流处理 SPEC

## 背景

回测引擎按全局时间轴 `timestamps`（取所有 symbol 的并集）逐根推进。当某个 symbol 在持仓期间 K 线数据提前结束（交易所暂停、接口缺失、币种下架等），其在后续 ts 上的 `tsToIdx.get(ts)` 会返回 `undefined`。

## 历史漏洞

修复前，断流场景下逻辑被两处不一致放大为「净值断崖」：

1. [apps/server/src/backtest/engine/engine.position-processing.ts](../../apps/server/src/backtest/engine/engine.position-processing.ts) `processPositions` 中 `curIdx === undefined` → `surviving.push(pos); continue;`，**持仓保留**。
2. [apps/server/src/backtest/engine/engine.portfolio-marks.ts](../../apps/server/src/backtest/engine/engine.portfolio-marks.ts) `calculatePortfolioValue` / `calculateOpenEquity` 中 `curIdx === undefined` → `continue;`，**市值跳过**。

后果：持仓挂在账上但 mark-to-market 时 `shares × price` 凭空蒸发，`closeEquity` 在断流首根 bar 出现断崖式下跌（实测 SYNUSDT 案例：1,007,926.75 → 705,602.85）。直到回测末尾 `forceClosePositions` 用「≤ lastTs 的最近可用 K 线」补平才恢复，但中间所有 bar 的净值曲线均为错误结果。

## 处理策略：末根 K 线收盘强平

在 `processPositions` 处理某根 K 线、走完常规出场逻辑后，若 `curIdx === df.length - 1`（即该 symbol 已无下一根 K 线），按当根 close 价强制平仓：

- 生成一笔 `exitReason = '数据断流'` 的 `TradeRecord`。
- 现金回流 `shares × close`。
- 推送对应 `CandleExitEvent`（`isHalf = false`）。
- 持仓不进入 `surviving`，后续 bar 自然不再参与 mark-to-market。
- 与一般完整平仓一致，按 `enableCooldown` 登记账户级冷却。

## 实现要点

实现位于 [apps/server/src/backtest/engine/engine.position-processing.ts](../../apps/server/src/backtest/engine/engine.position-processing.ts) 的 `forceCloseOnDataGap` 辅助函数。挂入两处：

1. **入场当根分支**：`processEntryCandle` 未返回 `exited` 时，再判 `curIdx === df.length - 1`。覆盖「入场即末根」的边界。
2. **常规分支**：`processCandle` 返回非 `'exit_full'` 时，再判 `curIdx === df.length - 1`。

顺序约束：**强平必须在常规出场逻辑之后判定**。这样当根触发的止损 / 止盈 / 回撤 / 分批等均可优先生效，不会被「数据断流」覆盖。

## 不改动的位置

- [apps/server/src/backtest/engine/engine.portfolio-marks.ts](../../apps/server/src/backtest/engine/engine.portfolio-marks.ts)：保持 `curIdx === undefined` 时跳过的现状。强平后该持仓已被移出，自然不再触发该分支。
- [apps/server/src/backtest/engine/engine.force-close.ts](../../apps/server/src/backtest/engine/engine.force-close.ts)：仅处理「数据延续到全局 lastTs 仍未出场」的持仓。提前断流的 symbol 已被新逻辑兜底，不会再走「找最近 ≤ lastTs」分支。
- [apps/server/src/backtest/engine/models.ts](../../apps/server/src/backtest/engine/models.ts)：无需新增任何运行时缓存字段（如 `lastSeenIdx`）。

## 出场原因约定

- 字符串字面量：`'数据断流'`。
- 与 `'回测结束'`（forceClose）、止损 / 止盈 / 半仓等并列，作为新的一类 `exitReason`。
- 若前端 / `report.ts` 按 `exitReason` 做聚合或筛选，需识别该新值；否则透明聚合到「其他」。

## 决策对比（已废弃方案）

曾考虑过 carry-forward 方案：在 `calculatePortfolioValue` / `calculateOpenEquity` 中缓存 `pos.lastSeenIdx`，断流后用最后一根可用 K 线的价格继续估值。该方案优点是不伪造交易、净值曲线最平滑，缺点是：

- 持仓在数据消失后仍长期挂账，与「真实账户在交易所下架时被强制兑现」语义偏离。
- 需要在 `Position` 上加运行时字段，污染数据模型。
- 估值只是延迟兑现，最终仍由 `forceClosePositions` 在 lastTs 之前的「某根」上结算，**结算价不可控**。

最终采用「末根 close 强平」：语义直观、收益立即兑现、`Position` 模型零侵入、改动面最小。

## 验证清单

- 重跑历史回测：含数据中途断流的 symbol，应在其最后一根 K 线时间产生一笔 `数据断流` 平仓 trade。
- `closeEquity` 曲线在断流首根 bar 不再出现断崖。
- 该 symbol 不再出现在 `forceClosePositions` 末尾平仓清单中。
- `pnpm exec tsc --noEmit`（`apps/server`）通过。

## 经验提炼（可复用规则）

1. **「持仓存在性」与「持仓估值贡献」两个判断必须保持口径一致**。任何一处对持仓做了 skip / continue，另一处也必须做出对应处理（要么同步移除，要么显式 carry-forward），不可一处保留一处归零。
2. **数据完整性问题应在最早能感知到的位置兜底**：`processPositions` 是引擎中最早判定 `curIdx === undefined` 的位置，也是最早知道 `df.length - 1` 的位置，应在此就地决策，而不是把不一致状态传递给下游 mark-to-market 函数。
3. **新增的兜底出场必须放在常规出场之后**：避免覆盖正常风控逻辑。
4. **回测末尾 `forceClosePositions` 仅是最后一道兜底**，不应承担常规数据断流的责任，否则中途净值曲线全错。
