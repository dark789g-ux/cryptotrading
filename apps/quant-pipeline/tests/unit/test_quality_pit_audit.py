"""PIT 三铁律 + 三幽灵 Bug 自动审计单测（不连库）。

每条铁律至少 1 个测试；幽灵 Bug 路径合并覆盖。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from quant_pipeline.quality.pit_audit import (
    audit_ghost2_adj_trap,
    audit_ghost3_fina_delay,
    audit_rule1_finance_uses_ann_date,
    audit_rule2_market_pit_window,
    verify_factor_window_no_future,
)
from tests.unit.test_quality_checks import FakeResult, FakeSession


# ----------------------------------------------------------------------
# 铁律 1：财务用披露日（复用 check_pit_finance）
# ----------------------------------------------------------------------

def test_rule1_finance_uses_ann_date_pass() -> None:
    session = FakeSession(
        [
            ("ann_date IS NULL", FakeResult(scalar=0)),
            ("factor_id LIKE :prefix", FakeResult(rows=[])),
        ]
    )
    results = audit_rule1_finance_uses_ann_date(session, ["20260517"])
    assert results == []


def test_rule1_finance_uses_ann_date_critical_when_null_ann() -> None:
    session = FakeSession(
        [
            ("ann_date IS NULL", FakeResult(scalar=10)),
            ("factor_id LIKE :prefix", FakeResult(rows=[])),
        ]
    )
    results = audit_rule1_finance_uses_ann_date(session, ["20260517"])
    assert len(results) == 1
    assert results[0].level == "critical"
    assert results[0].rule == "pit_finance"


# ----------------------------------------------------------------------
# 铁律 2：行情用 T 日盘后（factors/base.py 静态扫描）
# ----------------------------------------------------------------------

def test_rule2_market_pit_window_pass(tmp_path: Path) -> None:
    base_py = tmp_path / "base.py"
    base_py.write_text(
        "class Factor:\n    pit_window_days: int = 1\n",
        encoding="utf-8",
    )
    r = audit_rule2_market_pit_window(factors_base_path=base_py)
    assert r.passed is True
    assert r.detail["min_pit_window_days"] == 1


def test_rule2_market_pit_window_warn_when_declared_zero(tmp_path: Path) -> None:
    base_py = tmp_path / "base.py"
    base_py.write_text(
        "class Factor:\n    pit_window_days: int = 0\n",
        encoding="utf-8",
    )
    r = audit_rule2_market_pit_window(factors_base_path=base_py)
    assert r.passed is False
    assert r.level == "warn"


def test_rule2_market_pit_window_warn_when_not_declared(tmp_path: Path) -> None:
    base_py = tmp_path / "base.py"
    base_py.write_text(
        "class Factor:\n    name: str\n",
        encoding="utf-8",
    )
    r = audit_rule2_market_pit_window(factors_base_path=base_py)
    assert r.passed is False
    assert r.level == "warn"


def test_rule2_market_pit_window_info_when_base_missing(tmp_path: Path) -> None:
    r = audit_rule2_market_pit_window(factors_base_path=tmp_path / "absent.py")
    assert r.passed is True
    assert r.level == "info"


# ----------------------------------------------------------------------
# 铁律 3：因子窗口不跨未来（fixture 框架）
# ----------------------------------------------------------------------

class _FakeFactor:
    factor_id = "fake_mom_20d"

    def __init__(self) -> None:
        self.calls: list[tuple[str, list[str]]] = []

    def compute(self, trade_date: str, data: "_FakeDataFrame") -> None:
        self.calls.append((trade_date, list(data["trade_date"])))


class _FakeDataFrame:
    def __init__(self, dates: list[str]) -> None:
        self._dates = dates

    def __getitem__(self, key: str) -> list[str]:
        if key != "trade_date":
            raise KeyError(key)
        return self._dates

    @property
    def trade_date(self) -> list[str]:
        return self._dates

    def tolist(self) -> list[str]:
        return list(self._dates)


def test_rule3_factor_window_no_future_pass() -> None:
    factor = _FakeFactor()
    df = _FakeDataFrame(["20260510", "20260511", "20260512"])
    r = verify_factor_window_no_future(factor, "20260517", df)
    assert r.passed is True


def test_rule3_factor_window_no_future_critical_when_future_used() -> None:
    factor = _FakeFactor()
    # 含 20260520 > 20260517
    df = _FakeDataFrame(["20260510", "20260520"])
    r = verify_factor_window_no_future(factor, "20260517", df)
    assert r.passed is False
    assert r.level == "critical"
    assert "20260520" in r.detail["future_dates"]


# ----------------------------------------------------------------------
# 幽灵 Bug 2：复权陷阱
# ----------------------------------------------------------------------

def test_ghost2_adj_trap_no_candidates() -> None:
    session = FakeSession([("adj_series", FakeResult(rows=[]))])
    issues = audit_ghost2_adj_trap(session, sample_size_codes=2, sample_size_dates=1)
    assert issues == []


def test_ghost2_adj_trap_flags_factor_jump() -> None:
    # 第一个 SQL 返回候选 (ts, date)；后续 close_adj 比对返回值 prev=1.0 curr=2.0
    session = FakeSession(
        [
            (
                "adj_series",
                FakeResult(rows=[("000001.SZ", "20240620")]),
            ),
            (
                "factor_id = 'close_adj'",
                FakeResult(rows=[(2.0, 1.0)]),
            ),
        ]
    )
    issues = audit_ghost2_adj_trap(session, sample_size_codes=1, sample_size_dates=1)
    assert len(issues) == 1
    assert issues[0].rule == "adj_jump"
    assert issues[0].level == "critical"


# ----------------------------------------------------------------------
# 幽灵 Bug 3：财务披露延迟
# ----------------------------------------------------------------------

def test_ghost3_fina_delay_no_leaks() -> None:
    session = FakeSession(
        [
            (
                "FROM raw.fina_indicator",
                FakeResult(rows=[("000001.SZ", "20240428", "20240331")]),
            ),
            # leak_sql 默认返回空
        ]
    )
    issues = audit_ghost3_fina_delay(session, sample_size=1)
    assert issues == []


def test_ghost3_fina_delay_flags_leak() -> None:
    session = FakeSession(
        [
            (
                "FROM raw.fina_indicator",
                FakeResult(rows=[("000001.SZ", "20240428", "20240331")]),
            ),
            (
                "factor_id LIKE 'fin\\_%'",
                FakeResult(rows=[("fin_roe", "20240410")]),
            ),
        ]
    )
    issues = audit_ghost3_fina_delay(session, sample_size=1)
    assert len(issues) == 1
    assert issues[0].rule == "pit_finance"
    assert issues[0].detail["leaked_trade_dates"] == ["20240410"]


# ----------------------------------------------------------------------
# 入口冒烟：runner.run_pit_audit 拒空 dates
# ----------------------------------------------------------------------

def test_run_pit_audit_rejects_empty_dates() -> None:
    from quant_pipeline.quality.runner import run_pit_audit

    with pytest.raises(ValueError):
        run_pit_audit([])
