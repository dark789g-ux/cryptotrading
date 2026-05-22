# 01 — `labels/_common.py` 与复权数据链路

> 覆盖评审第 1 条（复权缺失，🔴 最高优先级）、第 16 条（重复代码）。
> 上游：无。下游：[02](./02-entry-t1-and-schemes.md)、[03](./03-exit-rules-fixes.md)、
> [04](./04-data-integrity-perf-cleanup.md) 均依赖本文定义的 `daily_quotes` 列契约。

## <a id="common-module"></a>1. 新建 `labels/_common.py`（评审第 16 条）

`fallback.py` 与 `strategy_aware.py` 存在重复实现（`_empty()`、dedup 块），
`derive_*` 系列虽只在 `strategy_aware.py` 定义但属通用 raw→lookup 助手。新建
`apps/quant-pipeline/src/quant_pipeline/labels/_common.py` 收拢：

```text
labels/_common.py
├─ apply_hfq(df)                  后复权：注入 close_adj / low_adj（见 §2）
├─ empty_labels_frame()           取代 fallback._empty() + strategy_aware._empty_labels()
├─ dedup_labels(df, *, log_key)   取代两处重复的 drop_duplicates + warning 块
├─ derive_limit_up_set()          ┐
├─ derive_suspended_set()         │ 从 strategy_aware.py 迁入（向量化版见 04 §item-6）
├─ derive_delist_map()            │
├─ derive_list_date_map()         ┘
└─ 进度常量：
     PROGRESS_LOAD          = 10
     PROGRESS_SIMULATE_START= 10
     PROGRESS_SIMULATE_SPAN = 50
     PROGRESS_COMPUTE_DONE  = 60
     PROGRESS_DONE          = 100
```

约定：

- `ROUND_TRIP_COST` **不迁入** —— 评审第 4 条已定 fallback 不扣成本，该常量仅
  `strategy_aware.py` 使用，留在原处（`strategy_aware.py:63`）。
- `empty_labels_frame()` 返回列 `[trade_date, ts_code, scheme, value, exit_reason,
  hold_days]`，与 `factors.labels` 一致。
- `dedup_labels(df, *, log_key)`：按 `["trade_date","ts_code","scheme"]` 去重
  `keep="last"`，条数变化时 `logger.warning(log_key, extra={"raw":..,"deduped":..})`。
  `strategy_aware`（原 454-463 行）与 `fallback`（原 110-118 行）改调此函数。
- `derive_*` 迁入后，`runner.py`（原 `from ...strategy_aware import derive_delist_map,
  derive_suspended_set`）与 `strategy_aware.py` 内部调用改为 `from ...labels._common
  import ...`。`strategy_aware.__all__` 移除这 4 个名字。

## <a id="apply_hfq"></a>2. 复权数据链路（评审第 1 条）

### 2.1 问题

`labels/runner.py:54` 的 `_load_daily_quotes` 只 `SELECT q.close`，从不碰
`raw.adj_factor`。但三处文档都声称用后复权 close（`fallback.py:5/13/39`、
`strategy_aware.py:14`、`exit_rules.py:62-63`）。后果：跨分红/送转/配股的票，裸
`close` 出现非交易性跳变，`fwd_5d_ret` 与 `gross` 把除权缺口当真实收益，污染训练
标签，并误触 `StopLossRule`。

### 2.2 核心原则：raw close 与后复权 close 并存

涨停/跌停判定依赖 `raw.stk_limit` 的 `up_limit/down_limit`，那是 Tushare **原始
（未复权）限价**。若把 `close` 整体换成复权价、`up_limit` 仍为原始价，
`derive_limit_up_set` 的 `close >= up_limit*(1-tol)` 对所有经历过除权的票全错。

因此 `daily_quotes` DataFrame 必须同时携带原始价与复权价：

```text
        raw.daily_quote              raw.adj_factor
        close / low                    adj_factor
             │                              │
             └────────── LEFT JOIN ─────────┘
                          │
            _load_daily_quotes()  →  [ts_code, trade_date, close, low, adj_factor]
                          │
            _common.apply_hfq()
            close_adj = close * adj_factor / max(adj_factor per ts_code)
            low_adj   = low   * adj_factor / max(adj_factor per ts_code)
                          │
       ┌──────────────────┴────────────────────┐
       ▼                                       ▼
  raw close / low                       close_adj / low_adj
  ────────────────                      ────────────────────
  涨停/跌停判定（vs raw up_limit）       收益率 gross = exit/entry - 1
  derive_limit_up_set / down_set        exit 模拟（止损穿透 / MA5）
                                        ExitState.current_price/low_price/ma5
                                        fallback fwd_5d_ret
```

