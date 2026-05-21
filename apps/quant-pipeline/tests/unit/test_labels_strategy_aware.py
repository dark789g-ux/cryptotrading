# -*- coding: utf-8 -*-
"""labels/strategy_aware.py 单测。

每个"坑"独立 case，外加 compute_strategy_aware_labels 的 value 正确性 +
PK 去重 + 兜底 fwd_5d_ret 路径。
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
    EXIT_FORCE_CLOSE,
    LABEL_SCHEME,
    ROUND_TRIP_COST,
    LabelInputs,
    apply_delisting_force_close,
    compute_strategy_aware_labels,
    derive_limit_up_set,
    derive_suspended_set,
    filter_limit_up_on_entry,
    filter_new_listing,
    filter_suspended_on_entry,
    winsorize_label_value,
)
from quant_pipeline.strategy.exit_rules import ExitOutcome


# ----------------------------------------------------------------------
# 坑 1：涨停过滤
# ----------------------------------------------------------------------

def test_filter_limit_up_on_entry_drops_limit_up_candidates() -> None:
    entries = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "entry_date": "20240102"},
            {"ts_code": "000002.SZ", "entry_date": "20240102"},
            {"ts_code": "000003.SZ", "entry_date": "20240102"},
        ]
    )
    limit_up_set = {("000002.SZ", "20240102")}
    out = filter_limit_up_on_entry(entries, limit_up_set=limit_up_set)
    assert out["ts_code"].tolist() == ["000001.SZ", "000003.SZ"]


def test_derive_limit_up_set_with_close_at_up_limit() -> None:
    quotes = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "trade_date": "20240102", "close": 11.0},
        ]
    )
    stk_limit = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "trade_date": "20240102",
             "up_limit": 11.0, "down_limit": 9.0},
        ]
    )
    out = derive_limit_up_set(quotes, stk_limit)
    assert ("000001.SZ", "20240102") in out


# ----------------------------------------------------------------------
# 坑 2：停牌过滤
# ----------------------------------------------------------------------

def test_filter_suspended_on_entry_drops_suspended_candidates() -> None:
    entries = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "entry_date": "20240102"},
            {"ts_code": "000002.SZ", "entry_date": "20240102"},
        ]
    )
    suspended_set = {("000001.SZ", "20240102")}
    out = filter_suspended_on_entry(entries, suspended_set=suspended_set)
    assert out["ts_code"].tolist() == ["000002.SZ"]


def test_derive_suspended_set_from_raw_suspend_d() -> None:
    suspend_d = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "trade_date": "20240102"},
            {"ts_code": "000002.SZ", "trade_date": "20240103"},
        ]
    )
    out = derive_suspended_set(suspend_d)
    assert out == {("000001.SZ", "20240102"), ("000002.SZ", "20240103")}


# ----------------------------------------------------------------------
# 坑 3：新股过滤
# ----------------------------------------------------------------------

def test_filter_new_listing_drops_recently_listed() -> None:
    trade_dates = (
        pd.bdate_range("2024-01-02", periods=30).strftime("%Y%m%d").tolist()
    )
    list_date_map = {
        "000001.SZ": trade_dates[0],   # 第 1 个交易日上市
        "000002.SZ": trade_dates[10],  # 第 11 个交易日上市
    }
    # 入场日选第 5 个交易日：000001 上市 4 天、000002 还没上市 → 都应丢
    entries = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "entry_date": trade_dates[4]},
            {"ts_code": "000002.SZ", "entry_date": trade_dates[4]},
        ]
    )
    out = filter_new_listing(
        entries,
        list_date_map=list_date_map,
        trade_dates_sorted=trade_dates,
        min_days=60,
    )
    assert out.empty

    # 同样的 list_date，但 min_days=2 → 第 5 个交易日时 000001 已上市 4 天 → 留
    out2 = filter_new_listing(
        entries,
        list_date_map=list_date_map,
        trade_dates_sorted=trade_dates,
        min_days=2,
    )
    assert out2["ts_code"].tolist() == ["000001.SZ"]


# ----------------------------------------------------------------------
# 坑 4：退市强制平仓
# ----------------------------------------------------------------------

def test_apply_delisting_force_close_overrides_reason() -> None:
    outcome = ExitOutcome(
        ts_code="000001.SZ",
        entry_date="20240102",
        exit_date="20240110",
        exit_price=9.5,
        exit_reason="ma5_break",
        hold_days=5,
    )
    out = apply_delisting_force_close(
        outcome, delist_date_map={"000001.SZ": "20240110"}
    )
    assert out.exit_reason == EXIT_FORCE_CLOSE


def test_apply_delisting_force_close_noop_when_delist_later() -> None:
    outcome = ExitOutcome(
        ts_code="000001.SZ",
        entry_date="20240102",
        exit_date="20240105",
        exit_price=9.5,
        exit_reason="ma5_break",
        hold_days=3,
    )
    out = apply_delisting_force_close(
        outcome, delist_date_map={"000001.SZ": "20240201"}
    )
    assert out.exit_reason == "ma5_break"


# ----------------------------------------------------------------------
# 坑 5：温和截尾（marker，features 复用同一函数）
# ----------------------------------------------------------------------

def test_winsorize_label_value_clips_extreme_returns() -> None:
    values = pd.Series([-0.8, -0.3, 0.0, 0.3, 0.9])
    clipped = winsorize_label_value(values, lo=-0.5, hi=0.5)
    assert clipped.tolist() == [-0.5, -0.3, 0.0, 0.3, 0.5]


def test_winsorize_label_value_handles_empty_series() -> None:
    out = winsorize_label_value(pd.Series([], dtype=float))
    assert out.empty


# ----------------------------------------------------------------------
# 标签值正确性（端到端 mock）
# ----------------------------------------------------------------------

def _make_quotes_simple(n_days: int, base: float = 10.0) -> pd.DataFrame:
    """单只股票、n_days 个交易日、close 严格单调上涨（每日 +1%）。

    避免触发 stop_loss / ma5_break，走 max_hold 路径，便于断言 value。
    """

    dates = pd.bdate_range("2024-01-02", periods=n_days).strftime("%Y%m%d").tolist()
    rows = [
        {
            "ts_code": "000001.SZ",
            "trade_date": d,
            "close": base * (1.01 ** i),
            "low": base * (1.01 ** i) * 0.999,
        }
        for i, d in enumerate(dates)
    ]
    return pd.DataFrame(rows)


def test_compute_strategy_aware_labels_max_hold_value() -> None:
    """单只票连涨 → 走 max_hold；value = (1.01^20 - 1) - 双边成本。"""

    quotes = _make_quotes_simple(n_days=25)
    entries = pd.DataFrame(
        [{"ts_code": "000001.SZ", "trade_date": quotes.iloc[0]["trade_date"]}]
    )
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
    assert row["exit_reason"] == "max_hold"
    assert row["hold_days"] == 20
    expected_gross = math.pow(1.01, 20) - 1.0
    assert row["value"] == pytest.approx(expected_gross - ROUND_TRIP_COST, abs=1e-6)


def test_compute_strategy_aware_labels_dedups_pk() -> None:
    """同一 (trade_date, ts_code, scheme) 在输入中重复 → 去重保留最后一条。"""

    quotes = _make_quotes_simple(n_days=25)
    entries = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "trade_date": quotes.iloc[0]["trade_date"]},
            {"ts_code": "000001.SZ", "trade_date": quotes.iloc[0]["trade_date"]},
        ]
    )
    out = compute_strategy_aware_labels(
        LabelInputs(daily_quotes=quotes, entries=entries)
    )
    assert len(out) == 1


def test_compute_strategy_aware_labels_empty_quotes_returns_empty() -> None:
    out = compute_strategy_aware_labels(
        LabelInputs(
            daily_quotes=pd.DataFrame(columns=["ts_code", "trade_date", "close"])
        )
    )
    assert out.empty


# ----------------------------------------------------------------------
# fallback fwd_5d_ret
# ----------------------------------------------------------------------

def test_compute_fwd_5d_ret_basic() -> None:
    """fwd_5d_ret 标签：第 t 行 value = close[t+5]/close[t] - 1。"""

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
    # i=1 应被剔除（t 停牌）；同时 i where t+5 == suspend_date 也被剔
    assert suspend_date not in out["trade_date"].tolist()
