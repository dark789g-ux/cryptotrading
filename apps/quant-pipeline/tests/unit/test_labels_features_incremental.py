"""labels / features 增量物化底座（P1）单测。

纯函数 ``gap_subranges`` / ``coverage_ranges`` 不连库，直接断言；DB helper
``query_materialized_dates`` / ``query_trading_days`` 用 fake session（参考
``test_cli_trade_cal_offset.py`` 风格）。
"""

from __future__ import annotations

from typing import Any

import pytest

from quant_pipeline.labels_features_incremental import (
    coverage_ranges,
    gap_subranges,
    query_materialized_dates,
    query_trading_days,
)

# 一组共用的升序交易日（含周末/节假日跳变，刻意让自然日不相邻）
TRADING_DAYS = [
    "20260102",
    "20260105",
    "20260106",
    "20260107",
    "20260108",
]


# ----------------------------------------------------------------------
# gap_subranges
# ----------------------------------------------------------------------


def test_gap_subranges_gap_in_middle() -> None:
    """缺口在中间：两端已物化，中段连续缺口合成一段。"""

    materialized = {"20260102", "20260105", "20260108"}
    assert gap_subranges(materialized, TRADING_DAYS) == [("20260106", "20260107")]


def test_gap_subranges_full_overlap_empty_gap() -> None:
    """完全重叠（全部已物化）→ 空缺口。"""

    assert gap_subranges(set(TRADING_DAYS), TRADING_DAYS) == []


def test_gap_subranges_no_overlap_whole_range() -> None:
    """完全不重叠（一个都没物化）→ 整段一个缺口。"""

    assert gap_subranges(set(), TRADING_DAYS) == [("20260102", "20260108")]


def test_gap_subranges_adjacent_days_merge_into_one() -> None:
    """相邻交易日缺口合并成一段（即便自然日不连续，跨周末也算相邻）。"""

    # 已物化首尾，中间 3 个交易日（含跨周末 0105）全缺 → 合并一段
    materialized = {"20260102", "20260108"}
    assert gap_subranges(materialized, TRADING_DAYS) == [("20260105", "20260107")]


def test_gap_subranges_single_day_gap() -> None:
    """单日缺口：g0 == g1。"""

    materialized = {"20260102", "20260105", "20260107", "20260108"}
    assert gap_subranges(materialized, TRADING_DAYS) == [("20260106", "20260106")]


def test_gap_subranges_multiple_disjoint_gaps() -> None:
    """多个互不相邻缺口：被中间已物化日切成多段。"""

    materialized = {"20260105", "20260107"}
    assert gap_subranges(materialized, TRADING_DAYS) == [
        ("20260102", "20260102"),
        ("20260106", "20260106"),
        ("20260108", "20260108"),
    ]


def test_gap_subranges_ignores_dates_outside_trading_days() -> None:
    """materialized 含 trading_days 之外的日期 → 忽略，不影响缺口判定。"""

    materialized = {"20260102", "99991231", "20260105"}
    assert gap_subranges(materialized, TRADING_DAYS) == [("20260106", "20260108")]


def test_gap_subranges_empty_trading_days() -> None:
    """空交易日列表 → 空缺口。"""

    assert gap_subranges({"20260102"}, []) == []


# ----------------------------------------------------------------------
# coverage_ranges
# ----------------------------------------------------------------------


def test_coverage_ranges_continuous_single_segment() -> None:
    """连续覆盖 → 1 段。"""

    assert coverage_ranges(set(TRADING_DAYS), TRADING_DAYS) == [
        ("20260102", "20260108")
    ]


def test_coverage_ranges_with_hole_multiple_segments() -> None:
    """含空洞 → 多段（段间间隙即空洞）。"""

    materialized = {"20260102", "20260105", "20260107", "20260108"}
    assert coverage_ranges(materialized, TRADING_DAYS) == [
        ("20260102", "20260105"),
        ("20260107", "20260108"),
    ]


def test_coverage_ranges_single_day() -> None:
    """单日覆盖：s == e。"""

    assert coverage_ranges({"20260106"}, TRADING_DAYS) == [("20260106", "20260106")]


def test_coverage_ranges_empty_set() -> None:
    """空集 → 无覆盖。"""

    assert coverage_ranges(set(), TRADING_DAYS) == []


def test_coverage_ranges_ignores_dates_outside_trading_days() -> None:
    """materialized 含 trading_days 之外的日期 → 忽略。"""

    materialized = {"20260106", "20260107", "99991231"}
    assert coverage_ranges(materialized, TRADING_DAYS) == [("20260106", "20260107")]


def test_gap_and_coverage_are_complementary() -> None:
    """gap 与 coverage 互补：二者覆盖的交易日并集 == 全部交易日，且不相交。"""

    materialized = {"20260102", "20260106", "20260108"}
    gaps = gap_subranges(materialized, TRADING_DAYS)
    covs = coverage_ranges(materialized, TRADING_DAYS)

    idx = {d: i for i, d in enumerate(TRADING_DAYS)}

    def _expand(ranges: list[tuple[str, str]]) -> set[str]:
        out: set[str] = set()
        for lo, hi in ranges:
            out |= set(TRADING_DAYS[idx[lo] : idx[hi] + 1])
        return out

    gap_days = _expand(gaps)
    cov_days = _expand(covs)
    assert gap_days.isdisjoint(cov_days)
    assert gap_days | cov_days == set(TRADING_DAYS)


