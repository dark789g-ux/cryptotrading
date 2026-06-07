# 02 · 逐笔模拟与口径（核心）

[← 返回 index](./index.md)

本文是实现的口径基准。所有列名 / 表名均已落真 DB 一条样本核对（见文末脚注），**实现时进硬断言前仍须自查**（`.claude/rules/data-integrity.md`）。

## 信号枚举

输入：买入条件集 `buy_conditions: StrategyConditionItem[]`、历史区间 `[date_start, date_end]`、标的池 `universe`。

步骤：
1. 取区间内全部 SSE 交易日：`raw.trade_cal WHERE exchange='SSE' AND is_open=1 AND cal_date BETWEEN :start AND :end ORDER BY cal_date`。
2. 对每个交易日 `T`，复用 `buildAShareQuery(buy_conditions)` 生成 WHERE 片段，但把锚定日从 runner 的 `MAX(trade_date)` 换成绑定参数 `i.trade_date = :T`（标的池为 list 时再 `AND i.ts_code = ANY(:tsCodes)`）。
3. 命中的 `(T, ts_code)` 即一个买入信号，进入逐笔模拟。

> 性能策略（已与用户确认"先慢后优化"）：首版可逐交易日循环执行 WHERE；后续可批量化（单条 SQL 跨日枚举 / 批量预取持有窗口数据后内存模拟）。`strategy` 出场模式逐日判卖出条件最重，是优化重点。

## 入场口径

```text
signal_date = T  ──▶  buy_date = T+1 (SSE 日历下一交易日)  ──▶  buy_price = qfq_open[T+1]
```

- `buy_date` 取 T 之后的**下一个** SSE 交易日（用 `trade_cal` 升序索引差，不假设 T+1 自然日）。
- `buy_price` = `raw.daily_quote.qfq_open`（前复权开盘价，已验证 100% 填充）。

## 入场过滤（全开，对齐 quant；用户已确认两处简化）

| 过滤项 | 口径 | 数据源 | 与 quant 差异 |
|---|---|---|---|
| **停牌** | T+1 在 `daily_quote` **无行 / `qfq_open` 为空** → 取不到 `buy_price` → 隐式剔除 | `raw.daily_quote` | quant 显式 join `suspend_d`；本功能用隐式口径（停牌日必无 quote 行），**不 join `suspend_d`**，避开 S/R 两类坑、少一张表。✅ 用户认可 |
| **一字涨停** | `raw.open[T+1] >= stk_limit.up_limit[T+1]`（开盘即顶格，买不进） | `raw.daily_quote.open`（未复权）+ `raw.stk_limit.up_limit` | quant 用 `close>=up_limit*0.995`（收盘涨停）；本功能 T+1 开盘入场，故判**开盘**涨停，且**用未复权 open 比未复权 up_limit**（计价仍用 `qfq_open`，判定与计价分离）。✅ 用户认可 |
| **次新股** | `buy_date` 距 `list_date` < **60 个 SSE 交易日** → 剔除 | `public.a_share_symbols.list_date` + 全局 SSE 日历索引差 | 对齐 quant（含 bug3 修复：必须用**全局** SSE 日历而非窗口局部日历计交易日数） |

