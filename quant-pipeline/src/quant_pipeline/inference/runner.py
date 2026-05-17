# -*- coding: utf-8 -*-
"""inference runner —— predict_one_day + worker.dispatcher 入口（M2 Part B）。

顺序（spec 04 §2 推理前必检 + m2 验收要求）：
  1. 推理前必检：调 quality.report.gate_check(trade_date, mode='inference_pregate', strict=True)
     失败抛 QualityGateBlocked；**不允许**任何 ml.scores_daily 行写入当日
  2. 从 ml.model_runs 取 artifact_uri，加载 model.txt（POSIX 相对路径还原为本地 Path）
  3. 加载同目录 meta.json，取 feature_columns_order（spec Part B 列顺序契约）
  4. 从 factors.feature_matrix 取当日截面（feature_set_id 由 model_runs 关联）
  5. 预测得分 → 调 score_writer.write_scores 做严格行数校验 + upsert ml.scores_daily

job.params schema（01-pg-schema §4.1）：
    {
        "model_version": "lgb-lambdarank-v1-20260620-seed42",
        "date":          "20260517",
        # 可选：CLI 通过 model_run_id 反查 model_version
        "model_run_id":  "<uuid>"
    }
"""

from __future__ import annotations

import json
import logging
from pathlib import Path, PurePosixPath
from typing import Any
from uuid import UUID

import numpy as np
import pandas as pd
from sqlalchemy import text
from sqlalchemy.orm import Session

from quant_pipeline.db.engine import session_scope
from quant_pipeline.inference.score_writer import write_scores
from quant_pipeline.quality.report import gate_check
from quant_pipeline.utils.paths import artifact_root
from quant_pipeline.worker.progress import update_progress

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# 工具：artifact_uri 还原本地 Path
# ----------------------------------------------------------------------


def _resolve_artifact_local_path(artifact_uri_str: str) -> Path:
    """把入库的 POSIX 相对路径 `./artifacts/<uuid>/model.txt` 还原为本地绝对 Path。

    artifact_root() 已封装 ARTIFACT_DIR 环境变量与默认值。
    """

    p = PurePosixPath(artifact_uri_str)
    parts = p.parts
    if parts and parts[0] in (".", "artifacts"):
        idx = 0
        while idx < len(parts) and parts[idx] in (".", "artifacts"):
            idx += 1
        rel_parts = parts[idx:]
    else:
        rel_parts = parts
    return artifact_root().joinpath(*rel_parts)


def _load_model_run(session: Session, *, model_version: str | None, model_run_id: str | None) -> dict[str, Any]:
    """按 model_version 或 model_run_id 取一条 ml.model_runs。"""

    if not model_version and not model_run_id:
        raise ValueError("必须提供 model_version 或 model_run_id 之一")
    if model_version:
        sql = text(
            """
            SELECT id, model_version, feature_set_id, artifact_uri
            FROM ml.model_runs
            WHERE model_version = :mv
            LIMIT 1
            """
        )
        row = session.execute(sql, {"mv": model_version}).mappings().first()
    else:
        sql = text(
            """
            SELECT id, model_version, feature_set_id, artifact_uri
            FROM ml.model_runs
            WHERE id = :rid
            LIMIT 1
            """
        )
        row = session.execute(sql, {"rid": model_run_id}).mappings().first()
    if row is None:
        raise ValueError(
            f"ml.model_runs 未命中：model_version={model_version!r}, model_run_id={model_run_id!r}"
        )
    return dict(row)


def _load_meta_json(model_path: Path) -> dict[str, Any]:
    """读取与 model.txt 同目录的 meta.json，拿 feature_columns_order。"""

    meta_path = model_path.parent / "meta.json"
    if not meta_path.exists():
        raise FileNotFoundError(f"meta.json 不存在: {meta_path}")
    with meta_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _load_daily_feature_section(
    session: Session,
    feature_set_id: str,
    trade_date: str,
    feature_columns: list[str],
) -> pd.DataFrame:
    """取当日 feature_set 截面，展平 features 为列；按 ts_code 升序。"""

    sql = text(
        """
        SELECT ts_code, features
        FROM factors.feature_matrix
        WHERE feature_set_id = :fs AND trade_date = :td
        ORDER BY ts_code
        """
    )
    rows = session.execute(sql, {"fs": feature_set_id, "td": trade_date}).mappings().all()
    if not rows:
        raise ValueError(
            f"factors.feature_matrix 中 feature_set_id={feature_set_id!r} "
            f"trade_date={trade_date!r} 当日为空"
        )

    records: list[dict[str, Any]] = []
    for r in rows:
        feats = dict(r["features"]) if r["features"] else {}
        rec: dict[str, Any] = {"ts_code": r["ts_code"]}
        for col in feature_columns:
            v = feats.get(col)
            rec[col] = float(v) if v is not None else np.nan
        records.append(rec)
    return pd.DataFrame.from_records(records, columns=["ts_code", *feature_columns])


# ----------------------------------------------------------------------
# predict_one_day —— spec Part B 明确入口
# ----------------------------------------------------------------------