# ----------------------------------------------------------------------
# DB helper：fake session
# ----------------------------------------------------------------------


class _FakeSession:
    """记录 execute 入参并回放固定行的 mock session。"""

    def __init__(self, rows: list[tuple]) -> None:
        self._rows = rows
        self.captured_sql: str | None = None
        self.captured_params: dict[str, Any] | None = None

    def execute(self, sql: Any, params: dict[str, Any] | None = None) -> _FakeSession:
        self.captured_sql = str(sql)
        self.captured_params = params
        return self

    def fetchall(self) -> list[tuple]:
        return list(self._rows)


def test_query_materialized_dates_labels() -> None:
    """labels 表：scheme 键，返回 DISTINCT trade_date 集合，参数走绑定。"""

    session = _FakeSession([("20260105",), ("20260106",)])
    result = query_materialized_dates(
        session,  # type: ignore[arg-type]
        table="factors.labels",
        key_col="scheme",
        key_val="fwd_5d_ret",
        start="20260101",
        end="20260131",
    )
    assert result == {"20260105", "20260106"}
    # 表名 / 列名 literal 拼进 SQL
    assert "factors.labels" in (session.captured_sql or "")
    assert "scheme" in (session.captured_sql or "")
    assert "DISTINCT trade_date" in (session.captured_sql or "")
    # 键值 / 区间走绑定参数
    assert session.captured_params == {
        "k": "fwd_5d_ret",
        "start": "20260101",
        "end": "20260131",
    }


def test_query_materialized_dates_feature_matrix() -> None:
    """feature_matrix 表：feature_set_id 键。"""

    session = _FakeSession([("20260105",)])
    result = query_materialized_dates(
        session,  # type: ignore[arg-type]
        table="factors.feature_matrix",
        key_col="feature_set_id",
        key_val="fs_abc123",
        start="20260101",
        end="20260131",
    )
    assert result == {"20260105"}
    assert "factors.feature_matrix" in (session.captured_sql or "")
    assert "feature_set_id" in (session.captured_sql or "")
    assert (session.captured_params or {})["k"] == "fs_abc123"


def test_query_materialized_dates_empty() -> None:
    """无命中 → 空集。"""

    session = _FakeSession([])
    result = query_materialized_dates(
        session,  # type: ignore[arg-type]
        table="factors.labels",
        key_col="scheme",
        key_val="missing",
        start="20260101",
        end="20260131",
    )
    assert result == set()


def test_query_materialized_dates_rejects_unknown_table() -> None:
    """非法 table → ValueError（防注入白名单）。"""

    session = _FakeSession([])
    with pytest.raises(ValueError, match="非法 table"):
        query_materialized_dates(
            session,  # type: ignore[arg-type]
            table="factors.evil; DROP TABLE x",
            key_col="scheme",
            key_val="x",
            start="20260101",
            end="20260131",
        )


def test_query_materialized_dates_rejects_mismatched_key_col() -> None:
    """key_col 与 table 不匹配 → ValueError。"""

    session = _FakeSession([])
    with pytest.raises(ValueError, match="不允许 key_col"):
        query_materialized_dates(
            session,  # type: ignore[arg-type]
            table="factors.labels",
            key_col="feature_set_id",  # labels 不该用这个键
            key_val="x",
            start="20260101",
            end="20260131",
        )


def test_query_materialized_dates_rejects_injection_in_key_col() -> None:
    """key_col 含注入串（不在白名单）→ ValueError，不拼进 SQL。"""

    session = _FakeSession([])
    with pytest.raises(ValueError, match="不允许 key_col"):
        query_materialized_dates(
            session,  # type: ignore[arg-type]
            table="factors.labels",
            key_col="scheme = 'x' OR 1=1 --",
            key_val="x",
            start="20260101",
            end="20260131",
        )
    # 注入串没进 SQL
    assert session.captured_sql is None


def test_query_trading_days() -> None:
    """raw.trade_cal：is_open=1 升序 cal_date 列表，exchange 透传绑定参数。"""

    session = _FakeSession([("20260105",), ("20260106",), ("20260107",)])
    result = query_trading_days(
        session,  # type: ignore[arg-type]
        start="20260101",
        end="20260131",
        exchange="SZSE",
    )
    assert result == ["20260105", "20260106", "20260107"]
    assert "raw.trade_cal" in (session.captured_sql or "")
    assert "is_open = 1" in (session.captured_sql or "")
    assert session.captured_params == {
        "ex": "SZSE",
        "start": "20260101",
        "end": "20260131",
    }


def test_query_trading_days_default_exchange_sse() -> None:
    """默认 exchange=SSE。"""

    session = _FakeSession([("20260105",)])
    query_trading_days(
        session,  # type: ignore[arg-type]
        start="20260101",
        end="20260131",
    )
    assert (session.captured_params or {})["ex"] == "SSE"
