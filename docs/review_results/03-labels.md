# Code Review：`labels/` 标签子系统

> 评审对象：`apps/quant-pipeline/src/quant_pipeline/labels/`（含被依赖的 `strategy/exit_rules.py`）
> 涉及文件：`runner.py` `strategy_aware.py` `fallback.py` `strategy/exit_rules.py`
> 评审重点：标签计算正确性、数据泄漏/前视偏差、数据完整性、性能。
> 使用方式：新会话打开本文，逐条核实后再修复。

## 🔴 严重

### 1. 复权缺失 —— 标签收益率被分红/拆股污染（确凿正确性 Bug，最高优先级）
`labels/runner.py:49-71` `_load_daily_quotes` 直接 `SELECT q.close FROM raw.daily_quote`，从不触碰 `raw.adj_factor`。但三处文档都明确要求后复权：
- `fallback.py:13` 「后复权 close（runner 用 raw.adj_factor 反推）」
- `strategy_aware.py:14` 「buy_price = T+1 日 close（含复权）」
- `exit_rules.py:60` ExitState 字段注释「当日 close（含复权）」

后果：任何在持有期内发生分红/送转/配股的票，`close` 出现非交易性跳变。`fwd_5d_ret = c_t5/c_t - 1` 与 `gross = exit_price/entry_close - 1` 都会把除权缺口当成真实收益，**直接污染训练标签**。除权缺口常达数个百分点，远超 -8% 止损量级，还会误触 `StopLossRule`。
**修复**：`_load_daily_quotes` JOIN `raw.adj_factor`，计算 `close * adj_factor`（后复权）再返回；`low`（若启用）同样复权。

### 2. `simulate_exit` 不接受 `suspend_dates`，停牌入场过滤后持仓期停牌可能全部失效
`strategy_aware.py:419-425` + `exit_rules.py:274-281`。模块顶部接口契约（`exit_rules.py:22`）写 `simulate_exit(..., suspend_dates=None, force_close_date=None)`，但实际函数签名（274 行）**没有 `suspend_dates` 参数**。停牌信息只能通过 `prices_df` 的 `is_suspended` 列传入。

`_augment_quotes_for_exit`（296 行）确实注入了 `is_suspended` 列，链路是通的。但 `simulate_exit` 切片 `sub = prices[prices["trade_date"] >= buy_date]` —— 若某票在停牌期间 `raw.daily_quote` 根本没有行（A 股停牌日通常无 quote 行），`is_suspended` 列对这些日子不存在，模拟器会把「停牌后复牌」的下一交易日当成连续持仓日，`hold_days` 偏小。
**修复**：确认 `raw.daily_quote` 是否给停牌日留空行；若否，「持仓期停牌挂起」实际从未生效，需把 `suspend_d` 真正传进模拟器，或在 quotes 里补停牌占位行。

### 3. `entries` 入场日范围错位 —— 信号日 = 入场日，与 doc/04 的 T+1 规范不一致
`runner.py:233-236` `entries` 限定 `start <= trade_date <= end`。`strategy_aware.py` 文档（344-347 行）自承「M2 简化：signal_date 与 buy_date 同日」，即 `trade_date` 字段写的是**入场日**，不是信号日。

doc/04 §4.2.3 要求 T 日信号→T+1 入场，当前实现是 T 日信号→T 日入场。若下游 features 假设 T+1 入场而标签实为 T 日入场，收益对齐错位一个交易日。
**修复**：要么按文档切到 T+1 入场（`buy_date` 取 `entry_date` 的下一交易日，`trade_date` 仍写 signal T），要么在 `factors.labels` schema 注释和 features 层显式声明「trade_date 即入场日」。二者必须有一个，不能含糊。

### 4. fallback `fwd_5d_ret` 不扣成本，与 strategy-aware 标签不可比
`fallback.py:94` `value = c_t5 / c_t - 1.0` 无 `ROUND_TRIP_COST`；strategy-aware 是 `gross - ROUND_TRIP_COST`（0.003）。两个 scheme 写进同一张 `factors.labels` 表、被同一套 training 消费。切 scheme 重训时标签均值系统性偏移 0.3%，且无任何注释说明差异。
**修复**：要么 fallback 也扣成本，要么在文档/列里明确两 scheme 的 value 口径不同。

## 🟡 中等

