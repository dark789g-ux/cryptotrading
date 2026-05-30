# -*- coding: utf-8 -*-
"""sequence_builder —— feature_matrix 宽表 → LSTM 序列样本。

实现设计 spec：
  docs/superpowers/specs/2026-05-30-lstm-quant-module-design/01-data-and-labels.md §3
  docs/superpowers/specs/2026-05-30-lstm-quant-module-design/02-python-training.md §3

契约（T3 lstm_walk_forward / T4 inference 依赖，禁止改签名）：

    @dataclass(frozen=True)
    class SequenceBundle:
        X: np.ndarray          # (N样本, L, Nfeat) float32
        y: np.ndarray          # (N样本,)         int64  类别 0/1/2
        index: pd.DataFrame    # 列 [ts_code, trade_date]，与 X/y 行对齐
        feature_cols: list[str]

    def build_sequences(df, lookback, feature_cols) -> SequenceBundle

核心规则（防泄漏 / 防串窗，见 spec §3 硬约束）：
  · 窗口只在同一 ts_code 内取，绝不跨股票拼接；
  · 连续性按该票在 feature_matrix 内**实际出现的 trade_date 相邻位置**判定
    （停牌 / 非交易日不算断裂，不依赖自然日差）——窗口取该票最近 L 个有数据的交易日；
  · 仅生成有完整连续 L 行的样本，不足 L 丢弃；
  · 因子列顺序固定（与训练时一致，由调用方传入 feature_cols 并存入 meta.json）；
  · 含 NaN 的样本（特征或标签）丢弃 + logger.warning 计数；
  · 标签整数护栏：label 非空值必须等于其取整且 ⊆ {0,1,2}，否则 ValueError
    （防误配连续标签如 fwd_5d_ret 被 .astype(int) 静默截断）。

本模块不依赖 torch（纯 numpy / pandas）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

_VALID_CLASSES = frozenset({0, 1, 2})


@dataclass(frozen=True)
class SequenceBundle:
    """build_sequences 输出。X/y/index 三者行对齐，feature_cols 为列顺序。"""

    X: np.ndarray          # (N, L, Nfeat) float32
    y: np.ndarray          # (N,) int64，类别 0/1/2
    index: pd.DataFrame    # 列 [ts_code, trade_date]
    feature_cols: list[str]


def _validate_label_integers(label: pd.Series) -> None:
    """标签整数护栏（spec 02 §3「标签整数护栏」）。

    feature_matrix.label 是浮点列；三分类存 {0.0, 1.0, 2.0}。若用户误把 lstm
    配了连续标签方案（如 fwd_5d_ret，label 是收益率浮点），`.astype(int)` 会
    **静默截断**成乱码类别。因此在构造序列前显式校验所有非空 label：
    必须等于其取整值且落在 {0,1,2}，否则 ValueError（禁止静默截断，CLAUDE.md）。
    """

    lbl = label.dropna().to_numpy(dtype=float)
    if lbl.size == 0:
        # 无任何有效标签：交由下游样本数门禁兜底，此处不护栏越界
        return
    rounded = np.round(lbl)
    if not np.allclose(lbl, rounded) or not set(rounded.astype(int)) <= _VALID_CLASSES:
        uniq = sorted({float(v) for v in lbl})[:10]
        raise ValueError(
            "LSTM 三分类要求 label 为整数类别 {0,1,2}；"
            "检测到非整数 / 越界值（可能误配了连续标签方案，如 fwd_5d_ret）。"
            f"unique(前10)={uniq}"
        )


def build_sequences(
    df: pd.DataFrame,
    lookback: int,
    feature_cols: list[str],
) -> SequenceBundle:
    """按 ts_code 分组、按 trade_date 升序滑窗，构造 LSTM 序列样本。

    Args:
        df: 宽表，列须含 [trade_date, ts_code, *feature_cols, label]。
            label 为浮点类别（{0.0,1.0,2.0}）；连续标签会被整数护栏拒绝。
        lookback: 序列窗口长度 L（交易日）。
        feature_cols: N 个因子列名，顺序即喂入 LSTM 的特征维顺序（固定，存 meta）。

    Returns:
        SequenceBundle(X(N,L,Nfeat) float32, y(N,) int64, index[ts_code,trade_date],
                       feature_cols)

    Raises:
        ValueError: lookback < 1 / 缺列 / 标签非整数越界。
    """

    if lookback < 1:
        raise ValueError(f"lookback 必须 >= 1，got {lookback}")
    if not feature_cols:
        raise ValueError("feature_cols 不能为空")

    required = {"trade_date", "ts_code", "label", *feature_cols}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"df 缺少必需列：{sorted(missing)}")

    # 列顺序固定：显式取 feature_cols 顺序，不依赖 df 列物理顺序
    feature_cols = list(feature_cols)

    # 标签整数护栏（在任何 astype(int) 之前）
    _validate_label_integers(df["label"])

    n_feat = len(feature_cols)
    x_blocks: list[np.ndarray] = []
    y_vals: list[int] = []
    idx_codes: list[object] = []
    idx_dates: list[object] = []

    dropped_nan = 0  # 含 NaN（特征或标签）被丢弃的样本计数

    # 按 ts_code 分组，组内按 trade_date 升序——窗口绝不跨 ts_code
    for ts_code, grp in df.groupby("ts_code", sort=False):
        grp = grp.sort_values("trade_date", kind="stable")
        # 该票实际出现的交易日序列（去重保序）；连续性按相邻位置判定，
        # 同一 trade_date 若重复（不应发生）stable 排序后取首次出现位置
        feats = grp[feature_cols].to_numpy(dtype=np.float64)
        labels = grp["label"].to_numpy(dtype=np.float64)
        dates = grp["trade_date"].to_numpy()
        n_rows = len(grp)
        if n_rows < lookback:
            continue
        # 滑窗：窗口 = 该票最近 L 个有数据的交易日（相邻位置即连续，
        # 停牌/非交易日不在该票行内出现，故位置相邻天然代表"连续交易日"）。
        # 目标行 = 窗口末行 (位置 j)；窗口为 [j-L+1 .. j]。
        for j in range(lookback - 1, n_rows):
            start = j - lookback + 1
            win = feats[start : j + 1]  # (L, Nfeat)
            y_lbl = labels[j]
            if np.isnan(y_lbl):
                # 末行无 t+1 标签被 shift 丢弃属正常（spec 01 §2），非数据质量缺陷，
                # 直接跳过且不计 NaN-drop（避免把正常无标签行伪装成数据残缺告警）。
                continue
            if np.isnan(win).any():
                # feature_matrix 已做截面中位数填充；窗口内仍有 NaN → 数据缺陷，
                # 丢弃 + 计数（下方统一 logger.warning）。
                dropped_nan += 1
                continue
            x_blocks.append(win)
            y_vals.append(int(round(float(y_lbl))))
            idx_codes.append(ts_code)
            idx_dates.append(dates[j])

    if dropped_nan:
        logger.warning(
            "sequence_builder_dropped_nan_samples",
            extra={"dropped": dropped_nan, "lookback": lookback},
        )

    if x_blocks:
        X = np.stack(x_blocks, axis=0).astype(np.float32, copy=False)
    else:
        X = np.empty((0, lookback, n_feat), dtype=np.float32)
    y = np.asarray(y_vals, dtype=np.int64)
    index = pd.DataFrame({"ts_code": idx_codes, "trade_date": idx_dates})

    return SequenceBundle(X=X, y=y, index=index, feature_cols=feature_cols)


__all__ = ["SequenceBundle", "build_sequences"]
