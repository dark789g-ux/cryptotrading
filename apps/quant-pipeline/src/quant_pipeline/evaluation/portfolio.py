"""扣成本年化（M3 评估层）。

> doc/量化/05-LightGBM训练体系.md §5.7 三层评估指标：
>   "成本后：扣单边 0.15% 手续费 + 0.15% 冲击 → 年化仍 > 沪深 300 + 10%"
> spec m3 §3：本任务命名为 `portfolio_annual_after_cost`，默认双边佣金 0.0003 + 滑点 5bps。

模拟策略（最简形式）：
  1) 每日按预测分数选 Top-K 等权持仓
  2) 第 T+1 日按 label（视为 T 日选股的实际净收益率）结算
  3) 与前一日持仓求 turnover；按 turnover * (commission_rate_two_side + slippage_rate) 扣成本
  4) daily_return = mean(top_k labels) - turnover_cost
  5) 输出年化（按 252 个交易日年化）/ Sharpe / 最大回撤 / 胜率 / 平均换手

公式（与 spec / doc/05 §5.7 对齐）：
  - 双边佣金 commission_rate = 0.0003（默认；调用方可配）
  - 滑点 slippage_bps = 5 → slippage_rate = 0.0005
  - 单边交易成本 ≈ commission_rate + slippage_rate（已含双边语义；commission 已设为双边）
  - 实际 turnover_cost_per_day = turnover * (commission_rate + slippage_rate)
  - annual_return = (1 + mean_daily_net) ** 252 - 1
  - Sharpe = mean_daily_net / std_daily_net * sqrt(252)
  - max_drawdown = max((cummax(equity) - equity) / cummax(equity))

scores_df / label_df 输入约定：
  scores_df: 含列 [trade_date, ts_code, score]
  label_df:  含列 [trade_date, ts_code, label]
  注意：label 视为"当日选股 → 持有到下个交易日的净收益率"，调用方负责对齐 PIT。
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


_TRADING_DAYS_PER_YEAR = 252


def compute_portfolio_metrics(
    scores_df: pd.DataFrame,
    label_df: pd.DataFrame,
    *,
    top_k: int = 20,
    commission_rate: float = 0.0003,
    slippage_bps: float = 5.0,
) -> dict[str, Any]:
    """扣成本 portfolio 评估。

    Args:
        scores_df:  含 [trade_date, ts_code, score]
        label_df:   含 [trade_date, ts_code, label]
        top_k:      每日选股数（默认 20）
        commission_rate: 双边佣金率（默认 0.0003）
        slippage_bps:    滑点 bp（默认 5；= 0.0005）

    Returns:
        dict: {
            annual_return, sharpe, max_drawdown,
            win_rate, turnover, daily_returns: pd.Series,
            n_days, top_k, commission_rate, slippage_rate
        }
    """

    if top_k <= 0:
        raise ValueError(f"top_k 必须 > 0，got {top_k}")
    if commission_rate < 0:
        raise ValueError(f"commission_rate 不能为负，got {commission_rate}")
    if slippage_bps < 0:
        raise ValueError(f"slippage_bps 不能为负，got {slippage_bps}")

    required = {"trade_date", "ts_code", "score"}
    if not required.issubset(scores_df.columns):
        raise ValueError(f"scores_df 缺列：{required - set(scores_df.columns)}")
    if not {"trade_date", "ts_code", "label"}.issubset(label_df.columns):
        raise ValueError(
            f"label_df 缺列：{ {'trade_date', 'ts_code', 'label'} - set(label_df.columns) }"
        )

    slippage_rate = float(slippage_bps) / 10000.0

    df = scores_df[["trade_date", "ts_code", "score"]].merge(
        label_df[["trade_date", "ts_code", "label"]],
        on=["trade_date", "ts_code"],
        how="inner",
    )
    df["trade_date"] = df["trade_date"].astype(str)
    df = df.dropna(subset=["score", "label"])

    if df.empty:
        return {
            "annual_return": float("nan"),
            "sharpe": float("nan"),
            "max_drawdown": float("nan"),
            "win_rate": float("nan"),
            "turnover": float("nan"),
            "daily_returns": pd.Series(dtype=float),
            "n_days": 0,
            "top_k": top_k,
            "commission_rate": commission_rate,
            "slippage_rate": slippage_rate,
        }

    # 每日选 Top-K 等权持仓
    daily_returns: list[float] = []
    daily_dates: list[str] = []
    turnovers: list[float] = []
    prev_holdings: set[str] = set()

    for td, sub in df.groupby("trade_date", sort=True):
        sub_sorted = sub.sort_values("score", ascending=False)
        topk = sub_sorted.head(top_k)
        if topk.empty:
            continue
        holdings = set(topk["ts_code"].tolist())
        # turnover：与前日相比换掉的比例（双向）；首日 turnover=1
        if not prev_holdings:
            turnover = 1.0
        else:
            common = len(prev_holdings & holdings)
            denom = max(len(prev_holdings), len(holdings))
            turnover = 1.0 - common / denom if denom > 0 else 0.0
        # 单日 gross return = 等权平均 label
        gross = float(topk["label"].mean())
        cost = turnover * (float(commission_rate) + slippage_rate)
        net = gross - cost
        daily_returns.append(net)
        daily_dates.append(str(td))
        turnovers.append(turnover)
        prev_holdings = holdings

    returns = pd.Series(daily_returns, index=daily_dates, name="daily_net_return")
    if returns.empty:
        return {
            "annual_return": float("nan"),
            "sharpe": float("nan"),
            "max_drawdown": float("nan"),
            "win_rate": float("nan"),
            "turnover": float("nan"),
            "daily_returns": returns,
            "n_days": 0,
            "top_k": top_k,
            "commission_rate": commission_rate,
            "slippage_rate": slippage_rate,
        }

    mean_daily = float(returns.mean())
    std_daily = float(returns.std(ddof=1)) if len(returns) > 1 else 0.0

    annual_return = float((1.0 + mean_daily) ** _TRADING_DAYS_PER_YEAR - 1.0)
    sharpe = (
        float(mean_daily / std_daily * np.sqrt(_TRADING_DAYS_PER_YEAR))
        if std_daily > 0
        else float("nan")
    )

    # max drawdown on equity curve
    equity = (1.0 + returns).cumprod()
    cummax = equity.cummax()
    drawdown = (cummax - equity) / cummax
    max_drawdown = float(drawdown.max()) if not drawdown.empty else float("nan")

    win_rate = float((returns > 0).sum() / len(returns))
    turnover_mean = float(np.mean(turnovers)) if turnovers else float("nan")

    return {
        "annual_return": annual_return,
        "sharpe": sharpe,
        "max_drawdown": max_drawdown,
        "win_rate": win_rate,
        "turnover": turnover_mean,
        "daily_returns": returns,
        "n_days": int(len(returns)),
        "top_k": top_k,
        "commission_rate": commission_rate,
        "slippage_rate": slippage_rate,
    }


__all__ = [
    "compute_portfolio_metrics",
]
