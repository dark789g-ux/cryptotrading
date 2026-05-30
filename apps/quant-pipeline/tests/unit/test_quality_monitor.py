"""quality.monitor（M4 Part A · IC drop + 特征 PSI 监控）单测。

不连库；用 monkeypatch 注入 loaders，并 stub warn_with_quality_report 拦截写库。

验证：
  1. compute_psi 在分布相同时 ≈ 0，分布漂移时 > 0
  2. PSI 阈值映射：< 0.25 不告警；0.25-0.5 warn；> 0.5 critical
  3. IC drop：rolling_ic < train_ic × 0.5 → critical 写 quality_reports
  4. run_daily_monitor 完整路径：注入 mock loaders → 返回结构 + 写库次数符合预期
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import numpy as np
import pandas as pd
import pytest


@pytest.fixture
def captured_warns(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """拦截所有 warn_with_quality_report 调用。"""

    out: list[dict[str, Any]] = []

    def _fake(**kwargs: Any) -> None:
        out.append(kwargs)

    # monitor.py 顶层 import 的，直接 patch monitor 模块上的引用
    from quant_pipeline.quality import monitor as mon

    monkeypatch.setattr(mon, "warn_with_quality_report", _fake)
    monkeypatch.setattr(mon, "update_progress", lambda *a, **k: None)
    return out


# ----------------------------------------------------------------------
# 1. compute_psi 基础属性
# ----------------------------------------------------------------------


def test_compute_psi_identical_distributions_near_zero() -> None:
    from quant_pipeline.quality.psi_utils import compute_psi

    rng = np.random.default_rng(42)
    base = rng.normal(0.0, 1.0, size=2000)
    other = rng.normal(0.0, 1.0, size=2000)
    psi, bins = compute_psi(base, other, n_bins=10)
    assert psi < 0.05
    assert len(bins) > 0


def test_compute_psi_shifted_distribution_large() -> None:
    from quant_pipeline.quality.psi_utils import compute_psi

    rng = np.random.default_rng(42)
    base = rng.normal(0.0, 1.0, size=2000)
    shifted = rng.normal(2.0, 1.0, size=2000)  # 均值偏 2σ
    psi, _ = compute_psi(base, shifted, n_bins=10)
    assert psi > 0.5  # 强漂移


# ----------------------------------------------------------------------
# 2. PSI 阈值映射
# ----------------------------------------------------------------------


def test_psi_threshold_levels() -> None:
    from quant_pipeline.quality.psi_utils import psi_level

    assert psi_level(0.1) is None  # < 0.25
    assert psi_level(0.3) == "warn"  # (0.25, 0.5]
    assert psi_level(0.7) == "critical"  # > 0.5
    assert psi_level(float("nan")) is None


# ----------------------------------------------------------------------
# 3. IC drop：rolling_ic 大幅低于 train_ic → critical
# ----------------------------------------------------------------------


def test_ic_drop_triggers_critical(captured_warns: list[dict[str, Any]]) -> None:
    from quant_pipeline.quality.monitor import _check_ic_drop

    res = _check_ic_drop(
        trade_date="20260517",
        model_version="lgb-v1",
        train_ic=0.08,
        rolling_ic=0.02,  # < 0.08 * 0.5 = 0.04
    )
    assert res is not None
    assert res["level"] == "critical"
    assert res["rule"] == "ic_drop"

    # warn_with_quality_report 被调用一次
    assert any(w["rule"] == "ic_drop" and w["level"] == "critical" for w in captured_warns)


def test_ic_drop_no_trigger_when_recent_close_to_train(
    captured_warns: list[dict[str, Any]],
) -> None:
    from quant_pipeline.quality.monitor import _check_ic_drop

    res = _check_ic_drop(
        trade_date="20260517",
        model_version="lgb-v1",
        train_ic=0.08,
        rolling_ic=0.05,  # > 0.04 阈值
    )
    assert res is None
    assert not captured_warns


# ----------------------------------------------------------------------
# 4. run_daily_monitor 完整路径
# ----------------------------------------------------------------------


def _make_feat_df(n_codes: int, cols: list[str], shift: float = 0.0) -> pd.DataFrame:
    rng = np.random.default_rng(123)
    records: list[dict[str, Any]] = []
    for i in range(n_codes):
        rec: dict[str, Any] = {"ts_code": f"{i:06d}.SZ"}
        for c in cols:
            rec[c] = float(rng.normal(shift, 1.0))
        records.append(rec)
    return pd.DataFrame(records)


def test_run_daily_monitor_full_path(
    captured_warns: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    from quant_pipeline.quality.monitor import run_daily_monitor

    rng = np.random.default_rng(42)
    # IC drop：train_ic=0.08, rolling_ic=0.02
    # score 分布漂移：训练 N(0,1)，当日 N(2,1) → PSI 大
    # 特征 f0 漂移：训练 N(0,1)，当日 N(3,1) → PSI critical
    cols = ["f0", "f1"]

    out = run_daily_monitor(
        date="20260517",
        model_version="lgb-v1",
        job_id=uuid4(),
        load_current_scores=lambda mv, td: pd.DataFrame(
            {"ts_code": [f"{i:06d}.SZ" for i in range(500)],
             "score": rng.normal(2.0, 1.0, size=500)}
        ),
        load_train_oos_metrics=lambda mv: {
            "model_run_id": str(uuid4()),
            "feature_set_id": "fs_test",
            "oos_metrics": {"ic": 0.08, "ndcg@10": 0.12},
        },
        load_rolling_ic=lambda mv, td, w: 0.02,
        load_train_scores_sample=lambda mv, td, n_samples=5000: rng.normal(0.0, 1.0, size=2000),
        load_current_features=lambda fs, td: _make_feat_df(500, cols, shift=3.0),
        load_train_features_sample=lambda fs, td, n_dates=60: _make_feat_df(2000, cols, shift=0.0),
    )

    # 返回结构
    assert out["date"] == "20260517"
    assert out["model_version"] == "lgb-v1"
    assert out["rolling_ic"] == 0.02
    assert out["train_ic"] == 0.08
    assert out["n_features_checked"] == 2

    # 至少触发：ic_drop（critical）+ score_distribution_drift + 2 个 feature_drift_psi
    rules = [w["rule"] for w in captured_warns]
    assert "ic_drop" in rules
    assert "score_distribution_drift" in rules
    assert rules.count("feature_drift_psi") == 2

    # issues 与写入次数一致
    assert len(out["issues"]) == len(captured_warns)


def test_run_daily_monitor_missing_scores_returns_note(
    captured_warns: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """当 model_version=None 且当日无 scores → 返回 note: no_scores_today，不抛。"""

    from quant_pipeline.quality import monitor as mon

    # 让 session_scope 路径返回空结果：直接走 model_version=None 分支
    # 但因为没 inject 出 model_version, 实际逻辑会进 session_scope 查询。
    # 用 monkeypatch 干掉 session_scope 让它返回 fake context
    class _FakeSession:
        def execute(self, *a: Any, **k: Any) -> Any:
            class _R:
                def first(self_inner) -> None:
                    return None
                def mappings(self_inner) -> Any:
                    return self_inner
                def all(self_inner) -> list[Any]:
                    return []
            return _R()

    from contextlib import contextmanager

    @contextmanager
    def _fake_scope() -> Any:
        yield _FakeSession()

    monkeypatch.setattr(mon, "session_scope", _fake_scope)

    out = mon.run_daily_monitor(date="20260517", model_version=None)
    assert out.get("note") == "no_scores_today"
    assert out["issues"] == []


# ----------------------------------------------------------------------
# 5. runner_entrypoint 参数校验
# ----------------------------------------------------------------------


def test_runner_entrypoint_validates_params() -> None:
    from quant_pipeline.quality.monitor import runner_entrypoint

    class _Job:
        def __init__(self, params: dict[str, Any]) -> None:
            self.id = uuid4()
            self.params = params

    with pytest.raises(ValueError, match="date"):
        runner_entrypoint(_Job({}))
    with pytest.raises(ValueError, match="date"):
        runner_entrypoint(_Job({"date": "2026-05-17"}))
    with pytest.raises(ValueError, match="model_version"):
        runner_entrypoint(_Job({"date": "20260517", "model_version": 123}))


def test_dispatcher_routes_monitor() -> None:
    from quant_pipeline.worker.dispatcher import get_routes

    routes = get_routes()
    assert "monitor" in routes
    assert routes["monitor"].__name__ == "_runner_monitor"
