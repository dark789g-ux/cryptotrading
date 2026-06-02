"""label_scheme → avg_hold_days 映射 + Sharpe 年化系数单测（问题 #3）。

锁定：
  - resolve_avg_hold_days 对各 scheme 返回官方实现一致的持仓视界
    （fwd_5d_ret=5、dir3 家族=1、strategy-aware=10）。
  - dir3_band_epsNNNN 变体也归 1（持仓 1 日）。
  - 未知 scheme → warn + 回退 10.0（不静默）。
  - compute_portfolio_metrics 在不同 avg_hold_days 下 Sharpe 年化系数
    = sqrt(252 / avg_hold_days)，且默认（不传）仍按 10 年化（向后兼容）。
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.evaluation.portfolio import (
    _DEFAULT_AVG_HOLD_DAYS,
    compute_portfolio_metrics,
    resolve_avg_hold_days,
)


def test_resolve_fwd_5d_ret() -> None:
    # fallback.FWD_HORIZON_DAYS == 5
    assert resolve_avg_hold_days("fwd_5d_ret") == pytest.approx(5.0)


def test_resolve_dir3_schemes() -> None:
    # direction_3class.DIR3_HOLD_DAYS == 1（次日方向，持有 1 日）
    assert resolve_avg_hold_days("dir3_band") == pytest.approx(1.0)
    assert resolve_avg_hold_days("dir3_tercile") == pytest.approx(1.0)


def test_resolve_dir3_band_eps_variant() -> None:
    # dir3_band_epsNNNN 变体仍属 dir3_band 家族 → 持仓 1 日
    assert resolve_avg_hold_days("dir3_band_eps0080") == pytest.approx(1.0)


def test_resolve_strategy_aware() -> None:
    # 变长 1~20，无逐笔 hold_days 时用经验均值（沿用 _DEFAULT_AVG_HOLD_DAYS=10）
    assert resolve_avg_hold_days("strategy-aware") == pytest.approx(_DEFAULT_AVG_HOLD_DAYS)


def test_resolve_unknown_scheme_warns_and_falls_back(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING):
        got = resolve_avg_hold_days("totally-unknown-scheme")
    assert got == pytest.approx(_DEFAULT_AVG_HOLD_DAYS)
    assert any("unknown" in r.message.lower() or "未知" in r.message for r in caplog.records)


def test_resolve_none_returns_default() -> None:
    # None（上游未传）→ 默认 10，向后兼容
    assert resolve_avg_hold_days(None) == pytest.approx(_DEFAULT_AVG_HOLD_DAYS)


def _fixed_return_panel(
    n_days: int = 60, fixed_label: float = 0.001
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """构造每笔 trade 净收益恒定的面板：top_k=1、始终持有同一票、0 成本。"""

    rows_s = []
    rows_l = []
    for d in range(n_days):
        td = f"2026{1 + d // 28:02d}{1 + d % 28:02d}"
        for i in range(3):
            score = 1.0 if i == 0 else 0.0
            label = fixed_label if i == 0 else -1.0
            rows_s.append({"trade_date": td, "ts_code": f"00000{i}.SZ", "score": score})
            rows_l.append({"trade_date": td, "ts_code": f"00000{i}.SZ", "label": label})
    return pd.DataFrame(rows_s), pd.DataFrame(rows_l)


def _noisy_panel(
    n_days: int = 80, n_codes: int = 10, seed: int = 7
) -> tuple[pd.DataFrame, pd.DataFrame]:
    rng = np.random.default_rng(seed)
    rows_s, rows_l = [], []
    for d in range(n_days):
        td = f"2026{1 + d // 28:02d}{1 + d % 28:02d}"
        sig = rng.normal(size=n_codes)
        for i in range(n_codes):
            rows_s.append(
                {"trade_date": td, "ts_code": f"00000{i}.SZ", "score": float(sig[i])}
            )
            rows_l.append(
                {"trade_date": td, "ts_code": f"00000{i}.SZ", "label": float(sig[i] * 0.01)}
            )
    return pd.DataFrame(rows_s), pd.DataFrame(rows_l)


def test_sharpe_annualization_factor_scales_with_hold_days() -> None:
    """同一收益序列下，Sharpe ∝ sqrt(252 / avg_hold_days)。"""

    sc, lb = _noisy_panel()
    out1 = compute_portfolio_metrics(sc, lb, top_k=3, avg_hold_days=1.0)
    out5 = compute_portfolio_metrics(sc, lb, top_k=3, avg_hold_days=5.0)
    # 收益序列与 std 不变，仅年化系数变 → 比值应为 sqrt(1/5 ... )= sqrt(252/1)/sqrt(252/5)
    assert not np.isnan(out1["sharpe"]) and not np.isnan(out5["sharpe"])
    expected_ratio = np.sqrt(252.0 / 1.0) / np.sqrt(252.0 / 5.0)
    assert out1["sharpe"] / out5["sharpe"] == pytest.approx(expected_ratio, rel=1e-9)


def test_sharpe_uses_hold_days_value() -> None:
    """显式核对 Sharpe = mean/std * sqrt(252/avg_hold_days)。"""

    sc, lb = _noisy_panel(seed=123)
    avg_hold_days = 5.0
    out = compute_portfolio_metrics(sc, lb, top_k=3, avg_hold_days=avg_hold_days)
    returns = out["daily_returns"]
    mean = float(returns.mean())
    std = float(returns.std(ddof=1))
    expected = mean / std * np.sqrt(252.0 / avg_hold_days)
    assert out["sharpe"] == pytest.approx(expected, rel=1e-9)
    assert out["avg_hold_days"] == pytest.approx(avg_hold_days)


def test_default_avg_hold_days_is_ten() -> None:
    """不传 avg_hold_days 仍按 10 年化（向后兼容）。"""

    sc, lb = _noisy_panel(seed=99)
    out = compute_portfolio_metrics(sc, lb, top_k=3)
    assert out["avg_hold_days"] == pytest.approx(_DEFAULT_AVG_HOLD_DAYS)
    returns = out["daily_returns"]
    mean = float(returns.mean())
    std = float(returns.std(ddof=1))
    expected = mean / std * np.sqrt(252.0 / _DEFAULT_AVG_HOLD_DAYS)
    assert out["sharpe"] == pytest.approx(expected, rel=1e-9)


def test_invalid_avg_hold_days_raises() -> None:
    sc, lb = _noisy_panel()
    with pytest.raises(ValueError, match="avg_hold_days"):
        compute_portfolio_metrics(sc, lb, top_k=3, avg_hold_days=0.0)
