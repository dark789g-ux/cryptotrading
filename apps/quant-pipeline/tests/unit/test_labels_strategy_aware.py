"""labels/strategy_aware.py 单测。

每个"坑"独立 case，外加 compute_strategy_aware_labels 的 value 正确性 +
PK 去重 + T+1 入场 + 兜底 fwd_5d_ret 路径。
"""

from __future__ import annotations

import math

import pandas as pd
import pytest

from quant_pipeline.labels.fallback import (
    FWD_HORIZON_DAYS,
    SCHEME_FWD_5D_RET,
    FallbackInputs,
    compute_fwd_5d_ret,
)
from quant_pipeline.labels.strategy_aware import (
    LABEL_SCHEME,
    NEW_LISTING_MIN_DAYS,
    LabelInputs,
    _validate_min_days,
    compute_strategy_aware_labels,
    filter_limit_up_on_entry,
    filter_new_listing,
    filter_suspended_on_entry,
)

# ----------------------------------------------------------------------
# 坑 1：涨停过滤
# ----------------------------------------------------------------------

def test_filter_limit_up_on_entry_drops_limit_up_candidates() -> None:
    entries = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "buy_date": "20240102"},
            {"ts_code": "000002.SZ", "buy_date": "20240102"},
            {"ts_code": "000003.SZ", "buy_date": "20240102"},
        ]
    )
    limit_up_set = {("000002.SZ", "20240102")}
    out = filter_limit_up_on_entry(
        entries, limit_up_set=limit_up_set, entry_col="buy_date"
    )
    assert out["ts_code"].tolist() == ["000001.SZ", "000003.SZ"]


# ----------------------------------------------------------------------
# 坑 2：停牌过滤
# ----------------------------------------------------------------------

def test_filter_suspended_on_entry_drops_suspended_candidates() -> None:
    entries = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "buy_date": "20240102"},
            {"ts_code": "000002.SZ", "buy_date": "20240102"},
        ]
    )
    suspended_set = {("000001.SZ", "20240102")}
    out = filter_suspended_on_entry(
        entries, suspended_set=suspended_set, entry_col="buy_date"
    )
    assert out["ts_code"].tolist() == ["000002.SZ"]


# ----------------------------------------------------------------------
# 坑 3：新股过滤（向量化版 —— 与旧 apply(axis=1) 版完全一致）
# ----------------------------------------------------------------------

def _filter_new_listing_legacy(
    entries, *, list_date_map, trade_dates_sorted, min_days, entry_col="buy_date"
):
    if entries.empty:
        return entries
    if not list_date_map:
        return entries.reset_index(drop=True)
    td_to_idx = {d: i for i, d in enumerate(trade_dates_sorted)}

    def _ok(row):
        ts_code = str(row["ts_code"])
        buy_date = str(row[entry_col])
        list_date = list_date_map.get(ts_code)
        if list_date is None:
            return True
        if list_date not in td_to_idx or buy_date not in td_to_idx:
            return True
        return td_to_idx[buy_date] - td_to_idx[list_date] >= min_days

    mask = entries.apply(_ok, axis=1)
    return entries.loc[mask].reset_index(drop=True)


def test_filter_new_listing_drops_recently_listed() -> None:
    trade_dates = (
        pd.bdate_range("2024-01-02", periods=30).strftime("%Y%m%d").tolist()
    )
    list_date_map = {
        "000001.SZ": trade_dates[0],   # 第 1 个交易日上市
        "000002.SZ": trade_dates[10],  # 第 11 个交易日上市
    }
    entries = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "buy_date": trade_dates[4]},
            {"ts_code": "000002.SZ", "buy_date": trade_dates[4]},
        ]
    )
    out = filter_new_listing(
        entries,
        list_date_map=list_date_map,
        trade_dates_sorted=trade_dates,
        min_days=60,
    )
    assert out.empty

    out2 = filter_new_listing(
        entries,
        list_date_map=list_date_map,
        trade_dates_sorted=trade_dates,
        min_days=2,
    )
    assert out2["ts_code"].tolist() == ["000001.SZ"]


