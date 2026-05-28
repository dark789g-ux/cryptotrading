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
    DEFAULT_NEUTRALIZE_COLS,
    DEFAULT_ROBUST_Z,
    build_feature_matrix_for_inference,
    build_feature_matrix_from_frames,
    resolve_feature_set_id,
)
from quant_pipeline.worker.progress import (
    JobCancelled,
    ProgressCallback,
    check_cancel_requested,
    update_progress,
)

logger = logging.getLogger(__name__)


def _load_factor_ids(session: Any, factor_version: str) -> list[str]:
    """从 factors.daily_factors 拉取该 factor_version 下出现过的所有 factor_id，
    再用 registry 的 `list_active(factor_version)` 过滤掉 `enabled=false` 的因子。

    spec 2026-05-23-factor-registry-frontend-design 02-pipeline-refactor.md：
    feature_set_id 哈希契约里的 `sorted_factor_ids` 应来自"启用集合"，
    启停一个因子 → 哈希变化 → 新 feature_set_id。这里做"DB 数据 ∩ 启用集合"
    交集：既排除掉历史遗留的、已停用因子，也防止因 registry 缓存未加载导致
    SQL 拉到的 id 没经过 enabled 过滤就进哈希。

    spec 03：调用方拿到结果后必须 ``tuple(sorted(...))`` 排序，再传入
    :func:`resolve_feature_set_id` 与写入侧 INSERT——三处对 factor_ids 的
    排序约定一致，DB 唯一索引（``factors._factor_ids_hash(factor_ids)``）
    才能稳定命中。
    """

    sql = text(
        """
        SELECT DISTINCT factor_id
          FROM factors.daily_factors
         WHERE factor_version = :v
        """
    )
    rows = session.execute(sql, {"v": factor_version}).fetchall()
    in_db = {r[0] for r in rows}

    # 启用集合：依赖调用方（train_e2e_runner）已在入口 `reload_from_db()`。
    # 若 `_meta_cache` 为空，`list_active` 抛 `FactorMetaMissing`——这里**不**
    # 用 try/except 兜底成 in_db 全集，避免静默吞错（CLAUDE.md）。
    from quant_pipeline.factors.registry import list_active

    active = {f.factor_id for f in list_active(factor_version)}

    # 交集：DB 有数据 + registry 已启用
    return sorted(in_db & active)


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
        logger.error("daily_factors_failed", extra={"err": str(exc)})
        raise


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
        logger.error("labels_failed", extra={"err": str(exc)})
        raise


def _load_mv_map(start: str, end: str) -> pd.DataFrame:
    """从 raw.daily_basic 加载**总市值** total_mv（按 PIT 安全：trade_date 直接对应）。

    注：market-cap 中性化口径取 Tushare `daily_basic.total_mv`（总市值）。
    spec（doc/量化）未明确要求总市值 vs 流通市值（circ_mv）——本实现沿用现有
    SQL 已落地的 `total_mv` 列，并保持注释 / 变量名一致（review §9）。
    如后续 spec 要求改用流通市值，仅需把列名换成 `circ_mv` 并同步本注释。
    """

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
        logger.error("daily_basic_mv_failed", extra={"err": str(exc)})
        raise


