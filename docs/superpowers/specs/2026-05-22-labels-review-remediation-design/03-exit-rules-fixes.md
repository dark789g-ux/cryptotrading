# 03 — `exit_rules.py` / `simulate_exit` 修复

> 覆盖评审第 2 条（停牌，🔴→🟢 降级）、第 5 条（缓冲不足，🟡）、第 8 条（退市双判，
> 🟡）、第 9 条（force_close NaN，🟡）、第 12 条（契约文档，🟢）。
> 文件域：`strategy/exit_rules.py` + `labels/runner.py` + `labels/strategy_aware.py`。
> `exit_rules.py` 部分文件域独立，可与 [01](./01-common-and-adjustment.md) 阶段 C/D 并行。

## <a id="item-2"></a>1. 停牌处理 —— 文档级修复（评审第 2、12 条）

### 1.1 评审第 2 条降级依据

评审第 2 条原判为 🔴 严重，担心「持仓期停牌挂起从未生效」「hold_days 偏小」。
经 `tushare-sync-dev` 查证 `daily` 接口官方文档原文：**「停牌期间不提供数据」**。

推论链：

```text
Tushare daily 停牌日无数据
        │
        ▼
raw.daily_quote 停牌日无行
        │
        ├─▶ _augment_quotes_for_exit 把 suspended_set merge 到 quote 行上，
        │   但「有 quote 行」⟺「当天交易了」⟺「非停牌」
        │   ⟹ is_suspended 列几乎恒为 False
        │
        └─▶ simulate_exit 的 sub 里停牌日根本不存在 ⟹ 被自然跳过
            ⟹ hold_days 只数实际交易日 ⟹ 恰好符合 ExitState.hold_days
               注释「停牌日不计」的规范
```

结论：评审所述「收益污染 / 误标」**不成立**，停牌挂起的行为本身是对的。
`exit_rules.py` 里 `if is_suspended: continue` 分支是冗余防御代码（near-dead），无害。

### 1.2 真正的缺陷 —— 文档不实

- `exit_rules.py:22-23` 接口契约 docstring 写了 `simulate_exit(..., suspend_dates=None,
  force_close_date=None)`，但实际签名（`exit_rules.py:274-281`）**没有 `suspend_dates`
  参数**（评审第 12 条同此）。
- `strategy_aware.py:24-25` 注释把机制说成「持仓期停牌挂起由 exit_rules 内部处理」，
  实际机制是「停牌行缺失被自然跳过」。

### 1.3 修复（仅文档，不加参数）

1. `exit_rules.py:22-23` 契约 docstring 改为与实际签名一致：
   `simulate_exit(buy_date, ts_code, prices_df, rules, *, force_close_date=None)`，
   删除 `suspend_dates`。
2. `exit_rules.py` 的「设计原则 3.」与 `simulate_exit` docstring「停牌处理」段，补一句：
   「A 股停牌日 `raw.daily_quote` 无行（Tushare `daily` 停牌不提供数据），停牌日因
   缺行被自然跳过；`is_suspended` 列为冗余防御，正常数据下恒 False。」
3. `strategy_aware.py:24-25` 注释如实描述上述机制。

**不新增 `suspend_dates` 参数** —— 它只会制造一个永远走不到的入口（YAGNI）。

## <a id="item-5"></a>2. `end_padded` 缓冲不足（评审第 5 条）

### 2.1 问题

`runner.py:217` 用 `end + 45 自然日` 作缓冲，让 `simulate_exit` 能模拟尾部入场的完整
持仓。但 `MAX_HOLD_DAYS=20` 个交易日在长假前可跨 ~30 自然日，45 自然日可能不足。
数据尾部不够时 `simulate_exit` 走「数据末尾 force_close」分支（`exit_rules.py:427-438`），
把本应 `max_hold` 的样本误标成 `force_close` 且收益截断 —— 静默错误。

### 2.2 修复

1. **`end_padded` 改按交易日历取**：查 `raw.trade_cal`（`is_open=1`），取 `end` 之后
   第 30 个交易日作为 `end_padded`（30 > `MAX_HOLD_DAYS=20` + T+1 入场偏移 + 余量）。
   参考 `factors/runner.py` 的 `_query_trade_dates` 查交易日历的写法。
   - 若 `raw.trade_cal` 在 `end` 之后不足 30 个交易日（数据本身到期）→ 取能取到的
     最后一日，并 `logger.warning`。
