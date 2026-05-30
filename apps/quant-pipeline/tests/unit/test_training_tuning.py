"""training.tuning（M4 Part A · Optuna 调参）单测。

不连 PG；用 in-memory SQLite Optuna storage + monkeypatch 替换：
  - tuning.build_storage_url → 'sqlite:///:memory:'
  - tuning._load_feature_matrix（通过 load_feature_matrix kwarg 注入 mock）
  - update_progress / _write_best_trial_to_model_runs（避免连库）

验证：
  1. SEARCH_SPACES 覆盖 4 主旋钮（doc/05 §5.5）
  2. 中断恢复：同 study_name 二次 create 走 load_if_exists=True 且 trial 数累加
  3. tune 返回结构含 best_value / best_params / best_trial_number
  4. dispatcher 路由 'optuna' 不再是 _runner_not_implemented
  5. runner_entrypoint 对 params 做硬校验（feature_set_id / n_trials）
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import numpy as np
import pandas as pd
import pytest

# ----------------------------------------------------------------------
# fixtures
# ----------------------------------------------------------------------


def _mock_feature_matrix(n_dates: int = 320, n_codes: int = 20) -> pd.DataFrame:
    """构造长度 ≥ min_train+embargo+n_folds (252+21+6=279) 的 mock 矩阵。"""

    rng = np.random.default_rng(42)
    records: list[dict[str, Any]] = []
    base = pd.Timestamp("2024-01-02")
    for d in range(n_dates):
        td = (base + pd.Timedelta(days=d)).strftime("%Y%m%d")
        true_sig = rng.normal(0.0, 1.0, size=n_codes)
        for i in range(n_codes):
            records.append(
                {
                    "trade_date": td,
                    "ts_code": f"{i:06d}.SZ",
                    "features": {
                        "f0": float(true_sig[i] + rng.normal(0.0, 0.3)),
                        "f1": float(rng.normal()),
                        "f2": float(rng.normal()),
                    },
                    "label": float(rng.integers(0, n_codes)),
                }
            )
    return pd.DataFrame(records)


@pytest.fixture(autouse=True)
def _no_progress_writes(monkeypatch: pytest.MonkeyPatch) -> None:
    """禁止 update_progress 实际连库。"""

    from quant_pipeline.training import tuning as tuning_mod

    monkeypatch.setattr(tuning_mod, "update_progress", lambda *a, **k: None)


# ----------------------------------------------------------------------
# 1. SEARCH_SPACES（doc/05 §5.5）
# ----------------------------------------------------------------------


def test_search_spaces_cover_four_main_knobs() -> None:
    from quant_pipeline.training.tuning import SEARCH_SPACES

    assert "default" in SEARCH_SPACES
    knobs = SEARCH_SPACES["default"]
    for k in ("num_leaves", "min_data_in_leaf", "feature_fraction", "learning_rate"):
        assert k in knobs, f"缺少调参旋钮 {k}"
    # learning_rate 必须 log scale
    _lo, _hi, log = knobs["learning_rate"]
    assert log is True


# ----------------------------------------------------------------------
# 2. build_study_name 命名规范
# ----------------------------------------------------------------------


def test_build_study_name_yyyymmdd_format() -> None:
    from quant_pipeline.training.tuning import build_study_name

    name = build_study_name("fs_v1", "20260517")
    assert name == "optuna_fs_v1_20260517"


# ----------------------------------------------------------------------
# 3. tune 主路径：跑 2 trial，验证返回结构
# ----------------------------------------------------------------------


def test_tune_runs_two_trials_returns_best(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    """用 SQLite RDB storage 跑 2 trial，验证最小返回结构。"""

    from quant_pipeline.training import tuning as tuning_mod

    # SQLite 文件（Optuna 支持 sqlite RDB；同样命中 load_if_exists 分支）
    storage = f"sqlite:///{tmp_path / 'optuna.db'}"

    df = _mock_feature_matrix()

    result = tuning_mod.tune(
        feature_set_id="fs_test",
        n_trials=2,
        space="default",
        load_feature_matrix=lambda fs: df,
        storage_url=storage,
        study_name="optuna_fs_test_20260517",
        write_model_run=False,  # 避免触碰 ml.model_runs
        today_yyyymmdd="20260517",
        num_boost_round=10,  # 小训练量加速
    )

    assert result["study_name"] == "optuna_fs_test_20260517"
    assert result["n_trials_completed"] == 2
    assert isinstance(result["best_value"], float)
    assert set(result["best_params"]).issuperset(
        {"num_leaves", "min_data_in_leaf", "feature_fraction", "learning_rate"}
    )
    assert isinstance(result["best_trial_number"], int)
    assert result["model_version"] is None  # write_model_run=False


# ----------------------------------------------------------------------
# 4. 中断恢复：同 study 名第二次 tune 走 load_if_exists（trial 数累加）
# ----------------------------------------------------------------------


def test_tune_resume_via_load_if_exists(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    """第二次以更大 n_trials 重跑同 study → 总 completed 数 ≥ 第一次 + 增量。"""

    from quant_pipeline.training import tuning as tuning_mod

    storage = f"sqlite:///{tmp_path / 'resume.db'}"
    df = _mock_feature_matrix()
    common = dict(
        feature_set_id="fs_resume",
        space="default",
        load_feature_matrix=lambda fs: df,
        storage_url=storage,
        study_name="optuna_fs_resume_20260517",
        write_model_run=False,
        today_yyyymmdd="20260517",
        num_boost_round=10,
    )

    r1 = tuning_mod.tune(n_trials=2, **common)
    assert r1["n_trials_completed"] == 2

    # 第二次提到 4 trial：实际只需增量跑 2 个
    r2 = tuning_mod.tune(n_trials=4, **common)
    assert r2["n_trials_completed"] == 4
    assert r2["study_name"] == r1["study_name"]


# ----------------------------------------------------------------------
# 5. dispatcher 路由 'optuna' 已实装
# ----------------------------------------------------------------------


def test_dispatcher_routes_optuna_to_runner() -> None:
    from quant_pipeline.worker.dispatcher import get_routes

    routes = get_routes()
    assert "optuna" in routes
    runner = routes["optuna"]
    assert runner.__name__ != "_runner_not_implemented"
    assert runner.__name__ == "_runner_optuna"


# ----------------------------------------------------------------------
# 6. runner_entrypoint 参数硬校验
# ----------------------------------------------------------------------


def test_runner_entrypoint_rejects_bad_params() -> None:
    from quant_pipeline.training.tuning import runner_entrypoint

    class _Job:
        def __init__(self, params: dict[str, Any]) -> None:
            self.id = uuid4()
            self.params = params

    # 缺 feature_set_id
    with pytest.raises(ValueError, match="feature_set_id"):
        runner_entrypoint(_Job({"n_trials": 10}))

    # n_trials 非正
    with pytest.raises(ValueError, match="n_trials"):
        runner_entrypoint(_Job({"feature_set_id": "fs", "n_trials": 0}))

    # n_trials 类型错
    with pytest.raises(ValueError, match="n_trials"):
        runner_entrypoint(_Job({"feature_set_id": "fs", "n_trials": "abc"}))
