"""pytest 单测：_recompute_helpers 纯函数。

不连 DB、不调 compute_labels；只测 _month_ends_from_caldates 与 diff_labels。
跑法：
    cd apps/quant-pipeline
    uv run pytest tests/integration/test_recompute_helpers.py -q
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from tests.integration._recompute_helpers import (
    _month_ends_from_caldates,
    diff_labels,
)


# ──────────────────────────────────────────────
# _month_ends_from_caldates
# ──────────────────────────────────────────────

class TestMonthEndsFromCaldates:
    def test_single_month(self) -> None:
        """单月：取该月最后一个交易日。"""
        dates = ["20230301", "20230302", "20230303", "20230330", "20230331"]
        result = _month_ends_from_caldates(dates)
        assert result == ["20230331"]

    def test_two_months(self) -> None:
        """跨两个月：各取最后一个交易日。"""
        dates = [
            "20230301", "20230315", "20230331",
            "20230403", "20230428",
        ]
        result = _month_ends_from_caldates(dates)
        assert result == ["20230331", "20230428"]

    def test_cross_year(self) -> None:
        """跨年：12 月 → 1 月，各月独立分组。"""
        dates = [
            "20221228", "20221229", "20221230",
            "20230103", "20230104", "20230131",
        ]
        result = _month_ends_from_caldates(dates)
        assert result == ["20221230", "20230131"]

    def test_end_falls_mid_month(self) -> None:
        """end 落在月中：返回该月最后一个已知交易日（不是月末自然日）。"""
        dates = [
            "20230103", "20230104", "20230131",
            "20230201", "20230215",  # 2 月只有两天，最后一天 0215
        ]
        result = _month_ends_from_caldates(dates)
        assert result == ["20230131", "20230215"]

    def test_empty_input(self) -> None:
        """空输入 → 空列表。"""
        assert _month_ends_from_caldates([]) == []

    def test_three_months(self) -> None:
        """三个月，每月有多个交易日。"""
        dates = [
            "20230103", "20230116", "20230131",
            "20230201", "20230228",
            "20230301", "20230331",
        ]
        result = _month_ends_from_caldates(dates)
        assert result == ["20230131", "20230228", "20230331"]

    def test_single_day(self) -> None:
        """只有一天。"""
        dates = ["20230615"]
        result = _month_ends_from_caldates(dates)
        assert result == ["20230615"]


# ──────────────────────────────────────────────
# diff_labels — 辅助函数
# ──────────────────────────────────────────────

def _make_df(rows: list[dict]) -> pd.DataFrame:
    """构造测试用 DataFrame，列与 dump_labels 输出相同。"""
    df = pd.DataFrame(rows, columns=["trade_date", "ts_code", "value", "exit_reason", "hold_days"])
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    df["hold_days"] = pd.to_numeric(df["hold_days"], errors="coerce")
    return df


class TestDiffLabels:
    def test_identical(self) -> None:
        """完全相同：所有计数为 0。"""
        rows = [
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "ma5_break", "hold_days": 5},
            {"trade_date": "20230104", "ts_code": "000002.SZ", "value": -0.03,
             "exit_reason": "stop_loss", "hold_days": 3},
        ]
        old = _make_df(rows)
        new = _make_df(rows)
        result = diff_labels(old, new)
        assert result["only_in_old"] == 0
        assert result["only_in_new"] == 0
        assert result["value_changed"] == 0
        assert result["exit_reason_changed"] == 0
        assert result["hold_days_changed"] == 0
        assert result["common_rows"] == 2

    def test_only_in_old(self) -> None:
        """old 有、new 无：only_in_old 计数正确。"""
        old = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "ma5_break", "hold_days": 5},
            {"trade_date": "20230104", "ts_code": "000002.SZ", "value": -0.03,
             "exit_reason": "stop_loss", "hold_days": 3},
        ])
        new = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "ma5_break", "hold_days": 5},
        ])
        result = diff_labels(old, new)
        assert result["only_in_old"] == 1
        assert result["only_in_new"] == 0
        assert result["common_rows"] == 1

    def test_only_in_new(self) -> None:
        """new 有、old 无：only_in_new 计数正确。"""
        old = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "ma5_break", "hold_days": 5},
        ])
        new = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "ma5_break", "hold_days": 5},
            {"trade_date": "20230105", "ts_code": "000003.SZ", "value": 0.02,
             "exit_reason": "timeout", "hold_days": 20},
        ])
        result = diff_labels(old, new)
        assert result["only_in_old"] == 0
        assert result["only_in_new"] == 1

    def test_value_within_atol_counts_equal(self) -> None:
        """value 差 < 1e-9：算相等，value_changed=0。"""
        old = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "ma5_break", "hold_days": 5},
        ])
        new = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ",
             "value": 0.05 + 5e-10,   # < 1e-9，算相等
             "exit_reason": "ma5_break", "hold_days": 5},
        ])
        result = diff_labels(old, new)
        assert result["value_changed"] == 0

    def test_value_exceeds_atol_counts_changed(self) -> None:
        """value 差 > 1e-9：算变更，value_changed=1。"""
        old = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "ma5_break", "hold_days": 5},
        ])
        new = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ",
             "value": 0.05 + 2e-9,   # > 1e-9，算变更
             "exit_reason": "ma5_break", "hold_days": 5},
        ])
        result = diff_labels(old, new)
        assert result["value_changed"] == 1

    def test_exit_reason_changed(self) -> None:
        """exit_reason 不同：exit_reason_changed=1。"""
        old = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "ma5_break", "hold_days": 5},
        ])
        new = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "stop_loss", "hold_days": 5},
        ])
        result = diff_labels(old, new)
        assert result["exit_reason_changed"] == 1
        assert result["value_changed"] == 0

    def test_hold_days_changed(self) -> None:
        """hold_days 不同：hold_days_changed=1。"""
        old = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "ma5_break", "hold_days": 5},
        ])
        new = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "ma5_break", "hold_days": 7},
        ])
        result = diff_labels(old, new)
        assert result["hold_days_changed"] == 1
        assert result["exit_reason_changed"] == 0

    def test_nan_value_both_nan_counts_equal(self) -> None:
        """old 和 new 的 value 都是 NaN：equal_nan=True，算相等。"""
        old = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": None,
             "exit_reason": "ma5_break", "hold_days": 5},
        ])
        new = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": None,
             "exit_reason": "ma5_break", "hold_days": 5},
        ])
        result = diff_labels(old, new)
        assert result["value_changed"] == 0

    def test_exit_reason_null_vs_null_equal(self) -> None:
        """exit_reason 都是 None（fillna('∅')后相等）：exit_reason_changed=0。"""
        old = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": None, "hold_days": 5},
        ])
        new = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": None, "hold_days": 5},
        ])
        result = diff_labels(old, new)
        assert result["exit_reason_changed"] == 0

    def test_exit_reason_null_vs_value_changed(self) -> None:
        """exit_reason: None vs 'ma5_break'（fillna 后 '∅' != 'ma5_break'）→ 变更。"""
        old = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": None, "hold_days": 5},
        ])
        new = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "ma5_break", "hold_days": 5},
        ])
        result = diff_labels(old, new)
        assert result["exit_reason_changed"] == 1

    def test_hold_days_null_vs_null_equal(self) -> None:
        """hold_days 都是 None（fillna(-1)后相等）：hold_days_changed=0。"""
        old = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "ma5_break", "hold_days": None},
        ])
        new = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "ma5_break", "hold_days": None},
        ])
        result = diff_labels(old, new)
        assert result["hold_days_changed"] == 0

    def test_total_rows_reported(self) -> None:
        """total_old_rows = len(old)，total_new_rows = len(new) — 各自独立计，公共行不合并。"""
        old = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "ma5_break", "hold_days": 5},
            {"trade_date": "20230104", "ts_code": "000002.SZ", "value": -0.03,
             "exit_reason": "stop_loss", "hold_days": 3},
        ])
        new = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "ma5_break", "hold_days": 5},
            {"trade_date": "20230105", "ts_code": "000003.SZ", "value": 0.01,
             "exit_reason": "timeout", "hold_days": 20},
        ])
        result = diff_labels(old, new)
        # old=2, new=2, 公共1行
        assert result["only_in_old"] == 1
        assert result["only_in_new"] == 1
        assert result["common_rows"] == 1
        assert result["total_old_rows"] == 2
        assert result["total_new_rows"] == 2

    def test_samples_included(self) -> None:
        """diff 结果含每类差异的样本列表。"""
        old = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.05,
             "exit_reason": "ma5_break", "hold_days": 5},
            {"trade_date": "20230104", "ts_code": "000099.SZ", "value": 0.02,
             "exit_reason": "stop_loss", "hold_days": 2},
        ])
        new = _make_df([
            {"trade_date": "20230103", "ts_code": "000001.SZ", "value": 0.09,
             "exit_reason": "ma5_break", "hold_days": 5},  # value changed
        ])
        result = diff_labels(old, new)
        assert result["value_changed"] == 1
        # sample keys 存在
        assert "value_changed_samples" in result
        assert len(result["value_changed_samples"]) >= 1

    def test_empty_both(self) -> None:
        """两个空 DataFrame：所有计数 0。"""
        cols = ["trade_date", "ts_code", "value", "exit_reason", "hold_days"]
        old = pd.DataFrame(columns=cols)
        new = pd.DataFrame(columns=cols)
        old["value"] = pd.to_numeric(old["value"], errors="coerce")
        old["hold_days"] = pd.to_numeric(old["hold_days"], errors="coerce")
        new["value"] = pd.to_numeric(new["value"], errors="coerce")
        new["hold_days"] = pd.to_numeric(new["hold_days"], errors="coerce")
        result = diff_labels(old, new)
        assert result["only_in_old"] == 0
        assert result["only_in_new"] == 0
        assert result["common_rows"] == 0
        assert result["value_changed"] == 0