def predict_one_day(
    model_version: str,
    trade_date: str,
    session: Session,
    *,
    feature_columns_override: list[str] | None = None,
) -> pd.DataFrame:
    """加载模型 + 当日特征 → 预测；返回 DataFrame[ts_code, score, rank_in_day]。

    本函数仅做"读 + 预测 + 排名计算"，不写库；写库由 score_writer.write_scores 负责，
    便于 unit test 单独 mock 任一阶段。

    Args:
        model_version: 必填，ml.model_runs.model_version
        trade_date:    YYYYMMDD
        session:       SQLAlchemy Session（外部事务上下文）
        feature_columns_override: 可选；调试场景下覆盖 meta.json 的列顺序

    Returns:
        DataFrame，列 [ts_code, score, rank_in_day]（按 score desc 排序）

    Raises:
        ValueError / FileNotFoundError 见各分支说明
    """

    run_info = _load_model_run(session, model_version=model_version, model_run_id=None)
    feature_set_id = run_info["feature_set_id"]
    artifact_uri_str = run_info["artifact_uri"]
    model_path = _resolve_artifact_local_path(artifact_uri_str)
    if not model_path.exists():
        raise FileNotFoundError(
            f"artifact 不存在: {model_path}（artifact_uri={artifact_uri_str}）"
        )

    # 延迟 import（与训练共用），避免 worker 启动时强依赖 lightgbm
    import lightgbm as lgb

    booster = lgb.Booster(model_file=str(model_path))
    meta = _load_meta_json(model_path)
    feature_columns = list(
        feature_columns_override
        or meta.get("feature_columns_order")
        or meta.get("feature_columns")
        or booster.feature_name()
        or []
    )
    if not feature_columns:
        raise ValueError("无法确定 feature_columns_order（meta.json 与 booster 均为空）")

    section = _load_daily_feature_section(session, feature_set_id, trade_date, feature_columns)
    X = section[feature_columns].to_numpy(dtype=float)
    scores = booster.predict(X)

    out = pd.DataFrame(
        {
            "ts_code": section["ts_code"].astype(str).values,
            "score": np.asarray(scores, dtype=float),
        }
    )
    # 计算 rank_in_day（按 score desc）并按 rank 排序
    out = _attach_rank_in_day(out)
    return out


def _attach_rank_in_day(df: pd.DataFrame) -> pd.DataFrame:
    """按 score desc 排名；同分用 method='first' 保证整数 1..N 唯一。"""

    if df.empty:
        out = df.copy()
        out["rank_in_day"] = pd.Series([], dtype=int)
        return out
    n = len(df)
    asc_rank = df["score"].rank(method="first", ascending=True).astype(int)
    out = df.assign(rank_in_day=(n + 1 - asc_rank).astype(int))
    return out.sort_values("score", ascending=False).reset_index(drop=True)


# ----------------------------------------------------------------------
# 主流程：必检 → 预测 → 严格行数校验 + 写库
# ----------------------------------------------------------------------


def run_inference(
    *,
    model_version: str,
    trade_date: str,
    job_id: UUID | None = None,
) -> int:
    """完整推理流程；返回写入 ml.scores_daily 的行数。

    Raises:
        QualityGateBlocked: 推理前必检失败（dispatcher 写 status='blocked'）
        ScoreRowCountMismatch: 预测结果与 raw.daily_quote 行数不一致
        ValueError / FileNotFoundError 见各分支
    """

    if len(trade_date) != 8 or not trade_date.isdigit():
        raise ValueError(f"trade_date 必须是 YYYYMMDD，got {trade_date!r}")

    if job_id is not None:
        update_progress(job_id, 0, stage="infer:start")

    # 1) 推理前必检（spec 04 §2 硬约束；不允许任何半量写入）
    gate_check(trade_date, mode="inference_pregate", strict=True, job_id=job_id)
    if job_id is not None:
        update_progress(job_id, 20, stage="infer:quality_passed")

    # 2) 预测 + 3) 写库 共用同一 session 事务
    with session_scope() as session:
        df = predict_one_day(model_version, trade_date, session)
        if job_id is not None:
            update_progress(job_id, 70, stage="infer:scored")
        written = write_scores(
            df,
            model_version=model_version,
            trade_date=trade_date,
            session=session,
            enforce_row_count=True,
        )

    if job_id is not None:
        update_progress(job_id, 100, stage="infer:done")

    logger.info(
        "infer_done",
        extra={
            "model_version": model_version,
            "trade_date": trade_date,
            "written": written,
        },
    )
    return written


def runner_entrypoint(job: Any) -> None:
    """worker.dispatcher 入口。解析 job.params → run_inference。"""

    params = getattr(job, "params", {}) or {}
    model_version = params.get("model_version")
    trade_date = params.get("date")
    model_run_id = params.get("model_run_id")

    # 通过 model_run_id 反查 model_version（CLI 友好；spec CLI 即支持 --run-id）
    if not model_version and model_run_id:
        with session_scope() as session:
            row = session.execute(
                text("SELECT model_version FROM ml.model_runs WHERE id = :id"),
                {"id": model_run_id},
            ).first()
        if row is None:
            raise ValueError(f"ml.model_runs 找不到 model_run_id={model_run_id!r}")
        model_version = str(row[0])

    if not isinstance(model_version, str) or not model_version:
        raise ValueError(
            f"infer job.params.model_version 必须是非空字符串，got {model_version!r}"
        )
    if (
        not isinstance(trade_date, str)
        or len(trade_date) != 8
        or not trade_date.isdigit()
    ):
        raise ValueError(
            f"infer job.params.date 必须是 YYYYMMDD 字符串，got {trade_date!r}"
        )

    run_inference(
        model_version=model_version,
        trade_date=trade_date,
        job_id=getattr(job, "id", None),
    )


__all__ = [
    "predict_one_day",
    "run_inference",
    "runner_entrypoint",
]
