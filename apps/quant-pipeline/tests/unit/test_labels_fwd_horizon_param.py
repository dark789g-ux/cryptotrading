"""compute_fwd_5d_ret 的 fwd_horizon_days 入参透传单测（spec 02 §标签参数透传）。

默认 horizon=5 时行为与改动前完全一致；horizon=3/10 时 hold_days 与 shift 行数随之变化。
不连 DB / 不依赖 lightgbm / torch（纯 pandas）。
"""

from __future__ import annotations

import pandas as pd

from quant_pipeline.labels.fallback import FWD_HORIZON_DAYS, FallbackInputs, compute_fwd_5d_ret


def _quotes(n: int = 12) -> pd.DataFrame:
    dates = [f"2024{1:02d}{i:02d}" for i in range(1, n + 1)]
    return pd.DataFrame(
        {"ts_code": ["X"] * n, "trade_date": dates, "close_adj": [10.0 + i for i in range(n)]}
    )


def test_default_horizon_unchanged() -> None:
    df = _quotes(12)
    out = compute_fwd_5d_ret(FallbackInputs(daily_quotes=df))
    assert (out["hold_days"] == FWD_HORIZON_DAYS).all()
    assert len(out) == 12 - FWD_HORIZON_DAYS
    # value at t0 = close[5]/close[0] - 1 = 15/10 - 1
    assert abs(out.iloc[0]["value"] - (15.0 / 10.0 - 1)) < 1e-9


def test_none_equals_default() -> None:
    df = _quotes(12)
    a = compute_fwd_5d_ret(FallbackInputs(daily_quotes=df))
    b = compute_fwd_5d_ret(FallbackInputs(daily_quotes=df), fwd_horizon_days=None)
    assert len(a) == len(b)
    assert (b["hold_days"] == FWD_HORIZON_DAYS).all()


def test_horizon_3() -> None:
    df = _quotes(12)
    out = compute_fwd_5d_ret(FallbackInputs(daily_quotes=df), fwd_horizon_days=3)
    assert (out["hold_days"] == 3).all()
    assert len(out) == 12 - 3
    assert abs(out.iloc[0]["value"] - (13.0 / 10.0 - 1)) < 1e-9


def test_horizon_10() -> None:
    df = _quotes(12)
    out = compute_fwd_5d_ret(FallbackInputs(daily_quotes=df), fwd_horizon_days=10)
    assert (out["hold_days"] == 10).all()
    assert len(out) == 12 - 10
