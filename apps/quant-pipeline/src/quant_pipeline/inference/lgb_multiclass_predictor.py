# -*- coding: utf-8 -*-
"""lgb-multiclass 当日推理（spec 03 §推理路径）。

与 lgb-lambdarank / lstm 同契约：返回 ``DataFrame[ts_code, score, rank_in_day]``。

关键点（spec 03）：
  · 模型加载：lgb.Booster(model_file=model.txt)（非 torch state_dict）；
  · 当日截面（非序列）：取 trade_date 当日 feature_matrix 截面；
  · 列对齐：严格按 meta.json 的 ``feature_columns_order`` 重排（顺序错位会打分错误）；
  · score = P(涨) − P(跌)（class_order=[down,flat,up]，与 LSTM/LambdaRank 同向同口径）；
  · 缺票补 NaN + 显式 warn（禁 pad 伪装全覆盖，CLAUDE.md 静默降级禁令）；
  · rank_in_day 按 score 降序（NaN 末尾）；写库由 score_writer.write_scores
    （enforce_row_count=True）负责。

lightgbm 延迟 import（worker 启动不强依赖）。
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

_DEFAULT_CLASS_ORDER = ["down", "flat", "up"]


def predict_one_day_lgb_multiclass(
    model_version: str,
    trade_date: str,
    session: Session,
) -> pd.DataFrame:
    """lgb-multiclass 当日推理；返回 DataFrame[ts_code, score, rank_in_day]。

    不写库（与 predict_one_day / predict_one_day_lstm 一致）。

    Raises:
        ValueError:        当日 feature_matrix 截面为空 / 无法确定 feature_columns_order
        FileNotFoundError: artifact 不存在
    """

    # 复用 lgb 路径的取数/对齐/补缺工具，保持单一真理源。
    from quant_pipeline.inference.runner import (
        _attach_rank_in_day,
        _load_all_ts_codes,
        _load_daily_feature_section,
        _load_meta_json,
        _load_model_run,
        _resolve_artifact_local_path,
    )

    run_info = _load_model_run(session, model_version=model_version, model_run_id=None)
    feature_set_id = run_info["feature_set_id"]
    artifact_uri_str = run_info["artifact_uri"]
    model_path = _resolve_artifact_local_path(artifact_uri_str)
    if not model_path.exists():
        raise FileNotFoundError(
            f"artifact 不存在: {model_path}（artifact_uri={artifact_uri_str}）"
        )

    meta = _load_meta_json(model_path)
    # feature_columns_order 是推理列对齐权威（spec 03 §meta.json）；只读它，
    # 不依赖可能漂移的 feature_cols（保留时与 order 同值）。
    feature_columns = list(
        meta.get("feature_columns_order")
        or meta.get("feature_cols")
        or meta.get("feature_columns")
        or []
    )
    if not feature_columns:
        raise ValueError(
            "lgb-multiclass 推理无法确定 feature_columns_order（meta.json 为空）"
        )
    class_order = list(meta.get("class_order") or _DEFAULT_CLASS_ORDER)
    up_idx = class_order.index("up") if "up" in class_order else 2
    down_idx = class_order.index("down") if "down" in class_order else 0

    # 当日截面（按 feature_columns 顺序展平）；空截面 → ValueError（确凿缺口）。
    section = _load_daily_feature_section(
        session, feature_set_id, trade_date, feature_columns
    )
    X = section[feature_columns].to_numpy(dtype=float)

    import lightgbm as lgb

    booster = lgb.Booster(model_file=str(model_path))
    proba = np.asarray(booster.predict(X), dtype=np.float64).reshape(-1, 3)
    score = proba[:, up_idx] - proba[:, down_idx]

    out = pd.DataFrame(
        {
            "ts_code": section["ts_code"].astype(str).values,
            "score": np.asarray(score, dtype=float),
        }
    )

    # 缺票补 NaN + 显式 warn（复用 lgb 路径全量股票对齐口径）。
    all_codes = _load_all_ts_codes(session, trade_date)
    if all_codes:
        existing = set(out["ts_code"])
        missing = [c for c in all_codes if c not in existing]
        if missing:
            logger.warning(
                "inference_missing_feature_codes",
                extra={
                    "trade_date": trade_date,
                    "model_version": model_version,
                    "algorithm": "lgb-multiclass",
                    "n_scored": int(len(existing)),
                    "n_missing": len(missing),
                    "n_total_daily_quote": len(all_codes),
                    "missing_ts_codes": missing[:50],
                },
            )
            nan_rows = pd.DataFrame({"ts_code": missing, "score": np.nan})
            out = pd.concat([out, nan_rows], ignore_index=True)

    return _attach_rank_in_day(out)


__all__ = ["predict_one_day_lgb_multiclass"]
