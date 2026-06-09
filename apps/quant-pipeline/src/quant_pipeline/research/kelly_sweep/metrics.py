"""指标聚合：从前向收益率序列计算 Kelly 相关统计量。

口径与 signal-stats.metrics.ts 严格对齐：
  - ret > 0 → win；ret < 0 → loss；ret == 0 → 计入 N，不计入 wins 或 losses
  - win_rate = wins / N（N=0 时整个 MetricResult 退化）
  - payoff_b = avg_win / |avg_loss|（任一为 None 时为 None）
  - profit_factor = sum(winRets) / |sum(lossRets)|（lossRets 为空时为 None）
  - kelly = p - (1-p)/b（payoff_b 为 None 或 ≤ 0 时为 None）

纯函数模块，不碰 DB。
"""

from __future__ import annotations

from typing import Optional, Sequence

import numpy as np

from quant_pipeline.research.kelly_sweep.types import MetricResult, TradeResult


def compute_metrics(rets: Sequence[float]) -> MetricResult:
    """从前向收益率序列计算 MetricResult。

    Parameters
    ----------
    rets:
        收益率序列，支持任意 Sequence[float]（list、tuple、numpy array 元素等）。

    Returns
    -------
    MetricResult
        N=0 时 win_rate 及后续所有字段均为 None。
    """
    n = len(rets)
    if n == 0:
        return MetricResult(
            n=0,
            wins=0,
            win_rate=None,
            avg_win=None,
            avg_loss=None,
            payoff_b=None,
            profit_factor=None,
            kelly=None,
        )

    win_rets = [r for r in rets if r > 0]
    loss_rets = [r for r in rets if r < 0]
    wins = len(win_rets)

    win_rate: float = wins / n

    avg_win: Optional[float] = sum(win_rets) / len(win_rets) if win_rets else None
    avg_loss: Optional[float] = sum(loss_rets) / len(loss_rets) if loss_rets else None

    # payoff_b 要求双侧均有数据且 avg_loss ≠ 0（avg_loss 为负，abs 即其绝对值）
    payoff_b: Optional[float]
    if avg_win is not None and avg_loss is not None and avg_loss != 0:
        payoff_b = avg_win / abs(avg_loss)
    else:
        payoff_b = None

    # profit_factor 只要求 lossRets 非空
    profit_factor: Optional[float]
    if loss_rets:
        profit_factor = sum(win_rets) / abs(sum(loss_rets))
    else:
        profit_factor = None

    # kelly: f* = p - (1-p)/b，payoff_b 须为正数
    kelly: Optional[float]
    if payoff_b is not None and payoff_b > 0:
        kelly = win_rate - (1 - win_rate) / payoff_b
    else:
        kelly = None

    return MetricResult(
        n=n,
        wins=wins,
        win_rate=win_rate,
        avg_win=avg_win,
        avg_loss=avg_loss,
        payoff_b=payoff_b,
        profit_factor=profit_factor,
        kelly=kelly,
    )


def metrics_from_trades(trades: list[TradeResult]) -> MetricResult:
    """从 TradeResult 列表提取 ret 后调用 compute_metrics 的便捷函数。

    Parameters
    ----------
    trades:
        交易结果列表；空列表返回退化的 MetricResult（n=0）。
    """
    return compute_metrics([t.ret for t in trades])


def bootstrap_kelly_ci(
    rets: Sequence[float],
    iters: int,
    seed: int | None = None,
    alpha: float = 0.05,
) -> tuple[Optional[float], Optional[float]]:
    """对 kelly 值进行 bootstrap 置信区间估计。

    有放回地重采样 iters 次，每次用 compute_metrics 计算 kelly，
    收集所有非 None 的 kelly 值，返回 (alpha/2, 1-alpha/2) 分位数。

    Parameters
    ----------
    rets:
        原始收益率序列。
    iters:
        重采样次数。
    seed:
        numpy RNG 种子；传入相同 seed 可复现结果；None 表示不固定。
    alpha:
        置信水平参数，默认 0.05 对应 2.5%/97.5% 双侧 CI。

    Returns
    -------
    (low, high) : tuple[Optional[float], Optional[float]]
        有效 kelly 数为 0 或样本为空时返回 (None, None)。
        low 对应 alpha/2 分位，high 对应 1-alpha/2 分位，恒有 low ≤ high。

    Notes
    -----
    重采样时某次可能全为盈利或全为亏损，此时 kelly=None，该次不计入分位数估计。
    若所有 iters 次的 kelly 均为 None，则返回 (None, None)。
    """
    n = len(rets)
    if n == 0:
        return (None, None)

    rng = np.random.default_rng(seed)
    arr = np.asarray(rets, dtype=float)

    kelly_samples: list[float] = []
    for _ in range(iters):
        sample = rng.choice(arr, size=n, replace=True)
        m = compute_metrics(sample.tolist())
        if m.kelly is not None:
            kelly_samples.append(m.kelly)

    if not kelly_samples:
        return (None, None)

    low = float(np.quantile(kelly_samples, alpha / 2))
    high = float(np.quantile(kelly_samples, 1 - alpha / 2))
    return (low, high)
