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
from quant_pipeline.worker.progress import update_progress, warn_with_quality_report

logger = logging.getLogger(__name__)


PSI_WARN_THRESHOLD = 0.25
PSI_CRITICAL_THRESHOLD = 0.5
IC_DROP_RATIO = 0.5  # 滚动 IC < 训练期 IC × 0.5 → critical
IC_ROLLING_WINDOW = 20


# ----------------------------------------------------------------------
# PSI 工具
# ----------------------------------------------------------------------


def compute_psi(
    train_values: np.ndarray,
    curr_values: np.ndarray,
    *,
    n_bins: int = 10,
) -> tuple[float, list[dict[str, float]]]:
    """PSI（Population Stability Index）= sum( (curr% - train%) * ln(curr% / train%) )

    bin 切分按 train_values 的 quantile（避免极端值把 bin 压扁）。
    单 bin 占比为 0 时按 1e-6 平滑（避免 log(0)）。
    """

    train = np.asarray(train_values, dtype=float)
    curr = np.asarray(curr_values, dtype=float)
    train = train[~np.isnan(train)]
    curr = curr[~np.isnan(curr)]
    if train.size == 0 or curr.size == 0:
        return float("nan"), []

    # 用 train 的分位点切 bin（保留首尾 ±inf）
    quantiles = np.linspace(0.0, 1.0, n_bins + 1)
    edges = np.unique(np.quantile(train, quantiles))
    if edges.size < 3:
        # train 几乎是常数，PSI 不可计算
        return float("nan"), []
    edges[0] = -np.inf
    edges[-1] = np.inf

    train_hist, _ = np.histogram(train, bins=edges)
    curr_hist, _ = np.histogram(curr, bins=edges)
    train_pct = train_hist.astype(float) / max(1.0, train.size)
    curr_pct = curr_hist.astype(float) / max(1.0, curr.size)
    eps = 1e-6
    train_pct = np.where(train_pct < eps, eps, train_pct)
    curr_pct = np.where(curr_pct < eps, eps, curr_pct)
    psi = float(np.sum((curr_pct - train_pct) * np.log(curr_pct / train_pct)))

    bins_detail = [
        {
            "bin_id": int(i),
            "edge_lo": float(edges[i]) if np.isfinite(edges[i]) else float(edges[i]),
            "edge_hi": float(edges[i + 1]) if np.isfinite(edges[i + 1]) else float(edges[i + 1]),
            "train_pct": float(train_pct[i]),
            "curr_pct": float(curr_pct[i]),
        }
        for i in range(len(train_pct))
    ]
    return psi, bins_detail


def _psi_level(psi: float) -> str | None:
    """PSI 阈值 → level；NaN / < 0.25 返回 None（不写 quality_reports）。"""

    if np.isnan(psi):
        return None
    if psi > PSI_CRITICAL_THRESHOLD:
        return "critical"
    if psi > PSI_WARN_THRESHOLD:
        return "warn"
    return None


# ----------------------------------------------------------------------
# DB 加载（生产）
# ----------------------------------------------------------------------


def _load_current_scores(model_version: str, trade_date: str) -> pd.DataFrame:
    sql = text(
        """
        SELECT ts_code, score
        FROM ml.scores_daily
        WHERE model_version = :mv AND trade_date = :td
        """
    )
    with session_scope() as session:
        rows = session.execute(sql, {"mv": model_version, "td": trade_date}).mappings().all()
    return pd.DataFrame([{"ts_code": r["ts_code"], "score": float(r["score"])} for r in rows])


def _load_train_oos_metrics(model_version: str) -> dict[str, Any]:
    sql = text(
        """
        SELECT id, oos_metrics, feature_set_id
        FROM ml.model_runs
        WHERE model_version = :mv
        ORDER BY created_at DESC
        LIMIT 1
        """
    )
    with session_scope() as session:
        row = session.execute(sql, {"mv": model_version}).mappings().first()
    if row is None:
        raise ValueError(f"ml.model_runs 找不到 model_version={model_version!r}")
    return {
        "model_run_id": str(row["id"]),
        "feature_set_id": row["feature_set_id"],
        "oos_metrics": dict(row["oos_metrics"] or {}),
    }