2. **截断暴露**：`compute_strategy_aware_labels` 主循环拿到 `outcome` 后，若
   `outcome.exit_reason == EXIT_FORCE_CLOSE` 且 `outcome.hold_days < MAX_HOLD_DAYS`
   且 `ts_code` 不在 `delist_map`（排除真退市）→ `logger.warning`
   （`labels_force_close_truncated`，extra 带 `ts_code`/`signal_date`/`hold_days`），
   把疑似「数据末尾截断」从静默变可见。

### 2.3 测试要点

- 断言 `end_padded` 是 `end` 之后第 30 个 `is_open=1` 交易日。
- 构造尾部数据不足的票，断言触发 `labels_force_close_truncated` warning。

## <a id="item-8"></a>3. 退市 force_close 双重判定（评审第 8 条）

### 3.1 问题

`compute_strategy_aware_labels` 已经把 `force_close_date=delist_map.get(ts_code)` 传给
`simulate_exit`（`strategy_aware.py:424`），`simulate_exit` 在规则判定之前优先处理
`force_close_date`（`exit_rules.py:345-355`）。`strategy_aware.py:429` 又调
`apply_delisting_force_close` 做兜底。

正常路径下 429 行是 no-op。但 `limit_down` 顺延（`exit_rules.py:396-416`）的
`_find_first_tradable` 可能把 `exit_date` 推到退市日之后，此时 429 行会把 `exit_reason`
改成 `force_close` 却不改 `exit_price`/`value` → 产生 reason 与 value 不自洽的记录。

### 3.2 修复

1. 删除 `strategy_aware.py:429` 的 `apply_delisting_force_close(...)` 兜底调用。
2. `apply_delisting_force_close` 函数随之完全无引用 → **一并删除函数本体**
   （`strategy_aware.py:181-198`），并从 `__all__` 移除。
3. 「5 个坑」docstring 坑 4 条目改为：「退市：force_close 完全由 `simulate_exit` 的
   `force_close_date` 入参处理，无独立函数」。

> 退市 force_close 的正确性由 `simulate_exit` 单独保证，见 §4。

## <a id="item-9"></a>4. force_close NaN close 兜底缺陷（评审第 9 条）

### 4.1 问题

`exit_rules.py` 有 4 处在 close 为 NaN 时用 `entry_price` 兜底：

- `exit_rules.py:335`（退市分支）
- `exit_rules.py:347`（`force_close_date` 分支）
- `exit_rules.py:371`（持仓中 close NaN 分支）
- `exit_rules.py:430`（数据末尾分支）

用 `entry_price` 兜底 → `exit_price == entry_price` → `gross = entry/entry - 1 = 0`，
错误强平价（收益恒为 0）。虽然 NaN-close 行因「停牌无行」很少见，退市日占位行等
边缘情况仍可能触发。

### 4.2 修复

新增私有助手 `_last_valid_close(sub, up_to_idx)`：从 `up_to_idx` 起**向前回溯**，
返回第一个有限（`np.isfinite`）的 `close` 值；全程无有效值时再退回 `entry_price`
（保留最末兜底，避免无解时崩溃）。

```python
def _last_valid_close(sub: pd.DataFrame, up_to_idx: int, entry_price: float) -> float:
    """从 up_to_idx 向前（含）回溯最近一个有限 close；找不到退回 entry_price。"""
    for j in range(up_to_idx, -1, -1):
        c = float(sub.iloc[j]["close"])
        if np.isfinite(c):
            return c
    return entry_price
```

4 处兜底统一改用 `_last_valid_close`。注意：

- 该函数接收的 `sub` 是 `simulate_exit` 内已切片、按日升序的 DataFrame；`up_to_idx`
  为当前行下标 `i`（退市/数据末尾分支用对应下标）。
- `sub` 的 `close` 列在 strategy-aware 路径下已是 `close_adj`（见
  [01 §2.6](./01-common-and-adjustment.md#apply_hfq)），回溯到的也是复权价，口径一致。

### 4.3 测试要点

- 构造退市日 close 为 NaN、前一交易日 close 有效的 `sub`，断言 force_close 的
  `exit_price` 取前一日有效 close 而非 `entry_price`。
- 构造全程 close 均 NaN 的极端 `sub`，断言退回 `entry_price` 不抛错。

## 5. 本文件改动小结

| 文件 | 改动 |
|---|---|
| `exit_rules.py` | 契约 docstring 修正（删 `suspend_dates`）；停牌机制注释补充；新增 `_last_valid_close`，4 处兜底改用它；删未用 import `Iterable`（见 [04 §item-13](./04-data-integrity-perf-cleanup.md#item-13)） |
| `strategy_aware.py` | 删 429 行兜底调用；删 `apply_delisting_force_close` 函数 + `__all__` 项；坑 4 docstring 更新；主循环加截断 warning |
| `runner.py` | `end_padded` 改交易日历口径 |
