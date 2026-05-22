# 04 — 空数据硬约束、性能向量化与清理

> 覆盖评审第 10 条（空数据，🟡）、第 6/7 条（性能，🟡）、第 11/13/14/15 条（建议，🟢）。
> 上游：[01](./01-common-and-adjustment.md)（`_common.py` 已建）。

## <a id="item-10"></a>1. 空数据硬约束（评审第 10 条）

违反 CLAUDE.md 硬约束「空数据 `return 0` 伪装成功」。

```text
  compute_labels()
    │
    ├─ quotes = _load_daily_quotes(...)
    │     └─ quotes.empty  ❌ 现: logger.warning + return 0   ✅ 改: raise RuntimeError
    │
    ├─ stk_limit = _load_stk_limit(...)
    │     └─ 空          ❌ 现: 静默返回（涨停过滤全失效）   ✅ 改: logger.warning
    │
    └─ labels_df = compute_*(...)
          └─ labels_df.empty  ❌ 现: logger.warning + return 0  ✅ 改: raise RuntimeError
```

### 1.1 修复

1. **`runner.py:225` `quotes.empty`** → `raise RuntimeError`，message 含 `date_range` /
   `scheme` / `end_padded`。窗口内一行 `daily_quote` 都没有是确凿数据缺口。
2. **`labels_df.empty` 抛错 —— 但要分清判定时机**：
   - `compute_strategy_aware_labels` / `compute_fwd_5d_ret` 的**原始输出**为空 →
     `raise RuntimeError`（candidates 被过滤光、模拟全失败属真异常）。判定点放在
     `compute_*` 调用返回后、**fallback 的 `[start,end]` 区间过滤之前**。
   - ⚠️ fallback 路径 `runner.py:263-265` 在 `compute_fwd_5d_ret` 之后还做一次
     `[start,end]` 区间过滤。`compute_fwd_5d_ret` 用 `end_padded` 的 quotes，每只票
     末 5 行被 shift 丢弃属正常；若查询区间很短且都临近 `end`，**区间过滤后**合法地
     为空。故区间过滤**之后**再为空 → 只 `logger.warning` + `return 0`，不 raise
     （避免把正常的小区间查询误判为失败）。
   - message 含 `date_range` / `scheme`。
3. **`_load_stk_limit`（`runner.py:84-85`）空返回补 `logger.warning`** —— 与
   `_load_suspend`（`runner.py:107` 已有）对齐。message 注明「stk_limit 为空 → 本次
   涨停过滤失效」。
4. **worker 链路**：`runner_entrypoint`（`runner.py:287-306`）**不捕获** `compute_labels`
   抛出的 `RuntimeError`，让其传播到 `worker.dispatcher`，job 标记 failed。
   - 验证项：确认 `worker.dispatcher` 对 runner 抛出的异常确实标记 job failed，而非
     吞掉。若 dispatcher 当前会吞，需在 dispatcher 层补 failed 标记（超出本文件域时
     在实现中单列）。

### 1.2 连带影响

[01](./01-common-and-adjustment.md) 的复权改动若遇 `adj_factor` 全缺，`close_adj` 全
NaN → 标签算不出 → `labels_df.empty` → 走新 `raise` → 复权数据缺口也被这条硬约束
响亮暴露，而非静默产出空表。

`fallback.py:54` 自身的 quotes 空守卫保留（防御性）；因 runner 已在调用前 `raise`，
该分支经 runner 不再可达，仅作直接调用时兜底。

### 1.3 测试要点

- 断言 `quotes` 为空时 `compute_labels` 抛 `RuntimeError`。
- 断言 `labels_df` 为空时 `compute_labels` 抛 `RuntimeError`。
- 断言 `_load_stk_limit` 空时触发 warning。

## <a id="item-6"></a>2. `derive_*` 与 fallback 主循环向量化（评审第 6 条）

