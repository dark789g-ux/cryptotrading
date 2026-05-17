"""报告生成单测（M3 Part I）。

覆盖：
  - generate_report 落 report.md（UTF-8）+ daily_returns.csv
  - 内容含三组对照表 + 每折指标 + 排查建议
  - daily_returns 为空时不写 csv 但 md 仍能生成
  - GBDT vs Linear 提升 < 0.015 时报告显式 warn
"""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pandas as pd

from quant_pipeline.evaluation.report_generator import generate_report


def _mock_summary(linear_ndcg: float = 0.50, lambdarank_ndcg: float = 0.55) -> dict:
    fold_metrics = [
        {
            "fold": i,
            "ndcg@5": 0.5,
            "ndcg@10": linear_ndcg,
            "ic": 0.02,
            "rank_ic": 0.03,
            "portfolio_annual_after_cost": 0.10,
            "sharpe": 1.0,
        }
        for i in range(6)
    ]
    fold_metrics_lr = [
        dict(f, **{"ndcg@10": lambdarank_ndcg}) for f in fold_metrics
    ]
    return {
        "linear": {
            "ndcg_at_5_mean": 0.5,
            "ndcg_at_10_mean": linear_ndcg,
            "ic_mean": 0.02,
            "rank_ic_mean": 0.03,
            "portfolio_annual_after_cost": 0.10,
            "sharpe_mean": 1.0,
            "fold_metrics": fold_metrics,
            "n_folds": 6,
        },
        "gbdt-pointwise": {
            "ndcg_at_5_mean": 0.52,
            "ndcg_at_10_mean": 0.53,
            "ic_mean": 0.025,
            "rank_ic_mean": 0.04,
            "portfolio_annual_after_cost": 0.12,
            "sharpe_mean": 1.1,
            "fold_metrics": fold_metrics,
            "n_folds": 6,
        },
        "lgb-lambdarank": {
            "ndcg_at_5_mean": 0.55,
            "ndcg_at_10_mean": lambdarank_ndcg,
            "ic_mean": 0.03,
            "rank_ic_mean": 0.05,
            "portfolio_annual_after_cost": 0.15,
            "sharpe_mean": 1.3,
            "fold_metrics": fold_metrics_lr,
            "n_folds": 6,
        },
        "ensemble": {
            "ndcg_at_5_mean": 0.54,
            "ndcg_at_10_mean": 0.56,
            "ic_mean": 0.028,
            "rank_ic_mean": 0.045,
            "portfolio_annual_after_cost": 0.14,
            "sharpe_mean": 1.25,
            "fold_metrics": fold_metrics,
            "n_folds": 6,
        },
    }


def test_generate_report_writes_md_and_csv(tmp_path: Path) -> None:
    summary = _mock_summary()
    run_id = str(uuid4())
    daily = pd.Series(
        [0.001, -0.002, 0.003, 0.001],
        index=["20260101", "20260102", "20260103", "20260104"],
        name="daily_net_return",
    )
    content, uri = generate_report(
        model_run_id=run_id,
        model_version="lgb-lambdarank-v1-20260517-seed42",
        feature_set_id="fs_v1",
        hyperparams={"num_leaves": 31, "learning_rate": 0.05},
        walk_forward_params={"n_folds": 6, "embargo_days": 21, "min_train_days": 252},
        compare_summary=summary,
        ensemble_daily_returns=daily,
        output_dir=tmp_path,
    )

    assert "lgb-lambdarank-v1-20260517-seed42" in content
    assert "NDCG@10" in content
    assert "linear" in content and "lgb-lambdarank" in content
    assert "ensemble" in content
    # 落盘
    assert (tmp_path / "report.md").exists()
    assert (tmp_path / "daily_returns.csv").exists()
    # 文本应 UTF-8
    raw = (tmp_path / "report.md").read_text(encoding="utf-8")
    assert raw == content
    # report_uri POSIX
    assert uri.startswith("./artifacts/")
    assert uri.endswith("/report.md")


def test_generate_report_no_daily_returns(tmp_path: Path) -> None:
    summary = _mock_summary()
    content, _uri = generate_report(
        model_run_id=str(uuid4()),
        model_version="lgb-lambdarank-v1-20260517-seed42",
        feature_set_id="fs_v1",
        hyperparams={},
        walk_forward_params={"n_folds": 6, "embargo_days": 21, "min_train_days": 252},
        compare_summary=summary,
        ensemble_daily_returns=None,
        output_dir=tmp_path,
    )
    assert (tmp_path / "report.md").exists()
    assert not (tmp_path / "daily_returns.csv").exists()
    assert "daily returns 缺失" in content


def test_generate_report_flags_gap_below_threshold(tmp_path: Path) -> None:
    """LambdaRank vs Linear 差距 < 0.015 时报告应给出 warn。"""

    summary = _mock_summary(linear_ndcg=0.50, lambdarank_ndcg=0.505)  # 差 0.005
    content, _ = generate_report(
        model_run_id=str(uuid4()),
        model_version="lgb-lambdarank-v1-20260517-seed42",
        feature_set_id="fs_v1",
        hyperparams={},
        walk_forward_params={"n_folds": 6, "embargo_days": 21, "min_train_days": 252},
        compare_summary=summary,
        ensemble_daily_returns=None,
        output_dir=tmp_path,
    )
    assert "0.015" in content
    assert "提升" in content


def test_generate_report_flags_gap_meets_threshold(tmp_path: Path) -> None:
    summary = _mock_summary(linear_ndcg=0.50, lambdarank_ndcg=0.52)  # 差 0.02
    content, _ = generate_report(
        model_run_id=str(uuid4()),
        model_version="x",
        feature_set_id="fs_v1",
        hyperparams={},
        walk_forward_params={},
        compare_summary=summary,
        ensemble_daily_returns=None,
        output_dir=tmp_path,
    )
    # 应有 ✅ 标记
    assert "✅" in content
