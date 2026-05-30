"""PSI（Population Stability Index）工具函数。

从 quality/monitor.py 拆出的纯计算工具。
"""

from __future__ import annotations

import numpy as np

PSI_WARN_THRESHOLD = 0.25
PSI_CRITICAL_THRESHOLD = 0.5
IC_DROP_RATIO = 0.5  # 滚动 IC < 训练期 IC × 0.5 → critical
IC_ROLLING_WINDOW = 20


def compute_psi(
    train_values: np.ndarray,
    curr_values: np.ndarray,
    *,
    n_bins: int = 10,
) -> tuple[float, list[dict[str, float | None]]]:
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

    def _edge(x: float) -> float | None:
        # ±inf 写进 jsonb 是非法 JSON（06-quality.md 问题 17）：首尾哨兵边界
        # 用 None 表示「无界」，避免 json.dumps 产出 Infinity 这种非法字面量。
        return float(x) if np.isfinite(x) else None

    bins_detail = [
        {
            "bin_id": int(i),
            "edge_lo": _edge(edges[i]),
            "edge_hi": _edge(edges[i + 1]),
            "train_pct": float(train_pct[i]),
            "curr_pct": float(curr_pct[i]),
        }
        for i in range(len(train_pct))
    ]
    return psi, bins_detail


def psi_level(psi: float) -> str | None:
    """PSI 阈值 → level；NaN / < 0.25 返回 None（不写 quality_reports）。"""

    if np.isnan(psi):
        return None
    if psi > PSI_CRITICAL_THRESHOLD:
        return "critical"
    if psi > PSI_WARN_THRESHOLD:
        return "warn"
    return None


def safe_skew(arr: np.ndarray) -> float:
    arr = arr[~np.isnan(arr)]
    if arr.size < 3:
        return float("nan")
    m = float(np.mean(arr))
    sd = float(np.std(arr))
    if sd < 1e-12:
        return 0.0
    return float(np.mean(((arr - m) / sd) ** 3))
