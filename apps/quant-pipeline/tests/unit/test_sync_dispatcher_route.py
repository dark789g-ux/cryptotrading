"""验证 worker.dispatcher 的 sync 路由（M1 Part C）。"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch
from uuid import uuid4

import pytest

from quant_pipeline.worker.dispatcher import _ROUTES, _runner_us_index_sync
from quant_pipeline.worker.poller import Job


def test_sync_route_is_implemented() -> None:
    """sync 路由必须指向真实 runner（_runner_sync）。"""

    runner = _ROUTES.get("sync")
    assert runner is not None
    # 名称应为 _runner_sync
    assert getattr(runner, "__name__", None) == "_runner_sync"


def test_noop_route_unchanged() -> None:
    """M0 noop 通路必须保持不动。"""

    runner = _ROUTES.get("noop")
    assert runner is not None
    assert getattr(runner, "__name__", None) == "_runner_noop"


def test_us_index_sync_route_is_implemented() -> None:
    """us_index_sync 路由必须指向 _runner_us_index_sync。"""

    runner = _ROUTES.get("us_index_sync")
    assert runner is not None
    assert getattr(runner, "__name__", None) == "_runner_us_index_sync"


def _make_job(params: dict) -> Job:
    return Job(
        id=uuid4(),
        run_type="us_index_sync",
        params=params,
        attempts=1,
        max_attempts=3,
    )


def test_us_index_runner_missing_date_range_defaults_no_raise() -> None:
    """UI 无参同步：缺 date_range → 兜底默认全量，不 raise。"""

    job = _make_job({})  # 无 date_range
    today = f"{date.today():%Y%m%d}"
    with patch(
        "quant_pipeline.sync.us_index_orchestrator.run_us_index_sync"
    ) as run_mock:
        _runner_us_index_sync(job)
    run_mock.assert_called_once()
    kwargs = run_mock.call_args.kwargs
    assert kwargs["date_range"] == f"20100101:{today}"
    assert kwargs["symbols"] is None


def test_us_index_runner_non_colon_date_range_raises() -> None:
    """非冒号串（显式传了坏值）→ ValueError。"""

    job = _make_job({"date_range": "20100101-20261231"})
    with pytest.raises(ValueError, match="date_range"):
        _runner_us_index_sync(job)
