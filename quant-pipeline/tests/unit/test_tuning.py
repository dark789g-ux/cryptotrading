"""Optuna 调参单测（M4 Part L）。

不连库；用：
  - in-memory storage 替代 PG RDB
  - 注入 mock load_feature_matrix
  - write_model_run=False 跳过 ml.model_runs 写入
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.training import tuning


def _mock_panel(n_dates: int = 320, n_codes: int = 10) -> pd.DataFrame:
    """生成足够 PurgedWalkForwardSplit 跑动的 mock feature_matrix。

    PurgedWalkForwardSplit 硬约束 n_dates >= min_train(252) + embargo(21) + n_folds(6) = 279。
    取 320 个连续工作日即可。
    """

    rng = np.random.default_rng(42)
    business_days = pd.bdate_range("2023-01-02", periods=n_dates).strftime("%Y%m%d").tolist()
    records: list[dict[str, Any]] = []
    for td in business_days:
        signal = rng.normal(0.0, 1.0, size=n_codes)
        for i in range(n_codes):
            features = {
                "f0": float(signal[i] + rng.normal(0, 0.5)),
                "f1": float(rng.normal()),
                "f2": float(rng.normal()),
            }
            records.append(
                {
                    "trade_date": td,
                    "ts_code": f"00000{i}.SZ",
                    "features": features,
                    "label": float(rng.integers(0, n_codes)),
                }
            )
    return pd.DataFrame(records)


def test_search_space_keys_align_doc05() -> None:
    """搜索空间必须包含 doc/05 §5.5 给的 4 个主旋钮，且区间端点正确。"""

    sp = tuning.SEARCH_SPACES["default"]
    assert set(sp.keys()) == {
        "num_leaves",
        "min_data_in_leaf",
        "feature_fraction",
        "learning_rate",
    }
    assert sp["num_leaves"] == (15, 127)
    assert sp["min_data_in_leaf"] == (50, 500)
    assert sp["feature_fraction"] == (0.5, 1.0)
    lr_lo, lr_hi, lr_log = sp["learning_rate"]
    assert (lr_lo, lr_hi, lr_log) == (0.01, 0.2, True)


def test_build_study_name_includes_feature_set_and_date() -> None:
    name = tuning.build_study_name("fs_v1", today_yyyymmdd="20260517")
    assert name == "optuna_fs_v1_20260517"


def test_tune_completes_n_trials_with_inmemory_storage(monkeypatch: pytest.MonkeyPatch) -> None:
    """跑 2 trial（in-memory storage），验证 best_value 写出 + n_trials_completed。"""

    # 关闭 progress 回写（避免连库）
    monkeypatch.setattr(tuning, "update_progress", lambda *a, **k: None)

    df = _mock_panel()
    out = tuning.tune(
        feature_set_id="fs_v1",
        n_trials=2,
        space="default",
        load_feature_matrix=lambda fs: df,
        storage_url="sqlite:///:memory:",
        study_name="t_unit_inmem",
        n_folds=6,
        embargo_days=21,
        min_train_days=252,
        num_boost_round=20,
        write_model_run=False,
        today_yyyymmdd="20260517",
    )
    assert out["study_name"] == "t_unit_inmem"
    assert out["n_trials_completed"] >= 2
    assert "num_leaves" in out["best_params"]
    assert out["model_version"] is None
    assert isinstance(out["best_value"], float)


def test_tune_resumes_existing_study_load_if_exists(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    """同 study 名跑两次：第二次应感知到既有 trial，total >= 第一次 + 第二次。"""

    monkeypatch.setattr(tuning, "update_progress", lambda *a, **k: None)
    df = _mock_panel()

    # 用文件型 sqlite 模拟"中断恢复"
    storage = f"sqlite:///{tmp_path / 'optuna.db'}"

    out1 = tuning.tune(
        feature_set_id="fs_v1",
        n_trials=2,
        load_feature_matrix=lambda fs: df,
        storage_url=storage,
        study_name="t_resume",
        n_folds=6,
        embargo_days=21,
        min_train_days=252,
        num_boost_round=20,
        write_model_run=False,
        today_yyyymmdd="20260517",
    )
    assert out1["n_trials_completed"] >= 2

    # 同 study 再跑 1 个
    out2 = tuning.tune(
        feature_set_id="fs_v1",
        n_trials=3,  # 总目标 3
        load_feature_matrix=lambda fs: df,
        storage_url=storage,
        study_name="t_resume",
        n_folds=6,
        embargo_days=21,
        min_train_days=252,
        num_boost_round=20,
        write_model_run=False,
        today_yyyymmdd="20260517",
    )
    # 总 trial 数 = max(out2.n_trials_completed, ...) 至少为 3（接续 + 新跑 1 个）
    assert out2["n_trials_completed"] >= 3


def test_tune_rejects_invalid_n_trials() -> None:
    with pytest.raises(ValueError, match="n_trials"):
        tuning.tune(
            feature_set_id="fs_v1",
            n_trials=0,
            load_feature_matrix=lambda fs: pd.DataFrame(),
            write_model_run=False,
        )


def test_tune_rejects_unknown_space() -> None:
    with pytest.raises(ValueError, match="搜索空间"):
        tuning.tune(
            feature_set_id="fs_v1",
            n_trials=1,
            space="not_a_space",
            load_feature_matrix=lambda fs: pd.DataFrame(),
            write_model_run=False,
        )


def test_dispatcher_route_optuna_present() -> None:
    """dispatcher _ROUTES 必须含 optuna 且不是 _runner_not_implemented。"""

    from quant_pipeline.worker.dispatcher import get_routes

    routes = get_routes()
    assert "optuna" in routes
    assert routes["optuna"].__name__ != "_runner_not_implemented"
    assert routes["optuna"].__name__ == "_runner_optuna"


def test_runner_entrypoint_validates_params() -> None:
    """runner_entrypoint 缺 feature_set_id / 非法 n_trials 应 raise。"""

    class _MockJob:
        id = None
        params = {"n_trials": 10}

    with pytest.raises(ValueError, match="feature_set_id"):
        tuning.runner_entrypoint(_MockJob())

    class _MockJob2:
        id = None
        params = {"feature_set_id": "fs", "n_trials": 0}

    with pytest.raises(ValueError, match="n_trials"):
        tuning.runner_entrypoint(_MockJob2())