def _load_industry_map(start: str, end: str) -> pd.DataFrame:
    """从 raw.daily_quote（PIT 真值日历）+ raw.index_member 解析 PIT 行业归属。

    简化：返回 [trade_date, ts_code, industry_l1]——对每个交易日按 in_date <= t AND
    (out_date IS NULL OR out_date > t) 解析。表不可用时返回空 DF。

    日期源头：raw.daily_quote.trade_date（与 factors/runner._query_trade_dates 口径一致，
    不依赖 raw.trade_cal 同步范围）。
    """

    sql = text(
        """
        SELECT cal.cal_date AS trade_date,
               im.ts_code,
               im.l1_code AS industry_l1
        FROM (
            SELECT DISTINCT trade_date AS cal_date
            FROM raw.daily_quote
            WHERE trade_date >= :start AND trade_date <= :end
        ) cal
        JOIN raw.index_member im
          ON im.in_date <= cal.cal_date
         AND (im.out_date IS NULL OR im.out_date > cal.cal_date)
        WHERE im.l1_code IS NOT NULL
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql, {"start": start, "end": end}).fetchall()
        if not rows:
            return pd.DataFrame(columns=["trade_date", "ts_code", "industry_l1"])
        return pd.DataFrame(rows, columns=["trade_date", "ts_code", "industry_l1"])
    except Exception as exc:  # noqa: BLE001
        logger.error("industry_map_failed", extra={"err": str(exc)})
        raise


def _upsert_feature_set(
    *,
    feature_set_id: str,
    factor_version: str,
    scheme: str,
    factor_ids: list[str],
    new_listing_min_days: int,
) -> None:
    """spec 03：INSERT ... ON CONFLICT DO NOTHING（不再 UPDATE）。

    - 预查复用机制（D-16）已在 :func:`resolve_feature_set_id` 处保证命中
      老行；走到这里若 PK 冲突说明同 ID 已存在，metadata 列保留原值即可。
    - 写入的 ``factor_ids`` text[] 由调用方保证已排序（与 builder 哈希侧、
      DB 唯一索引侧三处对齐）。
    """

    sql = text(
        """
        INSERT INTO factors.feature_sets
            (feature_set_id, factor_version, scheme, factor_ids,
             new_listing_min_days, created_at)
        VALUES
            (:feature_set_id, :factor_version, :scheme,
             CAST(:factor_ids AS text[]), :new_listing_min_days, now())
        ON CONFLICT (feature_set_id) DO NOTHING
        """
    )
    with session_scope() as session:
        session.execute(
            sql,
            {
                "feature_set_id": feature_set_id,
                "factor_version": factor_version,
                "scheme": scheme,
                "factor_ids": "{" + ",".join(f'"{f}"' for f in factor_ids) + "}",
                "new_listing_min_days": int(new_listing_min_days),
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

    # to_dict("records") 比 iterrows() 快一个数量级（百万行级别）：iterrows
    # 每行构造一个 Series 对象，开销极大（review §16）。
    present_factor_ids = [fid for fid in factor_ids if fid in matrix.columns]
    rows: list[dict[str, Any]] = []
    for r in matrix.to_dict("records"):
        feat = {
            fid: (float(r[fid]) if pd.notna(r[fid]) else None)
            for fid in present_factor_ids
        }
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
    new_listing_min_days: int,
    job_id: UUID | None = None,
    progress_callback: ProgressCallback | None = None,
) -> str:
    """构建并落库 feature_matrix；返回 feature_set_id。

    参数：
        new_listing_min_days：新股门槛（spec 03 D-11/D-12 必填，进 feature_set_id
            哈希并写入 ``factors.feature_sets.new_listing_min_days`` 列）
        progress_callback: 可选，CLI 终端进度条回调 (progress, stage) -> None
    """

    def _progress(progress: int, stage: str) -> None:
        if progress_callback is not None:
            progress_callback(progress, stage)
        if job_id is not None:
            update_progress(job_id, progress, stage=stage)

    start, end = date_range.split(":")
    if len(start) != 8 or len(end) != 8:
        raise ValueError(f"date_range must be 'YYYYMMDD:YYYYMMDD', got {date_range!r}")

    if job_id is not None and check_cancel_requested(job_id):
        raise JobCancelled
    _progress(10, "features:load")

    # spec 03：预先拉一遍 factor_ids 列表用于哈希 + 预查复用。
    # tuple(sorted(...)) 是「三处排序约定一致」的关键——builder 哈希侧、DB
    # 唯一索引（factors._factor_ids_hash(factor_ids)）侧、写入侧都依赖此排序。
    with session_scope() as _session:
        factor_ids = tuple(sorted(_load_factor_ids(_session, factor_version)))

        # 预查复用：哈希契约升级后，老 row 与新跑同逻辑元组 → 复用老 ID
        fsid, reused = resolve_feature_set_id(
            _session,
            factor_version=factor_version,
            label_scheme=label_scheme,
            new_listing_min_days=new_listing_min_days,
            factor_ids=factor_ids,
        )
    if reused:
        logger.info(
            "feature_set_reused",
            extra={
                "feature_set_id": fsid,
                "factor_version": factor_version,
                "scheme": label_scheme,
                "new_listing_min_days": int(new_listing_min_days),
            },
        )

    daily_factors = _load_daily_factors(factor_version, start, end)
    labels = _load_labels(label_scheme, start, end)
    industry_map = _load_industry_map(start, end)
    mv_map = _load_mv_map(start, end)

    # review §17：industry_map / mv_map 为空会让中性化静默退化（仅 builder 内部
    # warn 一次）。在 runner 层把「中性化输入缺失」作为独立 warn 透出到 job 日志，
    # 便于排查「job 成功但特征未中性化」。
    if industry_map.empty:
        logger.warning(
            "feature_matrix_industry_map_empty",
            extra={"date_range": date_range, "effect": "中性化退化为全市场 z-score"},
        )
    if mv_map.empty:
        logger.warning(
            "feature_matrix_mv_map_empty",
            extra={"date_range": date_range, "effect": "跳过市值中性化"},
        )

    if daily_factors.empty or labels.empty:
        logger.warning(
            "feature_matrix_inputs_empty",
            extra={
                "feature_set_id": fsid,
                "factor_version": factor_version,
                "label_scheme": label_scheme,
                "factors_rows": len(daily_factors),
                "labels_rows": len(labels),
            },
        )
        # 即便数据为空，也要写一行 feature_sets 元数据以确保 fsid 可被后续 train
        # 阶段引用（保持端到端 job 的 result_payload.feature_set_id 不悬空）。
        _upsert_feature_set(
            feature_set_id=fsid,
            factor_version=factor_version,
            scheme=label_scheme,
            factor_ids=list(factor_ids),
            new_listing_min_days=new_listing_min_days,
        )
        _progress(100, "features:empty")
        return fsid

    _progress(30, "features:compute")

    bundle = build_feature_matrix_from_frames(
        daily_factors=daily_factors,
        labels=labels,
        industry_map=industry_map,
        mv_map=mv_map if not mv_map.empty else None,
        factor_version=factor_version,
        label_scheme=label_scheme,
        new_listing_min_days=new_listing_min_days,
        factor_ids=factor_ids,
    )
    # builder 自算的 ID 与预查得到的 fsid 应一致（reused=False 时），不一致
    # 即三处排序约定破裂——以 fsid 为准并 warn，便于 surface 出来排查。
    if bundle.feature_set_id != fsid:
        logger.warning(
            "feature_set_id_mismatch_using_resolved",
            extra={"resolved": fsid, "builder": bundle.feature_set_id},
        )

    _progress(70, "features:upsert")

    _upsert_feature_set(
        feature_set_id=fsid,
        factor_version=factor_version,
        scheme=label_scheme,
        factor_ids=list(factor_ids),
        new_listing_min_days=new_listing_min_days,
    )
    n = _upsert_feature_matrix(
        feature_set_id=fsid,
        matrix=bundle.matrix,
        factor_ids=bundle.factor_ids,
    )
    logger.info(
        "feature_matrix_written",
        extra={
            "feature_set_id": fsid,
            "rows": n,
            "factor_count": len(bundle.factor_ids),
            "reused_feature_set_id": reused,
        },
    )

    _progress(100, "features:done")
    return fsid


def build_feature_matrix_inference(
    *,
    factor_version: str,
    label_scheme: str,
    date_range: str,
    new_listing_min_days: int,
    job_id: UUID | None = None,
    progress_callback: ProgressCallback | None = None,
) -> str:
    """labels-optional 构建路径：跳过 ``_load_labels``，
    最新交易日（labels 未闭合）也能写入 feature_matrix。

    与 :func:`build_feature_matrix` 共享 feature_set_id（同
    ``factor_version`` × ``label_scheme`` × ``new_listing_min_days`` ×
    ``factor_ids`` 四元组 → 同 fsid），label 列写 NULL。

    历史：spec 2026-05-29 inference-only feature_matrix；详见
    :func:`quant_pipeline.features.builder.build_feature_matrix_for_inference`
    的安全性证据。
    """

    def _progress(progress: int, stage: str) -> None:
        if progress_callback is not None:
            progress_callback(progress, stage)
        if job_id is not None:
            update_progress(job_id, progress, stage=stage)

    start, end = date_range.split(":")
    if len(start) != 8 or len(end) != 8:
        raise ValueError(f"date_range must be 'YYYYMMDD:YYYYMMDD', got {date_range!r}")

    if job_id is not None and check_cancel_requested(job_id):
        raise JobCancelled
    _progress(10, "features:load")

    with session_scope() as _session:
        factor_ids = tuple(sorted(_load_factor_ids(_session, factor_version)))
        fsid, reused = resolve_feature_set_id(
            _session,
            factor_version=factor_version,
            label_scheme=label_scheme,
            new_listing_min_days=new_listing_min_days,
            factor_ids=factor_ids,
        )
    if reused:
        logger.info(
            "feature_set_reused",
            extra={
                "feature_set_id": fsid,
                "factor_version": factor_version,
                "scheme": label_scheme,
                "new_listing_min_days": int(new_listing_min_days),
                "mode": "inference",
            },
        )

    daily_factors = _load_daily_factors(factor_version, start, end)
    industry_map = _load_industry_map(start, end)
    mv_map = _load_mv_map(start, end)

    if industry_map.empty:
        logger.warning(
            "feature_matrix_industry_map_empty",
            extra={
                "date_range": date_range,
                "effect": "中性化退化为全市场 z-score",
                "mode": "inference",
            },
        )
    if mv_map.empty:
        logger.warning(
            "feature_matrix_mv_map_empty",
            extra={
                "date_range": date_range,
                "effect": "跳过市值中性化",
                "mode": "inference",
            },
        )

    if daily_factors.empty:
        logger.warning(
            "feature_matrix_inputs_empty",
            extra={
                "feature_set_id": fsid,
                "factor_version": factor_version,
                "label_scheme": label_scheme,
                "factors_rows": 0,
                "mode": "inference",
            },
        )
        _upsert_feature_set(
            feature_set_id=fsid,
            factor_version=factor_version,
            scheme=label_scheme,
            factor_ids=list(factor_ids),
            new_listing_min_days=new_listing_min_days,
        )
        _progress(100, "features:empty")
        return fsid

    _progress(30, "features:compute")

    bundle = build_feature_matrix_for_inference(
        daily_factors=daily_factors,
        industry_map=industry_map,
        mv_map=mv_map if not mv_map.empty else None,
        factor_version=factor_version,
        label_scheme=label_scheme,
        new_listing_min_days=new_listing_min_days,
        factor_ids=factor_ids,
    )
    if bundle.feature_set_id != fsid:
        logger.warning(
            "feature_set_id_mismatch_using_resolved",
            extra={
                "resolved": fsid,
                "builder": bundle.feature_set_id,
                "mode": "inference",
            },
        )

    _progress(70, "features:upsert")

    _upsert_feature_set(
        feature_set_id=fsid,
        factor_version=factor_version,
        scheme=label_scheme,
        factor_ids=list(factor_ids),
        new_listing_min_days=new_listing_min_days,
    )
    n = _upsert_feature_matrix(
        feature_set_id=fsid,
        matrix=bundle.matrix,
        factor_ids=bundle.factor_ids,
    )
    logger.info(
        "feature_matrix_written",
        extra={
            "feature_set_id": fsid,
            "rows": n,
            "factor_count": len(bundle.factor_ids),
            "reused_feature_set_id": reused,
            "mode": "inference",
        },
    )

    _progress(100, "features:done")
    return fsid


def runner_entrypoint(job: object) -> None:
    """供 worker.dispatcher 调用。

    job.params schema（spec 03 D-11/D-12 升级后）::

        {
            "factor_version": "v1",
            "label_scheme": "strategy-aware",
            "date_range": "YYYYMMDD:YYYYMMDD",
            "new_listing_min_days": 60         # 必填，[0,250]
        }
    """

    params = getattr(job, "params", {}) or {}
    factor_version = params.get("factor_version")
    label_scheme = params.get("label_scheme")
    date_range = params.get("date_range")
    new_listing_min_days = params.get("new_listing_min_days")
    if (
        not factor_version
        or not label_scheme
        or not date_range
        or new_listing_min_days is None
    ):
        raise ValueError(
            "features job missing required params: factor_version / label_scheme / "
            f"date_range / new_listing_min_days, got {params!r}"
        )
    if not isinstance(new_listing_min_days, int) or isinstance(new_listing_min_days, bool):
        raise ValueError(
            f"new_listing_min_days must be int, got {type(new_listing_min_days).__name__}"
            f"={new_listing_min_days!r}"
        )
    job_id = getattr(job, "id", None)
    build_feature_matrix(
        factor_version=str(factor_version),
        label_scheme=str(label_scheme),
        date_range=str(date_range),
        new_listing_min_days=int(new_listing_min_days),
        job_id=job_id,
    )


__all__ = ["build_feature_matrix", "runner_entrypoint"]
