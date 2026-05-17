"""每日推理后监控单测（M4 Part L）。

不连库；用 mock loader 注入：
  - compute_psi 数值正确性
  - IC drop 阈值（< train_ic * 0.5 触发 critical）
  - 评分分布漂移阈值（0.25 / 0.5）
  - feature_drift 多列 + 截断
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.quality import monitor


def test_compute_psi_zero_for_identical_distributions() -> None:
    rng = np.random.default_rng(0)
    base = rng.normal(size=5000)
    psi, bins = monitor.compute_psi(base, base.copy())
    assert psi < 0.01
    assert len(bins) >= 5


def test_compute_psi_large_for_shifted_distribution() -> None:
    rng = np.random.default_rng(0)
    base = rng.normal(size=5000)
    shifted = base + 3.0  # 整体平移 3σ
    psi, _ = monitor.compute_psi(base, shifted)
    assert psi > monitor.PSI_CRITICAL_THRESHOLD


def test_check_ic_drop_triggers_when_rolling_below_half(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    quality_writes: list[dict[str, Any]] = []

    def _capture(*, rule, trade_date, detail, level, job_id=None):
        quality_writes.append({"rule": rule, "level": level, "detail": detail})

    monkeypatch.setattr(monitor, "warn_with_quality_report", _capture)

    res = monitor._check_ic_drop(
        trade_date="20260517",
        model_version="mv1",
        train_ic=0.04,
        rolling_ic=0.01,  # < 0.04 * 0.5
    )
    assert res is not None
    assert res["level"] == "critical"
    assert res["rule"] == "ic_drop"
    assert len(quality_writes) == 1
    assert quality_writes[0]["rule"] == "ic_drop"
    assert quality_writes[0]["detail"]["model_version"] == "mv1"
    assert quality_writes[0]["detail"]["rolling_window"] == monitor.IC_ROLLING_WINDOW


def test_check_ic_drop_skips_when_rolling_not_low(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(monitor, "warn_with_quality_report", lambda **k: None)
    res = monitor._check_ic_drop(
        trade_date="20260517",
        model_version="mv1",
        train_ic=0.04,
        rolling_ic=0.03,  # > 0.02 threshold
    )
    assert res is None


def test_check_score_distribution_drift_triggers_warn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    quality_writes: list[dict[str, Any]] = []
    monkeypatch.setattr(
        monitor,
        "warn_with_quality_report",
        lambda **k: quality_writes.append(k),
    )

    rng = np.random.default_rng(0)
    base = rng.normal(size=5000)
    # 强漂移：中心偏移 1.5σ + 方差扩大 1.5 倍 → 应至少触发 warn
    drifted = rng.normal(loc=1.5, scale=1.5, size=500)
    res = monitor._check_score_distribution_drift(
        trade_date="20260517",
        model_version="mv1",
        train_scores=base,
        curr_scores=drifted,
    )
    # 这种程度的漂移应至少触发 warn
    assert res is not None
    assert res["level"] in ("warn", "critical")
    assert res["rule"] == "score_distribution_drift"
    assert len(quality_writes) >= 1


def test_check_feature_drift_writes_for_drifted_features(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    quality_writes: list[dict[str, Any]] = []
    monkeypatch.setattr(
        monitor,
        "warn_with_quality_report",
        lambda **k: quality_writes.append(k),
    )

    rng = np.random.default_rng(0)
    train_df = pd.DataFrame(
        {
            "ts_code": [f"t{i}" for i in range(2000)],
            "f_stable": rng.normal(size=2000),
            "f_drifted": rng.normal(size=2000),
        }
    )
    curr_df = pd.DataFrame(
        {
            "ts_code": [f"t{i}" for i in range(500)],
            # 与 train 同分布 → 不触发
            "f_stable": rng.normal(size=500),
            # 整体平移 3 倍 σ → 触发
            "f_drifted": rng.normal(size=500) + 3.0,
        }
    )
    out = monitor._check_feature_drift(
        trade_date="20260517",
        train_features=train_df,
        curr_features=curr_df,
    )
    drifted_ids = [r["detail"]["feature_id"] for r in out]
    assert "f_drifted" in drifted_ids
    # f_stable 不应触发（PSI 应 < 0.25）
    assert "f_stable" not in drifted_ids


def test_run_daily_monitor_returns_summary_with_all_loaders_mocked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """整链路 smoke：mock 全部 loader，验证 issues + n_features_drifted 字段。"""

    monkeypatch.setattr(monitor, "update_progress", lambda *a, **k: None)
    monkeypatch.setattr(monitor, "warn_with_quality_report", lambda **k: None)

    rng = np.random.default_rng(0)
    out = monitor.run_daily_monitor(
        date="20260517",
        model_version="mv-mock",
        load_current_scores=lambda mv, td: pd.DataFrame(
            {"ts_code": ["a", "b", "c"], "score": [0.1, 0.2, 0.3]}
        ),
        load_train_oos_metrics=lambda mv: {
            "model_run_id": "rid",
            "feature_set_id": "fs1",
            "oos_metrics": {"ic": 0.04},
        },
        load_rolling_ic=lambda mv, td, w: 0.005,  # < 0.02 → critical
        load_train_scores_sample=lambda mv: rng.normal(size=2000),
        load_current_features=lambda fs, td: pd.DataFrame(
            {"ts_code": ["a", "b"], "f0": [0.1, 0.2]}
        ),
        load_train_features_sample=lambda fs, td: pd.DataFrame(
            {"ts_code": [f"t{i}" for i in range(500)], "f0": rng.normal(size=500)}
        ),
    )
    assert out["model_version"] == "mv-mock"
    assert out["date"] == "20260517"
    # IC drop 触发了 critical
    rules = {r["rule"] for r in out["issues"]}
    assert "ic_drop" in rules


def test_dispatcher_route_monitor_present() -> None:
    from quant_pipeline.worker.dispatcher import get_routes

    routes = get_routes()
    assert "monitor" in routes
    assert routes["monitor"].__name__ == "_runner_monitor"


def test_runner_entrypoint_validates_date() -> None:
    class _Bad:
        id = None
        params = {"date": "not-a-date"}

    with pytest.raises(ValueError, match="date"):
        monitor.runner_entrypoint(_Bad())

    class _Bad2:
        id = None
        params = {"date": "20260517", "model_version": 123}

    with pytest.raises(ValueError, match="model_version"):
        monitor.runner_entrypoint(_Bad2())


def test_feature_drift_psi_in_allowed_rules() -> None:
    from quant_pipeline.quality.report import ALLOWED_RULES

    assert "feature_drift_psi" in ALLOWED_RULES
    assert "score_distribution_drift" in ALLOWED_RULES
    assert "ic_drop" in ALLOWED_RULES
