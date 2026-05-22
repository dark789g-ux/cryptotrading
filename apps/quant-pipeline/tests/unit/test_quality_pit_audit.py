"""PIT 三铁律 + 三幽灵 Bug 自动审计单测（不连库）。

每条铁律至少 1 个测试；幽灵 Bug 路径合并覆盖。
"""

from __future__ import annotations

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
# 铁律 2：行情用 T 日盘后（import factors.base.Factor 读取契约属性）
# ----------------------------------------------------------------------

def test_rule2_market_pit_window_pass_when_attr_declared() -> None:
    class _FakeFactorCls:
        pit_window_days: int = 0  # 抽象基类默认 0 是合法哨兵

    r = audit_rule2_market_pit_window(factor_cls=_FakeFactorCls)
    assert r.passed is True
    assert r.level == "info"


def test_rule2_market_pit_window_warn_when_attr_missing() -> None:
    class _FakeFactorCls:
        name: str = ""

    r = audit_rule2_market_pit_window(factor_cls=_FakeFactorCls)
    assert r.passed is False
    assert r.level == "warn"


def test_rule2_market_pit_window_warn_when_attr_not_int() -> None:
    class _FakeFactorCls:
        pit_window_days = "bad"

    r = audit_rule2_market_pit_window(factor_cls=_FakeFactorCls)
    assert r.passed is False
    assert r.level == "warn"


def test_rule2_market_pit_window_real_factor_class() -> None:
    """默认 import 真实 factors.base.Factor：属性已声明 → pass。"""

    r = audit_rule2_market_pit_window()
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
# 幽灵 Bug 2：复权陷阱 —— 已标注「未实现」（06-quality.md 问题 5）
# ----------------------------------------------------------------------

def test_ghost2_adj_trap_returns_not_implemented_marker() -> None:
    """ghost2 不再用"跳变幅度"代理（既假阳又假阴），改为返回 info 级未实现留痕。"""

    session = FakeSession([])
    issues = audit_ghost2_adj_trap(session, sample_size_codes=2, sample_size_dates=1)
    assert len(issues) == 1
    res = issues[0]
    assert res.passed is True  # 不是 critical 失败
    assert res.level == "info"  # 但仍会 emit 留痕，非静默绿灯
    assert res.detail["audit_status"] == "not_implemented"


# ----------------------------------------------------------------------
# 幽灵 Bug 3：财务披露延迟 —— 已标注「未实现」（06-quality.md 问题 4）
# ----------------------------------------------------------------------

def test_ghost3_fina_delay_returns_not_implemented_marker() -> None:
    """ghost3 原 [end_date, ann_date) 窗口既假阳又假阴，改为返回 info 级未实现留痕。"""

    session = FakeSession([])
    issues = audit_ghost3_fina_delay(session, sample_size=1)
    assert len(issues) == 1
    res = issues[0]
    assert res.passed is True
    assert res.level == "info"
    assert res.detail["audit_status"] == "not_implemented"


# ----------------------------------------------------------------------
# 入口冒烟：runner.run_pit_audit 拒空 dates
# ----------------------------------------------------------------------

def test_run_pit_audit_rejects_empty_dates() -> None:
    from quant_pipeline.quality.runner import run_pit_audit

    with pytest.raises(ValueError):
        run_pit_audit([])
