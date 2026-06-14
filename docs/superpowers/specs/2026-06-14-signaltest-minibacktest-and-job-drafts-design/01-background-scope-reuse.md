# 01 · 背景、范围与三引擎复用结论

[← 返回总入口](./index.md)

## 1.1 诉求演化与决策链

原始触发点：组合源选择器三态来源里「新建信号源」内联弹窗（`PortfolioSimNewSourceModal.vue`）的「创建并运行」按钮，点一下串行做两件事——`POST /api/signal-tests`（建方案）+ `POST /api/signal-tests/:id/run`（立即跑）。用户希望改成「点击只创建参数、点运行才运算」，并排查全站同类逻辑。

brainstorming 中用户逐项拍板，决策链如下（每一步都把范围推大一档）：

```text
①范围 = 内联弹窗 + ml.jobs 队列   两块都改
②Part A 形态 = ③完全照「新建策略」  独立 tab 表单 + 列表运行
③内联弹窗 = 移除                   源选择器只留「选历史run」+「手填uuid」
④tab 映射 = 强行做满 7 tab          含资金/排序/风控
⑤3 区语义 = 真改统计运算            升级成迷你回测(带资金账户)
⑥范围岔路 = 坚持本次就做迷你回测     接受与现有引擎重叠
⑦D1 存储 = 扩展现有 run + equity 新表
⑧D2 运算 = 信号统计 + 回测 叠加都出
```

> 设计者已在「3 区语义」与「范围岔路」两处明确反驳并提示「范围爆炸 + 引擎重叠」，用户三次确认坚持。故本设计在「接受大改」前提下，把重叠压到最小（见 §1.4 复用结论）。
>
> 注：本节决策链编号 ①~⑧ 仅指 brainstorming 决策项，与 [02 §2.1](./02-minibacktest-architecture.md) 的 runner 步骤 ①~⑧ 是两套独立编号，勿混。

## 1.2 最终范围边界

**纳入：**

- Part A：signal_test 运行时**叠加**一层带资金账户的迷你回测（复用 portfolio-sim 引擎纯函数 in-process）；7-tab 创建表单（详见 [05 §5.1](./05-minibacktest-frontend.md)）；详情页净值曲线；移除内联新建源入口（`PortfolioSimNewSourceModal` 删除、`PortfolioSimSourceRunPicker` 收成两态）。
- Part B：`ml.jobs` draft 态 + dispatch endpoint + 三触发入口默认建草稿 + jobs 列表运行按钮。

**排除（YAGNI / 语义不成立）：**

- 不复用 crypto backtest 引擎（§1.4.3）。
- 不把 portfolio-sim/backtest 的 StrategyParams section 控件直接搬进 signal_test 表单（类型与出场体系不兼容，见 [05](./05-minibacktest-frontend.md)）。
- 决策④照搬新建策略 7 区：其中「基础配置」承载从出场参数上浮的 `lookback`（phase_lock 初始止损回看窗口），仿策略「窗口归基础配置、止损因子归止损与出场」的拆法——属拆分既有字段、不新增后端字段（见 [05 §5.1](./05-minibacktest-frontend.md)）。
- 信号统计页（`SignalStatsView`）的创建/运行**早已分离**（`保存`→`store.createTest` 只落库；列表`运行`→`store.startRun`），Part A 无需新造解耦，只是表单 tab 化 + 运行时叠加回测。

## 1.3 全站「创建即运行」扫荡结论

| 模块 | 当前 | 是否需改 |
|------|------|----------|
| 内联新建信号源（`PortfolioSimNewSourceModal`） | 建 + 立即跑（耦合） | **改**（移除，Part A） |
| `ml.jobs` 队列（train/optuna/seed_avg/prepare/kelly_sweep） | 提交即入队、worker 立即拾取 | **改**（draft 态，Part B） |
| 组合模拟（portfolio-sim） | 建（pending）/ 运行（`:id/run`）已分离 | 不改 |
| 信号统计（signal-stats） | 保存 / 运行已分离 | 不改（仅表单+运算升级） |
| 条件扫描（strategy-conditions） | 创建 / 运行已分离 | 不改 |
| 策略回测（backtest） | 建策略 / 启动回测已分离 | 不改 |

