"""features.runner.runner_entrypoint 预热回归测试。

校验：worker 的 ``run_type=features`` 入口必须先 ``ensure_loaded()`` 预热因子
注册表，再调 ``build_feature_matrix``。与 factors 入口（commit b17316b）同款 bug：
全新 worker 进程跑 features 时 ``_meta_cache`` 为空 → 路径上的 ``list_active``
抛 ``FactorMetaMissing``。
"""

from __future__ import annotations

from uuid import uuid4

import pytest

from quant_pipeline.features import runner as runner_mod
from quant_pipeline.features.runner import runner_entrypoint


def test_runner_entrypoint_preheats_registry_before_build_feature_matrix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """features 入口必须先 ``ensure_loaded()`` 预热注册表，再 ``build_feature_matrix``。

    全新 worker 进程未预热 ``_meta_cache`` → ``_load_factor_ids`` 里的
    ``list_active(factor_version)`` 抛 ``factor meta missing in cache``
    （FactorMetaMissing）。features 过去把预热责任挂靠在已废弃的
    ``train_e2e_runner`` 上，独立跑 ``run_type=features`` 时会漏掉这一步。
    """

    order: list[str] = []
    monkeypatch.setattr(
        runner_mod, "ensure_loaded", lambda: order.append("ensure_loaded")
    )
    monkeypatch.setattr(
        runner_mod,
        "build_feature_matrix",
        lambda **kw: order.append("build_feature_matrix"),
    )

    class _Job:
        id = uuid4()
        params = {
            "factor_version": "v1",
            "label_scheme": "strategy-aware",
            "date_range": "20240101:20240131",
            "new_listing_min_days": 60,
        }

    runner_entrypoint(_Job())

    # 必须先预热再算，且预热确实被调用一次
    assert order == ["ensure_loaded", "build_feature_matrix"]
