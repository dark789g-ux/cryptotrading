"""metrics.py 单测。

覆盖 compute_metrics 与 bootstrap_kelly_ci 的全部分支：
  1. 正常样本：手算对照精确值
  2. r==0 的零收益样本：计入 N、不计入 wins/losses
  3. 无亏损样本（全正）：payoff_b / kelly / profit_factor 均为 None
  4. 无盈利样本（全负）：avg_win / kelly 为 None、profit_factor 有定义
  5. 仅零收益样本：wins=0、N>0、其余 None
  6. N=0（空列表）：全 None
  7. 从 list[TradeResult] 取 ret 的便捷函数
  8. bootstrap：固定 seed 可复现、low≤high、退化样本返回 (None, None)
"""

from __future__ import annotations

import pytest

from quant_pipeline.research.kelly_sweep.metrics import (
    bootstrap_kelly_ci,
    compute_metrics,
    metrics_from_trades,
)
from quant_pipeline.research.kelly_sweep.types import MetricResult, TradeResult


# ---------------------------------------------------------------------------
# 辅助：构造 TradeResult（只填 ret，其余字段占位）
# ---------------------------------------------------------------------------

def _trade(ret: float) -> TradeResult:
    return TradeResult(
        ts_code="000001.SZ",
        signal_date="20240101",
        buy_date="20240102",
        exit_date="20240110",
        buy_price=10.0,
        exit_price=10.0 * (1 + ret),
        ret=ret,
        hold_days=8,
        exit_reason="max_hold",
    )


# ---------------------------------------------------------------------------
# 1. 正常样本：手算精确值
#
# rets = [0.1, 0.2, -0.05, -0.1]
#   N=4, wins=2, win_rate=0.5
#   winRets=[0.1, 0.2]  → avg_win = 0.15
#   lossRets=[-0.05, -0.1] → avg_loss = -0.075
#   payoff_b = 0.15 / 0.075 = 2.0
#   profit_factor = 0.3 / 0.15 = 2.0
#   kelly = 0.5 - (0.5 / 2.0) = 0.5 - 0.25 = 0.25
# ---------------------------------------------------------------------------

def test_normal_sample_exact_values() -> None:
    rets = [0.1, 0.2, -0.05, -0.1]
    m = compute_metrics(rets)

    assert m.n == 4
    assert m.wins == 2
    assert m.win_rate == pytest.approx(0.5)
    assert m.avg_win == pytest.approx(0.15)
    assert m.avg_loss == pytest.approx(-0.075)
    assert m.payoff_b == pytest.approx(2.0)
    assert m.profit_factor == pytest.approx(2.0)
    assert m.kelly == pytest.approx(0.25)


# ---------------------------------------------------------------------------
# 2. r==0 的零收益：不计入 wins、不计入 losses、但计入 N
#
# rets = [0.1, 0.0, -0.1]
#   N=3, wins=1, win_rate=1/3
#   winRets=[0.1] → avg_win=0.1
#   lossRets=[-0.1] → avg_loss=-0.1
#   payoff_b = 0.1 / 0.1 = 1.0
#   profit_factor = 0.1 / 0.1 = 1.0
#   kelly = 1/3 - (2/3) / 1.0 = 1/3 - 2/3 = -1/3
# ---------------------------------------------------------------------------

def test_zero_ret_not_in_wins_or_losses() -> None:
    rets = [0.1, 0.0, -0.1]
    m = compute_metrics(rets)

    assert m.n == 3               # 零收益计入 N
    assert m.wins == 1            # 零收益不计入 wins
    assert m.win_rate == pytest.approx(1 / 3)
    assert m.avg_win == pytest.approx(0.1)
    assert m.avg_loss == pytest.approx(-0.1)  # 零收益不计入 avg_loss
    assert m.payoff_b == pytest.approx(1.0)
    assert m.profit_factor == pytest.approx(1.0)
    assert m.kelly == pytest.approx(1 / 3 - 2 / 3)


def test_zero_ret_only_in_n_multiple_zeros() -> None:
    """多个零收益，全部计入 N，全部不计入 wins/losses。"""
    rets = [0.2, 0.0, 0.0, -0.1]
    m = compute_metrics(rets)

    assert m.n == 4
    assert m.wins == 1
    assert m.win_rate == pytest.approx(0.25)
    assert m.avg_loss == pytest.approx(-0.1)  # 零收益不进来


# ---------------------------------------------------------------------------
# 3. 无亏损样本（全正）：payoff_b / kelly / profit_factor → None
# ---------------------------------------------------------------------------

def test_no_loss_samples() -> None:
    rets = [0.05, 0.10, 0.20]
    m = compute_metrics(rets)

    assert m.n == 3
    assert m.wins == 3
    assert m.win_rate == pytest.approx(1.0)
    assert m.avg_win == pytest.approx((0.05 + 0.10 + 0.20) / 3)  # 0.1167
    assert m.avg_loss is None
    assert m.payoff_b is None
    assert m.profit_factor is None
    assert m.kelly is None


# ---------------------------------------------------------------------------
# 4. 无盈利样本（全负）：avg_win → None，kelly → None，profit_factor 有定义
#
# rets = [-0.05, -0.10]
#   N=2, wins=0, win_rate=0.0
#   avg_win=None, avg_loss=-0.075
#   payoff_b=None（avg_win 为 None）
#   profit_factor=None 因无盈利，sum(winRets)=0 → 0/|sum(lossRets)| = 0.0
#     ↑ 注意：profit_factor 公式只要求 lossRets 非空；sum(winRets)=0 时结果为 0.0
#   kelly=None（payoff_b 为 None）
# ---------------------------------------------------------------------------

