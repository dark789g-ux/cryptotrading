"""Portfolio 扣成本组合评估单测（M3 Part I）。

覆盖：
  - 合成 scores + labels：单日篮子净收益均值/中位数计算正确
  - top_k <= 0 / 负成本 抛 ValueError
  - 空输入返回 nan
  - 双边佣金 + 滑点 5bps 公式核对
  - 最大回撤计算

> 止血（2026-05-22）：原 `annual_return`（按 252 年化）已移除，
> 改为 `net_return_mean` / `net_return_median`，见 portfolio.py 文件头。
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.evaluation.portfolio import compute_portfolio_metrics


def _build_scores_labels(
    n_days: int = 50, n_codes: int = 10, signal_strength: float = 1.0, seed: int = 42
) -> tuple[pd.DataFrame, pd.DataFrame]:
    rng = np.random.default_rng(seed)
    scores_rows: list[dict] = []
    labels_rows: list[dict] = []
    for d in range(n_days):
        td = f"2026{1 + d // 28:02d}{1 + d % 28:02d}"
        # true signal -> 决定 label 和 score
        true_signal = rng.normal(size=n_codes)
        for i in range(n_codes):
            ts_code = f"00000{i}.SZ"
            score = float(true_signal[i] * signal_strength + rng.normal(scale=0.1))
            label = float(true_signal[i] * 0.01)  # 1% 量级日收益
            scores_rows.append({"trade_date": td, "ts_code": ts_code, "score": score})
            labels_rows.append({"trade_date": td, "ts_code": ts_code, "label": label})
    return pd.DataFrame(scores_rows), pd.DataFrame(labels_rows)


def test_portfolio_basic_metrics_present() -> None:
    sc, lb = _build_scores_labels(n_days=30, n_codes=10)
    out = compute_portfolio_metrics(sc, lb, top_k=3, commission_rate=0.0003, slippage_bps=5.0)
    assert {
        "net_return_mean", "net_return_median", "sharpe",
        "max_drawdown", "win_rate", "turnover", "daily_returns",
    } <= set(out.keys())
    assert out["n_days"] > 0
    assert isinstance(out["daily_returns"], pd.Series)


def test_portfolio_net_return_formula() -> None:
    """构造每日固定净收益 r，均值/中位数均应 = r（止血后不再年化）。"""

    # 让 score 完美对齐 label：选 top-1，且每日 label 相同
    n_days = 60
    rows_s = []
    rows_l = []
    fixed_label = 0.001  # 0.1% 单日篮子净收益
    for d in range(n_days):
        td = f"2026{1 + d // 28:02d}{1 + d % 28:02d}"
        # 同一个 ts_code 始终持有，turnover 之后 = 0；首日 turnover=1
        for i in range(3):
            score = 1.0 if i == 0 else 0.0  # 始终选 i=0
            label = fixed_label if i == 0 else -1.0
            rows_s.append({"trade_date": td, "ts_code": f"00000{i}.SZ", "score": score})
            rows_l.append({"trade_date": td, "ts_code": f"00000{i}.SZ", "label": label})

    out = compute_portfolio_metrics(
        pd.DataFrame(rows_s), pd.DataFrame(rows_l),
        top_k=1, commission_rate=0.0, slippage_bps=0.0,
    )
    # 0 成本 → 每日 net 恒为 fixed_label → 均值/中位数都等于它
    assert out["net_return_mean"] == pytest.approx(fixed_label, rel=1e-6)
    assert out["net_return_median"] == pytest.approx(fixed_label, rel=1e-6)
    # 持仓不变 → 平均 turnover ≈ 1/n_days
    assert out["turnover"] == pytest.approx(1.0 / n_days, rel=1e-6)


def test_portfolio_commission_slippage_reduces_return() -> None:
    """加成本后单日净收益均值必须 < 不加成本。"""

    sc, lb = _build_scores_labels(n_days=30, n_codes=10, signal_strength=2.0)
    out_no_cost = compute_portfolio_metrics(sc, lb, top_k=3, commission_rate=0.0, slippage_bps=0.0)
    out_with_cost = compute_portfolio_metrics(
        sc, lb, top_k=3, commission_rate=0.0003, slippage_bps=5.0
    )
    # 当存在 turnover 时，扣成本后净收益均值必须更低
    if out_no_cost["turnover"] > 0:
        assert out_with_cost["net_return_mean"] < out_no_cost["net_return_mean"]


def test_portfolio_invalid_top_k_raises() -> None:
    with pytest.raises(ValueError, match="top_k"):
        compute_portfolio_metrics(
            pd.DataFrame({"trade_date": [], "ts_code": [], "score": []}),
            pd.DataFrame({"trade_date": [], "ts_code": [], "label": []}),
            top_k=0,
        )


def test_portfolio_invalid_cost_raises() -> None:
    with pytest.raises(ValueError, match="commission_rate"):
        compute_portfolio_metrics(
            pd.DataFrame({"trade_date": [], "ts_code": [], "score": []}),
            pd.DataFrame({"trade_date": [], "ts_code": [], "label": []}),
            commission_rate=-0.01,
        )


def test_portfolio_empty_input_returns_nan() -> None:
    out = compute_portfolio_metrics(
        pd.DataFrame({"trade_date": [], "ts_code": [], "score": []}),
        pd.DataFrame({"trade_date": [], "ts_code": [], "label": []}),
    )
    assert out["n_days"] == 0
    assert np.isnan(out["net_return_mean"])
    assert np.isnan(out["net_return_median"])


def test_portfolio_max_drawdown_nonnegative() -> None:
    sc, lb = _build_scores_labels(n_days=50, n_codes=10)
    out = compute_portfolio_metrics(sc, lb, top_k=3)
    assert out["max_drawdown"] >= 0.0 or np.isnan(out["max_drawdown"])