即：全站真正「创建即运行」只有内联弹窗 + ml.jobs 两处，其余四处早是「先建后跑」。

## 1.4 三引擎复用结论（地基）

### 1.4.1 signal_test 现有引擎（可保留+复用）

- 入口 `signal-stats.runner.ts:89` `executeRun` → `doExecute`（:110）：枚举买入信号 → `simulateSignalsBatched`（批量+并发）→ `calcSignalStats` 聚合 → 落 `signal_test_trade` + 写 `signal_test_run` 聚合列。
- **出场模拟纯函数核**（DB-free，零改可复用）：`signal-stats.simulator.ts` 的 `simulateTradeCore`(:179) / `decideFixedN`(:326) / `decideStrategy`(:365) / `decideBandLock`(:449) / `decidePhaseLock`(:659)。
- **运算口径**：逐信号买 T+1 开盘、按 4 模式出场、`ret = exitPrice/buyPrice - 1`；信号间彼此独立、等权、可时间重叠；**无资金账户、无净值、无复利**。这正是缺的「资金账户层」要补的。

### 1.4.2 portfolio-sim 引擎（迷你回测内核，整体复用）

- 纯内存函数 `runPortfolioSim`（`portfolio-sim.engine.ts:122`）：吃 `EngineInput{config, trades:EngineTrade[], quotes, calendar}` → 逐日回放（出场→开仓→盯市→记录）→ `EngineResult{dailyRows, fills, summary}`。
- 资金账户 / 仓位三模式（`portfolio-sim.sizing.ts`）/ 单·多因子排序（`portfolio-sim.ranking.ts`）/ 双触发熔断（`portfolio-sim.cooldown.ts`）/ 成本 全在其内。
- **关键**：`EngineTrade` 已带每笔 `ret`（`portfolio-sim.types.ts` EngineTrade 接口 172-197，`ret` 在 :184），引擎**不重算出场路径**。所以 signal_test 必须先算出 `ret` 才能喂引擎——**单向依赖，非循环**。
- 单源（`sources.length==1`）时，引擎语义即「对该信号源做一次有资金约束/费率的迷你回测」。`anchorMode=true` 时约束全停、费率全 0，`realizedRetNet ≡ ret`（代数恒等，可对拍）。

### 1.4.3 backtest 引擎（不可复用，已排除）

crypto K 线引擎（OHLCV、`KlineBarRow`、逐根 K 线动态止损），与 signal_test（A 股日线、SSE 日历、qfq 价、4 离散出场模式）数据模型/入场口径/出场口径/资金模型/资产宇宙**五处根本性不兼容**。强行复用需改 data.service + 移植 A 股过滤 + 移植 trailing/phase_lock 出场，成本远超各自维护，**不复用**。

## 1.5 复用收益小结

```text
迷你回测所需能力            来源                         新代码量
────────────────────────────────────────────────────────────────
枚举买入信号                signal-stats enumerator      0（复用）
逐笔出场→ret                signal-stats simulator 核     0（复用）
逐笔明细落库                signal_test_trade            0（复用）
信号质量统计(胜率/凯利)     signal-stats metrics         0（复用）
资金账户/仓位/排序/熔断/盯市 runPortfolioSim 引擎         0（复用纯函数）
trades→EngineTrade[] 适配                                少量（新增接线）
回测结果落库(run新列+equity)                             少量（新增）
```

「迷你回测引擎」＝既有 `runPortfolioSim`，in-process 调用、结果写进 signal_test 自己的表。难的引擎部分全复用，新代码集中在「适配 + 落库」。