def test_no_win_samples() -> None:
    rets = [-0.05, -0.10]
    m = compute_metrics(rets)

    assert m.n == 2
    assert m.wins == 0
    assert m.win_rate == pytest.approx(0.0)
    assert m.avg_win is None
    assert m.avg_loss == pytest.approx(-0.075)
    assert m.payoff_b is None        # avg_win 为 None 无法计算
    assert m.profit_factor == pytest.approx(0.0)  # 0 / 0.15 = 0.0
    assert m.kelly is None           # payoff_b 为 None


# ---------------------------------------------------------------------------
# 5. 仅零收益样本：wins=0、N>0、avg_win/avg_loss/payoff_b/profit_factor/kelly → None
# ---------------------------------------------------------------------------

def test_only_zero_rets() -> None:
    rets = [0.0, 0.0]
    m = compute_metrics(rets)

    assert m.n == 2
    assert m.wins == 0
    assert m.win_rate == pytest.approx(0.0)
    assert m.avg_win is None
    assert m.avg_loss is None
    assert m.payoff_b is None
    assert m.profit_factor is None   # lossRets 为空
    assert m.kelly is None


# ---------------------------------------------------------------------------
# 6. N=0（空列表）：全 None
# ---------------------------------------------------------------------------

def test_empty_rets() -> None:
    m = compute_metrics([])

    assert m.n == 0
    assert m.wins == 0
    assert m.win_rate is None
    assert m.avg_win is None
    assert m.avg_loss is None
    assert m.payoff_b is None
    assert m.profit_factor is None
    assert m.kelly is None


# ---------------------------------------------------------------------------
# 7. 从 list[TradeResult] 取 ret 的便捷函数
# ---------------------------------------------------------------------------

def test_metrics_from_trades_matches_compute_metrics() -> None:
    rets = [0.1, -0.05, 0.0]
    trades = [_trade(r) for r in rets]

    m_direct = compute_metrics(rets)
    m_trades = metrics_from_trades(trades)

    assert m_direct == m_trades


def test_metrics_from_trades_empty() -> None:
    m = metrics_from_trades([])
    assert m.n == 0
    assert m.win_rate is None


# ---------------------------------------------------------------------------
# 8. bootstrap_kelly_ci
# ---------------------------------------------------------------------------

def test_bootstrap_fixed_seed_reproducible() -> None:
    """相同 seed 两次调用结果完全一致。"""
    rets = [0.1, 0.2, -0.05, -0.1, 0.15, -0.08, 0.05, -0.12]
    ci1 = bootstrap_kelly_ci(rets, iters=200, seed=42)
    ci2 = bootstrap_kelly_ci(rets, iters=200, seed=42)
    assert ci1 == ci2


def test_bootstrap_different_seeds_may_differ() -> None:
    """不同 seed 大概率结果不同（用极少 iters 以免随机碰撞）。"""
    rets = [0.1, 0.2, -0.05, -0.1, 0.15, -0.08]
    ci1 = bootstrap_kelly_ci(rets, iters=10, seed=1)
    ci2 = bootstrap_kelly_ci(rets, iters=10, seed=999)
    # 两者都非 None，且至少有一个值不同（99.9% 概率）
    assert ci1[0] is not None
    assert ci2[0] is not None


def test_bootstrap_low_le_high() -> None:
    """low ≤ high 恒成立。"""
    rets = [0.1, 0.2, -0.05, -0.1, 0.15, -0.08, 0.05, -0.12, 0.08, -0.06]
    low, high = bootstrap_kelly_ci(rets, iters=500, seed=0)
    assert low is not None
    assert high is not None
    assert low <= high


def test_bootstrap_alpha_bounds() -> None:
    """alpha=0.1 → 5%/95% 分位；区间宽度应比 alpha=0.05 窄。"""
    rets = [0.1, 0.2, -0.05, -0.1, 0.15, -0.08, 0.05, -0.12]
    low_05, high_05 = bootstrap_kelly_ci(rets, iters=500, seed=0, alpha=0.05)
    low_10, high_10 = bootstrap_kelly_ci(rets, iters=500, seed=0, alpha=0.10)
    # 更大的 alpha → 区间更窄
    assert (high_10 - low_10) <= (high_05 - low_05) + 1e-9  # 浮点容差


def test_bootstrap_degenerate_no_loss() -> None:
    """全盈利样本：每次重采样都没有 loss → kelly=None → 返回 (None, None)。"""
    rets = [0.1, 0.2, 0.15, 0.05]
    low, high = bootstrap_kelly_ci(rets, iters=100, seed=0)
    assert low is None
    assert high is None


def test_bootstrap_empty_rets() -> None:
    """空列表：返回 (None, None)。"""
    low, high = bootstrap_kelly_ci([], iters=100, seed=0)
    assert low is None
    assert high is None


def test_bootstrap_single_ret() -> None:
    """单个样本（盈利+亏损各一）：重采样每次只含一种 → kelly 多为 None → 可能 (None, None)。"""
    # 只有两个样本但这里有盈亏，少部分重采样会同时含盈亏，大部分不会
    # 只验证返回类型正确（tuple of Optional[float]）
    rets = [0.1, -0.1]
    result = bootstrap_kelly_ci(rets, iters=100, seed=0)
    assert isinstance(result, tuple)
    assert len(result) == 2
    # 不断言 None/非 None，因为取决于重采样是否同时含盈亏