### 5. `runner.py:217` — `end_padded` 缓冲 45 自然日可能不够覆盖 `MAX_HOLD_DAYS=20` 个交易日
20 个交易日在长假前可跨 ~30 自然日，叠加持仓期停牌挂起，45 天可能不足。一旦 quotes 尾部不够，`simulate_exit` 走「数据末尾 force_close」分支，把本应 `max_hold` 的样本误标成 `force_close` 且收益截断——静默错误，无告警。
**修复**：缓冲改为按交易日历取 `end` 之后第 25~30 个交易日；或 simulate_exit 命中「数据末尾」分支且 `hold_days < MAX_HOLD_DAYS` 时 `logger.warning`。

### 6. `strategy_aware.py:240-245` — `derive_limit_up_set` 用 `iterrows` 逐行，大数据集性能差
全市场百万级行。`derive_suspended_set`（253）、`derive_delist_map`（262）、`derive_list_date_map`（268）、`fallback.py` 主循环也都逐行。
**修复**：向量化，如 `hit = m["close"] >= m["up_limit"] * (1 - tolerance)` 后 `set(zip(...))`。`compute_strategy_aware_labels` 的主模拟循环（409 行）难向量化，可接受。

### 7. `strategy_aware.py:161-171` — `filter_new_listing` 用 `apply(axis=1)`，可向量化
先 `map` 出 `list_idx` 和 `buy_idx` 两列再做向量比较。

### 8. `strategy_aware.py:181-198,429` — 退市 force_close 双重判定，`apply_delisting_force_close` 兜底逻辑有缺陷
`simulate_exit` 已接收 `force_close_date` 并内部正确强平（346 行）。429 行又调 `apply_delisting_force_close`，当前是无害死代码；但该函数改 reason 不改 value/exit_price，会产生 reason 与 value 不自洽的矛盾记录。
**修复**：删掉 429 行兜底调用，或让该函数同时重算 exit_price。

### 9. `exit_rules.py:346-355` — 持仓中段退市时 force_close 落在退市当日，退市日常无有效 quote
退市日 quote 不存在则落「数据末尾 force_close」分支取最后一行 close（尚可接受）；若退市日 quote 是停牌占位（close=NaN），走 `entry_price` 兜底 → **收益恒为 0**，错误强平价。
**修复**：force_close 分支 close 兜底应回溯找最近有效 close，而非用 `entry_price`。

### 10. 空数据静默跳过，违反 CLAUDE.md 硬约束
- `runner.py:225` `quotes.empty` → `logger.warning` + `return 0`，job 看似「成功」实则一行未写。
- `_load_stk_limit`（85 行）空返回**无 warning**，而 `_load_suspend`（107 行）有，不一致。stk_limit 空意味着涨停过滤完全失效。
- `fallback.py:54` quotes 空仅 warn 返回空表。
**修复**：labels job 在 quotes/labels_df 为空时应抛错或标记 failed，不能 `return 0`；`_load_stk_limit` 空补 `logger.warning`。

## 🟢 建议

- **11.** `runner.py:234` 用字符串比较日期依赖 `YYYYMMDD` 定宽，建议加注释说明前提。
- **12.** `exit_rules.py:22` 接口契约文档与实际签名不符（写了 `suspend_dates` 实际无）。
- **13.** 未使用 import：`strategy_aware.py:42` `Iterable`、`44` `Any`、`exit_rules.py:29` `Iterable`。
- **14.** `strategy_aware.py:201-214` `winsorize_label_value` 是 dead code 占位，注释自承 runner 不调用。
- **15.** 进度回调魔数（`strategy_aware.py:411` 的 `10 + int(50*...)` 等）散落两处，建议集中常量。
- **16.** fallback 与 strategy_aware 的 `_empty()`、dedup、`derive_*` 重复，建议抽 `labels/_common.py`。`strategy_aware.py` 498 行逼近 500 行红线，新增功能前应先拆分。

## 总评

骨架清晰、坑位拆分规范、去重双保险到位，但**最致命的是 `_load_daily_quotes` 从未做后复权**——三处文档都声称后复权 close，实现却用裸 `raw.close`，会让所有跨除权日的标签收益率被系统性污染并误触止损，必须立即修复；其次是「M2 简化」把信号日与入场日合并、与所引 doc/04 的 T+1 规范不一致；空数据 `return 0` 伪装成功也违反 CLAUDE.md 硬约束。
