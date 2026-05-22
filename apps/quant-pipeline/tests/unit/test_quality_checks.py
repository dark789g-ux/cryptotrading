"""8 项数据质量检验单测（不连库 / 用 FakeSession 替代）。

策略：每条 check 函数对 session 仅调用 session.execute(sql, bind)，
我们用一个 FakeSession 按"SQL 文本里包含的关键字"决定返回值，
即可覆盖通过路径与失败路径。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

from quant_pipeline.quality.checks import (
    check_adj_jump,
    check_cross_table_alignment,
    check_duplicate_pk,
    check_extreme_value,
    check_null_violation,
    check_pit_finance,
    check_row_count_drift,
    check_survivor_bias,
    make_threshold_relaxation_record,
)


# ----------------------------------------------------------------------
# FakeSession：根据 SQL 关键字返回值的最小实现
# ----------------------------------------------------------------------

class FakeResult:
    """模拟 session.execute() 的返回值。"""

    def __init__(
        self,
        *,
        scalar: Any = None,
        rows: list[tuple[Any, ...]] | None = None,
        mappings_rows: list[dict[str, Any]] | None = None,
    ) -> None:
        self._scalar = scalar
        self._rows = rows or []
        self._mappings_rows = mappings_rows or []

    def scalar_one(self) -> Any:
        return self._scalar

    def scalar(self) -> Any:
        return self._scalar

    def first(self) -> tuple[Any, ...] | None:
        return self._rows[0] if self._rows else None

    def all(self) -> list[tuple[Any, ...]]:
        return list(self._rows)

    def scalars(self) -> "FakeResult":
        return FakeResult(rows=[(r[0],) for r in self._rows])

    def mappings(self) -> "FakeResult":
        return FakeResult(mappings_rows=self._mappings_rows or [dict(r) for r in []])


class FakeMappings:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows

    def all(self) -> list[dict[str, Any]]:
        return list(self._rows)

    def first(self) -> dict[str, Any] | None:
        return self._rows[0] if self._rows else None


class FakeSession:
    """根据 responses（关键字 → FakeResult）匹配 SQL 文本。"""

    def __init__(self, responses: list[tuple[str, FakeResult]]) -> None:
        self.responses = responses
        self.executed: list[tuple[str, Mapping[str, Any] | None]] = []

    def execute(self, sql: Any, bind: Mapping[str, Any] | None = None) -> Any:
        sql_text = str(getattr(sql, "text", sql))
        self.executed.append((sql_text, bind))
        for key, resp in self.responses:
            if key in sql_text:
                # 返回支持 .mappings() 链式的 wrapper
                return _ResultWrapper(resp)
        # 默认空结果
        return _ResultWrapper(FakeResult(scalar=0, rows=[]))


class _ResultWrapper:
    def __init__(self, inner: FakeResult) -> None:
        self._inner = inner

    def scalar_one(self) -> Any:
        return self._inner.scalar_one()

    def scalar(self) -> Any:
        return self._inner.scalar()

    def first(self) -> Any:
        return self._inner.first()

    def all(self) -> Any:
        return self._inner.all()

    def scalars(self) -> "_ResultWrapper":
        return _ResultWrapper(self._inner.scalars())

    def mappings(self) -> FakeMappings:
        return FakeMappings(self._inner._mappings_rows)


# ----------------------------------------------------------------------
# 1. row_count_drift
# ----------------------------------------------------------------------

def test_row_count_drift_pass_within_threshold() -> None:
    session = FakeSession(
        [
            ("trade_date = :d", FakeResult(scalar=5000)),
            ("trade_date < :d", FakeResult(scalar=5050)),
        ]
    )
    r = check_row_count_drift(session, "20260517", {})
    assert r.passed is True
    assert r.rule == "row_count_drift"
    assert r.detail["delta_ratio"] < 0.05


def test_row_count_drift_critical_over_10pct() -> None:
    session = FakeSession(
        [
            ("trade_date = :d", FakeResult(scalar=4000)),
            ("trade_date < :d", FakeResult(scalar=5000)),
        ]
    )
    r = check_row_count_drift(session, "20260517", {})
    assert r.passed is False
    assert r.level == "critical"
    assert r.detail["delta_ratio"] == pytest.approx(0.2)


def test_row_count_drift_warn_between_5_and_10() -> None:
    session = FakeSession(
        [
            ("trade_date = :d", FakeResult(scalar=4640)),
            ("trade_date < :d", FakeResult(scalar=5000)),
        ]
    )
    r = check_row_count_drift(session, "20260517", {})
    assert r.passed is False
    assert r.level == "warn"


def test_row_count_drift_relaxation_via_params() -> None:
    # 7% 漂移；默认会 warn，但放宽阈值到 0.10 后通过
    session = FakeSession(
        [
            ("trade_date = :d", FakeResult(scalar=4650)),
            ("trade_date < :d", FakeResult(scalar=5000)),
        ]
    )
    r = check_row_count_drift(
        session, "20260517", {"row_count_drift_threshold": 0.10}
    )
    assert r.passed is True
    assert r.level == "info"


def test_make_threshold_relaxation_record() -> None:
    rec = make_threshold_relaxation_record("20260517", 0.05, 0.10)
    assert rec.level == "info"
    assert rec.passed is False  # 强制 emit
    assert rec.detail["event"] == "threshold_relaxed"


# ----------------------------------------------------------------------
# 2. duplicate_pk
# ----------------------------------------------------------------------

def test_duplicate_pk_pass_no_duplicates() -> None:
    session = FakeSession([])  # 所有 SQL 默认空结果 → 无重复
    r = check_duplicate_pk(session, "20260517", {})
    assert r.passed is True
    assert r.rule == "duplicate_pk"


def test_duplicate_pk_critical_when_dup_found() -> None:
    session = FakeSession(
        [
            # 任一表 GROUP BY HAVING 返回行 → critical
            (
                "FROM raw.daily_quote",
                FakeResult(
                    mappings_rows=[
                        {"ts_code": "000001.SZ", "trade_date": "20260517", "c": 2}
                    ]
                ),
            ),
        ]
    )
    r = check_duplicate_pk(session, "20260517", {})
    assert r.passed is False
    assert r.level == "critical"
    assert r.detail["violations"][0]["table"] == "raw.daily_quote"


# ----------------------------------------------------------------------
# 3. null_violation
# ----------------------------------------------------------------------

def test_null_violation_pass() -> None:
    # 各表当日有数据（行数 > 0）才不触发"空表"critical；无 NULL 违约 → 通过
    session = FakeSession(
        [
            ("count(*) FROM raw.daily_quote WHERE", FakeResult(scalar=5000)),
            ("count(*) FROM raw.adj_factor WHERE", FakeResult(scalar=5000)),
        ]
    )
    r = check_null_violation(session, "20260517", {})
    assert r.passed is True
    assert r.rule == "null_violation"


def test_null_violation_critical_when_empty_table_on_trading_day() -> None:
    """交易日 + 基础表当日 0 行 → 漏同步 → critical（06-quality.md 问题 3）。"""

    session = FakeSession(
        [
            # trade_cal 确认是交易日
            ("FROM raw.trade_cal", FakeResult(rows=[(2, 2)])),
            # 表行数查询默认 scalar=0 → 空表
        ]
    )
    r = check_null_violation(session, "20260517", {})
    assert r.passed is False
    assert r.level == "critical"
    assert r.detail["reason"] == "empty_table_on_trading_day"


def test_null_violation_skips_when_non_trading_day() -> None:
    """非交易日 + 表空 → 合法空，不报 critical。"""

    session = FakeSession(
        [
            # trade_cal: total=2, open_cnt=0 → 非交易日
            ("FROM raw.trade_cal", FakeResult(rows=[(2, 0)])),
        ]
    )
    r = check_null_violation(session, "20260517", {})
    assert r.passed is True


def test_null_violation_critical_when_ohlc_null() -> None:
    # 让 raw.daily_quote.open IS NULL 返回 3 行 + count=3
    session = FakeSession(
        [
            # 注意顺序：更具体的 "open IS NULL" 键必须排在表行数键之前，
            # 否则 NULL-count 查询会先命中宽泛的 "count(*) FROM ... WHERE"。
            (
                "open IS NULL\n                LIMIT 10",
                FakeResult(rows=[("000001.SZ",), ("000002.SZ",), ("000003.SZ",)]),
            ),
            (
                "open IS NULL",  # count(*) 那条
                FakeResult(scalar=3),
            ),
            # 各表当日有数据，绕过"空表"分支
            ("count(*) FROM raw.daily_quote WHERE", FakeResult(scalar=5000)),
            ("count(*) FROM raw.adj_factor WHERE", FakeResult(scalar=5000)),
        ]
    )
    r = check_null_violation(session, "20260517", {})
    assert r.passed is False
    assert r.level == "critical"
    assert r.detail["column"] == "open"
    assert r.detail["violation_count"] == 3


# ----------------------------------------------------------------------
# 4. extreme_value
# ----------------------------------------------------------------------

def test_extreme_value_pass_no_outliers() -> None:
    session = FakeSession([("outliers", FakeResult(rows=[]))])
    r = check_extreme_value(session, "20260517", {})
    assert r.passed is True


def test_extreme_value_warn_when_outliers() -> None:
    session = FakeSession(
        [
            (
                "outliers",
                FakeResult(rows=[("mom_20d", 12), ("vol_60d", 5)]),
            )
        ]
    )
    r = check_extreme_value(session, "20260517", {})
    assert r.passed is False
    assert r.level == "warn"
    assert r.detail["factor_id"] == "mom_20d"
    assert r.detail["outlier_count"] == 12


# ----------------------------------------------------------------------
# 5. pit_finance
# ----------------------------------------------------------------------

def test_pit_finance_pass_when_no_null_ann_and_no_leak() -> None:
    session = FakeSession(
        [
            ("ann_date IS NULL", FakeResult(scalar=0)),
            ("factor_id LIKE :prefix", FakeResult(rows=[])),
        ]
    )
    r = check_pit_finance(session, "20260517", {})
    assert r.passed is True


def test_pit_finance_critical_when_null_ann_date_exists() -> None:
    session = FakeSession(
        [
            ("ann_date IS NULL", FakeResult(scalar=42)),
            ("factor_id LIKE :prefix", FakeResult(rows=[])),
        ]
    )
    r = check_pit_finance(session, "20260517", {})
    assert r.passed is False
    assert r.level == "critical"
    assert r.detail["null_ann_date_count"] == 42


def test_pit_finance_critical_when_factor_missing_fina() -> None:
    session = FakeSession(
        [
            ("ann_date IS NULL", FakeResult(scalar=0)),
            (
                "factor_id LIKE :prefix",
                FakeResult(rows=[("fin_roe", ["000001.SZ", "000002.SZ"])]),
            ),
        ]
    )
    r = check_pit_finance(session, "20260517", {})
    assert r.passed is False
    assert r.level == "critical"
    assert r.detail["factor_id"] == "fin_roe"


# ----------------------------------------------------------------------
# 6. adj_jump
# ----------------------------------------------------------------------

def test_adj_jump_pass_no_jump() -> None:
    session = FakeSession([])
    r = check_adj_jump(session, "20260517", {})
    assert r.passed is True


def test_adj_jump_warn_when_jump_found() -> None:
    session = FakeSession(
        [
            (
                "p.prev_factor > 0",
                FakeResult(rows=[("000001.SZ", 1.0, 6.5, 6.5)]),
            )
        ]
    )
    r = check_adj_jump(session, "20260517", {})
    assert r.passed is False
    assert r.level == "warn"
    assert r.detail["ts_code"] == "000001.SZ"
    assert r.detail["ratio"] == 6.5


# ----------------------------------------------------------------------
# 7. survivor_bias
# ----------------------------------------------------------------------

def test_survivor_bias_pass_when_zero_bad_codes() -> None:
    session = FakeSession([("NOT EXISTS", FakeResult(rows=[(0, 0)]))])
    r = check_survivor_bias(session, "20260517", {})
    assert r.passed is True


def test_survivor_bias_critical_when_phantom_codes_used() -> None:
    session = FakeSession(
        [
            # count 行
            ("count(DISTINCT f.ts_code)", FakeResult(rows=[(5, 3)])),
            # sample 行（含 LIMIT 20）
            (
                "LIMIT 20",
                FakeResult(rows=[("mom_20d", "999999.SZ"), ("vol_60d", "999998.SZ")]),
            ),
        ]
    )
    r = check_survivor_bias(session, "20260517", {})
    assert r.passed is False
    assert r.level == "critical"
    assert r.detail["count"] == 5


# ----------------------------------------------------------------------
# 8. cross_table_alignment
# ----------------------------------------------------------------------

def test_cross_table_alignment_pass_when_derived_ge_base() -> None:
    # 5000 stocks * 30 factors = 150000 派生行
    session = FakeSession(
        [("base_rows", FakeResult(rows=[(5000, 150000, 5000, 5000)]))]
    )
    r = check_cross_table_alignment(session, "20260517", {})
    assert r.passed is True


def test_cross_table_alignment_critical_when_derived_lt_base() -> None:
    session = FakeSession(
        [("base_rows", FakeResult(rows=[(5000, 3000, 5000, 3000)]))]
    )
    r = check_cross_table_alignment(session, "20260517", {})
    assert r.passed is False
    assert r.level == "critical"
    assert r.detail["base_rows"] == 5000
    assert r.detail["derived_rows"] == 3000


def test_cross_table_alignment_skips_when_base_empty_non_trading_day() -> None:
    """基础表空 + 非交易日 → 合法空，info 跳过（06-quality.md 问题 2）。"""

    session = FakeSession(
        [
            ("base_rows", FakeResult(rows=[(0, 0, 0, 0)])),
            # trade_cal: total=2, open_cnt=0 → 非交易日
            ("FROM raw.trade_cal", FakeResult(rows=[(2, 0)])),
        ]
    )
    r = check_cross_table_alignment(session, "20260517", {})
    assert r.passed is True
    assert r.level == "info"
    assert r.detail["note"] == "non_trading_day"


def test_cross_table_alignment_critical_when_base_empty_on_trading_day() -> None:
    """基础表空 + 交易日 → 漏同步 → critical（06-quality.md 问题 2）。"""

    session = FakeSession(
        [
            ("base_rows", FakeResult(rows=[(0, 0, 0, 0)])),
            ("FROM raw.trade_cal", FakeResult(rows=[(2, 2)])),
        ]
    )
    r = check_cross_table_alignment(session, "20260517", {})
    assert r.passed is False
    assert r.level == "critical"
    assert r.detail["reason"] == "base_table_empty_on_trading_day"
