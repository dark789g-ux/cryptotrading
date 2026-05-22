"""每日推理后监控（M4 Part L）。

计算 3 类指标，写 ml.quality_reports（rule 对齐 01-pg-schema §4.3）：

  1. IC 漂移（ic_drop）
       - 当日 IC vs 训练期 IC（ml.model_runs.oos_metrics.ic）
       - 滚动 20 日 IC < 训练期 IC × 50% → level='critical', rule='ic_drop'
       - detail: {model_version, recent_ic, train_ic, rolling_window}

  2. 评分分布漂移（score_distribution_drift）
       - 当日 scores 与训练期 OOS scores 的 PSI
       - PSI > 0.25 → 'warn'；> 0.5 → 'critical'
       - detail: {model_version, psi, std_curr, std_train, skew_curr, skew_train}

  3. 特征 PSI（feature_drift_psi）
       - 对每个 feature 当日截面 vs 训练期 PSI
       - PSI > 0.25 → 'warn'；> 0.5 → 'critical'
       - detail: {feature_id, psi, bins}

入口：`run_daily_monitor(date, model_version=None) -> dict`

PSI 工具函数已拆分到 psi_utils.py。
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

import numpy as np
import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.quality.monitor_loaders import build_default_loaders
from quant_pipeline.quality.psi_utils import (
    IC_DROP_RATIO,
    IC_ROLLING_WINDOW,
    PSI_CRITICAL_THRESHOLD,  # noqa: F401 —— re-export 供测试/调用方读阈值
    PSI_WARN_THRESHOLD,  # noqa: F401
    compute_psi,
    psi_level,
    safe_skew,
)
from quant_pipeline.worker.progress import update_progress, warn_with_quality_report

logger = logging.getLogger(__name__)


# DB loader 段已抽到 monitor_loaders.py（06-quality.md 问题 12 行数 + 问题 13
# 单 session 复用）。run_daily_monitor 只开一个 session_scope，经
# build_default_loaders 把同一 session 绑进默认 loader 闭包。


# ----------------------------------------------------------------------
# 三类检查
# ----------------------------------------------------------------------


def _check_ic_drop(
    *,
    trade_date: str,
    model_version: str,
    train_ic: float | None,
    rolling_ic: float,
) -> dict[str, Any] | None:
    if train_ic is None or np.isnan(rolling_ic) or np.isnan(train_ic):
        return None
    if abs(train_ic) < 1e-9:
        return None
    # 用 |IC| 比较预测力，避免负 IC 模型判据失效（见 06-quality.md 问题 7）：
    # 直接 `rolling_ic < train_ic * 0.5` 在 train_ic<0 时阈值反而抬高，更难触发。
    # 预测力 ≈ |IC|；滚动 |IC| 跌破训练期 |IC| 的一半即视为衰减。
    if abs(rolling_ic) < abs(train_ic) * IC_DROP_RATIO:
        detail = {
            "model_version": model_version,
            "recent_ic": float(rolling_ic),
            "train_ic": float(train_ic),
            "rolling_window": IC_ROLLING_WINDOW,
            "threshold_ratio": IC_DROP_RATIO,
            "date": trade_date,
        }
        warn_with_quality_report(
            rule="ic_drop",
            trade_date=trade_date,
            detail=detail,
            level="critical",
        )
        return {"level": "critical", "rule": "ic_drop", "detail": detail}
    return None


def _check_score_distribution_drift(
    *,
    trade_date: str,
    model_version: str,
    train_scores: np.ndarray,
    curr_scores: np.ndarray,
) -> dict[str, Any] | None:
    if train_scores.size < 100 or curr_scores.size < 10:
        return None
    psi, bins = compute_psi(train_scores, curr_scores)
    level = psi_level(psi)

    std_train = float(np.std(train_scores))
    std_curr = float(np.std(curr_scores))
    skew_train = safe_skew(train_scores)
    skew_curr = safe_skew(curr_scores)

    detail: dict[str, Any] = {
        "model_version": model_version,
        "psi": float(psi) if not np.isnan(psi) else None,
        "std_curr": std_curr,
        "std_train": std_train,
        "skew_curr": skew_curr,
        "skew_train": skew_train,
        "date": trade_date,
        "n_train": int(train_scores.size),
        "n_curr": int(curr_scores.size),
        "bins": bins,
    }
    if level is None:
        # PSI 无法计算（train 近似常数 → edges 塌陷）时 compute_psi 返回 NaN。
        # 不能静默当作"无漂移"（06-quality.md 问题 16）：产出一条 info 级留痕，
        # 使 ml.quality_reports 明确记录"本日 PSI 不可计算"而非伪装成绿灯。
        if np.isnan(psi):
            warn_with_quality_report(
                rule="score_distribution_drift",
                trade_date=trade_date,
                detail={**detail, "psi_status": "not_computable"},
                level="info",
            )
        return None
    warn_with_quality_report(
        rule="score_distribution_drift",
        trade_date=trade_date,
        detail=detail,
        level=level,
    )
    return {"level": level, "rule": "score_distribution_drift", "detail": detail}


def _check_feature_drift(
    *,
    trade_date: str,
    train_features: pd.DataFrame,
    curr_features: pd.DataFrame,
) -> list[dict[str, Any]]:
    """对每个 feature 计算 PSI，超阈值写 quality_reports。"""

    if train_features.empty or curr_features.empty:
        return []
    feat_cols = sorted(
        [c for c in train_features.columns if c != "ts_code"]
    )
    out: list[dict[str, Any]] = []
    for col in feat_cols:
        if col not in curr_features.columns:
            continue
        train_vals = train_features[col].to_numpy(dtype=float)
        curr_vals = curr_features[col].to_numpy(dtype=float)
        psi, bins = compute_psi(train_vals, curr_vals)
        level = psi_level(psi)
        if level is None:
            continue
        detail = {
            "feature_id": col,
            "psi": float(psi),
            "bins": bins,
            "date": trade_date,
        }
        warn_with_quality_report(
            rule="feature_drift_psi",
            trade_date=trade_date,
            detail=detail,
            level=level,
        )
        out.append({"level": level, "rule": "feature_drift_psi", "detail": detail})
    return out


# ----------------------------------------------------------------------
# 主入口
# ----------------------------------------------------------------------


def run_daily_monitor(
    date: str,
    model_version: str | None = None,
    *,
    job_id: UUID | None = None,
    # 测试期注入
    load_current_scores: Any = None,
    load_train_oos_metrics: Any = None,
    load_rolling_ic: Any = None,
    load_train_scores_sample: Any = None,
    load_current_features: Any = None,
    load_train_features_sample: Any = None,
) -> dict[str, Any]:
    """每日推理后监控总入口。

    Args:
        date: YYYYMMDD（A 股规范）
        model_version: 可选；为空时取 ml.scores_daily 当日最近的 model_version
        job_id: 写进度回 ml.jobs

    Returns:
        {
            "date": "...",
            "model_version": "...",
            "rolling_ic": float | None,
            "train_ic": float | None,
            "psi_score": float | None,
            "issues": [
                {"level": "...", "rule": "...", "detail": {...}}, ...
            ],
            "n_features_checked": int,
            "n_features_drifted": int,
        }
    """

    if len(date) != 8 or not date.isdigit():
        raise ValueError(f"date 必须是 YYYYMMDD，got {date!r}")

    if job_id is not None:
        update_progress(job_id, 0, stage="monitor:start")

    # 单 session 贯穿整个 monitor（06-quality.md 问题 13）：避免每个 loader
    # 各开一个事务、读到不同时刻快照。默认 loader 经 build_default_loaders
    # 绑定到这同一个 session；测试注入的 loader 各自独立、不受影响。
    with session_scope() as session:
        defaults = build_default_loaders(session)
        load_current_scores = load_current_scores or defaults["load_current_scores"]
        load_train_oos_metrics = (
            load_train_oos_metrics or defaults["load_train_oos_metrics"]
        )
        load_rolling_ic = load_rolling_ic or defaults["load_rolling_ic"]
        load_train_scores_sample = (
            load_train_scores_sample or defaults["load_train_scores_sample"]
        )
        load_current_features = (
            load_current_features or defaults["load_current_features"]
        )
        load_train_features_sample = (
            load_train_features_sample or defaults["load_train_features_sample"]
        )

        # 1) 取当日 scores（若未指定 model_version 则自动选）
        if model_version is None:
            row = session.execute(
                text(
                    """
                    SELECT model_version
                    FROM ml.scores_daily
                    WHERE trade_date = :td
                    ORDER BY model_version DESC
                    LIMIT 1
                    """
                ),
                {"td": date},
            ).first()
            if row is None:
                logger.warning("monitor_no_scores_today", extra={"date": date})
                if job_id is not None:
                    update_progress(job_id, 100, stage="monitor:done")
                return {
                    "date": date,
                    "model_version": None,
                    "issues": [],
                    "note": "no_scores_today",
                }
            model_version = str(row[0])

        return _run_monitor_body(
            date=date,
            model_version=model_version,
            job_id=job_id,
            load_current_scores=load_current_scores,
            load_train_oos_metrics=load_train_oos_metrics,
            load_rolling_ic=load_rolling_ic,
            load_train_scores_sample=load_train_scores_sample,
            load_current_features=load_current_features,
            load_train_features_sample=load_train_features_sample,
        )


def _run_monitor_body(
    *,
    date: str,
    model_version: str,
    job_id: UUID | None,
    load_current_scores: Any,
    load_train_oos_metrics: Any,
    load_rolling_ic: Any,
    load_train_scores_sample: Any,
    load_current_features: Any,
    load_train_features_sample: Any,
) -> dict[str, Any]:
    """run_daily_monitor 的核心计算段（model_version 已解析、loader 已绑定）。"""

    if job_id is not None:
        update_progress(job_id, 10, stage="monitor:model_resolved")

    curr_scores_df = load_current_scores(model_version, date)
    train_info = load_train_oos_metrics(model_version)
    train_ic = train_info["oos_metrics"].get("ic")
    feature_set_id = train_info["feature_set_id"]

    if job_id is not None:
        update_progress(job_id, 30, stage="monitor:data_loaded")

    issues: list[dict[str, Any]] = []

    # 2) IC drop
    rolling_ic = load_rolling_ic(model_version, date, IC_ROLLING_WINDOW)
    res_ic = _check_ic_drop(
        trade_date=date,
        model_version=model_version,
        train_ic=train_ic,
        rolling_ic=rolling_ic,
    )
    if res_ic:
        issues.append(res_ic)

    # 3) 评分分布漂移
    train_scores_arr = load_train_scores_sample(model_version, date)
    curr_scores_arr = (
        curr_scores_df["score"].to_numpy(dtype=float)
        if not curr_scores_df.empty
        else np.empty(0, dtype=float)
    )
    res_score = _check_score_distribution_drift(
        trade_date=date,
        model_version=model_version,
        train_scores=train_scores_arr,
        curr_scores=curr_scores_arr,
    )
    if res_score:
        issues.append(res_score)

    if job_id is not None:
        update_progress(job_id, 60, stage="monitor:score_checked")

    # 4) 特征 PSI
    curr_features = load_current_features(feature_set_id, date)
    train_features = load_train_features_sample(feature_set_id, date)
    feat_issues = _check_feature_drift(
        trade_date=date,
        train_features=train_features,
        curr_features=curr_features,
    )
    issues.extend(feat_issues)

    n_features_checked = (
        max(0, len([c for c in curr_features.columns if c != "ts_code"]))
        if not curr_features.empty
        else 0
    )

    if job_id is not None:
        update_progress(job_id, 100, stage="monitor:done")

    psi_score_value = (
        res_score["detail"]["psi"] if (res_score and "detail" in res_score) else None
    )

    return {
        "date": date,
        "model_version": model_version,
        "rolling_ic": rolling_ic if not np.isnan(rolling_ic) else None,
        "train_ic": train_ic,
        "psi_score": psi_score_value,
        "issues": issues,
        "n_features_checked": n_features_checked,
        "n_features_drifted": len(feat_issues),
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
    }


# ----------------------------------------------------------------------
# Dispatcher 入口（run_type='monitor'）
# ----------------------------------------------------------------------


def runner_entrypoint(job: Any) -> None:
    """worker.dispatcher 路由：run_type='monitor'。

    params schema：
        {
            "date": "YYYYMMDD",
            "model_version": "..."     # 可选
        }
    """

    params = getattr(job, "params", {}) or {}
    date = params.get("date")
    if not isinstance(date, str) or len(date) != 8 or not date.isdigit():
        raise ValueError(f"monitor job.params.date 必须是 YYYYMMDD，got {date!r}")
    model_version = params.get("model_version")
    if model_version is not None and not isinstance(model_version, str):
        raise ValueError(
            f"monitor job.params.model_version 必须是字符串或省略，got {model_version!r}"
        )

    run_daily_monitor(
        date=date,
        model_version=model_version,
        job_id=getattr(job, "id", None),
    )


__all__ = [
    "run_daily_monitor",
    "runner_entrypoint",
]
