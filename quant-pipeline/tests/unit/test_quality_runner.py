"""quality runner / dispatcher 路由冒烟（不连库）。"""

from __future__ import annotations

from typing import Any

import pytest


def test_dispatcher_routes_quality_to_runner() -> None:
    from quant_pipeline.worker.dispatcher import get_routes

    routes = get_routes()
    assert "quality" in routes
    runner = routes["quality"]
    # 必须不是 _runner_not_implemented（M1 Part E 已实装）
    assert runner.__name__ != "_runner_not_implemented"
    assert runner.__name__ == "_runner_quality"


def test_dispatcher_quality_rejects_bad_date(monkeypatch: pytest.MonkeyPatch) -> None:
    from quant_pipeline.worker.dispatcher import get_routes
    from quant_pipeline.worker.poller import Job
    from uuid import uuid4

    job = Job(
        id=uuid4(),
        run_type="quality",
        params={"date": "2026-05-17"},  # 错误格式（应 YYYYMMDD）
        attempts=1,
        max_attempts=1,
    )
    runner = get_routes()["quality"]
    with pytest.raises(ValueError, match="must be YYYYMMDD"):
        runner(job)


def test_quality_gate_blocked_carries_rule_detail() -> None:
    from quant_pipeline.quality.runner import QualityGateBlocked

    exc = QualityGateBlocked(rule="row_count_drift", detail={"delta_ratio": 0.2})
    assert exc.rule == "row_count_drift"
    assert exc.detail == {"delta_ratio": 0.2}


def test_run_checks_no_critical_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """对 run_checks 整体路径做最小 stub：每条 check 都返回 passed=True。"""

    from quant_pipeline.quality import runner as runner_mod
    from quant_pipeline.quality.report import CheckResult

    def fake_check(session: Any, trade_date: str, params: dict[str, Any]) -> CheckResult:
        return CheckResult(
            passed=True,
            level="info",
            rule="row_count_drift",
            detail={"date": trade_date},
            trade_date=trade_date,
            name="row_count_drift",
        )

    monkeypatch.setattr(
        runner_mod,
        "ALL_CHECKS",
        tuple((f"check_{i}", fake_check) for i in range(8)),
    )

    # stub session_scope，避免连库
    class _StubSession:
        def execute(self, *_: Any, **__: Any) -> Any:
            raise AssertionError("should not be called")

    class _StubCtx:
        def __enter__(self) -> _StubSession:
            return _StubSession()

        def __exit__(self, *_: Any) -> None:
            return None

    monkeypatch.setattr(runner_mod, "session_scope", lambda: _StubCtx())

    # 也要 stub emit 避免触发 warn_with_quality_report DB 写入
    monkeypatch.setattr(runner_mod, "emit", lambda *_a, **_k: None)

    report = runner_mod.run_checks("20260517", strict=True, params={})
    assert report.passed is True
    assert report.critical_count == 0


def test_run_checks_strict_blocks_on_critical(monkeypatch: pytest.MonkeyPatch) -> None:
    from quant_pipeline.quality import runner as runner_mod
    from quant_pipeline.quality.report import CheckResult
    from quant_pipeline.quality.runner import QualityGateBlocked

    def fake_check_critical(
        session: Any, trade_date: str, params: dict[str, Any]
    ) -> CheckResult:
        return CheckResult(
            passed=False,
            level="critical",
            rule="duplicate_pk",
            detail={"violations": [{"table": "raw.daily_quote"}]},
            trade_date=trade_date,
            name="duplicate_pk",
        )

    monkeypatch.setattr(
        runner_mod, "ALL_CHECKS", (("duplicate_pk", fake_check_critical),)
    )

    class _StubSession:
        def execute(self, *_: Any, **__: Any) -> Any:
            raise AssertionError("should not be called")

    class _StubCtx:
        def __enter__(self) -> _StubSession:
            return _StubSession()

        def __exit__(self, *_: Any) -> None:
            return None

    monkeypatch.setattr(runner_mod, "session_scope", lambda: _StubCtx())
    monkeypatch.setattr(runner_mod, "emit", lambda *_a, **_k: None)

    with pytest.raises(QualityGateBlocked) as exc_info:
        runner_mod.run_checks("20260517", strict=True, params={})
    assert exc_info.value.rule == "duplicate_pk"


def test_run_checks_relaxation_record_emitted(monkeypatch: pytest.MonkeyPatch) -> None:
    """阈值放宽时应 emit 一条 level='info' 留痕事件。"""

    from quant_pipeline.quality import runner as runner_mod
    from quant_pipeline.quality.report import CheckResult

    def fake_check(session: Any, trade_date: str, params: dict[str, Any]) -> CheckResult:
        return CheckResult(
            passed=True,
            level="info",
            rule="row_count_drift",
            detail={"date": trade_date},
            trade_date=trade_date,
            name="row_count_drift",
        )

    monkeypatch.setattr(
        runner_mod, "ALL_CHECKS", (("row_count_drift", fake_check),)
    )

    class _StubSession:
        def execute(self, *_: Any, **__: Any) -> Any:
            raise AssertionError("should not be called")

    class _StubCtx:
        def __enter__(self) -> _StubSession:
            return _StubSession()

        def __exit__(self, *_: Any) -> None:
            return None

    monkeypatch.setattr(runner_mod, "session_scope", lambda: _StubCtx())

    emitted: list[CheckResult] = []

    def fake_emit(result: CheckResult, *, job_id: Any = None) -> None:
        emitted.append(result)

    monkeypatch.setattr(runner_mod, "emit", fake_emit)

    runner_mod.run_checks(
        "20260517", strict=False, params={"row_count_drift_threshold": 0.10}
    )

    relaxation_events = [
        r for r in emitted if r.detail.get("event") == "threshold_relaxed"
    ]
    assert len(relaxation_events) == 1
    assert relaxation_events[0].level == "info"
    assert relaxation_events[0].detail["relaxed_threshold"] == 0.10
