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


def test_tune_resumes_existing_study_load_if_exists(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
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


def test_tune_default_path_annotates_in_tuning_bias(monkeypatch: pytest.MonkeyPatch) -> None:
    """默认路径（holdout_n_folds=0）：返回结果必须如实标注 objective 为
    in-tuning OOS（调参与评估同源，乐观偏差），不得让消费者误以为是干净 OOS。"""

    monkeypatch.setattr(tuning, "update_progress", lambda *a, **k: None)

    df = _mock_panel()
    out = tuning.tune(
        feature_set_id="fs_v1",
        n_trials=2,
        load_feature_matrix=lambda fs: df,
        storage_url="sqlite:///:memory:",
        study_name="t_bias_annot",
        num_boost_round=20,
        write_model_run=False,
        today_yyyymmdd="20260517",
    )
    # 默认不切 holdout
    assert out["holdout_evaluated"] is False
    assert out["holdout_metrics"] is None
    # objective 来源如实标注
    assert out["objective_source"] == "in_tuning_oos"
    assert out["optimistic_bias"] is True
    assert out["best_value_kind"] == "in_tuning_oos_ndcg@10"


def test_tune_holdout_split_zero_overlap_and_embargo(monkeypatch: pytest.MonkeyPatch) -> None:
    """方案甲：holdout 区交易日必须严格在调参区之后，且与调参区留 >= embargo_days 间隔。

    通过 patch _evaluate_on_holdout 捕获实际传入的调参区 / holdout 区交易日，
    断言零重叠 + embargo gap。"""

    monkeypatch.setattr(tuning, "update_progress", lambda *a, **k: None)

    captured: dict[str, Any] = {}
    real_eval = tuning._evaluate_on_holdout

    def _spy(*args: Any, **kwargs: Any) -> Any:
        captured["tuning_dates"] = sorted(
            kwargs["df_tuning"]["trade_date"].astype(str).unique().tolist()
        )
        captured["holdout_dates"] = sorted(
            kwargs["df_holdout"]["trade_date"].astype(str).unique().tolist()
        )
        captured["embargo_days"] = kwargs["embargo_days"]
        return real_eval(*args, **kwargs)

    monkeypatch.setattr(tuning, "_evaluate_on_holdout", _spy)

    df = _mock_panel()
    out = tuning.tune(
        feature_set_id="fs_v1",
        n_trials=2,
        load_feature_matrix=lambda fs: df,
        storage_url="sqlite:///:memory:",
        study_name="t_holdout",
        num_boost_round=20,
        write_model_run=False,
        today_yyyymmdd="20260517",
        holdout_n_folds=2,
    )

    t_dates = captured["tuning_dates"]
    h_dates = captured["holdout_dates"]
    emb = captured["embargo_days"]
    assert t_dates and h_dates
    # 零重叠
    assert set(t_dates).isdisjoint(set(h_dates))
    # holdout 严格在调参区之后
    assert min(h_dates) > max(t_dates)
    # embargo gap：调参区最后一日与 holdout 第一日之间，原始全序列里至少隔 emb 天
    all_dates = sorted(df["trade_date"].astype(str).unique().tolist())
    gap = all_dates.index(min(h_dates)) - all_dates.index(max(t_dates)) - 1
    assert gap >= emb, f"holdout 与调参区间隔 {gap} < embargo {emb}"

    # 结果如实反映 holdout 已评估，objective_source 升级为干净 OOS
    assert out["holdout_evaluated"] is True
    assert out["holdout_metrics"] is not None
    assert "ndcg@10" in out["holdout_metrics"]
    assert out["objective_source"] == "holdout_oos"
    assert out["optimistic_bias"] is False


def test_tune_holdout_too_small_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    """数据不足以切出合规 holdout 时，必须回退到默认 in-tuning 路径（不抛错），
    并如实标注仍为乐观偏差。"""

    monkeypatch.setattr(tuning, "update_progress", lambda *a, **k: None)

    # 刚好够单纯调参（>=279），但切出 holdout 后调参区不足 -> 回退
    df = _mock_panel(n_dates=285)
    out = tuning.tune(
        feature_set_id="fs_v1",
        n_trials=2,
        load_feature_matrix=lambda fs: df,
        storage_url="sqlite:///:memory:",
        study_name="t_holdout_fallback",
        num_boost_round=20,
        write_model_run=False,
        today_yyyymmdd="20260517",
        holdout_n_folds=2,
    )
    assert out["holdout_evaluated"] is False
    assert out["objective_source"] == "in_tuning_oos"
    assert out["optimistic_bias"] is True


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