任一过滤命中 → 该信号丢弃，不计入样本（并按可观测要求记数，见 [05 文档](./05-error-testing-tasks.md#空数据与可观测)）。

## 出场模拟

按 `exit_mode` 分两支。两支底层共用同一逐笔推进框架（固定 N 天 = "最大持仓 N 天"单规则特例）。

```text
持有期逐 SSE 交易日推进 d = buy_date 之后 (T+2, T+3, ...):

  exit_mode = 'fixed_n':
    d 到达第 N 个持有交易日(即 buy_date 后第 N 个 SSE 交易日, = T+1+N)
      → 卖出, exit_price = qfq_close[d], exit_reason = 'max_hold'

  exit_mode = 'strategy':
    每个 d 用 buildAShareQuery(exit_conditions) 锚定到 d 判该 ts_code 是否命中
      首次命中 → 卖出, exit_price = qfq_close[d], exit_reason = 'signal'
      满 max_hold 仍未命中 → 强平, exit_price = qfq_close[buy_date 后第 max_hold 个交易日], exit_reason = 'max_hold'

  退市(任一模式): delist_date 到达 → 强平, exit_price = qfq_close[最后可交易日], exit_reason = 'delist'
  持有期内停牌日: daily_quote 无行 → hold_days 不递增, 跳过该日(对齐 quant)
```

- **`fixed_n` 卖价** = `qfq_close[T+1+N]`（用户选 T+1+N 收盘）。
- **`strategy` 卖价** = 命中日 `qfq_close`。
- `hold_days` = buy_date 到 exit_date 之间的 SSE 交易日数。

### 持有期计数与边界口径（B3 实现澄清）

- **停牌不占持有额度**：`fixed_n` 的"第 N 个持有交易日"与 `strategy` 的 `max_hold` 兜底，均按**实际可交易日**计数——持有期内停牌日（daily_quote 无行）完全跳过，既不占 N/max_hold 额度、也不递增 `hold_days`，顺延到下一个有 quote 的交易日取价。（对齐 quant 持仓期停牌处理。）
- **hold_days 口径**：= buy_date 到 exit_date 之间的**可交易日步数**（停牌日不计步，buy_date 记为第 0 天）；`fixed_n` 模式恒等于 N。与上条"停牌不占额度"一致——`hold_days` 永远只数实际可交易日。
- **strategy 最早出场日**：buy_date(T+1) 当天**不判**卖出条件，逐日判定从 buy_date 的下一交易日起，故最短持有 1 个交易日。
- **退市强平**：持有推进中一旦某 SSE 交易日 `cal_date >= delist_date`，用其**之前最后一个有 quote 的交易日** `qfq_close` 强平，`exit_reason='delist'`；`delist_date` 为空（未退市）则永不触发。
- **数据不足丢弃**：信号 T 的 buy_date 或出场日超出 `date_end` / 超出 `trade_cal` 收录 / quote 尚未入库（取不到有效 `qfq_open/qfq_close`）→ 以 `FilterReason='insufficient_data'` 丢弃，**单独计数**、不混入停牌/涨停/次新。故 `FilterReason` 四类：`'suspended' | 'limit_up' | 'new_listing' | 'insufficient_data'`。

## 前向收益

```text
ret = exit_price / buy_price − 1        (毛收益, 未扣交易成本)
    = qfq_close[exit] / qfq_open[buy] − 1
```

毛收益口径对齐 quant（交易成本由组合评估层统一扣，本功能不扣）。

## 指标聚合（calcSignalStats）

设有效样本（通过过滤、能算出 `ret` 的逐笔）共 `N` 笔，记：

```text
wins   = { ret : ret > 0 }      losses = { ret : ret < 0 }
胜率 p        = |wins| / N
avg_win       = mean(wins)                          (>0)
avg_loss      = mean(losses)                         (<0)
赔率 b        = avg_win / |avg_loss|
profit_factor = Σ wins / |Σ losses|                 (实现以此为准)
凯利 f*       = p − (1 − p) / b
avg_hold_days = mean(hold_days)
worst_trade_ret = min(ret over all N)               (最差单笔, 替代"最大回撤")
```

> **说明**：单笔统计无组合净值曲线，"最大回撤"退化为**最差单笔收益** `worst_trade_ret`（逐笔 `ret` 最小值），字段语义在 03 文档表注明，避免与 backtest 的净值回撤混淆。

**边界处理（必须落 fail-safe，不得除零崩）**：

| 情形 | profit_factor | 赔率 b | 凯利 f* |
|---|---|---|---|
| `losses` 为空（无亏损样本） | `null`（标记"无亏损样本"） | `null` | `null` |
| `N = 0`（无有效样本） | `null` | `null` | `null`，且 run 标记"零样本"warn |
| `wins` 为空（全亏） | `0`（Σwins=0） | `null`（avgWin 无样本） | `null`（b 不可用，避免除零） |

> 凯利 `f*` 仅在赔率 `b != null 且 b > 0` 时可算，否则一律 `null`（不得用 `b=0` 反算导致除零）。`avg_win/avg_loss` 对空集取 `null`（不编造 0）。

前端对 `null` 显示 "—"。`ret = 0` 的样本计入 `N` 与 `avg_hold_days`，但不计入 wins/losses（与 `report.ts` 的 `pnl>0`/`pnl<0` 分组一致，`pnl=0` 不归任一组）。

> **恒等式注记**：仅当**无 `ret=0` 样本**时，`profit_factor == p/(1−p) × b` 才成立（此时 `p/(1−p) = |wins|/|losses|`）。一旦存在 `ret=0` 样本，`N` 含零样本使 `p/(1−p) ≠ |wins|/|losses|`，两者发散——**实现一律以 `Σwins/|Σlosses|` 直接计算**，不得用恒等式反推。`profit_factor` 与 `kelly f*` 各自独立从样本直接算。

## 脚注：真 DB 核实的列名（2026-06-07 亲查）

- `raw.daily_quote`：`ts_code, trade_date(varchar8), open, high, low, close, pre_close, pct_chg, qfq_open, qfq_close, qfq_pre_close`；唯一键 `(ts_code, trade_date)`。`qfq_open/qfq_close` 全表非空。
- `raw.adj_factor`：因子列名就是 `adj_factor`（本功能用 qfq 列，**不**需要 join 此表）。
- `raw.trade_cal`：`exchange(SSE), cal_date(char8), is_open(smallint), pretrade_date`；主键 `(exchange, cal_date)`。
- `raw.stk_limit`：`ts_code, trade_date(char8), pre_close, up_limit, down_limit`；主键 `(ts_code, trade_date)`。
- `public.a_share_symbols`：`ts_code, list_date(varchar), delist_date(varchar), list_status`；主键 `ts_code`。
- `raw.suspend_d`：`ts_code, trade_date, suspend_type(S=停牌/R=复牌)` — **本功能不使用**（停牌走隐式口径）。

**停牌隐式口径的源头验证（2026-06-07 亲查，data-integrity 落实）**：对 `suspend_d` 中 2024-2025 全部 `suspend_type='S'` 记录左连 `daily_quote`——6891 条停牌中**仅 80 条（1.2%）有 quote 行**，98.8% 全天停牌日**无 quote 行**（样本 000691.SZ/600721.SH 等 20251231 全天停牌，`quote_rows=0`）。那 80 条是**盘中临时停牌**（开盘正常交易、有 `qfq_open`），T+1 开盘买得进，隐式口径**不剔除它们是正确的**。对照 `suspend_type='R'`（复牌）902 条中 879 条有正常 quote 行——印证**不能**用 `suspend_d` 存在性判停牌（会误杀复牌日），隐式口径（"T+1 取不到 `qfq_open` 才剔除"）天然规避此坑，且在 T+1 开盘入场口径下比 quant 的 `suspend_d` 全剔除**更精确**。

[← index](./index.md) ｜ [下一篇：03 数据模型 →](./03-data-model.md)
