"""扣成本组合评估（M3 评估层）。

> doc/量化/05-LightGBM训练体系.md §5.7 三层评估指标：
>   "成本后：扣单边 0.15% 手续费 + 0.15% 冲击 → 年化仍 > 沪深 300 + 10%"
> spec m3 §3：本任务命名为 `portfolio_annual_after_cost`，默认双边佣金 0.0003 + 滑点 5bps。

label 口径（2026-05-23 评审 05-#1/#2 修正）：
  feature_matrix.label 来自 labels/strategy_aware，是 strategy-aware 出场规则驱动的
  **多日持仓毛收益率**（gross；1~20 个交易日变长持仓，T+1 入场）。交易成本在本层
  **唯一一次**扣减：`cost = turnover * (commission_rate + slippage_rate)`。label 本身
  不含成本——本层是扣成本的唯一处。

每条 label = 一笔独立的多日 trade（评审 05-#2 修正）：
  原实现把每个 trade_date 的 Top-K 篮子收益当作「单日收益」，再 `(1+r).cumprod()`
  按日复利 + `sqrt(252)` 年化。但 label 是 1~20 日变长持仓收益，重叠持仓期被多个
  trade_date 重复计入，cumprod 跨重叠期累乘会高估净值；`sqrt(252)` 年化也不成立。
  修正口径：
    - 把每个交易日的 Top-K 篮子当作「该入场日的一笔多日 trade」（trade 收益 =
      篮子内 label 等权平均，是多日累计收益率，不是日收益率）。
    - net_return_mean / net_return_median = 各「入场日 trade」净收益的均值 / 中位数
      —— 语义是**每笔多日 trade 的净收益**，不是日收益。
    - equity = 各入场日 trade 净收益按 trade 顺序 cumprod → **逐笔 trade 净值曲线**
      （非日历净值曲线）；max_drawdown 在此曲线上算，语义是逐笔交易回撤。
    - Sharpe 按实际平均持仓天数年化：每年约可滚动 `252 / avg_hold_days` 个持仓周期，
      annualized Sharpe = mean_trade / std_trade * sqrt(252 / avg_hold_days)。
      硬用 sqrt(252) 会把多日 trade 当单日，高估年化。
  真正的事件驱动 + 重叠持仓资金占用回测见后续任务；本层是近似的「逐笔 trade」口径。

模拟策略：
  1) 每个交易日按预测分数选 Top-K 等权持仓（视为该入场日的一笔 trade）
  2) 按 label（多日持仓毛收益率）等权平均得 trade 毛收益
  3) 与前一入场日持仓求 turnover；扣 turnover * (commission_rate + slippage_rate)
  4) trade_net = mean(top_k labels) - turnover_cost
  5) 输出逐笔 trade 净收益均值/中位数 / 年化 Sharpe / 最大回撤 / 胜率 / 平均换手

公式（与 spec / doc/05 §5.7 对齐）：
  - 双边佣金 commission_rate = 0.0003（默认；调用方可配）
  - 滑点 slippage_bps = 5 → slippage_rate = 0.0005
  - 单边交易成本 ≈ commission_rate + slippage_rate（已含双边语义；commission 已设为双边）
  - turnover_cost = turnover * (commission_rate + slippage_rate)
  - net_return_mean / net_return_median = 各入场日 trade 净收益的均值 / 中位数
  - sharpe = mean_trade_net / std_trade_net * sqrt(252 / avg_hold_days)
  - max_drawdown = max((cummax(equity) - equity) / cummax(equity))，equity 为逐笔 trade 净值

scores_df / label_df 输入约定：
  scores_df: 含列 [trade_date, ts_code, score]
  label_df:  含列 [trade_date, ts_code, label]（多日持仓毛收益率）
  注意：调用方负责对齐 PIT；trade_date 为信号日 T。
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


_TRADING_DAYS_PER_YEAR = 252

# strategy-aware label 的默认平均持仓天数（用于 Sharpe 年化）。
# labels/strategy_aware 持仓上限 MAX_HOLD_DAYS=20、下限 1 个交易日，变长持仓。
# 无逐笔 hold_days 时用本经验均值；调用方可通过 avg_hold_days 参数覆盖。
_DEFAULT_AVG_HOLD_DAYS = 10.0


def compute_portfolio_metrics(
    scores_df: pd.DataFrame,
    label_df: pd.DataFrame,
    *,
    top_k: int = 20,
    commission_rate: float = 0.0003,
    slippage_bps: float = 5.0,
    avg_hold_days: float = _DEFAULT_AVG_HOLD_DAYS,
) -> dict[str, Any]:
    """扣成本 portfolio 评估（逐笔多日 trade 口径）。

    Args:
        scores_df:  含 [trade_date, ts_code, score]
        label_df:   含 [trade_date, ts_code, label]（多日持仓毛收益率）
        top_k:      每个入场日选股数（默认 20）
        commission_rate: 双边佣金率（默认 0.0003）
        slippage_bps:    滑点 bp（默认 5；= 0.0005）
        avg_hold_days:   平均持仓天数，用于 Sharpe 年化（默认 10；见模块 docstring）

    Returns:
        dict: {
            net_return_mean, net_return_median, sharpe, max_drawdown,
            win_rate, turnover, daily_returns: pd.Series（逐笔 trade 净收益，idx=入场日）,
            n_days（= trade 笔数）, top_k, commission_rate, slippage_rate, avg_hold_days
        }

    注意：net_return_* 是逐笔多日 trade 的净收益（非日收益）；daily_returns 字段名
    沿用历史命名，实际承载逐笔 trade 净收益序列。
    """

    if top_k <= 0:
        raise ValueError(f"top_k 必须 > 0，got {top_k}")
    if commission_rate < 0:
        raise ValueError(f"commission_rate 不能为负，got {commission_rate}")
    if slippage_bps < 0:
        raise ValueError(f"slippage_bps 不能为负，got {slippage_bps}")
    if avg_hold_days <= 0:
        raise ValueError(f"avg_hold_days 必须 > 0，got {avg_hold_days}")

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

    def _empty_result(returns: pd.Series) -> dict[str, Any]:
        return {
            "net_return_mean": float("nan"),
            "net_return_median": float("nan"),
            "sharpe": float("nan"),
            "max_drawdown": float("nan"),
            "win_rate": float("nan"),
            "turnover": float("nan"),
            "daily_returns": returns,
            "n_days": 0,
            "top_k": top_k,
            "commission_rate": commission_rate,
            "slippage_rate": slippage_rate,
            "avg_hold_days": avg_hold_days,
        }

    if df.empty:
        return _empty_result(pd.Series(dtype=float))

    # 每个入场日选 Top-K 等权持仓 → 视为该入场日的一笔多日 trade
    trade_returns: list[float] = []
    trade_dates_idx: list[str] = []
    turnovers: list[float] = []
    prev_holdings: set[str] = set()

    for td, sub in df.groupby("trade_date", sort=True):
        sub_sorted = sub.sort_values("score", ascending=False)
        topk = sub_sorted.head(top_k)
        if topk.empty:
            continue
        holdings = set(topk["ts_code"].tolist())
        # turnover：与前一入场日相比换掉的比例（双向）；首笔 turnover=1
        if not prev_holdings:
            turnover = 1.0
        else:
            common = len(prev_holdings & holdings)
            denom = max(len(prev_holdings), len(holdings))
            turnover = 1.0 - common / denom if denom > 0 else 0.0
        # trade 毛收益 = Top-K 等权平均 label（多日持仓毛收益率）
        gross = float(topk["label"].mean())
        # 交易成本在本层唯一一次扣减（label 是毛收益）
        cost = turnover * (float(commission_rate) + slippage_rate)
        net = gross - cost
        trade_returns.append(net)
        trade_dates_idx.append(str(td))
        turnovers.append(turnover)
        prev_holdings = holdings

    returns = pd.Series(trade_returns, index=trade_dates_idx, name="trade_net_return")
    if returns.empty:
        return _empty_result(returns)

    mean_trade = float(returns.mean())
    std_trade = float(returns.std(ddof=1)) if len(returns) > 1 else 0.0

    net_return_mean = mean_trade
    net_return_median = float(returns.median())

    # Sharpe 按实际平均持仓天数年化：每年约滚动 252 / avg_hold_days 个持仓周期。
    # 硬用 sqrt(252) 会把多日 trade 当单日，高估年化（评审 05-#2）。
    periods_per_year = _TRADING_DAYS_PER_YEAR / float(avg_hold_days)
    sharpe = (
        float(mean_trade / std_trade * np.sqrt(periods_per_year))
        if std_trade > 0
        else float("nan")
    )

    # 逐笔 trade 净值曲线：按 trade 顺序 cumprod（非日历净值，不跨重叠持仓期累乘）。
    equity = (1.0 + returns).cumprod()
    cummax = equity.cummax()
    drawdown = (cummax - equity) / cummax
    max_drawdown = float(drawdown.max()) if not drawdown.empty else float("nan")

    win_rate = float((returns > 0).sum() / len(returns))
    turnover_mean = float(np.mean(turnovers)) if turnovers else float("nan")

    return {
        "net_return_mean": net_return_mean,
        "net_return_median": net_return_median,
        "sharpe": sharpe,
        "max_drawdown": max_drawdown,
        "win_rate": win_rate,
        "turnover": turnover_mean,
        "daily_returns": returns,
        "n_days": int(len(returns)),
        "top_k": top_k,
        "commission_rate": commission_rate,
        "slippage_rate": slippage_rate,
        "avg_hold_days": avg_hold_days,
    }


__all__ = [
    "compute_portfolio_metrics",
]
