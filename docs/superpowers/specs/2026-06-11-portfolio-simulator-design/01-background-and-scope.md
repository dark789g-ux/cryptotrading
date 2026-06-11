# 01 · 背景、摸底事实与范围边界

## 为什么做

- 0AMV 研究终态（`doc/研究/0amv-regime-strategy/results.md`）的 kelly 全是逐笔量纲；
  config v1（`regime_strategy_config` id `6c5e9323-7a52-40fc-93d2-faadf23609a2`，active）
  按半凯利折扣 kellyFraction Q3=0.33 / Q1=0.15（语义=该策略建议**总仓位**占比，
  holdout kelly × 0.5；与 backtest 模块同名字段的"单票缩放系数"是不同概念），
  但"实际该上多少仓位"承诺由影子期以
  **组合日收益口径**复核——本项目就是那个口径的工具链。
- 交易成本研究期未建模（靠手工敏感性折算拦截短持仓配置），需参数化补上。
- 影子期 2026-06-11 起算 ≥8 周，**2026-08 初复核到期**，是本项目的硬截止背景。

## 摸底事实（2026-06-11 两个 Explore 子代理实测，实现时复核）

### DB 面

- **`signal_test_trade` 回放就绪**：11 列全 NOT NULL（ts_code/signal_date/buy_date/
  exit_date/buy_price/exit_price/ret/hold_days/exit_reason），三个索引可用：
  `idx_signal_test_trade_run_id`、`(run_id, ret)`、`(run_id, signal_date)`；
  FK→signal_test_run ON DELETE CASCADE。
- **三个官方源 run**（id 一律从 `doc/研究/0amv-regime-strategy/runs-manifest.md` 复制）：

  | 名称 | run id | trades | signal_date 范围 | hold_days |
  |---|---|---|---|---|
  | Q3-winner | `52d2a2c8-1d36-4a0a-a4f6-5ef6e7137971` | 14,364 | 20221014~20250623 | 1~20（中位 20） |
  | Q3-alt | `8988e4ec-d57b-42ac-b2ad-1514f8b18a69` | 25,123 | 20220505~20260424 | 1~20 |
  | Q1-winner | `800c3732-38e1-4fd3-b778-3b14fb09de4d` | 28,032 | 20220608~20260521 | 恒 5（fixed_n） |

  三 run 的 buy_price/exit_price/ret **零 NULL**。
- **同日聚簇极端**（分仓规则是引擎核心而非边缘 case）：
  Q3-winner 130 个信号日，单日 max **1818** / p90 273.4 / 中位 23.5；
  Q1-winner 248 个信号日，单日 max 1255 / p90 244.2 / 中位 76.5。
- **Q1/Q3 持仓期重叠 153 天**：Q3-winner 持仓开放日 301 天、Q1-winner 450 天，交集
  153 天（占 Q3 的 50.8%、Q1 的 34%）。信号日因象限定义互斥，但 Q3 单笔最长拿 20 天，
  期间大盘可切到 Q1。**"分池简化"不成立，必须共享资金池统一回放。**
- **trade 表无排序字段**：无 circ_mv / pos_120 / 成交额，同日选股排序需按
  `(ts_code, signal_date)` 回 JOIN `signal_rolling_indicator`（pos_120）与
  `raw.daily_basic`（circ_mv）。
- **基准指数缺失**：沪深300（000300.SH）/中证1000 在库内全部查无（raw 无 index_daily
  类表）；`oamv_daily`（1153 行，20210901~20260610）只是大盘情绪代理。→ 用户决策一期
  不做基准对比。
- `regime_daily_pick` 当前仅 20 行（20250623 Q3 测试批），影子期数据还很薄。

### 代码面

- **metrics 口径**（`apps/server/src/strategy-conditions/signal-stats/signal-stats.metrics.ts:51-83`）：
  win 取 `r > 0`、loss 取 `r < 0`（ret===0 两边不计但进 N 分母）；
  `kellyF = winRate - (1 - winRate) / payoffRatio`。锚点对账以 `calcSignalStats` 输出为准。
- **simulator 价格口径**（`signal-stats.simulator.ts:65-67,180,208`）：买入=信号次日
  qfq_open，出场多为 qfq_close，`ret = exitPrice/buyPrice - 1`，未扣费用；
  `signal-stats.simulator.db.ts` 的按 tsCode 分组预取+有界并发是本引擎行情预取的模仿对象。
- **backtest 模块（加密货币）是仓位语义参照**（用户指定）：
  `BacktestConfig`（`apps/server/src/backtest/engine/models.ts:372-444`）含
  initialCapital（默认 1,000,000）/ positionRatio（默认 0.40，占最新 NAV）/
  maxPositions（默认 2）/ kellyFraction 及硬上限等；资金分配
  `alloc = min(NAV×ratio, cash)`（`engine.pending-execution.ts:58-90`）；
  多信号靠排序后每根 K 线只取第一名（`engine.ts:328-334`）；**无任何成本建模**；
  在持 symbol 不重复进场（heldSymbols 排除）。
  前端表单参照 `apps/web/src/components/backtest/strategy/sections/StrategyCapitalSection.vue`。
- **运行态模式参照 signal-stats**（2026-06-10 刚打磨）：run 表 status/phase/progress 列
  + 前端全局 2s 轮询器 + resumeAllPolling + per-id 互斥 409 透传。
- **研究表先例**：`research.kelly_sweep_results`（alembic，Python 域）。本项目是 TS/NestJS
  域 → 表放 public schema 走 `apps/server/migrations/` 惯例（`.sql`+`.ps1` 配对），不混
  research schema。
- **前端模仿对象**：净值曲线 `apps/web/src/components/quant/OosTrendChart.vue`；
  布局 `apps/web/src/views/quant/QuantRunDetailView.vue`。

## 用户决策记录（2026-06-11 brainstorming 四问 + 方案选择）

1. **资金语义：比例制**——组合按权重×逐笔 ret 推进，成本按百分比双边扣；
   忽略整手 100 股与最低 5 元佣金（不附误差量化）。
2. **佣金：万 2.5**（0.025%/边）作为"现实档"校准基础。
3. **基准对比：一期不做**（绝对指标足够，库内也无指数日线）。
4. **交付形态：含 Web 操作台**（配置+触发+进度+净值曲线页）。
5. **选股规则：开跑前设置仓位控制，参照 backtest 模块**——positionRatio/maxPositions
   等上游约束 + 排序消化超额信号，不做独立"选股规则"概念。
6. **实现方案 A**：独立 TS 模块 `portfolio-sim`（与 signal-stats 平级）。

## 范围边界（诚实声明）

1. **本期只做"回放官方 run"**。影子期 picks 重模拟（picks 无前向收益，需调 signal-stats
   simulator 现算）本期交付**文档化复算路径**（见 `./05-verification-and-tasks.md#影子期复算路径`），
   工具化按钮留二期。
2. **回撤是近似、总收益是精确**：持有期内逐日盯市用当前 qfq 比率推进，若持有期内发生
   除权，中间路径形状与 run 时点真实路径可能有微小偏差；出场日强制收口保证每笔总收益
   逐位等于官方 ret（见 `./02-engine-design.md#盯市与出场收口`）。
3. 比例制不建模整手/最低佣金/流动性冲击（滑点为常数参数，与 amount 分位挂钩留二期）。
4. 一期不做基准对比、不做多 run 扫参网格（一次模拟一组配置；扫参靠多次建 run）。
