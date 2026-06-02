"""labels/_common.py 单测。

覆盖：apply_hfq 后复权、empty_labels_frame、dedup_labels、derive_* 向量化版
（含「新旧结果完全一致」断言）、PROGRESS_* 常量不变式。
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.labels import _common  # noqa: F401
from quant_pipeline.labels._common import (
    PROGRESS_COMPUTE_DONE,
    PROGRESS_DONE,
    PROGRESS_LOAD,
    PROGRESS_SIMULATE_SPAN,
    PROGRESS_SIMULATE_START,
    apply_hfq,
    dedup_labels,
    derive_delist_map,
    derive_limit_up_set,
    derive_list_date_map,
    derive_suspended_set,
    empty_labels_frame,
)

# ----------------------------------------------------------------------
# PROGRESS_* 不变式
# ----------------------------------------------------------------------

def test_progress_constants_invariants() -> None:
    assert PROGRESS_SIMULATE_START == PROGRESS_LOAD
    assert PROGRESS_COMPUTE_DONE == PROGRESS_SIMULATE_START + PROGRESS_SIMULATE_SPAN
    assert PROGRESS_DONE == 100


# ----------------------------------------------------------------------
# empty_labels_frame
# ----------------------------------------------------------------------

def test_empty_labels_frame_columns() -> None:
    df = empty_labels_frame()
    assert df.empty
    assert list(df.columns) == [
        "trade_date", "ts_code", "scheme", "value", "exit_reason", "hold_days"
    ]


# ----------------------------------------------------------------------
# apply_hfq
# ----------------------------------------------------------------------

def test_apply_hfq_injects_close_adj_low_adj() -> None:
    """后复权基准 = 窗口内该 ts_code 的 max(adj_factor)。"""

    df = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "trade_date": "20240102",
             "close": 10.0, "low": 9.8, "adj_factor": 1.0},
            {"ts_code": "000001.SZ", "trade_date": "20240103",
             "close": 11.0, "low": 10.8, "adj_factor": 2.0},
        ]
    )
    out = apply_hfq(df)
    # max_af = 2.0
    assert out.iloc[0]["close_adj"] == pytest.approx(10.0 * 1.0 / 2.0)
    assert out.iloc[1]["close_adj"] == pytest.approx(11.0 * 2.0 / 2.0)
    assert out.iloc[0]["low_adj"] == pytest.approx(9.8 * 1.0 / 2.0)
    assert out.iloc[1]["low_adj"] == pytest.approx(10.8 * 2.0 / 2.0)


def test_apply_hfq_nan_adj_factor_yields_nan_and_warns(caplog) -> None:
    df = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "trade_date": "20240102",
             "close": 10.0, "low": 9.8, "adj_factor": None},
            {"ts_code": "000001.SZ", "trade_date": "20240103",
             "close": 11.0, "low": 10.8, "adj_factor": 2.0},
        ]
    )
    with caplog.at_level("WARNING"):
        out = apply_hfq(df)
    assert math.isnan(out.iloc[0]["close_adj"])
    assert "apply_hfq_adj_factor_missing" in caplog.text


def test_apply_hfq_without_low_column() -> None:
    df = pd.DataFrame(
        [{"ts_code": "X", "trade_date": "20240102", "close": 10.0, "adj_factor": 1.0}]
    )
    out = apply_hfq(df)
    assert "close_adj" in out.columns
    assert "low_adj" not in out.columns


# ----------------------------------------------------------------------
# dedup_labels
# ----------------------------------------------------------------------

def test_dedup_labels_keeps_last_and_warns(caplog) -> None:
    df = pd.DataFrame(
        [
            {"trade_date": "20240102", "ts_code": "A", "scheme": "s",
             "value": 0.1, "exit_reason": "r", "hold_days": 1},
            {"trade_date": "20240102", "ts_code": "A", "scheme": "s",
             "value": 0.2, "exit_reason": "r", "hold_days": 2},
        ]
    )
    with caplog.at_level("WARNING"):
        out = dedup_labels(df, log_key="my_dedup")
    assert len(out) == 1
    assert out.iloc[0]["value"] == 0.2
    assert "my_dedup" in caplog.text


def test_dedup_labels_no_change_no_warn(caplog) -> None:
    df = pd.DataFrame(
        [
            {"trade_date": "20240102", "ts_code": "A", "scheme": "s",
             "value": 0.1, "exit_reason": "r", "hold_days": 1},
        ]
    )
    with caplog.at_level("WARNING"):
        out = dedup_labels(df, log_key="my_dedup")
    assert len(out) == 1
    assert "my_dedup" not in caplog.text


# ----------------------------------------------------------------------
# derive_* 向量化版 —— 与旧 iterrows 版「完全一致」
# ----------------------------------------------------------------------

def _derive_limit_up_set_legacy(quotes, stk_limit, *, tolerance=0.005):
    if stk_limit is None or stk_limit.empty:
        return set()
    merged = quotes.merge(
        stk_limit[["ts_code", "trade_date", "up_limit"]],
        on=["ts_code", "trade_date"], how="left",
    )
    out = set()
    for _, row in merged.iterrows():
        close = float(row["close"]) if pd.notna(row["close"]) else np.nan
        up = float(row["up_limit"]) if pd.notna(row.get("up_limit")) else np.nan
        if np.isfinite(close) and np.isfinite(up) and close >= up * (1 - tolerance):
            out.add((str(row["ts_code"]), str(row["trade_date"])))
    return out


def _derive_suspended_set_legacy(suspend_d):
    if suspend_d is None or suspend_d.empty:
        return set()
    return {(str(r["ts_code"]), str(r["trade_date"])) for _, r in suspend_d.iterrows()}


def _derive_delist_map_legacy(delist):
    if delist is None or delist.empty:
        return {}
    return {str(r["ts_code"]): str(r["delist_date"]) for _, r in delist.iterrows()}


def _derive_list_date_map_legacy(listing):
    if listing is None or listing.empty:
        return {}
    return {str(r["ts_code"]): str(r["list_date"]) for _, r in listing.iterrows()}


def test_derive_limit_up_set_vectorized_matches_legacy() -> None:
    quotes = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "trade_date": "20240102", "close": 11.0},
            {"ts_code": "000002.SZ", "trade_date": "20240102", "close": 9.0},
            {"ts_code": "000003.SZ", "trade_date": "20240103", "close": 5.0},
            {"ts_code": "000004.SZ", "trade_date": "20240104", "close": np.nan},
        ]
    )
    stk_limit = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "trade_date": "20240102",
             "up_limit": 11.0, "down_limit": 9.0},
            {"ts_code": "000002.SZ", "trade_date": "20240102",
             "up_limit": 10.0, "down_limit": 8.0},
            {"ts_code": "000004.SZ", "trade_date": "20240104",
             "up_limit": 6.0, "down_limit": 4.0},
        ]
    )
    new = derive_limit_up_set(quotes, stk_limit)
    legacy = _derive_limit_up_set_legacy(quotes, stk_limit)
    assert new == legacy
    assert new == {("000001.SZ", "20240102")}


def test_derive_limit_up_set_empty_inputs() -> None:
    assert derive_limit_up_set(pd.DataFrame(columns=["ts_code", "trade_date", "close"]),
                               None) == set()


def test_derive_suspended_set_vectorized_matches_legacy() -> None:
    suspend_d = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "trade_date": "20240102"},
            {"ts_code": "000002.SZ", "trade_date": "20240103"},
        ]
    )
    assert derive_suspended_set(suspend_d) == _derive_suspended_set_legacy(suspend_d)
    assert derive_suspended_set(None) == set()


def test_derive_delist_map_vectorized_matches_legacy() -> None:
    delist = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "delist_date": "20240102"},
            {"ts_code": "000002.SZ", "delist_date": "20240103"},
        ]
    )
    assert derive_delist_map(delist) == _derive_delist_map_legacy(delist)
    assert derive_delist_map(None) == {}


def test_derive_list_date_map_vectorized_matches_legacy() -> None:
    listing = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "list_date": "20200102"},
            {"ts_code": "000002.SZ", "list_date": "20210103"},
        ]
    )
    assert derive_list_date_map(listing) == _derive_list_date_map_legacy(listing)
    assert derive_list_date_map(None) == {}