### 2.3 `_load_daily_quotes` 改造（`runner.py:49-70`）

SQL 加 `LEFT JOIN raw.adj_factor`，并补 `q.low`：

```sql
SELECT q.ts_code, q.trade_date, q.close, q.low, a.adj_factor
FROM raw.daily_quote q
LEFT JOIN raw.adj_factor a
       ON a.ts_code = q.ts_code AND a.trade_date = q.trade_date
WHERE q.trade_date >= :start AND q.trade_date <= :end
ORDER BY q.ts_code, q.trade_date
```

返回 DataFrame 列 `[ts_code, trade_date, close, low, adj_factor]`，`close/low/adj_factor`
经 `pd.to_numeric(errors="coerce")`。随后调 `_common.apply_hfq` 注入 `close_adj/low_adj`。

### 2.4 `apply_hfq` 实现

复用 `factors/runner.py:215-221` **完全相同**的公式（窗口内该票 `max(adj_factor)`
为基准）：

```python
def apply_hfq(df: pd.DataFrame) -> pd.DataFrame:
    """注入后复权列 close_adj / low_adj。

    后复权基准 = 窗口内该 ts_code 的 max(adj_factor)，与 factors/runner.py 一致。
    adj_factor 为 NULL 的行 → close_adj/low_adj 为 NaN；统计并 warn。
    """
    out = df.copy()
    af = pd.to_numeric(out["adj_factor"], errors="coerce")
    max_af = af.groupby(out["ts_code"]).transform("max")
    out["close_adj"] = out["close"] * af / max_af
    if "low" in out.columns:
        out["low_adj"] = out["low"] * af / max_af
    na_cnt = int(af.isna().sum())
    if na_cnt > 0:
        logger.warning("apply_hfq_adj_factor_missing",
                        extra={"na_rows": na_cnt, "total": len(out)})
    return out
```

- 收益率对复权基准不敏感（基准在 `exit/entry` 比值中约掉），但全 pipeline 统一用
  「窗口 max」基准，与 `factors` 模块口径一致。
- **不修改 `factors/runner.py`** 的内联实现（避免无关重构）；仅 labels 内统一到
  `_common.apply_hfq`。

### 2.5 消费方分流

| 消费点 | 用哪个价 | 说明 |
|---|---|---|
| `derive_limit_up_set` / `derive_limit_down_set` | **raw `close`** | 配 raw `up_limit/down_limit`，口径一致 |
| 停牌检测 | 不涉及价 | 由 `raw.suspend_d` 派生 |
| `compute_strategy_aware_labels` 喂给 `simulate_exit` 的 per-stock 价表 | `close_adj` 充当 `close` 列、`low_adj` 充当 `low` 列 | `exit_rules` 注释本就声明「含复权」 |
| `entry_close` / `gross`（`strategy_aware.py:434-437`） | `close_adj` | 收益率必须用复权价 |
| `fallback.compute_fwd_5d_ret` 的 `c_t`/`c_t5` | `close_adj` | 见 [02 §item-4](./02-entry-t1-and-schemes.md#item-4) |

`LabelInputs` / `FallbackInputs` 的 docstring 更新：`daily_quotes` 现含
`[ts_code, trade_date, close, low, adj_factor, close_adj, low_adj]`。

### 2.6 `_augment_quotes_for_exit` 与 `simulate_exit` 衔接

`compute_strategy_aware_labels` 在 `_augment_quotes_for_exit`（`strategy_aware.py:296`）
之后、把 per-stock 切片传给 `simulate_exit` 之前，构造交给模拟器的价格表时：

- 把 `close_adj` 列重命名为 `close`、`low_adj` 重命名为 `low` 传入（`simulate_exit`
  的 `_REQUIRED_PRICE_COLS` 是 `("trade_date","close")`，可选 `low`）。
- 涨停/停牌/退市的派生（`derive_limit_up_set` 等）在此之前已用 raw `close` 完成，
  结果以 `is_limit_up` 等布尔列注入，不受复权影响。

## 3. 测试要点

- `apply_hfq`：构造含 `adj_factor` 变化的小 DataFrame，断言 `close_adj` = 预期值；
  含 NULL `adj_factor` 时断言对应行 `close_adj` 为 NaN 且触发 warning。
- 端到端：用一只已知高送转的票（除权日裸 `close` 跳变），断言
  `fwd_5d_ret` / `gross` 不再含除权缺口。
- `derive_limit_up_set` 在复权改造后仍用 raw `close`，断言除权票的涨停判定不变。