def _load_rolling_ic(model_version: str, end_date: str, window: int) -> float:
    """计算滚动 window 日 IC 均值：用 ml.scores_daily JOIN factors.labels (strategy-aware)。

    若 ml.scores_daily 无足量数据，返回 NaN。
    """

    sql = text(
        """
        WITH dates AS (
            SELECT DISTINCT trade_date
            FROM ml.scores_daily
            WHERE model_version = :mv AND trade_date <= :td
            ORDER BY trade_date DESC
            LIMIT :w
        ),
        joined AS (
            SELECT s.trade_date, s.ts_code, s.score, l.value AS label
            FROM ml.scores_daily s
            JOIN factors.labels l
              ON l.trade_date = s.trade_date AND l.ts_code = s.ts_code
            WHERE s.model_version = :mv
              AND s.trade_date IN (SELECT trade_date FROM dates)
        )
        SELECT trade_date, score, label FROM joined
        """
    )
    with session_scope() as session:
        rows = (
            session.execute(sql, {"mv": model_version, "td": end_date, "w": window})
            .mappings()
            .all()
        )
    if not rows:
        return float("nan")
    df = pd.DataFrame([dict(r) for r in rows])
    # 按 trade_date 求截面 IC，再对 window 内的 IC 求均值
    ics: list[float] = []
    for _td, g in df.groupby("trade_date"):
        if len(g) < 2:
            continue
        s = g["score"].to_numpy(dtype=float)
        y = g["label"].to_numpy(dtype=float)
        if np.std(s) < 1e-12 or np.std(y) < 1e-12:
            continue
        ics.append(float(np.corrcoef(s, y)[0, 1]))
    if not ics:
        return float("nan")
    return float(np.mean(ics))


def _load_train_scores_sample(model_version: str, n_samples: int = 5000) -> np.ndarray:
    """取该 model_version 历史 ml.scores_daily 作为 train 分布的代理。

    若历史无样本（首次推理后立即监控），返回空数组。
    """

    sql = text(
        """
        SELECT score
        FROM ml.scores_daily
        WHERE model_version = :mv
        ORDER BY trade_date DESC
        LIMIT :lim
        """
    )
    with session_scope() as session:
        rows = session.execute(sql, {"mv": model_version, "lim": n_samples}).all()
    return np.asarray([float(r[0]) for r in rows], dtype=float)


def _load_current_features(feature_set_id: str, trade_date: str) -> pd.DataFrame:
    sql = text(
        """
        SELECT ts_code, features
        FROM factors.feature_matrix
        WHERE feature_set_id = :fs AND trade_date = :td
        """
    )
    with session_scope() as session:
        rows = (
            session.execute(sql, {"fs": feature_set_id, "td": trade_date})
            .mappings()
            .all()
        )
    records: list[dict[str, Any]] = []
    for r in rows:
        feats = dict(r["features"]) if r["features"] else {}
        rec = {"ts_code": r["ts_code"], **{k: float(v) if v is not None else np.nan
                                            for k, v in feats.items()}}
        records.append(rec)
    return pd.DataFrame(records)


def _load_train_features_sample(
    feature_set_id: str,
    trade_date: str,
    n_dates: int = 60,
) -> pd.DataFrame:
    """取该 feature_set 距 trade_date 之前 n_dates 个交易日的全样本，作为训练分布代理。"""

    sql = text(
        """
        WITH dates AS (
            SELECT DISTINCT trade_date
            FROM factors.feature_matrix
            WHERE feature_set_id = :fs AND trade_date < :td
            ORDER BY trade_date DESC
            LIMIT :n
        )
        SELECT ts_code, features
        FROM factors.feature_matrix
        WHERE feature_set_id = :fs
          AND trade_date IN (SELECT trade_date FROM dates)
        """
    )
    with session_scope() as session:
        rows = (
            session.execute(sql, {"fs": feature_set_id, "td": trade_date, "n": n_dates})
            .mappings()
            .all()
        )
    records: list[dict[str, Any]] = []
    for r in rows:
        feats = dict(r["features"]) if r["features"] else {}
        rec = {"ts_code": r["ts_code"], **{k: float(v) if v is not None else np.nan
                                            for k, v in feats.items()}}
        records.append(rec)
    return pd.DataFrame(records)


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
    if rolling_ic < train_ic * IC_DROP_RATIO:
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
    level = _psi_level(psi)

    std_train = float(np.std(train_scores))
    std_curr = float(np.std(curr_scores))
    skew_train = _safe_skew(train_scores)
    skew_curr = _safe_skew(curr_scores)

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
        level = _psi_level(psi)
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


def _safe_skew(arr: np.ndarray) -> float:
    arr = arr[~np.isnan(arr)]
    if arr.size < 3:
        return float("nan")
    m = float(np.mean(arr))
    sd = float(np.std(arr))
    if sd < 1e-12:
        return 0.0
    return float(np.mean(((arr - m) / sd) ** 3))


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

    # 默认 loader
    load_current_scores = load_current_scores or _load_current_scores
    load_train_oos_metrics = load_train_oos_metrics or _load_train_oos_metrics
    load_rolling_ic = load_rolling_ic or _load_rolling_ic
    load_train_scores_sample = load_train_scores_sample or _load_train_scores_sample
    load_current_features = load_current_features or _load_current_features
    load_train_features_sample = (
        load_train_features_sample or _load_train_features_sample
    )

    # 1) 取当日 scores（若未指定 model_version 则自动选）
    if model_version is None:
        with session_scope() as session:
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
    train_scores_arr = load_train_scores_sample(model_version)
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
    "PSI_WARN_THRESHOLD",
    "PSI_CRITICAL_THRESHOLD",
    "IC_DROP_RATIO",
    "IC_ROLLING_WINDOW",
    "compute_psi",
    "run_daily_monitor",
    "runner_entrypoint",
]
