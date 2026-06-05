"""compute_strategy_aware_labels 的 exit_rules 入参透传单测（spec 03 §3.2）。

None → default_rules()（MAX_HOLD_DAYS=20），行为不变；显式 exit_rules 覆盖
MaxHoldRule 上限（迁移自原 max_hold_days 入参，该入参已被 exit_rules 取代）。
不连 DB / 不依赖 lightgbm / torch（纯 pandas）。
"""

from __future__ import annotations

import pandas as pd

from quant_pipeline.labels.strategy_aware import (
    MAX_HOLD_DAYS,
    LabelInputs,
    compute_strategy_aware_labels,
)


def _rising_quotes(n: int = 40) -> pd.DataFrame:
    """单调上涨（不触发止损 / MA5 跌破）→ MaxHold 主导出场。"""

    dates = [f"202401{i:02d}" for i in range(1, n + 1)]
    close = [10.0 + i * 0.5 for i in range(n)]
    return pd.DataFrame(
        {
            "ts_code": ["X"] * n,
            "trade_date": dates,
            "close": close,
            "close_adj": close,
            "low": close,
            "low_adj": close,
        }
    )


def _default_exit_rules(max_hold: int) -> list[dict]:
    """default_exit 同序规则链（止损-8% / 跌破MA5 / 最大持仓），max_hold 可覆盖。"""

    return [
        {"type": "stop_loss", "params": {"pct": 0.08}},
        {"type": "ma_break", "params": {"period": 5}},
        {"type": "max_hold", "params": {"days": max_hold}},
    ]


def test_default_max_hold_is_20() -> None:
    """exit_rules=None → default_rules()，max_hold=20。"""

    df = _rising_quotes(40)
    entries = pd.DataFrame({"ts_code": ["X"], "trade_date": ["20240102"]})
    out = compute_strategy_aware_labels(
        LabelInputs(daily_quotes=df, entries=entries, end="20240210")
    )
    assert out.iloc[0]["exit_reason"] == "max_hold"
    assert out.iloc[0]["hold_days"] == MAX_HOLD_DAYS


def test_custom_max_hold_days_via_exit_rules() -> None:
    """显式 exit_rules 的 max_hold days=10 → hold_days=10（取代原 max_hold_days 入参）。"""

    df = _rising_quotes(40)
    entries = pd.DataFrame({"ts_code": ["X"], "trade_date": ["20240102"]})
    out = compute_strategy_aware_labels(
        LabelInputs(
            daily_quotes=df,
            entries=entries,
            end="20240210",
            exit_rules=_default_exit_rules(max_hold=10),
        )
    )
    assert out.iloc[0]["exit_reason"] == "max_hold"
    assert out.iloc[0]["hold_days"] == 10
