# -*- coding: utf-8 -*-
"""training.seed_averaging（M4 Part A · Seed Averaging）单测。

不连库；用 monkeypatch 替换：
  - train_seed_average(train_fn=...)：注入 mock train，返回伪 TrainResult
  - _create_child_train_job / _finalize_child_job / _write_ensemble_model_run / update_progress

验证：
  1. dispatcher 路由 'seed_avg' 已实装
  2. 5 seed 各跑一次 train_fn，每个 seed 创建一条 child job（parent_job_id 关联）
  3. ensemble metrics 是各 seed metrics 的平均
  4. runner_entrypoint 对 params 做硬校验
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

import pytest


@dataclass
class _FakeTrainResult:
    model_run_id: UUID
    model_version: str
    artifact_uri: str
    oos_metrics: dict[str, Any]
    report_uri: str | None = None


def _make_fake_train_fn(call_log: list[dict[str, Any]]) -> Any:
    """构造一个伪 train_fn，记录每次调用参数并返回 TrainResult。"""

    def _fn(
        *,
        feature_set_id: str,
        model: str,
        walk_forward: bool,
        seed: int,
        job_id: UUID | None = None,
        **_: Any,
    ) -> _FakeTrainResult:
        call_log.append(
            {
                "feature_set_id": feature_set_id,
                "model": model,
                "walk_forward": walk_forward,
                "seed": seed,
                "job_id": job_id,
            }
        )
        # 每个 seed 给不同的 ndcg / ic，便于验证平均
        return _FakeTrainResult(
            model_run_id=uuid4(),
            model_version=f"lgb-lambdarank-v1-20260517-seed{seed}",
            artifact_uri=f"./artifacts/{uuid4()}/model.txt",
            oos_metrics={
                "ndcg@10": 0.1 + seed * 0.001,
                "ic": 0.02 + seed * 0.0001,
                "rank_ic": 0.03,
                "portfolio_annual_after_cost": 0.15,
            },
        )

    return _fn


@pytest.fixture(autouse=True)
def _no_db(monkeypatch: pytest.MonkeyPatch) -> None:
    """禁所有数据库写。"""

    from quant_pipeline.training import seed_averaging as mod

    monkeypatch.setattr(mod, "_create_child_train_job", lambda **k: uuid4())
    monkeypatch.setattr(mod, "_finalize_child_job", lambda *a, **k: None)
    monkeypatch.setattr(mod, "update_progress", lambda *a, **k: None)

    def _fake_write(**k: Any) -> tuple[UUID, str]:
        return uuid4(), "./artifacts/fake/seed_avg_meta.json"

    monkeypatch.setattr(mod, "_write_ensemble_model_run", _fake_write)


def test_dispatcher_routes_seed_avg() -> None:
    from quant_pipeline.worker.dispatcher import get_routes

    routes = get_routes()
    assert "seed_avg" in routes
    assert routes["seed_avg"].__name__ != "_runner_not_implemented"
    assert routes["seed_avg"].__name__ == "_runner_seed_avg"


def test_seed_average_runs_each_seed_and_creates_child_jobs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from quant_pipeline.training import seed_averaging as mod

    call_log: list[dict[str, Any]] = []
    train_fn = _make_fake_train_fn(call_log)

    # 监听 _create_child_train_job 调用次数
    created: list[dict[str, Any]] = []

    def _spy_create(*, feature_set_id: str, seed: int, parent_job_id: UUID) -> UUID:
        cid = uuid4()
        created.append(
            {"feature_set_id": feature_set_id, "seed": seed, "parent": parent_job_id, "id": cid}
        )
        return cid

    monkeypatch.setattr(mod, "_create_child_train_job", _spy_create)

    parent_id = uuid4()
    seeds = [42, 123, 456]
    result = mod.train_seed_average(
        feature_set_id="fs_v1",
        seeds=seeds,
        parent_job_id=parent_id,
        train_fn=train_fn,
        today_yyyymmdd="20260517",
    )

    # 每个 seed 各一次 train + 一次 child job 创建
    assert len(call_log) == len(seeds)
    assert [c["seed"] for c in call_log] == seeds
    assert len(created) == len(seeds)
    assert all(c["parent"] == parent_id for c in created)

    # 返回结构
    assert len(result["child_model_run_ids"]) == len(seeds)
    assert result["ensemble_model_version"] == "lgb-lambdarank-v1-20260517-seedavg5"

    # ensemble metrics 是各 seed 平均
    n = len(seeds)
    expected_ndcg = sum(0.1 + s * 0.001 for s in seeds) / n
    assert abs(result["ensemble_oos_metrics"]["ndcg@10"] - expected_ndcg) < 1e-9


def test_seed_average_without_parent_skips_child_jobs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from quant_pipeline.training import seed_averaging as mod

    created: list[Any] = []
    monkeypatch.setattr(
        mod,
        "_create_child_train_job",
        lambda **k: (created.append(k) or uuid4()),
    )

    train_fn = _make_fake_train_fn([])
    mod.train_seed_average(
        feature_set_id="fs_v1",
        seeds=[42, 123],
        parent_job_id=None,  # 无父 job → 不创建 child
        train_fn=train_fn,
        today_yyyymmdd="20260517",
    )
    assert created == []


def test_runner_entrypoint_validates_params() -> None:
    from quant_pipeline.training.seed_averaging import runner_entrypoint

    class _Job:
        def __init__(self, params: dict[str, Any]) -> None:
            self.id = uuid4()
            self.params = params

    with pytest.raises(ValueError, match="feature_set_id"):
        runner_entrypoint(_Job({}))
    with pytest.raises(ValueError, match="seeds"):
        runner_entrypoint(_Job({"feature_set_id": "fs", "seeds": []}))
    with pytest.raises(ValueError, match="seeds"):
        runner_entrypoint(_Job({"feature_set_id": "fs", "seeds": ["bad"]}))