def test_filter_new_listing_vectorized_matches_legacy() -> None:
    trade_dates = (
        pd.bdate_range("2024-01-02", periods=30).strftime("%Y%m%d").tolist()
    )
    list_date_map = {
        "000001.SZ": trade_dates[0],
        "000002.SZ": trade_dates[10],
        "000003.SZ": "29991231",          # list_date 不在交易日历 → 保留
        # 000004.SZ 不在 map → 保留
    }
    entries = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "buy_date": trade_dates[25]},
            {"ts_code": "000002.SZ", "buy_date": trade_dates[15]},
            {"ts_code": "000003.SZ", "buy_date": trade_dates[20]},
            {"ts_code": "000004.SZ", "buy_date": trade_dates[20]},
            {"ts_code": "000001.SZ", "buy_date": "29991231"},   # buy_date 不在日历 → 保留
        ]
    )
    new = filter_new_listing(
        entries, list_date_map=list_date_map,
        trade_dates_sorted=trade_dates, min_days=10,
    )
    legacy = _filter_new_listing_legacy(
        entries, list_date_map=list_date_map,
        trade_dates_sorted=trade_dates, min_days=10,
    )
    assert new["ts_code"].tolist() == legacy["ts_code"].tolist()
    assert new["buy_date"].tolist() == legacy["buy_date"].tolist()


# ----------------------------------------------------------------------
# 标签值正确性（端到端 mock）
# ----------------------------------------------------------------------

def _make_quotes_simple(n_days: int, base: float = 10.0) -> pd.DataFrame:
    """单只股票、n_days 个交易日、close 严格单调上涨（每日 +1%）。

    含 close_adj / low_adj（adj_factor 全 1，复权价 == 原始价）。
    """

    dates = pd.bdate_range("2024-01-02", periods=n_days).strftime("%Y%m%d").tolist()
    rows = []
    for i, d in enumerate(dates):
        close = base * (1.01 ** i)
        low = close * 0.999
        rows.append(
            {
                "ts_code": "000001.SZ",
                "trade_date": d,
                "close": close,
                "low": low,
                "adj_factor": 1.0,
                "close_adj": close,
                "low_adj": low,
            }
        )
    return pd.DataFrame(rows)


def test_compute_strategy_aware_labels_max_hold_value_t1_entry() -> None:
    """单只票连涨 → 走 max_hold。T+1 入场：信号日 T，买入价 = T+1 close_adj。

    value = (close_adj[exit] / close_adj[T+1] - 1) - 双边成本。
    """

    quotes = _make_quotes_simple(n_days=30)
    signal_date = quotes.iloc[0]["trade_date"]
    entries = pd.DataFrame([{"ts_code": "000001.SZ", "trade_date": signal_date}])
    out = compute_strategy_aware_labels(
        LabelInputs(
            daily_quotes=quotes,
            stk_limit=None,
            suspend_d=None,
            delist=None,
            listing=None,
            entries=entries,
        )
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["scheme"] == LABEL_SCHEME
    # trade_date 应为信号日 T，不是买入日 T+1
    assert row["trade_date"] == signal_date
    assert row["exit_reason"] == "max_hold"
    assert row["hold_days"] == 20
    # 买入价 = T+1 close（i=1），exit = max_hold 后 close
    buy_close = quotes.iloc[1]["close_adj"]
    # hold_days=20：从 buy_date(i=1) 起第 20 个交易日决策日 = i=1+20 = i=21
    exit_close = quotes.iloc[21]["close_adj"]
    # 项目决策：label 输出毛收益，不扣 ROUND_TRIP_COST
    expected_gross = exit_close / buy_close - 1.0
    assert row["value"] == pytest.approx(expected_gross, abs=1e-6)


def test_compute_strategy_aware_labels_skips_last_day_signal() -> None:
    """信号日为窗口最后一个交易日 → 取不到 T+1 → 跳过该候选，不抛错。"""

    quotes = _make_quotes_simple(n_days=25)
    last_day = quotes.iloc[-1]["trade_date"]
    entries = pd.DataFrame([{"ts_code": "000001.SZ", "trade_date": last_day}])
    out = compute_strategy_aware_labels(
        LabelInputs(daily_quotes=quotes, entries=entries)
    )
    assert out.empty


def test_compute_strategy_aware_labels_dedups_pk() -> None:
    """同一 (ts_code, signal_date) 在输入中重复 → 去重保留一条。"""

    quotes = _make_quotes_simple(n_days=30)
    signal_date = quotes.iloc[0]["trade_date"]
    entries = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "trade_date": signal_date},
            {"ts_code": "000001.SZ", "trade_date": signal_date},
        ]
    )
    out = compute_strategy_aware_labels(
        LabelInputs(daily_quotes=quotes, entries=entries)
    )
    assert len(out) == 1