全市场百万级行，多处 `iterrows`。**纯重构，行为不变** —— 每个改造点配「新旧结果
完全一致」断言测试。以下函数均在 [01 §1](./01-common-and-adjustment.md#common-module)
迁入 `_common.py`，向量化在迁入时一并完成。

### 2.1 `derive_*` 系列

| 函数（原 `strategy_aware.py` 行号） | 向量化 |
|---|---|
| `derive_limit_up_set`（234-245） | `merged` 后布尔掩码 `hit = close.notna() & up.notna() & (close >= up*(1-tol))`，`set(zip(merged.loc[hit, "ts_code"], ...))`。用 **raw `close`**（见 [01 §2.5](./01-common-and-adjustment.md#apply_hfq)） |
| `derive_suspended_set`（248-256） | `set(zip(suspend_d["ts_code"].astype(str), suspend_d["trade_date"].astype(str)))` |
| `derive_delist_map`（259-262） | `dict(zip(delist["ts_code"].astype(str), delist["delist_date"].astype(str)))` |
| `derive_list_date_map`（265-268） | `dict(zip(listing["ts_code"].astype(str), listing["list_date"].astype(str)))` |

### 2.2 `fallback.py` 主循环（`compute_fwd_5d_ret`，原 73-104）

`groupby` + `for i in range(...)` 双层循环改为 groupby-shift 一次成型：

```text
quotes.sort_values([ts_code, trade_date])
   g = groupby(ts_code, sort=False)
   c_t5        = g["close_adj"].shift(-FWD_HORIZON_DAYS)   # 组内 shift，不跨票
   t_plus_date = g["trade_date"].shift(-FWD_HORIZON_DAYS)
   value = c_t5 / c_t - 1                                  # 毛收益（02 §item-4）
   丢弃 t_plus_date 为 NaN 的尾部行（每票末 5 行）
   丢弃 c_t 非有限 / ≤0、c_t5 非有限 的行
   停牌掩码: Series(zip(ts,t)).isin(suspended_set) | Series(zip(ts,t_plus)).isin(...)
   退市掩码: t_plus_date >= ts_code.map(delist_map)（delist 非空时）
   保留行 → 组装 records → _common.dedup_labels
```

- `c_t` = `close_adj`（复权，见 [01 §2.5](./01-common-and-adjustment.md#apply_hfq)）。
- 输出列、`exit_reason="fwd_horizon"`、`hold_days=FWD_HORIZON_DAYS` 与现状一致。

## <a id="item-7"></a>3. `filter_new_listing` 向量化（评审第 7 条）

`strategy_aware.py:161-178` 的 `apply(_ok, axis=1)` 改为两列 `map` + 向量比较：

```text
td_to_idx = {d: i for i, d in enumerate(trade_dates_sorted)}
buy_idx   = entries[entry_col].astype(str).map(td_to_idx)
list_date = entries["ts_code"].astype(str).map(list_date_map)
list_idx  = list_date.map(td_to_idx)
keep = list_date.isna() | list_idx.isna() | buy_idx.isna()
       | ((buy_idx - list_idx) >= min_days)
```

保留语义与现 `_ok` 完全一致：`list_date` 缺失、或日期不在交易日历 → 保留（`keep`）。
`dropped > 0` 时 `logger.warning` 保留。

> `compute_strategy_aware_labels` 的主模拟循环（`strategy_aware.py:409`）**不向量化**
> —— `simulate_exit` 是带状态的逐日推进，难向量化，评审第 6 条亦明确「可接受」。

## 4. 清理项（评审第 11、13、14、15 条）

### <a id="item-11"></a>4.1 日期字符串比较前提（第 11 条）

`runner.py:233-234` 等处对 `trade_date` 字符串做 `>=` / `<=` 比较，依赖 Tushare
`YYYYMMDD` 定宽格式（字典序 == 时序）。在 `runner.py:233-234`（及 `compute_labels`
内其它字符串日期比较处）加注释：

```python
# trade_date 为 Tushare YYYYMMDD 定宽字符串，字典序即时序，可直接做字符串比较
```

### <a id="item-13"></a>4.2 未使用 import（第 13 条）

- `strategy_aware.py:42` 删 `Iterable`（`from collections.abc import Iterable, Mapping`
  → 保留 `Mapping`）。
- `strategy_aware.py:44` 删 `Any`（`from typing import Any, Callable, Final` → 保留
  `Callable, Final`）。
- `exit_rules.py:29` 删 `Iterable`（`from collections.abc import Iterable, Sequence`
  → 保留 `Sequence`）。

改完按 CLAUDE.md 约束**回读文件头部验证 import 顺序**，不依赖 linter。

### <a id="item-14"></a>4.3 `winsorize_label_value`（第 14 条）—— ⚠️ 实施后修正：非死代码，保留

**评审第 14 条的「死代码」前提有误。** 评审依据是 docstring「labels.runner 不调用」，
但实测 `features/builder.py:28-35,434` **正在 import 并调用** `winsorize_label_value`
及 `WINSORIZE_LO/HI` 常量 —— 它是 features 层的真实依赖，删除会破坏 `features/builder.py`。

**实际处置（已实施）：**

- **保留** `winsorize_label_value` 函数、`WINSORIZE_LO/HI` 常量、`__all__` 中三个名字。
- 仅修正其 docstring 与模块「5 个坑」坑 5 描述，如实说明：labels.runner 不调用本函数，
  实际消费方是 `features/builder.py`（坑 5 截尾在 features 层完成）。
- **未决项**：`winsorize_label_value` 物理上在 `labels/strategy_aware.py`、消费方在
  `features/`，依赖方向略反常。是否把它迁到 `features/` 层属 spec 范围外重构，留待
  后续单独决定，本次不动。

### <a id="item-15"></a>4.4 进度回调魔数（第 15 条）

进度数字散落两处：`runner.py` 的 `_progress(10/60/100, ...)`、`strategy_aware.py:411`
的 `10 + int(50 * i / total)`。全部改用 [01 §1](./01-common-and-adjustment.md#common-module)
在 `_common.py` 定义的常量：

```text
runner.py        _progress(PROGRESS_LOAD, ...)            # 原 10
                 _progress(PROGRESS_COMPUTE_DONE, ...)    # 原 60
                 _progress(PROGRESS_DONE, ...)            # 原 100
strategy_aware   pct = PROGRESS_SIMULATE_START
                       + int(PROGRESS_SIMULATE_SPAN * i / total)   # 原 10 + int(50*..)
```

## 5. 本文件改动小结

| 文件 | 改动 |
|---|---|
| `runner.py` | quotes/labels 空改 `raise`；`_load_stk_limit` 空补 warning；进度魔数改常量；日期比较加注释 |
| `strategy_aware.py` | `derive_*` 迁出并向量化；`filter_new_listing` 向量化；`winsorize_label_value` 保留（非死代码，仅改 docstring）；删未用 import；进度魔数改常量 |
| `fallback.py` | `compute_fwd_5d_ret` 主循环向量化；`_empty()` 改用 `_common.empty_labels_frame`；dedup 改用 `_common.dedup_labels` |
| `_common.py` | 承接迁入的 `derive_*`（向量化版）、`empty_labels_frame`、`dedup_labels`、`PROGRESS_*` |
