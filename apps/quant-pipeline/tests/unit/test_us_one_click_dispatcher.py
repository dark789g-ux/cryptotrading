"""W2 美股一键同步 dispatcher 单测（spec 03）：

- _ROUTES['us_one_click_sync'] 指向 _runner_us_one_click_sync。
- runner 解析 job.params.date_range（缺/坏值校验，仿 _runner_us_sync）→ 调
  run_us_one_click_sync(job_id=job.id, date_range=...)。
- update_job_result_partial 写对 SQL（mock session）。

全部 mock，不碰真 DB。
"""

from __future__ import annotations

from unittest import mock
from uuid import uuid4

import pytest

from quant_pipeline.worker.dispatcher import (
    _ROUTES,
    _runner_us_one_click_sync,
    update_job_result_partial,
)
from quant_pipeline.worker.poller import Job


def _make_job(params: dict) -> Job:
    return Job(
        id=uuid4(),
        run_type="us_one_click_sync",
        params=params,
        attempts=1,
        max_attempts=3,
    )


def test_route_is_implemented() -> None:
    runner = _ROUTES.get("us_one_click_sync")
    assert runner is not None
    assert getattr(runner, "__name__", None) == "_runner_us_one_click_sync"


def test_runner_passes_job_id_and_date_range() -> None:
    job = _make_job({"date_range": "20260101:20260616"})
    with mock.patch(
        "quant_pipeline.sync.us_one_click_orchestrator.run_us_one_click_sync"
    ) as run_mock:
        _runner_us_one_click_sync(job)
    run_mock.assert_called_once()
    kwargs = run_mock.call_args.kwargs
    assert kwargs["job_id"] == job.id
    assert kwargs["date_range"] == "20260101:20260616"


def test_runner_missing_date_range_raises() -> None:
    """一键同步必带 date_range（前端日期选择器必填）；缺失 → ValueError。"""
    job = _make_job({})
    with pytest.raises(ValueError, match="date_range"):
        _runner_us_one_click_sync(job)


def test_runner_non_colon_date_range_raises() -> None:
    job = _make_job({"date_range": "20260101-20260616"})
    with pytest.raises(ValueError, match="date_range"):
        _runner_us_one_click_sync(job)


def test_update_job_result_partial_sql() -> None:
    """update_job_result_partial 写 UPDATE ml.jobs SET result_payload=CAST(:rp AS jsonb)。"""
    captured: dict = {}

    class _FakeSession:
        def execute(self, stmt, params):
            captured["sql"] = str(stmt)
            captured["params"] = params

    class _FakeCtx:
        def __enter__(self):
            return _FakeSession()

        def __exit__(self, *exc):
            return False

    job_id = uuid4()
    with mock.patch(
        "quant_pipeline.worker.dispatcher.session_scope", lambda: _FakeCtx()
    ):
        update_job_result_partial(job_id, {"version": 1, "steps": []})

    sql = captured["sql"]
    assert "UPDATE ml.jobs" in sql
    assert "result_payload" in sql
    assert "CAST(:rp AS jsonb)" in sql
    assert captured["params"]["id"] == job_id
    # rp 是 JSON 字符串
    assert isinstance(captured["params"]["rp"], str)
    assert '"version"' in captured["params"]["rp"]