def test_compute_strategy_aware_labels_empty_quotes_returns_empty() -> None:
    out = compute_strategy_aware_labels(
        LabelInputs(
            daily_quotes=pd.DataFrame(
                columns=["ts_code", "trade_date", "close", "close_adj"]
            )
        )
    )
    assert out.empty


def test_compute_strategy_aware_labels_t1_limit_up_filtered() -> None:
    """T+1 涨停的候选被剔除（entry_col=buy_date 生效）。"""

    quotes = _make_quotes_simple(n_days=30)
    signal_date = quotes.iloc[0]["trade_date"]
    buy_date = quotes.iloc[1]["trade_date"]
    # stk_limit 让 T+1 那天涨停：up_limit = close
    stk_limit = pd.DataFrame(
        [
            {
                "ts_code": "000001.SZ",
                "trade_date": buy_date,
                "up_limit": quotes.iloc[1]["close"],
                "down_limit": quotes.iloc[1]["close"] * 0.9,
            }
        ]
    )
    entries = pd.DataFrame([{"ts_code": "000001.SZ", "trade_date": signal_date}])
    out = compute_strategy_aware_labels(
        LabelInputs(daily_quotes=quotes, stk_limit=stk_limit, entries=entries)
    )
    assert out.empty


# ----------------------------------------------------------------------
# fallback fwd_5d_ret
# ----------------------------------------------------------------------

def test_compute_fwd_5d_ret_basic() -> None:
    """fwd_5d_ret 标签：第 t 行 value = close_adj[t+5]/close_adj[t] - 1。"""

    quotes = _make_quotes_simple(n_days=10)
    out = compute_fwd_5d_ret(FallbackInputs(daily_quotes=quotes))
    assert (out["scheme"] == SCHEME_FWD_5D_RET).all()
    assert (out["hold_days"] == FWD_HORIZON_DAYS).all()
    expected = math.pow(1.01, 5) - 1.0
    assert out.iloc[0]["value"] == pytest.approx(expected, abs=1e-6)


def test_compute_fwd_5d_ret_skips_suspended_endpoints() -> None:
    """t 或 t+5 任一停牌 → 跳过该样本。"""

    quotes = _make_quotes_simple(n_days=10)
    suspend_date = quotes.iloc[1]["trade_date"]
    suspended_set = {("000001.SZ", suspend_date)}
    out = compute_fwd_5d_ret(
        FallbackInputs(daily_quotes=quotes, suspended_set=suspended_set)
    )
    assert suspend_date not in out["trade_date"].tolist()


def _compute_fwd_5d_ret_legacy(inputs: FallbackInputs) -> pd.DataFrame:
    """原 iterrows 双层循环版（基于 close_adj），用于「新旧一致」断言。"""

    import numpy as np

    quotes = inputs.daily_quotes.copy()
    quotes["ts_code"] = quotes["ts_code"].astype(str)
    quotes["trade_date"] = quotes["trade_date"].astype(str)
    quotes["close_adj"] = pd.to_numeric(quotes["close_adj"], errors="coerce")
    suspended_set = inputs.suspended_set or set()
    delist_map = inputs.delist_map or {}
    records = []
    for ts_code, sub in quotes.groupby("ts_code", sort=False):
        sub = sub.sort_values("trade_date").reset_index(drop=True)
        for i in range(len(sub) - FWD_HORIZON_DAYS):
            t_row = sub.iloc[i]
            t = str(t_row["trade_date"])
            t_plus = sub.iloc[i + FWD_HORIZON_DAYS]
            t_plus_date = str(t_plus["trade_date"])
            ts = str(ts_code)
            if (ts, t) in suspended_set or (ts, t_plus_date) in suspended_set:
                continue
            delist = delist_map.get(ts)
            if delist is not None and t_plus_date >= delist:
                continue
            c_t = float(t_row["close_adj"])
            c_t5 = float(t_plus["close_adj"])
            if not np.isfinite(c_t) or c_t <= 0:
                continue
            if not np.isfinite(c_t5):
                continue
            records.append(
                {
                    "trade_date": t,
                    "ts_code": ts,
                    "scheme": SCHEME_FWD_5D_RET,
                    "value": float(c_t5 / c_t - 1.0),
                    "exit_reason": "fwd_horizon",
                    "hold_days": FWD_HORIZON_DAYS,
                }
            )
    if not records:
        return pd.DataFrame(
            columns=["trade_date", "ts_code", "scheme",
                     "value", "exit_reason", "hold_days"]
        )
    return pd.DataFrame(records).drop_duplicates(
        subset=["trade_date", "ts_code", "scheme"], keep="last"
    ).reset_index(drop=True)


