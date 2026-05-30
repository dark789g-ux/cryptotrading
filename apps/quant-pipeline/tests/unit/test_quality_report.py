"""CheckResult / emit / gate_check 的契约测试（不连库）。"""

from __future__ import annotations

from typing import Any

import pytest

from quant_pipeline.quality.report import ALLOWED_RULES, CheckResult, gate_check


def test_check_result_rejects_unknown_rule() -> None:
    with pytest.raises(ValueError):
        CheckResult(
            passed=False,
            level="warn",
            rule="made_up_rule",
            detail={},
            trade_date="20260517",
        )


def test_check_result_accepts_known_rule() -> None:
    r = CheckResult(
        passed=True,
        level="info",
        rule="row_count_drift",
        detail={"date": "20260517"},
        trade_date="20260517",
    )
    assert r.passed is True
    assert "row_count_drift" in ALLOWED_RULES


def test_check_result_accepts_empty_suffix_rule() -> None:
    # *_empty 由 sync 模块拼装，允许直接通过
    r = CheckResult(
        passed=False,
        level="warn",
        rule="daily_empty",
        detail={"api_name": "daily", "empty_path": "items_empty"},
        trade_date="20260517",
    )
    assert r.rule == "daily_empty"


def test_check_result_rejects_bad_trade_date() -> None:
    with pytest.raises(ValueError):
        CheckResult(
            passed=False,
            level="warn",
            rule="row_count_drift",
            detail={},
            trade_date="2026-05-17",
        )


def test_check_result_rejects_bad_level() -> None:
    with pytest.raises(ValueError):
        CheckResult(
            passed=False,
            level="fatal",  # type: ignore[arg-type]
            rule="row_count_drift",
            detail={},
            trade_date="20260517",
        )


# ----------------------------------------------------------------------
# gate_check：训练前 / 推理前必检入口（spec 04 §2）
# ----------------------------------------------------------------------

def _install_stub_session(monkeypatch: pytest.MonkeyPatch) -> None:
    """stub session_scope，避免连库；同时 stub emit 避免触发 worker.progress 写入。"""

    from quant_pipeline.quality import report as report_mod

    class _StubSession:
        def execute(self, *_: Any, **__: Any) -> Any:
            raise AssertionError("FakeCheck 应当不真正调用 session.execute")

    class _StubCtx:
        def __enter__(self) -> _StubSession:
            return _StubSession()

        def __exit__(self, *_: Any) -> None:
            return None

    # gate_check 在函数体内做 `from quant_pipeline.db.engine import session_scope`，
    # 实际名称解析时走 module 属性 → patch 源模块即可
    from quant_pipeline.db import engine as engine_mod
    monkeypatch.setattr(engine_mod, "session_scope", lambda: _StubCtx())
    monkeypatch.setattr(report_mod, "emit", lambda *_a, **_k: None)


def _set_all_checks(
    monkeypatch: pytest.MonkeyPatch,
    fake_checks: dict[str, CheckResult],
) -> None:
    """把 ALL_CHECKS 替换为映射；每个 fake check 返回字典里对应的 CheckResult。"""

    from quant_pipeline.quality import checks as checks_mod

    def _make_fn(name: str) -> Any:
        def _fn(session: Any, trade_date: str, params: dict[str, Any]) -> CheckResult:
            return fake_checks[name]

        return _fn

    monkeypatch.setattr(
        checks_mod,
        "ALL_CHECKS",
        tuple((name, _make_fn(name)) for name in fake_checks),
    )


def test_gate_check_rejects_unknown_mode() -> None:
    with pytest.raises(ValueError, match="gate_check mode"):
        gate_check("20260517", mode="something")  # type: ignore[arg-type]


def test_gate_check_training_pass_when_all_green(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_stub_session(monkeypatch)
    _set_all_checks(
        monkeypatch,
        {
            "null_violation": CheckResult(
                passed=True, level="info", rule="null_violation",
                detail={"date": "20260517"}, trade_date="20260517",
            ),
            "duplicate_pk": CheckResult(
                passed=True, level="info", rule="duplicate_pk",
                detail={"date": "20260517"}, trade_date="20260517",
            ),
            "cross_table_alignment": CheckResult(
                passed=True, level="info", rule="cross_table_alignment",
                detail={"date": "20260517"}, trade_date="20260517",
            ),
            "pit_finance": CheckResult(
                passed=True, level="info", rule="pit_finance",
                detail={"date": "20260517"}, trade_date="20260517",
            ),
            "survivor_bias": CheckResult(
                passed=True, level="info", rule="survivor_bias",
                detail={"date": "20260517"}, trade_date="20260517",
            ),
            "adj_jump": CheckResult(
                passed=True, level="info", rule="adj_jump",
                detail={"date": "20260517"}, trade_date="20260517",
            ),
        },
    )
    report = gate_check("20260517", mode="training_pregate", strict=True)
    assert report.passed is True
    assert report.critical_count == 0


def test_gate_check_strict_raises_on_critical(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """strict=True 时遇 critical 抛 QualityGateBlocked。"""

    from quant_pipeline.quality.runner import QualityGateBlocked

    _install_stub_session(monkeypatch)
    _set_all_checks(
        monkeypatch,
        {
            "null_violation": CheckResult(
                passed=False, level="critical", rule="null_violation",
                detail={
                    "table": "raw.daily_quote",
                    "column": "close",
                    "violation_count": 3,
                    "sample_keys": ["000001.SZ"],
                },
                trade_date="20260517",
            ),
            "row_count_drift": CheckResult(
                passed=True, level="info", rule="row_count_drift",
                detail={"date": "20260517"}, trade_date="20260517",
            ),
            "duplicate_pk": CheckResult(
                passed=True, level="info", rule="duplicate_pk",
                detail={"date": "20260517"}, trade_date="20260517",
            ),
        },
    )

    with pytest.raises(QualityGateBlocked) as exc_info:
        gate_check("20260517", mode="inference_pregate", strict=True)
    assert exc_info.value.rule == "null_violation"


def test_gate_check_nonstrict_warns_but_does_not_raise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """strict=False 时 critical 计数但不 raise，让调用方自行处置。"""

    _install_stub_session(monkeypatch)
    _set_all_checks(
        monkeypatch,
        {
            "null_violation": CheckResult(
                passed=False, level="critical", rule="null_violation",
                detail={
                    "table": "raw.daily_quote",
                    "column": "close",
                    "violation_count": 1,
                    "sample_keys": ["000001.SZ"],
                },
                trade_date="20260517",
            ),
            "row_count_drift": CheckResult(
                passed=True, level="info", rule="row_count_drift",
                detail={"date": "20260517"}, trade_date="20260517",
            ),
            "duplicate_pk": CheckResult(
                passed=True, level="info", rule="duplicate_pk",
                detail={"date": "20260517"}, trade_date="20260517",
            ),
        },
    )

    report = gate_check("20260517", mode="inference_pregate", strict=False)
    assert report.critical_count == 1
    assert report.passed is False  # critical 存在但不 raise
