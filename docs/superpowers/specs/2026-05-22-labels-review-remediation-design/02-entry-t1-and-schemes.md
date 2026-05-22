# 02 — T+1 入场改造与两 scheme 口径

> 覆盖评审第 3 条（入场日错位，🔴）、第 4 条（fallback 成本口径，🔴）。
> 上游：[01](./01-common-and-adjustment.md)（`close_adj` 列契约）。

## <a id="item-3"></a>1. T+1 入场改造（评审第 3 条）

### 1.1 问题与决策

`strategy_aware.py:343-346` 自承「M2 简化：signal_date 与 buy_date 同日」，即把信号日
当入场日。doc/04 §4.2.3 要求 T 日信号 → T+1 入场。

当前 T 入场**不构成前视偏差**（factor 用 ≤D 数据、label 用 ≥D 数据，在 D 收盘对接），
但它假设「按 D 收盘价买入」—— 实盘算完因子才知信号，只能 D+1 买，标签入场价是实盘
拿不到的，存在系统性乐观偏差。「含糊」的真正所在：`factors.labels` 表没有任何地方
声明 `trade_date` 是入场日还是信号日。

**用户决策：本次切真 T+1 入场**，对齐 doc/04。

### 1.2 改造设计

```text
   signal day T              buy day T+1            ...持仓...      exit day
 ┌────────────────┐   ┌──────────────────────┐               ┌──────────────┐
 │ 因子在 T 收盘算 │ ─▶│ buy_price = T+1 close_adj│ ─simulate_exit─▶│ exit_price  │
 └────────────────┘   └──────────────────────┘               └──────────────┘
 factors.labels.trade_date = T（信号日）   5 个坑过滤 / 模拟均以 buy_date=T+1 为准
```

**改动点：**

1. **`runner.py:233-236`** 的 `entries` 含义改为「信号日 T」（范围仍
   `start ≤ trade_date ≤ end`，SQL/切片不变，仅语义与注释更新）。

2. **`compute_strategy_aware_labels`（`strategy_aware.py:360-371`）构造 `cand` 时派生
   `buy_date` 列**：
   - `trade_dates_sorted`（原 `strategy_aware.py:378` 已有，= quotes 内全部 trade_date
     升序去重）即窗口交易日历。
   - `buy_date = trade_dates_sorted` 中 `signal_date` 的**下一个**元素。
   - `signal_date` 是窗口最后一个交易日、取不到下一日 → 跳过该候选（边界样本，正常）。
   - `end_padded` 缓冲（见 [03 §item-5](./03-exit-rules-fixes.md#item-5)）保证 `[start,end]`
     内的信号日总能取到 T+1。
   - `cand` 列变为 `[ts_code, signal_date, buy_date]`。

3. **5 个坑过滤全部以 `buy_date` 为准**：`filter_limit_up_on_entry` /
   `filter_suspended_on_entry` / `filter_new_listing` 调用时 `entry_col="buy_date"`
   （这三个函数早已带 `entry_col` 参数，本就是为 T+1 预留的）。

4. **`simulate_exit(buy_date=buy_date, ...)`**；`entry_close` 在 `buy_date` 行查
   （`strategy_aware.py:431-434`）；`gross` 用 `buy_date` 的 `close_adj`
   （见 [01 §2.5](./01-common-and-adjustment.md#apply_hfq)）。

5. **输出 `trade_date = signal_date`**（`strategy_aware.py:438-447` 的 record 字典里
   `"trade_date": signal_date`，不是 `buy_date`）。与 doc/04 §4.2.3、`fallback.py:16`
   一致。

6. **docstring 更新**：删 `strategy_aware.py:343-346` 的「M2 简化：signal 与 buy 同日」，
   改为如实描述 T+1；模块顶部「5 个坑」表述保持（坑 1/2 本就写 T+1）。

### 1.3 测试要点

- 断言：给定信号日 T，`buy_date` = `trade_dates_sorted` 中 T 的下一个。
- 断言：输出行的 `trade_date` 等于信号日，且 ∈ `[start, end]`。
- 断言：T+1 涨停/停牌的候选被 `filter_*` 剔除（`entry_col="buy_date"` 生效）。
- 断言：信号日为窗口末日时该候选被跳过、不抛错。

## <a id="item-4"></a>2. 两 scheme 口径文档（评审第 4 条）

### 2.1 问题与决策

`fallback.py:94` 的 `value = c_t5/c_t - 1` 不扣成本（毛收益）；`strategy_aware.py:443`
是 `gross - ROUND_TRIP_COST`（净收益）。两 scheme 写同一张 `factors.labels`、被同一套
training 消费，切 scheme 重训时标签均值系统性偏移 0.3%，且无任何说明。

**用户决策：fallback 保留毛收益，不改算法**，理由：`fwd_5d_ret` 的设计用途是学术
baseline / 单因子 IC 研究，学术惯例用毛收益。仅通过文档显式声明两 scheme 口径差异，
消除「静默不一致」。

### 2.2 改动

`fallback.py` **算法不动**：仍 `close_adj[t+5]/close_adj[t] - 1`（毛收益，
`trade_date = t`）。注意 `c_t/c_t5` 改取 `close_adj`（复权，见
[01 §2.5](./01-common-and-adjustment.md#apply_hfq)）。

三处显式声明口径差异：

- **`fallback.py` docstring**：`value` 为**毛收益**（未扣交易成本）；`fwd_5d_ret` 是
  **T 日起算**的简单前向收益，无 T+1 入场概念。
- **`strategy_aware.py` docstring**：`value` 为**净收益**（已扣 `ROUND_TRIP_COST`
  双边成本）；strategy-aware 为 **T+1 入场**。
- **`factors.labels` 表加 `COMMENT`**（见 §3）。

### 2.3 两 scheme 语义对照（写入文档，避免混淆）

```text
              trade_date        入场时点      value 口径       horizon
strategy-aware  信号日 T         T+1（买入）   净收益（扣成本）  止损/MA5/max_hold 模拟
fwd_5d_ret      信号日 T = t     T（起算）     毛收益（不扣）    固定 5 交易日
```

## 3. alembic migration：`factors.labels` 表注释

新建 alembic migration（`apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/`，
紧接 `20260517_0001_factors_ml_initial.py` 之后），对 `factors.labels` 加列注释：

```sql
COMMENT ON COLUMN factors.labels.trade_date IS
  '信号日（YYYYMMDD）。strategy-aware：T+1 入场；fwd_5d_ret：T 日起算。';
COMMENT ON COLUMN factors.labels.value IS
  '标签收益率。strategy-aware=净收益（扣双边成本 ROUND_TRIP_COST）；'
  'fwd_5d_ret=毛收益（不扣成本，学术 baseline 口径）。';
```

- `upgrade()` 加注释，`downgrade()` 置空注释（`COMMENT ... IS NULL`）。
- `factors.labels` 是 `PARTITION BY RANGE (trade_date)` 的分区表，`COMMENT ON COLUMN`
  对分区表父表有效，无需逐分区处理。
- 本仓库 quant-pipeline 用 alembic（见 `db/migrations/versions/`），故走 alembic 而非
  `apps/server/migrations/*.sql`。

## 4. 上线影响（重申）

strategy-aware 切 T+1 后口径变化，`factors.labels` 存量 `scheme='strategy-aware'`
行作废，须全量重跑。详见 [index.md「上线注意事项」](./index.md#上线注意事项)。