def test_compute_fwd_5d_ret_vectorized_matches_legacy() -> None:
    """向量化版与旧 iterrows 版输出完全一致（多票 + 停牌 + 退市）。"""

    dates = pd.bdate_range("2024-01-02", periods=15).strftime("%Y%m%d").tolist()
    rows = []
    for ts in ("000001.SZ", "000002.SZ"):
        for i, d in enumerate(dates):
            close = 10.0 * (1.0 + 0.01 * i)
            rows.append(
                {
                    "ts_code": ts,
                    "trade_date": d,
                    "close": close,
                    "low": close * 0.99,
                    "adj_factor": 1.0,
                    "close_adj": close,
                    "low_adj": close * 0.99,
                }
            )
    quotes = pd.DataFrame(rows)
    inputs = FallbackInputs(
        daily_quotes=quotes,
        suspended_set={("000001.SZ", dates[3])},
        delist_map={"000002.SZ": dates[12]},
    )
    new = compute_fwd_5d_ret(inputs)
    legacy = _compute_fwd_5d_ret_legacy(inputs)
    new_sorted = new.sort_values(["ts_code", "trade_date"]).reset_index(drop=True)
    legacy_sorted = legacy.sort_values(
        ["ts_code", "trade_date"]
    ).reset_index(drop=True)
    pd.testing.assert_frame_equal(
        new_sorted, legacy_sorted, check_dtype=False, check_like=True
    )


# ----------------------------------------------------------------------
# _validate_min_days：合法/非法值边界
# ----------------------------------------------------------------------

@pytest.mark.parametrize("v", [0, 1, 30, 60, 90, 250])
def test_validate_min_days_accepts_legal_int(v: int) -> None:
    # 不抛即通过
    _validate_min_days(v)


@pytest.mark.parametrize("v", [-1, 251, 1000, -1000])
def test_validate_min_days_rejects_out_of_range(v: int) -> None:
    with pytest.raises(ValueError, match="new_listing_min_days"):
        _validate_min_days(v)


@pytest.mark.parametrize("v", ["60", 60.0, None, [], True, False])
def test_validate_min_days_rejects_wrong_type(v: object) -> None:
    with pytest.raises(ValueError, match="new_listing_min_days"):
        _validate_min_days(v)


# ----------------------------------------------------------------------
# LabelInputs.new_listing_min_days 在 compute_strategy_aware_labels 内的传导
# ----------------------------------------------------------------------

def _make_multi_stock_quotes(
    *,
    listing_offset: int,
    n_days: int = 80,
) -> tuple[pd.DataFrame, pd.DataFrame, str]:
    """构造两只票的连涨行情 + listing 信息。

    000001.SZ：list_date = "20200101"（早于数据窗口，不在 trade_dates 内 →
                          filter_new_listing 语义为「保留」，代表"老股")
    000002.SZ：list_date = trade_dates[listing_offset]（在窗口内，可被过滤）

    返回 (quotes, listing, signal_date)；signal_date 取 dates[5]，让
    000002.SZ 的 buy_date - list_date 距离始终偏小（用于触发过滤）。
    """

    dates = pd.bdate_range("2024-01-02", periods=n_days).strftime("%Y%m%d").tolist()
    rows = []
    for ts in ("000001.SZ", "000002.SZ"):
        for i, d in enumerate(dates):
            close = 10.0 * (1.01 ** i)
            rows.append(
                {
                    "ts_code": ts,
                    "trade_date": d,
                    "close": close,
                    "low": close * 0.999,
                    "adj_factor": 1.0,
                    "close_adj": close,
                    "low_adj": close * 0.999,
                }
            )
    quotes = pd.DataFrame(rows)
    listing = pd.DataFrame(
        [
            # list_date 不在 trade_dates_sorted → filter_new_listing 视为"保留"，
            # 这正是"上市极早、肯定不是新股"的等价语义。
            {"ts_code": "000001.SZ", "list_date": "20200101"},
            {"ts_code": "000002.SZ", "list_date": dates[listing_offset]},
        ]
    )
    signal_date = dates[5]
    return quotes, listing, signal_date


