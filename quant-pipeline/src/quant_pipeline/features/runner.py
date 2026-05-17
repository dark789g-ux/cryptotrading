# -*- coding: utf-8 -*-
"""features runner：DB IO 层。

职责：
1. 从 factors.daily_factors / factors.labels / raw.index_member+index_classify 加载数据
2. 调 features.builder 计算 feature_matrix
3. upsert/replace feature_sets 元数据 + feature_matrix 数据

dispatcher 路由：run_type='features' → runner_entrypoint。
"""

from __future__ import annotations

import json
import logging
from typing import Any
from uuid import UUID

import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.features.builder import (
    build_feature_matrix_from_frames,
    build_feature_set_id,
)
from quant_pipeline.worker.progress import (
    JobCancelled,
    check_cancel_requested,
    update_progress,
)

logger = logging.getLogger(__name__)


def _load_daily_factors(
    factor_version: str, start: str, end: str
) -> pd.DataFrame:
    sql = text(
        """
        SELECT trade_date, ts_code, factor_id, value
        FROM factors.daily_factors
        WHERE factor_version = :v
          AND trade_date >= :start
          AND trade_date <= :end
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(
                sql, {"v": factor_version, "start": start, "end": end}
            ).fetchall()
        if not rows:
            return pd.DataFrame(columns=["trade_date", "ts_code", "factor_id", "value"])
        df = pd.DataFrame(rows, columns=["trade_date", "ts_code", "factor_id", "value"])
        df["value"] = pd.to_numeric(df["value"], errors="coerce")
        return df
    except Exception as exc:  # noqa: BLE001
        logger.warning("daily_factors_unavailable", extra={"err": str(exc)})
        return pd.DataFrame(columns=["trade_date", "ts_code", "factor_id", "value"])


def _load_labels(scheme: str, start: str, end: str) -> pd.DataFrame:
    sql = text(
        """
        SELECT trade_date, ts_code, scheme, value, exit_reason, hold_days
        FROM factors.labels
        WHERE scheme = :s
          AND trade_date >= :start
          AND trade_date <= :end
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(
                sql, {"s": scheme, "start": start, "end": end}
            ).fetchall()
        if not rows:
            return pd.DataFrame(
                columns=["trade_date", "ts_code", "scheme", "value", "exit_reason", "hold_days"]
            )
        df = pd.DataFrame(
            rows,
            columns=["trade_date", "ts_code", "scheme", "value", "exit_reason", "hold_days"],
        )
        df["value"] = pd.to_numeric(df["value"], errors="coerce")
        return df
    except Exception as exc:  # noqa: BLE001
        logger.warning("labels_unavailable", extra={"err": str(exc)})
        return pd.DataFrame(
            columns=["trade_date", "ts_code", "scheme", "value", "exit_reason", "hold_days"]
        )


def _load_mv_map(start: str, end: str) -> pd.DataFrame:
    """从 raw.daily_basic 加载流通市值 mv（按 PIT 安全：trade_date 直接对应）。"""

    sql = text(
        """
        SELECT trade_date, ts_code, total_mv AS mv
        FROM raw.daily_basic
        WHERE trade_date >= :start AND trade_date <= :end
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql, {"start": start, "end": end}).fetchall()
        if not rows:
            return pd.DataFrame(columns=["trade_date", "ts_code", "mv"])
        df = pd.DataFrame(rows, columns=["trade_date", "ts_code", "mv"])
        df["mv"] = pd.to_numeric(df["mv"], errors="coerce")
        return df
    except Exception as exc:  # noqa: BLE001
        logger.warning("daily_basic_mv_unavailable", extra={"err": str(exc)})
        return pd.DataFrame(columns=["trade_date", "ts_code", "mv"])


def _load_industry_map(start: str, end: str) -> pd.DataFrame:
    """从 raw.trade_cal + raw.index_member + raw.index_classify 解析 PIT 行业归属。

    简化：返回 [trade_date, ts_code, industry_l1]——对每个交易日按 in_date <= t AND
    (out_date IS NULL OR out_date > t) 解析。表不可用时返回空 DF。
    """

    sql = text(
        """
        SELECT cal.cal_date AS trade_date,
               im.con_code  AS ts_code,
               im.index_code AS industry_l1
        FROM raw.trade_cal cal
        JOIN raw.index_member im
          ON im.in_date <= cal.cal_date
         AND (im.out_date IS NULL OR im.out_date > cal.cal_date)
        JOIN raw.index_classify ic
          ON ic.index_code = im.index_code
         AND ic.level = 'L1'
        WHERE cal.is_open = 1
          AND cal.cal_date >= :start AND cal.cal_date <= :end
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql, {"start": start, "end": end}).fetchall()
        if not rows:
            return pd.DataFrame(columns=["trade_date", "ts_code", "industry_l1"])
        return pd.DataFrame(rows, columns=["trade_date", "ts_code", "industry_l1"])
    except Exception as exc:  # noqa: BLE001
        logger.warning("industry_map_unavailable", extra={"err": str(exc)})
        return pd.DataFrame(columns=["trade_date", "ts_code", "industry_l1"])


def _upsert_feature_set(
    *, feature_set_id: str, factor_version: str, scheme: str, factor_ids: list[str]
) -> None:
    sql = text(
        """
        INSERT INTO factors.feature_sets
            (feature_set_id, factor_version, scheme, factor_ids, created_at)
        VALUES
            (:feature_set_id, :factor_version, :scheme, CAST(:factor_ids AS jsonb), now())
        ON CONFLICT (feature_set_id)
        DO UPDATE SET factor_version = EXCLUDED.factor_version,
                      scheme         = EXCLUDED.scheme,
                      factor_ids     = EXCLUDED.factor_ids
        """
    )
    with session_scope() as session:
        session.execute(
            sql,
            {
                "feature_set_id": feature_set_id,
                "factor_version": factor_version,
                "scheme": scheme,
                "factor_ids": json.dumps(factor_ids, ensure_ascii=False),
            },
        )


def _upsert_feature_matrix(
    *, feature_set_id: str, matrix: pd.DataFrame, factor_ids: list[str]
) -> int:
    """把宽矩阵 upsert 到 factors.feature_matrix。

    matrix 列：trade_date / ts_code / <factor_id...> / label
    PG 端 factors.feature_matrix schema（spec §3）：宽格式，按 feature_set 分区。
    本 runner 假定有一列 features jsonb + label numeric，与 alembic schema 对齐。
    去重：按 PK (trade_date, ts_code, feature_set_id)。
    """

    if matrix.empty:
        return 0

    rows: list[dict[str, Any]] = []
    for _, r in matrix.iterrows():
        feat = {fid: (float(r[fid]) if pd.notna(r[fid]) else None) for fid in factor_ids if fid in r}
        rows.append(
            {
                "trade_date": str(r["trade_date"]),
                "ts_code": str(r["ts_code"]),
                "feature_set_id": feature_set_id,
                "features": json.dumps(feat, ensure_ascii=False),
                "label": float(r["label"]) if pd.notna(r["label"]) else None,
            }
        )

    # 按 PK 去重
    seen: dict[tuple[str, str, str], dict[str, Any]] = {}
    for r in rows:
        key = (r["trade_date"], r["ts_code"], r["feature_set_id"])
        seen[key] = r
    deduped = list(seen.values())
    if len(deduped) != len(rows):
        logger.warning(
            "feature_matrix_dedup",
            extra={"raw": len(rows), "deduped": len(deduped)},
        )

    sql = text(
        """
        INSERT INTO factors.feature_matrix
            (trade_date, ts_code, feature_set_id, features, label)
        VALUES
            (:trade_date, :ts_code, :feature_set_id, CAST(:features AS jsonb), :label)
        ON CONFLICT (trade_date, ts_code, feature_set_id)
        DO UPDATE SET features = EXCLUDED.features,
                      label    = EXCLUDED.label
        """
    )
    with session_scope() as session:
        session.execute(sql, deduped)
    return len(deduped)


def build_feature_matrix(
    *,
    factor_version: str,
    label_scheme: str,
    date_range: str,
    job_id: UUID | None = None,
) -> str:
    """构建并落库 feature_matrix；返回 feature_set_id。"""

    start, end = date_range.split(":")
    if len(start) != 8 or len(end) != 8:
        raise ValueError(f"date_range must be 'YYYYMMDD:YYYYMMDD', got {date_range!r}")

    if job_id is not None and check_cancel_requested(job_id):
        raise JobCancelled
    if job_id is not None:
        update_progress(job_id, 10, stage="features:load")

    daily_factors = _load_daily_factors(factor_version, start, end)
    labels = _load_labels(label_scheme, start, end)
    industry_map = _load_industry_map(start, end)
    mv_map = _load_mv_map(start, end)

    if daily_factors.empty or labels.empty:
        feature_set_id = build_feature_set_id(factor_version, label_scheme)
        logger.warning(
            "feature_matrix_inputs_empty",
            extra={
                "factor_version": factor_version,
                "label_scheme": label_scheme,
                "factors_rows": len(daily_factors),
                "labels_rows": len(labels),
            },
        )
        if job_id is not None:
            update_progress(job_id, 100, stage="features:empty")
        return feature_set_id

    if job_id is not None:
        update_progress(job_id, 30, stage="features:compute")

    bundle = build_feature_matrix_from_frames(
        daily_factors=daily_factors,
        labels=labels,
        industry_map=industry_map,
        mv_map=mv_map if not mv_map.empty else None,
        factor_version=factor_version,
        label_scheme=label_scheme,
    )

    if job_id is not None:
        update_progress(job_id, 70, stage="features:upsert")

    _upsert_feature_set(
        feature_set_id=bundle.feature_set_id,
        factor_version=factor_version,
        scheme=label_scheme,
        factor_ids=bundle.factor_ids,
    )
    n = _upsert_feature_matrix(
        feature_set_id=bundle.feature_set_id,
        matrix=bundle.matrix,
        factor_ids=bundle.factor_ids,
    )
    logger.info(
        "feature_matrix_written",
        extra={
            "feature_set_id": bundle.feature_set_id,
            "rows": n,
            "factor_count": len(bundle.factor_ids),
        },
    )

    if job_id is not None:
        update_progress(job_id, 100, stage="features:done")
    return bundle.feature_set_id


def runner_entrypoint(job: object) -> None:
    """供 worker.dispatcher 调用。

    job.params schema（01-pg-schema §4.1）：
        {
            "factor_version": "v1",
            "label_scheme": "strategy-aware",
            "date_range": "YYYYMMDD:YYYYMMDD"
        }
    """

    params = getattr(job, "params", {}) or {}
    factor_version = params.get("factor_version")
    label_scheme = params.get("label_scheme")
    date_range = params.get("date_range")
    if not factor_version or not label_scheme or not date_range:
        raise ValueError(
            f"features job missing required params: factor_version/label_scheme/date_range, "
            f"got {params!r}"
        )
    job_id = getattr(job, "id", None)
    build_feature_matrix(
        factor_version=str(factor_version),
        label_scheme=str(label_scheme),
        date_range=str(date_range),
        job_id=job_id,
    )


__all__ = ["build_feature_matrix", "runner_entrypoint"]
