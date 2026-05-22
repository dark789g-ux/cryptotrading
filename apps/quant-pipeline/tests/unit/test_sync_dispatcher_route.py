"""验证 worker.dispatcher 的 sync 路由（M1 Part C）。"""

from __future__ import annotations

from quant_pipeline.worker.dispatcher import _ROUTES


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