def test_label_inputs_default_uses_60_when_none() -> None:
    """new_listing_min_days=None → 默认 60。

    000002.SZ 上市 5 个交易日（< 60）→ T+1 (=第 7 个交易日) 距上市仅 6 日，应被过滤。
    """

    quotes, listing, signal_date = _make_multi_stock_quotes(listing_offset=5)
    entries = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "trade_date": signal_date},
            {"ts_code": "000002.SZ", "trade_date": signal_date},
        ]
    )
    out = compute_strategy_aware_labels(
        LabelInputs(
            daily_quotes=quotes,
            listing=listing,
            entries=entries,
            new_listing_min_days=None,
        )
    )
    # 000002.SZ 被过滤，仅老股留下
    assert out["ts_code"].tolist() == ["000001.SZ"]


def test_label_inputs_zero_disables_filter() -> None:
    """new_listing_min_days=0 → 不过滤（0 是合法值，不能被 `if min_days:` 判 falsy）。"""

    quotes, listing, signal_date = _make_multi_stock_quotes(listing_offset=5)
    entries = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "trade_date": signal_date},
            {"ts_code": "000002.SZ", "trade_date": signal_date},
        ]
    )
    out = compute_strategy_aware_labels(
        LabelInputs(
            daily_quotes=quotes,
            listing=listing,
            entries=entries,
            new_listing_min_days=0,
        )
    )
    assert set(out["ts_code"].tolist()) == {"000001.SZ", "000002.SZ"}


def test_label_inputs_min_days_30_filters_below_threshold() -> None:
    """min_days=30：000002.SZ 距上市 6 日 < 30 → 过滤；000001.SZ 老股留下。"""

    quotes, listing, signal_date = _make_multi_stock_quotes(listing_offset=5)
    entries = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "trade_date": signal_date},
            {"ts_code": "000002.SZ", "trade_date": signal_date},
        ]
    )
    out = compute_strategy_aware_labels(
        LabelInputs(
            daily_quotes=quotes,
            listing=listing,
            entries=entries,
            new_listing_min_days=30,
        )
    )
    assert out["ts_code"].tolist() == ["000001.SZ"]


def test_label_inputs_min_days_250_filters_almost_all() -> None:
    """min_days=250：80 个交易日窗口内，两只票 list_date 都在窗口起始 →
    距 buy_date 最多 ~6 个交易日 << 250 → 全过滤。

    本测试覆写 listing 表（两只票 list_date 都在窗口内），不沿用 helper
    中"老股 list_date 在窗口外被保留"的语义。
    """

    quotes, _, signal_date = _make_multi_stock_quotes(listing_offset=0)
    # 与 helper 不同：两只票 list_date 均在窗口内，让 filter 实质生效
    dates = sorted(quotes["trade_date"].unique().tolist())
    listing = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "list_date": dates[0]},
            {"ts_code": "000002.SZ", "list_date": dates[0]},
        ]
    )
    entries = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "trade_date": signal_date},
            {"ts_code": "000002.SZ", "trade_date": signal_date},
        ]
    )
    out = compute_strategy_aware_labels(
        LabelInputs(
            daily_quotes=quotes,
            listing=listing,
            entries=entries,
            new_listing_min_days=250,
        )
    )
    assert out.empty


@pytest.mark.parametrize("bad", [-1, 251, "60", 60.0])
def test_label_inputs_invalid_min_days_raises(bad: object) -> None:
    """非法 min_days → ValueError；由 worker 顶层捕获标记 job=failed。"""

    quotes, listing, signal_date = _make_multi_stock_quotes(listing_offset=5)
    entries = pd.DataFrame([{"ts_code": "000001.SZ", "trade_date": signal_date}])
    with pytest.raises(ValueError, match="new_listing_min_days"):
        compute_strategy_aware_labels(
            LabelInputs(
                daily_quotes=quotes,
                listing=listing,
                entries=entries,
                new_listing_min_days=bad,  # type: ignore[arg-type]
            )
        )


def test_new_listing_min_days_constant_value() -> None:
    """常量值锁定为 60（防误改 → 影响默认语义）。"""

    assert NEW_LISTING_MIN_DAYS == 60
