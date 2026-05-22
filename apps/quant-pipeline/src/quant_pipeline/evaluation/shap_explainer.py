"""SHAP 解释器（M4 Part L）。

用 `shap.TreeExplainer` 对 LightGBM Booster 做 OOS 抽样解释：
  - 输入：model_run_id（从 ml.model_runs 读 artifact_uri / feature_set_id）
  - 输出：Top-20 重要因子（按 mean(|SHAP|) 排序）+ 方向（mean(SHAP) 正负）
  - 落盘：./artifacts/<model_run_id>/shap_top20.json
  - 写库：ml.model_runs.shap_uri

JSON schema：
{
    "model_run_id": "<uuid>",
    "model_version": "...",
    "n_samples": 500,
    "top20": [
        {"factor_id": "mom_20d", "mean_abs_shap": 0.0832, "mean_shap": 0.0123, "direction": "+"},
        ...
    ],
    "generated_at_utc": "..."
}

失败处理（按交付物要求）：
  - 主流程默认调用 SHAP；失败不影响主流程，写一条
    ml.quality_reports(level='warn', rule='shap_explainer_failed')
  - 本规则名已在 quality/report.py ALLOWED_RULES 中追加
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any
from uuid import UUID

import numpy as np
import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.utils.paths import resolve_artifact_local_path

logger = logging.getLogger(__name__)


DEFAULT_SAMPLE_SIZE = 500
DEFAULT_TOP_K = 20


# ----------------------------------------------------------------------
# 工具：artifact_uri → 本地 Path（评审 05-#10：实现统一到 utils.paths）
# ----------------------------------------------------------------------

# 保留旧私名做别名，兼容既有单测 `shap_explainer._resolve_artifact_local_path`
_resolve_artifact_local_path = resolve_artifact_local_path


def _load_model_run_row(model_run_id: str) -> dict[str, Any]:
    sql = text(
        """
        SELECT id, model_version, feature_set_id, artifact_uri
        FROM ml.model_runs
        WHERE id = :id
        """
    )
    with session_scope() as session:
        row = session.execute(sql, {"id": model_run_id}).mappings().first()
    if row is None:
        raise ValueError(f"ml.model_runs 找不到 id={model_run_id!r}")
    return dict(row)


def _load_sample_features(
    feature_set_id: str,
    feature_columns: list[str],
    n_samples: int,
) -> pd.DataFrame:
    """从 factors.feature_matrix 取 n_samples 行截面样本（按 trade_date desc 取最近的）。

    实际取数（评审 05-#12 修正 docstring 与实现一致）：
      SQL `ORDER BY trade_date DESC, ts_code LIMIT n_samples*3` 先取最近的
      `n_samples*3` 行候选，再随机抽 `n_samples` 行。
      注意：`LIMIT` 按行截断，最旧的那个交易日可能只取到部分股票（样本不完整）；
      SHAP 仅做因子重要性抽样估计，对截面完整性不敏感，此截断可接受。
    """

    sql = text(
        """
        SELECT trade_date, ts_code, features
        FROM factors.feature_matrix
        WHERE feature_set_id = :fs
        ORDER BY trade_date DESC, ts_code
        LIMIT :lim
        """
    )
    with session_scope() as session:
        rows = (
            session.execute(sql, {"fs": feature_set_id, "lim": n_samples * 3})
            .mappings()
            .all()
        )
    if not rows:
        raise ValueError(
            f"factors.feature_matrix 中 feature_set_id={feature_set_id!r} 为空"
        )
    records: list[dict[str, Any]] = []
    for r in rows:
        feats = dict(r["features"]) if r["features"] else {}
        rec: dict[str, Any] = {}
        for col in feature_columns:
            v = feats.get(col)
            rec[col] = float(v) if v is not None else np.nan
        records.append(rec)
    df = pd.DataFrame.from_records(records, columns=feature_columns)
    if len(df) > n_samples:
        df = df.sample(n=n_samples, random_state=42).reset_index(drop=True)
    return df


# ----------------------------------------------------------------------
# 主入口
# ----------------------------------------------------------------------


def explain(
    model_run_id: str,
    *,
    n_samples: int = DEFAULT_SAMPLE_SIZE,
    top_k: int = DEFAULT_TOP_K,
    load_model_run: Any = None,
    load_sample_features: Any = None,
    booster_loader: Any = None,
    meta_loader: Any = None,
    skip_db_write: bool = False,
) -> str:
    """对 model_run_id 跑 SHAP TreeExplainer，输出 Top-K 因子。

    Args:
        model_run_id: ml.model_runs.id (uuid 字符串)
        n_samples: 抽样行数（默认 500）
        top_k: Top-K（默认 20）
        load_model_run / load_sample_features / booster_loader / meta_loader: 测试期注入
        skip_db_write: 跳过 ml.model_runs.shap_uri 更新（单测用）

    Returns:
        shap_uri 字符串（./artifacts/<run_id>/shap_top20.json）

    Raises:
        ValueError / FileNotFoundError / ImportError
    """

    # 1) 加载 model_run 行（artifact_uri / feature_set_id）
    if load_model_run is None:
        load_model_run = _load_model_run_row
    run = load_model_run(model_run_id)
    artifact_uri_str = run["artifact_uri"]
    feature_set_id = run["feature_set_id"]
    model_version = run["model_version"]

    # 2) 加载 booster + meta
    if booster_loader is None:
        import lightgbm as lgb

        model_path = _resolve_artifact_local_path(artifact_uri_str)
        if not model_path.exists():
            raise FileNotFoundError(
                f"artifact 不存在: {model_path}（artifact_uri={artifact_uri_str}）"
            )
        booster = lgb.Booster(model_file=str(model_path))
    else:
        booster = booster_loader(artifact_uri_str)

    if meta_loader is None:
        meta_path = _resolve_artifact_local_path(artifact_uri_str)
        meta_json_path = meta_path.parent / "meta.json"
        if meta_json_path.exists():
            with meta_json_path.open("r", encoding="utf-8") as f:
                meta = json.load(f)
        else:
            meta = {}
    else:
        meta = meta_loader(artifact_uri_str)

    feature_columns: list[str] = list(
        meta.get("feature_columns_order")
        or meta.get("feature_columns")
        or getattr(booster, "feature_name", lambda: [])()
        or []
    )
    if not feature_columns:
        raise ValueError(
            "无法确定 feature_columns_order（meta.json 与 booster 均为空）"
        )

    # 3) 抽样特征
    if load_sample_features is None:
        load_sample_features = _load_sample_features
    X_sample = load_sample_features(feature_set_id, feature_columns, n_samples)
    # 兼容：返回 DataFrame 或 ndarray
    if isinstance(X_sample, pd.DataFrame):
        X_arr = X_sample[feature_columns].to_numpy(dtype=float)
    else:
        X_arr = np.asarray(X_sample, dtype=float)

    actual_n = int(X_arr.shape[0])
    if actual_n == 0:
        raise ValueError("SHAP 抽样后样本数为 0")

    # 4) 跑 SHAP TreeExplainer
    import shap  # type: ignore[import-untyped]

    explainer = shap.TreeExplainer(booster)
    raw_shap = explainer.shap_values(X_arr)
    # LightGBM regression / lambdarank 返回 2D；分类可能返回 list
    if isinstance(raw_shap, list):
        # 多类：取均值合并；本任务只有 ranking / regression，正常走 else
        shap_values = np.mean(np.stack(raw_shap, axis=0), axis=0)
    else:
        shap_values = np.asarray(raw_shap, dtype=float)
    if shap_values.ndim != 2 or shap_values.shape[1] != len(feature_columns):
        raise ValueError(
            f"SHAP 输出形状异常: got {shap_values.shape}, "
            f"expected ({actual_n}, {len(feature_columns)})"
        )

    mean_abs = np.mean(np.abs(shap_values), axis=0)
    mean_signed = np.mean(shap_values, axis=0)

    # 取 Top-K
    order = np.argsort(-mean_abs)[:top_k]
    top: list[dict[str, Any]] = []
    for idx in order:
        top.append(
            {
                "factor_id": feature_columns[int(idx)],
                "mean_abs_shap": float(mean_abs[idx]),
                "mean_shap": float(mean_signed[idx]),
                "direction": "+" if float(mean_signed[idx]) >= 0 else "-",
            }
        )

    # 5) 落盘
    shap_uri = _write_shap_artifact(
        model_run_id=str(model_run_id),
        model_version=str(model_version),
        artifact_uri_str=artifact_uri_str,
        top_k=top_k,
        n_samples=actual_n,
        top=top,
    )

    # 6) 写库
    if not skip_db_write:
        _update_model_run_shap_uri(str(model_run_id), shap_uri)

    logger.info(
        "shap_explainer_done",
        extra={
            "model_run_id": str(model_run_id),
            "top1": top[0]["factor_id"] if top else None,
            "shap_uri": shap_uri,
        },
    )
    return shap_uri


def _write_shap_artifact(
    *,
    model_run_id: str,
    model_version: str,
    artifact_uri_str: str,
    top_k: int,
    n_samples: int,
    top: list[dict[str, Any]],
) -> str:
    """落 shap_top20.json 在 model_run artifact 目录下，返回 POSIX 风格 shap_uri。"""

    local_path = _resolve_artifact_local_path(artifact_uri_str)
    parent = local_path.parent
    parent.mkdir(parents=True, exist_ok=True)
    shap_path = parent / "shap_top20.json"

    payload = {
        "model_run_id": model_run_id,
        "model_version": model_version,
        "n_samples": n_samples,
        "top_k": top_k,
        "top20": top,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
    }
    with shap_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    # 还原 POSIX 风格 uri：artifact_uri/parent + shap_top20.json
    p = PurePosixPath(artifact_uri_str)
    parent_uri = "/".join(p.parts[:-1])
    if not parent_uri.startswith("."):
        parent_uri = "./" + parent_uri.lstrip("/")
    return f"{parent_uri}/shap_top20.json"


def _update_model_run_shap_uri(model_run_id: str, shap_uri: str) -> None:
    sql = text(
        """
        UPDATE ml.model_runs
        SET shap_uri = :uri
        WHERE id = :id
        """
    )
    with session_scope() as session:
        session.execute(sql, {"uri": shap_uri, "id": model_run_id})


# ----------------------------------------------------------------------
# 训练 runner 后置钩子（with_shap=True 时调用，失败不阻塞主流程）
# ----------------------------------------------------------------------


def safely_explain_after_train(
    model_run_id: str | UUID,
    *,
    trade_date: str | None = None,
    job_id: UUID | None = None,
) -> str | None:
    """训练 runner 末尾调用：失败时写 quality_reports(rule='shap_explainer_failed') 不抛。"""

    try:
        return explain(str(model_run_id))
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "shap_explainer_failed",
            extra={"model_run_id": str(model_run_id), "err": str(exc)},
        )
        # 写一条 quality_reports；trade_date 用 today 或传入值
        from quant_pipeline.worker.progress import warn_with_quality_report

        td = trade_date or datetime.now(timezone.utc).strftime("%Y%m%d")
        try:
            warn_with_quality_report(
                rule="shap_explainer_failed",
                trade_date=td,
                detail={
                    "model_run_id": str(model_run_id),
                    "error": str(exc)[:500],
                },
                level="warn",
                job_id=job_id,
            )
        except Exception as exc2:  # noqa: BLE001
            logger.warning(
                "shap_failed_report_write_failed",
                extra={"err": str(exc2)},
            )
        return None


__all__ = [
    "DEFAULT_SAMPLE_SIZE",
    "DEFAULT_TOP_K",
    "explain",
    "safely_explain_after_train",
]
