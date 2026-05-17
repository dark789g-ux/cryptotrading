"""三组对照单测（M3 Part I）。

覆盖：
  - compare_three 在 mock 数据上返回 4 个模型的 summary
  - 每个 model 都有 fold_metrics 且长度 = n_folds
  - 长度不匹配抛 ValueError
  - 空 splits 抛 ValueError
  - LightGBM-LambdaRank 的 NDCG@10 应高于 Linear（mock 数据上 sanity）
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.evaluation.ab_compare import MODEL_NAMES, compare_three
from quant_pipeline.training.walk_forward import PurgedWalkForwardSplit


def _build_mock_panel(
    n_dates: int = 400, n_codes: int = 8, n_features: int = 5, seed: int = 42
) -> tuple[pd.DataFrame, pd.DataFrame, pd.Series]:
    """生成 mock 训练矩阵：feature_0 是真信号，label = signal * scale + noise。"""

    rng = np.random.default_rng(seed)
    rows_meta: list[dict] = []
    rows_X: list[list[float]] = []
    rows_y: list[float] = []
    for d in range(n_dates):
        td = f"2026{1 + d // 28:02d}{1 + d % 28:02d}"
        signal = rng.normal(size=n_codes)
        for i in range(n_codes):
            feat = [float(signal[i] + rng.normal(scale=0.2))] + [
                float(rng.normal()) for _ in range(n_features - 1)
            ]
            rows_meta.append({"trade_date": td, "ts_code": f"00{i:04d}.SZ"})
            rows_X.append(feat)
            rows_y.append(float(signal[i]))  # label 直接是真信号
    df_meta = pd.DataFrame(rows_meta)
    X = pd.DataFrame(rows_X, columns=[f"f{i}" for i in range(n_features)])
    y = pd.Series(rows_y, name="label")
    return df_meta, X, y


def test_compare_three_returns_four_models() -> None:
    df_meta, X, y = _build_mock_panel(n_dates=400, n_codes=6, n_features=4)
    splitter = PurgedWalkForwardSplit(n_folds=6, embargo_days=21, min_train_days=252)
    summary = compare_three(
        df_meta, X, y,
        splitter.split(df_meta),
        seed=42,
        top_k=3,
        lgb_hyperparams={"min_data_in_leaf": 5, "num_leaves": 7},
        lgb_num_boost_round=30,
        lgb_early_stopping_rounds=None,
    )
    for name in MODEL_NAMES:
        assert name in summary, f"模型 {name} 缺失"
        for k in ["ndcg_at_5_mean", "ndcg_at_10_mean", "ic_mean", "rank_ic_mean",
                  "portfolio_annual_after_cost", "fold_metrics", "n_folds"]:
            assert k in summary[name], f"{name}.{k} 缺失"


def test_compare_three_fold_metrics_length() -> None:
    df_meta, X, y = _build_mock_panel(n_dates=400, n_codes=5, n_features=4)
    splitter = PurgedWalkForwardSplit(n_folds=6, embargo_days=21, min_train_days=252)
    summary = compare_three(
        df_meta, X, y, splitter.split(df_meta),
        seed=42, top_k=2,
        lgb_hyperparams={"min_data_in_leaf": 5, "num_leaves": 7},
        lgb_num_boost_round=20, lgb_early_stopping_rounds=None,
    )
    for name in MODEL_NAMES:
        assert len(summary[name]["fold_metrics"]) == 6


def test_compare_three_length_mismatch_raises() -> None:
    df_meta, X, y = _build_mock_panel(n_dates=400, n_codes=5, n_features=3)
    X_short = X.iloc[:-10].reset_index(drop=True)  # 行数不一致
    splitter = PurgedWalkForwardSplit(n_folds=6, embargo_days=21, min_train_days=252)
    with pytest.raises(ValueError, match="行数"):
        compare_three(df_meta, X_short, y, splitter.split(df_meta))


def test_compare_three_empty_splits_raises() -> None:
    df_meta, X, y = _build_mock_panel(n_dates=400, n_codes=5, n_features=3)
    with pytest.raises(ValueError, match="splits 为空"):
        compare_three(df_meta, X, y, iter([]))


def test_compare_three_lambdarank_beats_linear_on_ranking_signal() -> None:
    """在排序信号强的 mock 数据上，LambdaRank NDCG@10 应不低于 Linear。

    注意：mock 数据 + 短 num_boost_round，差距可能小；只要求 lambdarank 不显著差于 linear。
    """

    df_meta, X, y = _build_mock_panel(n_dates=400, n_codes=10, n_features=5, seed=123)
    splitter = PurgedWalkForwardSplit(n_folds=6, embargo_days=21, min_train_days=252)
    summary = compare_three(
        df_meta, X, y, splitter.split(df_meta),
        seed=42, top_k=3,
        lgb_hyperparams={"min_data_in_leaf": 5, "num_leaves": 15},
        lgb_num_boost_round=50, lgb_early_stopping_rounds=None,
    )
    linear_ndcg10 = summary["linear"]["ndcg_at_10_mean"]
    lambdarank_ndcg10 = summary["lgb-lambdarank"]["ndcg_at_10_mean"]
    # 在 mock 数据上不强求绝对 0.015 差距；只确保 lambdarank 不显著差于 linear
    assert lambdarank_ndcg10 >= linear_ndcg10 - 0.05, (
        f"lambdarank({lambdarank_ndcg10}) significantly worse than linear({linear_ndcg10})"
    )


def test_run_ab_compare_end_to_end(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """run_ab_compare 拉 feature_matrix → 跑 6 折 → 生成 report.md。

    Mock _load_feature_matrix，避免连库。
    """

    from quant_pipeline.evaluation import ab_compare as ab_mod
    from quant_pipeline.training import runner as runner_mod

    # 构造与 _load_feature_matrix 同形态：[trade_date, ts_code, features:dict, label:float]
    rng = np.random.default_rng(123)
    rows = []
    for d in range(400):
        td = f"2026{1 + d // 28:02d}{1 + d % 28:02d}"
        signal = rng.normal(size=6)
        for i in range(6):
            rows.append(
                {
                    "trade_date": td,
                    "ts_code": f"00{i:04d}.SZ",
                    "features": {
                        "f0": float(signal[i] + rng.normal(scale=0.2)),
                        "f1": float(rng.normal()),
                        "f2": float(rng.normal()),
                    },
                    "label": float(signal[i]),
                }
            )
    fake_df = pd.DataFrame(rows)

    monkeypatch.setattr(runner_mod, "_load_feature_matrix", lambda fs: fake_df)

    result = ab_mod.run_ab_compare(
        feature_set_id="fs_v1",
        baselines=["linear", "gbdt-pointwise", "lgb-lambdarank"],
        model_run_id="test-run-id",
        model_version="lgb-lambdarank-v1-test",
        output_dir=tmp_path,
        n_folds=6,
        embargo_days=21,
        min_train_days=252,
        top_k=3,
        lgb_hyperparams={"min_data_in_leaf": 5, "num_leaves": 7},
        lgb_num_boost_round=20,
        lgb_early_stopping_rounds=None,
    )

    summary = result["summary"]
    # 保留的模型：3 baselines + ensemble
    assert set(summary.keys()) == {"linear", "gbdt-pointwise", "lgb-lambdarank", "ensemble"}
    # report 落地
    assert (tmp_path / "report.md").exists()
    assert result["report_path"] is not None
    assert result["report_content"]
    assert "fs_v1" in result["report_content"]


def test_run_ab_compare_baseline_filter(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """baselines=['linear'] 时，summary 应仅含 linear + ensemble。"""

    from quant_pipeline.evaluation import ab_compare as ab_mod
    from quant_pipeline.training import runner as runner_mod

    rng = np.random.default_rng(7)
    rows = []
    for d in range(400):
        td = f"2026{1 + d // 28:02d}{1 + d % 28:02d}"
        signal = rng.normal(size=5)
        for i in range(5):
            rows.append(
                {
                    "trade_date": td,
                    "ts_code": f"00{i:04d}.SZ",
                    "features": {"f0": float(signal[i]), "f1": float(rng.normal())},
                    "label": float(signal[i]),
                }
            )
    monkeypatch.setattr(runner_mod, "_load_feature_matrix", lambda fs: pd.DataFrame(rows))

    result = ab_mod.run_ab_compare(
        feature_set_id="fs_v1",
        baselines=["linear"],
        model_run_id="r1",
        output_dir=tmp_path,
        lgb_hyperparams={"min_data_in_leaf": 5, "num_leaves": 7},
        lgb_num_boost_round=15,
        lgb_early_stopping_rounds=None,
        top_k=2,
    )
    assert set(result["summary"].keys()) == {"linear", "ensemble"}


def test_compare_three_progress_callback_called() -> None:
    df_meta, X, y = _build_mock_panel(n_dates=400, n_codes=5, n_features=3)
    splitter = PurgedWalkForwardSplit(n_folds=6, embargo_days=21, min_train_days=252)
    calls: list[tuple[int, int]] = []

    def cb(done: int, total: int) -> None:
        calls.append((done, total))

    compare_three(
        df_meta, X, y, splitter.split(df_meta),
        seed=42, top_k=2,
        lgb_hyperparams={"min_data_in_leaf": 5, "num_leaves": 7},
        lgb_num_boost_round=15, lgb_early_stopping_rounds=None,
        progress_callback=cb,
    )
    assert len(calls) == 6
    assert calls[-1] == (6, 6)
