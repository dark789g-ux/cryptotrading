# -*- coding: utf-8 -*-
"""LSTM 当日推理（M3 LSTM 接入 · T4）。

实现设计 spec：
  docs/superpowers/specs/2026-05-30-lstm-quant-module-design/03-inference.md

职责：与 lgb 的 ``inference.runner.predict_one_day`` 同契约，返回
``DataFrame[ts_code, score, rank_in_day]``，但走 torch state_dict + L 天序列窗口。

关键差异（spec 03 §1）：
  1. 模型加载：torch ``model.pt`` state_dict + ``meta.json`` 重建 DirectionLSTM，
     非 ``lgb.Booster``；
  2. 输入窗口：每只票需 ``[trade_date−L+1 .. trade_date]`` 共 L 个**有数据交易日**
     的特征序列（停牌/非交易日不算），而非单日截面 → 按 ts_code 滑窗。

排序分定义（spec 03 §3）：
    logits → softmax → [P(跌), P(横盘), P(涨)]   # class_order=[down,flat,up]
    score = P(涨) − P(跌) ∈ [−1, 1]              # 越大越看多，与 LambdaRank 同向

取数 / 缺失约束（spec 03 §4）：
  · "最近 L 个交易日"按 feature_matrix 实际存在的 trade_date 取，不按自然日；
  · 某票窗口内交易日数 < L → 无法构造序列 → 计入 missing，score=NaN + 显式 warn
    （禁止 pad 假序列伪装"全覆盖"，CLAUDE.md 静默降级禁令）；
  · 当日 feature_matrix 截面为空 → ValueError（确凿缺口）。

torch 延迟 import（worker 启动不强依赖 torch）。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


# 与 meta.json class_order=[down, flat, up] 一致（spec 02 §6 / 03 §3）。
_DOWN_IDX = 0
_UP_IDX = 2
_DEFAULT_CLASS_ORDER = ["down", "flat", "up"]


def _load_window_trade_dates(
    session: Session,
    feature_set_id: str,
    trade_date: str,
    lookback: int,
) -> list[str]:
    """取该 feature_set 下 trade_date 及其之前最近 L 个**有数据交易日**。

    按 feature_matrix 实际存在的 trade_date 取（停牌/非交易日不算），降序取 L 个后
    升序返回。目标日 trade_date 必须在结果内，否则当日截面为空 → 上游抛 ValueError。
    """

    sql = text(
        """
        SELECT DISTINCT trade_date
        FROM factors.feature_matrix
        WHERE feature_set_id = :fs AND trade_date <= :td
        ORDER BY trade_date DESC
        LIMIT :lim
        """
    )
    rows = session.execute(
        sql, {"fs": feature_set_id, "td": trade_date, "lim": int(lookback)}
    ).scalars().all()
    dates = sorted(str(r) for r in rows)
    return dates


def _load_window_feature_matrix(
    session: Session,
    feature_set_id: str,
    window_dates: list[str],
    feature_cols: list[str],
) -> pd.DataFrame:
    """取窗口内全部 (ts_code, trade_date) 的特征，展平 features jsonb 为列。

    返回长表，列 [ts_code, trade_date, *feature_cols]；缺失因子值填 NaN（交由
    sequence_builder 的 NaN 样本丢弃逻辑处理）。
    """

    sql = text(
        """
        SELECT ts_code, trade_date, features
        FROM factors.feature_matrix
        WHERE feature_set_id = :fs AND trade_date = ANY(:tds)
        ORDER BY ts_code, trade_date
        """
    )
    rows = session.execute(
        sql, {"fs": feature_set_id, "tds": list(window_dates)}
    ).mappings().all()

    records: list[dict[str, Any]] = []
    for r in rows:
        feats = dict(r["features"]) if r["features"] else {}
        rec: dict[str, Any] = {
            "ts_code": str(r["ts_code"]),
            "trade_date": str(r["trade_date"]),
        }
        for col in feature_cols:
            v = feats.get(col)
            rec[col] = float(v) if v is not None else np.nan
        records.append(rec)
    return pd.DataFrame.from_records(
        records, columns=["ts_code", "trade_date", *feature_cols]
    )


def _build_model(meta: dict[str, Any], model_path: Path, input_size: int) -> Any:
    """按 meta.json 结构超参重建 DirectionLSTM 并 load_state_dict（torch 延迟 import）。"""

    import torch

    from quant_pipeline.training.lstm_model import DirectionLSTM

    model = DirectionLSTM(
        input_size=input_size,
        hidden_size=int(meta.get("hidden_size", 128)),
        num_layers=int(meta.get("num_layers", 2)),
        dropout=float(meta.get("dropout", 0.2)),
    )
    state_dict = torch.load(str(model_path), map_location="cpu")
    model.load_state_dict(state_dict)
    model.eval()
    return model


def _forward_scores(model: Any, X: np.ndarray, class_order: list[str]) -> np.ndarray:
    """前向 → softmax → score = P(涨) − P(跌)（torch 延迟 import）。

    Args:
        X: (N, L, Nfeat) float32
        class_order: meta.json class_order，定位 up/down 概率列索引
    Returns:
        (N,) float，score = P(up) − P(down)
    """

    import torch

    down_idx = class_order.index("down") if "down" in class_order else _DOWN_IDX
    up_idx = class_order.index("up") if "up" in class_order else _UP_IDX

    with torch.no_grad():
        logits = model(torch.from_numpy(np.asarray(X, dtype=np.float32)))
        probs = torch.softmax(logits, dim=1).cpu().numpy()
    return (probs[:, up_idx] - probs[:, down_idx]).astype(float)


def predict_one_day_lstm(
    model_version: str,
    trade_date: str,
    session: Session,
) -> pd.DataFrame:
    """LSTM 当日推理；返回 DataFrame[ts_code, score, rank_in_day]，与 lgb 同契约。

    不写库（与 ``predict_one_day`` 一致，写库由 score_writer.write_scores 负责）。

    Raises:
        ValueError:        当日 feature_matrix 截面为空 / 无法确定 feature_cols
        FileNotFoundError: artifact 不存在
    """

    # 1) model_run → feature_set_id / artifact_uri
    from quant_pipeline.inference.runner import (
        _attach_rank_in_day,
        _load_all_ts_codes,
        _load_meta_json,
        _load_model_run,
        _resolve_artifact_local_path,
    )

    run_info = _load_model_run(
        session, model_version=model_version, model_run_id=None
    )
    feature_set_id = run_info["feature_set_id"]
    artifact_uri_str = run_info["artifact_uri"]
    model_path = _resolve_artifact_local_path(artifact_uri_str)
    if not model_path.exists():
        raise FileNotFoundError(
            f"artifact 不存在: {model_path}（artifact_uri={artifact_uri_str}）"
        )

    # 2) meta.json：lookback L、feature_cols 顺序、class_order
    meta = _load_meta_json(model_path)
    feature_cols = list(
        meta.get("feature_cols")
        or meta.get("feature_columns_order")
        or meta.get("feature_columns")
        or []
    )
    if not feature_cols:
        raise ValueError("LSTM 推理无法确定 feature_cols（meta.json 为空）")
    lookback = int(meta.get("lookback", 0))
    if lookback < 1:
        raise ValueError(f"LSTM 推理 meta.json lookback 非法: {lookback!r}")
    class_order = list(meta.get("class_order") or _DEFAULT_CLASS_ORDER)

    # 4) 读 L 天窗口特征（按 feature_matrix 实际存在的交易日取，不按自然日）
    window_dates = _load_window_trade_dates(
        session, feature_set_id, trade_date, lookback
    )
    if trade_date not in window_dates:
        # 当日截面为空 → 确凿缺口，与 lgb 路径 _load_daily_feature_section 一致抛错
        raise ValueError(
            f"factors.feature_matrix 中 feature_set_id={feature_set_id!r} "
            f"trade_date={trade_date!r} 当日为空"
        )

    panel = _load_window_feature_matrix(
        session, feature_set_id, window_dates, feature_cols
    )

    # 5) 按 ts_code 构造结尾于 trade_date 的序列（复用 sequence_builder 滑窗）。
    #    sequence_builder 需 label 列；推理无标签 → 填 0（合法类别，仅占位，不参与计算）。
    scored = _build_end_of_day_sequences(
        panel, trade_date, lookback, feature_cols
    )

    out_rows: list[dict[str, Any]] = []
    if scored is not None:
        seq_codes, X = scored
        # 6) 前向 → softmax → score = P(涨) − P(跌)
        scores = _forward_scores(_build_model(meta, model_path, len(feature_cols)), X, class_order)
        for code, sc in zip(seq_codes, scores):
            out_rows.append({"ts_code": str(code), "score": float(sc)})

    out = pd.DataFrame(out_rows, columns=["ts_code", "score"])

    # 7) 缺失票补 NaN + 显式 warn（复用现有 inference_missing_feature_codes 模式）
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
                    "algorithm": "lstm",
                    "lookback": lookback,
                    "n_scored": int(len(existing)),
                    "n_missing": len(missing),
                    "n_total_daily_quote": len(all_codes),
                    "missing_ts_codes": missing[:50],
                },
            )
            nan_rows = pd.DataFrame({"ts_code": missing, "score": np.nan})
            out = pd.concat([out, nan_rows], ignore_index=True)

    # 8) rank_in_day 按 score desc（NaN 排末尾，复用 score_writer.compute_rank_in_day）
    return _attach_rank_in_day(out)


def _build_end_of_day_sequences(
    panel: pd.DataFrame,
    trade_date: str,
    lookback: int,
    feature_cols: list[str],
) -> tuple[list[str], np.ndarray] | None:
    """按 ts_code 构造**结尾于 trade_date** 的 L 长序列。

    复用 sequence_builder.build_sequences 的滑窗 + NaN 丢弃 + 连续性判定逻辑，
    再筛 index.trade_date == trade_date 的样本（每票至多一条）。推理无标签，
    填占位 label=0（合法类别，不参与 score 计算）。

    Returns:
        (ts_codes, X(N,L,Nfeat)) ；无任何完整序列时返回 None。
    """

    if panel.empty:
        return None

    from quant_pipeline.training.sequence_builder import build_sequences

    work = panel.copy()
    work["label"] = 0  # 推理占位标签（合法类别 0，不影响前向）

    bundle = build_sequences(work, lookback, feature_cols)
    if bundle.X.shape[0] == 0:
        return None

    idx = bundle.index
    mask = idx["trade_date"].astype(str) == str(trade_date)
    if not mask.any():
        return None

    sel = np.asarray(mask.to_numpy())
    X = bundle.X[sel]
    ts_codes = [str(c) for c in idx.loc[mask, "ts_code"].tolist()]
    return ts_codes, X


__all__ = ["predict_one_day_lstm"]
