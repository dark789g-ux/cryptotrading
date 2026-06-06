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
from quant_pipeline.features.builder import (
    FACTOR_CLIP_SIGMA as _BUILDER_FACTOR_CLIP_SIGMA,
)
from quant_pipeline.features.feature_set_hash import (  # spec 02 §哈希方案 A
    apply_overlay_to_feature_set_id,
    build_overlay,
)
from quant_pipeline.labels.strategy_aware import (
    WINSORIZE_HI as _LABEL_WINSORIZE_HI,
)
from quant_pipeline.labels.strategy_aware import (
    WINSORIZE_LO as _LABEL_WINSORIZE_LO,
)
from quant_pipeline.labels_features_incremental import (
    gap_subranges,
    query_materialized_dates,
    query_trading_days,
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
    neutralize_cols: tuple[str, ...] | None = None,
    robust_z: bool | None = None,
    factor_clip_sigma: float | None = None,
    label_winsorize: tuple[float, float] | None = None,
    force_recompute: bool = False,
    job_id: UUID | None = None,
    progress_callback: ProgressCallback | None = None,
) -> str:
    """构建并落库 feature_matrix；返回 feature_set_id。

    参数：
        new_listing_min_days：新股门槛（spec 03 D-11/D-12 必填，进 feature_set_id
            哈希并写入 ``factors.feature_sets.new_listing_min_days`` 列）
        neutralize_cols/robust_z：spec 02 §特征参数透传。None → 用 builder 默认
            （``DEFAULT_NEUTRALIZE_COLS`` / ``DEFAULT_ROBUST_Z``）。这两项**已被
            builder.build_feature_set_id 纳入基础层哈希**，故非默认值通过基础层
            自然产生不同 id（不进覆盖层，避免双重影响）。
        factor_clip_sigma/label_winsorize：spec 02 §特征/标签参数透传。None → 用
            builder 默认（``FACTOR_CLIP_SIGMA`` / labels WINSORIZE_LO/HI）。这两项
            **不在基础层哈希**，由 feature_set_hash.build_overlay 按方案 A 纳入覆盖层
            （仅非默认值入哈希；全默认 → 最终 id == 基础 id == 改动前 id，回归红线）。
        progress_callback: 可选，CLI 终端进度条回调 (progress, stage) -> None
    """

    # None → 取 builder / labels 单一真理源默认（保证不传时行为完全不变）。
    eff_neutralize_cols = (
        DEFAULT_NEUTRALIZE_COLS if neutralize_cols is None else tuple(neutralize_cols)
    )
    eff_robust_z = DEFAULT_ROBUST_Z if robust_z is None else bool(robust_z)
    eff_factor_clip_sigma = (
        _BUILDER_FACTOR_CLIP_SIGMA if factor_clip_sigma is None else float(factor_clip_sigma)
    )
    eff_label_winsorize = (
        (_LABEL_WINSORIZE_LO, _LABEL_WINSORIZE_HI)
        if label_winsorize is None
        else (float(label_winsorize[0]), float(label_winsorize[1]))
    )

    # 方案 A 覆盖层：仅 factor_clip_sigma / label_winsorize（neutralize_cols / robust_z
    # 已在基础层）。fwd_horizon_days / max_hold_days 是标签阶段参数，由 train_e2e
    # 透传给 compute_labels；它们影响的是 factors.labels 数值，而 feature_set_id 的
    # 基础层 scheme 串已区分（dir3_band_epsNNNN 等），此处覆盖层只纳入对 feature_matrix
    # 数值有直接影响、且基础层未覆盖的两项。
    overlay = build_overlay(
        label_scheme=label_scheme,
        factor_clip_sigma=factor_clip_sigma,
        label_winsorize=label_winsorize,
    )

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

        # 预查复用：哈希契约升级后，老 row 与新跑同逻辑元组 → 复用老 ID。
        # neutralize_cols / robust_z 进基础层（与 builder 一致）：非默认值 → 基础 id 不同
        # → resolve 不会误命中默认配置的老行。
        base_fsid, reused = resolve_feature_set_id(
            _session,
            factor_version=factor_version,
            label_scheme=label_scheme,
            new_listing_min_days=new_listing_min_days,
            factor_ids=factor_ids,
            neutralize_cols=eff_neutralize_cols,
            robust_z=eff_robust_z,
        )

    # 方案 A 覆盖层：覆盖层为空 → fsid == base_fsid（回归红线，命中历史缓存）；
    # 覆盖层非空 → 折出新 id，且**不复用**老行（这是真正的新配置）。
    fsid = apply_overlay_to_feature_set_id(base_fsid, overlay)
    if overlay and fsid != base_fsid:
        reused = False
        logger.info(
            "feature_set_overlay_applied",
            extra={
                "base_feature_set_id": base_fsid,
                "feature_set_id": fsid,
                "overlay": overlay,
            },
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

    # -----------------------------------------------------------------------
    # 增量缺口：确定要算的子区间（force=True → 整段；False → 差集缺口）
    # -----------------------------------------------------------------------
    if force_recompute:
        subranges: list[tuple[str, str]] = [(start, end)]
        trading_days: list[str] = []  # force 路径不需要
    else:
        with session_scope() as _inc_session:
            trading_days = query_trading_days(_inc_session, start, end)
            fm_materialized = query_materialized_dates(
                _inc_session,
                "factors.feature_matrix",
                "feature_set_id",
                fsid,
                start,
                end,
            )
            labels_materialized = query_materialized_dates(
                _inc_session,
                "factors.labels",
                "scheme",
                label_scheme,
                start,
                end,
            )
        subranges = gap_subranges(fm_materialized, trading_days)
        labels_covered_set = labels_materialized  # set[str]

    skipped_days_count = len(trading_days) - sum(
        # trading_days 只在 force=False 时有意义；force=True 时 trading_days=[]
        1
        for g0, g1 in subranges
        for d in trading_days
        if g0 <= d <= g1
    ) if not force_recompute else 0

    if not force_recompute:
        logger.info(
            "feature_matrix_incremental_gaps",
            extra={
                "feature_set_id": fsid,
                "total_trading_days": len(trading_days),
                "skipped": skipped_days_count,
                "gap_subranges": subranges,
            },
        )

    if not subranges:
        logger.info(
            "feature_matrix_skipped_all",
            extra={
                "feature_set_id": fsid,
                "skipped": skipped_days_count,
                "reason": "all trading days already materialized",
            },
        )
        _upsert_feature_set(
            feature_set_id=fsid,
            factor_version=factor_version,
            scheme=label_scheme,
            factor_ids=list(factor_ids),
            new_listing_min_days=new_listing_min_days,
        )
        _progress(100, "features:done")
        return fsid

    _progress(30, "features:compute")

    # -----------------------------------------------------------------------
    # 每个缺口子区间独立算（零 padding：features 无跨日依赖）
    # -----------------------------------------------------------------------
    total_written = 0
    for gap_idx, (g0, g1) in enumerate(subranges):
        # ★ ⊆labels 覆盖校验：缺口内哪些天 labels 未覆盖
        if not force_recompute:
            gap_days_in_range = [d for d in trading_days if g0 <= d <= g1]
            missing_label_days = [d for d in gap_days_in_range if d not in labels_covered_set]
            if missing_label_days:
                logger.warning(
                    f"features_missing_labels: scheme={label_scheme!r}，"
                    f"缺口 ({g0},{g1}) 内 labels 未覆盖的天={missing_label_days}，跳过这些天",
                    extra={
                        "apiName": "features_missing_labels",
                        "scheme": label_scheme,
                        "gap": (g0, g1),
                        "dates": missing_label_days,
                    },
                )
                # 仅算 labels 已覆盖的连续子段
                covered_days_in_gap = [d for d in gap_days_in_range if d in labels_covered_set]
                if not covered_days_in_gap:
                    # 全部未覆盖，跳过整个缺口
                    continue
                # 按 labels 覆盖天切出连续子段（零 padding 不变）
                covered_subranges = gap_subranges(
                    set(missing_label_days),  # missing 作为"已物化"跳过集合
                    gap_days_in_range,
                )
                for cg0, cg1 in covered_subranges:
                    daily_factors = _load_daily_factors(factor_version, cg0, cg1)
                    labels_df = _load_labels(label_scheme, cg0, cg1)
                    industry_map = _load_industry_map(cg0, cg1)
                    mv_map = _load_mv_map(cg0, cg1)
                    if industry_map.empty:
                        logger.warning(
                            "feature_matrix_industry_map_empty",
                            extra={"date_range": f"{cg0}:{cg1}", "effect": "中性化退化为全市场 z-score"},
                        )
                    if mv_map.empty:
                        logger.warning(
                            "feature_matrix_mv_map_empty",
                            extra={"date_range": f"{cg0}:{cg1}", "effect": "跳过市值中性化"},
                        )
                    if daily_factors.empty or labels_df.empty:
                        logger.warning(
                            "feature_matrix_inputs_empty",
                            extra={
                                "feature_set_id": fsid,
                                "factor_version": factor_version,
                                "label_scheme": label_scheme,
                                "factors_rows": len(daily_factors),
                                "labels_rows": len(labels_df),
                                "gap": (cg0, cg1),
                            },
                        )
                        continue
                    bundle = build_feature_matrix_from_frames(
                        daily_factors=daily_factors,
                        labels=labels_df,
                        industry_map=industry_map,
                        mv_map=mv_map if not mv_map.empty else None,
                        factor_version=factor_version,
                        label_scheme=label_scheme,
                        new_listing_min_days=new_listing_min_days,
                        factor_ids=factor_ids,
                        neutralize_cols=eff_neutralize_cols,
                        robust_z=eff_robust_z,
                        factor_clip_sigma=eff_factor_clip_sigma,
                        label_winsorize=eff_label_winsorize,
                    )
                    if bundle.feature_set_id != base_fsid:
                        logger.warning(
                            "feature_set_id_mismatch_using_resolved",
                            extra={"resolved": base_fsid, "builder": bundle.feature_set_id},
                        )
                    n = _upsert_feature_matrix(
                        feature_set_id=fsid,
                        matrix=bundle.matrix,
                        factor_ids=bundle.factor_ids,
                    )
                    total_written += n
                    logger.info(
                        "feature_matrix_written",
                        extra={
                            "feature_set_id": fsid,
                            "rows": n,
                            "factor_count": len(bundle.factor_ids),
                            "gap": (cg0, cg1),
                        },
                    )
                continue  # 已处理含缺失天的缺口，进入下一个 gap

        # 正常路径：整个缺口 labels 均已覆盖（或 force_recompute=True）
        # 零 padding：加载区间 == 缺口子区间
        daily_factors = _load_daily_factors(factor_version, g0, g1)
        labels_df = _load_labels(label_scheme, g0, g1)
        industry_map = _load_industry_map(g0, g1)
        mv_map = _load_mv_map(g0, g1)

        # review §17：industry_map / mv_map 为空会让中性化静默退化
        if industry_map.empty:
            logger.warning(
                "feature_matrix_industry_map_empty",
                extra={"date_range": f"{g0}:{g1}", "effect": "中性化退化为全市场 z-score"},
            )
        if mv_map.empty:
            logger.warning(
                "feature_matrix_mv_map_empty",
                extra={"date_range": f"{g0}:{g1}", "effect": "跳过市值中性化"},
            )

        if daily_factors.empty or labels_df.empty:
            logger.warning(
                "feature_matrix_inputs_empty",
                extra={
                    "feature_set_id": fsid,
                    "factor_version": factor_version,
                    "label_scheme": label_scheme,
                    "factors_rows": len(daily_factors),
                    "labels_rows": len(labels_df),
                    "gap": (g0, g1),
                },
            )
            _upsert_feature_set(
                feature_set_id=fsid,
                factor_version=factor_version,
                scheme=label_scheme,
                factor_ids=list(factor_ids),
                new_listing_min_days=new_listing_min_days,
            )
            continue

        bundle = build_feature_matrix_from_frames(
            daily_factors=daily_factors,
            labels=labels_df,
            industry_map=industry_map,
            mv_map=mv_map if not mv_map.empty else None,
            factor_version=factor_version,
            label_scheme=label_scheme,
            new_listing_min_days=new_listing_min_days,
            factor_ids=factor_ids,
            # spec 02 §特征参数透传：eff_* 已在上方按 None→默认归一，行为不变。
            neutralize_cols=eff_neutralize_cols,
            robust_z=eff_robust_z,
            factor_clip_sigma=eff_factor_clip_sigma,
            label_winsorize=eff_label_winsorize,
        )
        # builder 自算的 ID 是**基础层** ID（不含覆盖层），应与预查得到的 base_fsid 一致
        # （reused=False 时）；不一致即三处排序约定破裂——warn 便于 surface 排查。
        if bundle.feature_set_id != base_fsid:
            logger.warning(
                "feature_set_id_mismatch_using_resolved",
                extra={"resolved": base_fsid, "builder": bundle.feature_set_id},
            )

        n = _upsert_feature_matrix(
            feature_set_id=fsid,
            matrix=bundle.matrix,
            factor_ids=bundle.factor_ids,
        )
        total_written += n
        logger.info(
            "feature_matrix_written",
            extra={
                "feature_set_id": fsid,
                "rows": n,
                "factor_count": len(bundle.factor_ids),
                "gap": (g0, g1),
                "reused_feature_set_id": reused,
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

    logger.info(
        "feature_matrix_computed",
        extra={
            "feature_set_id": fsid,
            "total_rows_written": total_written,
            "gap_subranges": subranges,
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
    force_recompute = bool(params.get("force_recompute", False))
    build_feature_matrix(
        factor_version=str(factor_version),
        label_scheme=str(label_scheme),
        date_range=str(date_range),
        new_listing_min_days=int(new_listing_min_days),
        force_recompute=force_recompute,
        job_id=job_id,
    )


__all__ = ["build_feature_matrix", "runner_entrypoint"]
