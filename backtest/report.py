# -*- coding: utf-8 -*-
"""
回测报告生成：统计指标计算、CSV/JSON 输出。
"""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path

import pandas as pd

from .config import INITIAL_CAPITAL
from .models import TradeRecord

logger = logging.getLogger(__name__)


# ══════════════════════════════════════════════════════════════
#  统计指标计算
# ══════════════════════════════════════════════════════════════

def calc_stats(
    all_trades: list[TradeRecord],
    portfolio_log: list[tuple[str, float]],
) -> dict:
    """计算回测统计指标。"""
    if not portfolio_log:
        return {}

    pf_values = [v for _, v in portfolio_log]
    total_return = (pf_values[-1] - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100

    peak   = pf_values[0]
    max_dd = 0.0
    for v in pf_values:
        if v > peak:
            peak = v
        dd = (peak - v) / peak * 100 if peak else 0
        if dd > max_dd:
            max_dd = dd

    if len(pf_values) > 1:
        hourly_rets = [(pf_values[i] - pf_values[i-1]) / pf_values[i-1]
                       for i in range(1, len(pf_values))]
        mean_r = sum(hourly_rets) / len(hourly_rets)
        std_r  = math.sqrt(sum((r - mean_r)**2 for r in hourly_rets) / len(hourly_rets))
        sharpe = (mean_r / std_r * math.sqrt(8760)) if std_r > 1e-12 else 0.0
    else:
        sharpe = 0.0

    full_trades  = [t for t in all_trades if not t.is_half]
    half_trades  = [t for t in all_trades if t.is_half]
    winning_full = [t for t in full_trades if t.pnl > 0]
    losing_full  = [t for t in full_trades if t.pnl < 0]
    win_rate     = len(winning_full) / len(full_trades) * 100 if full_trades else 0.0
    avg_win_return = sum(t.return_pct for t in winning_full) / len(winning_full) if winning_full else 0.0
    avg_loss_return = sum(t.return_pct for t in losing_full) / len(losing_full) if losing_full else 0.0
    avg_hold     = (sum(t.hold_candles for t in full_trades) / len(full_trades)
                    if full_trades else 0.0)
    total_pnl    = sum(t.pnl for t in all_trades)

    return {
        "初始资金":         f"{INITIAL_CAPITAL:,.2f} USDT",
        "最终净值":         f"{pf_values[-1]:,.2f} USDT",
        "总收益率":         f"{total_return:.2f}%",
        "总盈亏":           f"{total_pnl:,.2f} USDT",
        "最大回撤":         f"{max_dd:.2f}%",
        "夏普率(年化)":     f"{sharpe:.3f}",
        "完整交易次数":     len(full_trades),
        "阶段止盈次数":     len(half_trades),
        "胜率(完整出场)":   f"{win_rate:.1f}%",
        "胜场平均收益率":   f"{avg_win_return:.2f}%",
        "败场平均收益率":   f"{avg_loss_return:.2f}%",
        "平均持仓周期(h)":  f"{avg_hold:.1f}",
        "回测K线数":        len(portfolio_log),
    }


# ══════════════════════════════════════════════════════════════
#  CSV 输出
# ══════════════════════════════════════════════════════════════

def save_trades_csv(all_trades: list[TradeRecord], output_dir: Path) -> None:
    rows = []
    for i, t in enumerate(all_trades, 1):
        rows.append({
            "序号":       i,
            "交易对":     t.symbol,
            "买入时间":   t.entry_time,
            "买入价":     round(t.entry_price, 8),
            "买入额":     round(t.entry_price * t.shares, 2),
            "卖出时间":   t.exit_time,
            "卖出价":     round(t.exit_price, 8),
            "卖出额":     round(t.exit_price * t.shares, 2),
            "数量":       round(t.shares, 8),
            "盈亏(USDT)": round(t.pnl, 4),
            "收益率(%)":  round(t.return_pct, 4),
            "退出原因":   t.exit_reason,
            "持仓周期":   t.hold_candles,
            "是否半仓":   "是" if t.is_half else "否",
        })
    df = pd.DataFrame(rows)
    path = output_dir / "trades.csv"
    df.to_csv(path, index=False, encoding="utf-8-sig")
    logger.info("交易明细已保存：%s  共 %d 条", path, len(rows))


def save_portfolio_csv(portfolio_log: list[tuple[str, float]], output_dir: Path) -> None:
    df = pd.DataFrame(portfolio_log, columns=["time", "portfolio_value"])
    path = output_dir / "portfolio.csv"
    df.to_csv(path, index=False, encoding="utf-8-sig")
    logger.info("净值序列已保存：%s  共 %d 行", path, len(df))


# ══════════════════════════════════════════════════════════════
#  JSON 报告数据构建
# ══════════════════════════════════════════════════════════════

def _build_positions(all_trades: list) -> list:
    """按仓位聚合 TradeRecord，每个 (symbol, entry_time) 对应一行，newest-first。"""
    pos_dict: dict = {}
    for t in all_trades:
        key = (t.symbol, t.entry_time)
        if key not in pos_dict:
            pos_dict[key] = []
        pos_dict[key].append(t)

    pos_list = []
    for (symbol, entry_time), trades in pos_dict.items():
        total_shares = sum(t.shares for t in trades)
        entry_price  = trades[0].entry_price
        buy_amount   = entry_price * total_shares
        total_sell   = sum(t.exit_price * t.shares for t in trades)
        avg_sell     = total_sell / total_shares if total_shares else 0
        total_pnl    = sum(t.pnl for t in trades)
        close_time   = max(t.exit_time for t in trades)
        hold_candles = max(t.hold_candles for t in trades)
        sorted_trades = sorted(trades, key=lambda t: t.exit_time)
        stop_types    = list(dict.fromkeys(t.exit_reason for t in sorted_trades))
        pos_list.append({
            "symbol":       symbol,
            "entry_time":   entry_time,
            "entry_price":  f"{entry_price:.6g}",
            "buy_amount":   round(buy_amount, 2),
            "buy_shares":   round(total_shares, 6),
            "close_time":   close_time,
            "sell_price":   f"{avg_sell:.6g}",
            "sell_amount":  round(total_sell, 2),
            "pnl":          round(total_pnl, 4),
            "return_pct":   round(total_pnl / buy_amount * 100 if buy_amount else 0, 4),
            "hold_candles": hold_candles,
            "trade_count":  len(trades),
            "stop_types":   stop_types,
        })

    pos_list.sort(key=lambda x: x["entry_time"])
    total = len(pos_list)
    for i, p in enumerate(reversed(pos_list)):
        p["pos_no"] = total - i
    return list(reversed(pos_list))


def _build_symbols(all_trades: list) -> list:
    """
    按 symbol 聚合所有仓位的统计数据。

    第一步：按 (symbol, entry_time) 聚合每个仓位的核心指标
    第二步：按 symbol 汇总所有仓位，生成交易对维度的统计行
    """
    pos_dict: dict = {}
    for t in all_trades:
        key = (t.symbol, t.entry_time)
        if key not in pos_dict:
            pos_dict[key] = []
        pos_dict[key].append(t)

    pos_summary: list[dict] = []
    for (symbol, entry_time), trades in pos_dict.items():
        total_shares = sum(t.shares for t in trades)
        entry_price  = trades[0].entry_price
        buy_amount   = entry_price * total_shares
        total_pnl    = sum(t.pnl for t in trades)
        return_pct   = total_pnl / buy_amount * 100 if buy_amount else 0.0
        hold_candles = max(t.hold_candles for t in trades)
        had_half     = any(t.is_half for t in trades)
        pos_summary.append({
            "symbol":       symbol,
            "entry_time":   entry_time,
            "buy_amount":   buy_amount,
            "pnl":          total_pnl,
            "return_pct":   return_pct,
            "hold_candles": hold_candles,
            "had_half":     had_half,
        })

    sym_dict: dict = {}
    for p in pos_summary:
        sym = p["symbol"]
        if sym not in sym_dict:
            sym_dict[sym] = []
        sym_dict[sym].append(p)

    sym_list: list[dict] = []
    for symbol, positions in sym_dict.items():
        pos_count    = len(positions)
        win_count    = sum(1 for p in positions if p["pnl"] > 0)
        win_rate     = win_count / pos_count * 100 if pos_count else 0.0
        total_pnl    = sum(p["pnl"] for p in positions)
        total_buy    = sum(p["buy_amount"] for p in positions)
        returns      = [p["return_pct"] for p in positions]
        avg_return   = sum(returns) / len(returns) if returns else 0.0
        best_return  = max(returns) if returns else 0.0
        worst_return = min(returns) if returns else 0.0
        avg_hold     = sum(p["hold_candles"] for p in positions) / pos_count if pos_count else 0.0
        half_count   = sum(1 for p in positions if p["had_half"])
        entry_times  = [p["entry_time"] for p in positions]
        sym_list.append({
            "symbol":       symbol,
            "pos_count":    pos_count,
            "win_rate":     round(win_rate, 1),
            "total_pnl":    round(total_pnl, 2),
            "total_buy":    round(total_buy, 2),
            "avg_return":   round(avg_return, 2),
            "best_return":  round(best_return, 2),
            "worst_return": round(worst_return, 2),
            "avg_hold":     round(avg_hold, 1),
            "half_count":   half_count,
            "first_entry":  min(entry_times),
            "last_entry":   max(entry_times),
        })

    sym_list.sort(key=lambda x: x["total_pnl"], reverse=True)
    return sym_list


def _build_transactions(all_trades: list) -> list:
    """将仓位记录拆解为原子买卖流水（按时间升序，newest-first 序号）。"""
    buy_agg: dict = {}
    for t in all_trades:
        key = (t.symbol, t.entry_time)
        if key not in buy_agg:
            buy_agg[key] = {"entry_price": t.entry_price, "shares": 0.0,
                            "entry_reason": t.entry_reason}
        # 只累加非半仓交易的 shares（半仓是卖出记录）
        if not t.is_half:
            buy_agg[key]["shares"] += t.shares

    txn_list: list[dict] = []
    for (symbol, entry_time), agg in buy_agg.items():
        txn_list.append({
            "time":      entry_time,
            "symbol":    symbol,
            "price":     f"{agg['entry_price']:.6g}",
            "amount":    round(agg["entry_price"] * agg["shares"], 2),
            "shares":    round(agg["shares"], 6),
            "direction": "买入",
            "reason":    agg.get("entry_reason", ""),
        })
    for t in all_trades:
        txn_list.append({
            "time":      t.exit_time,
            "symbol":    t.symbol,
            "price":     f"{t.exit_price:.6g}",
            "amount":    round(t.exit_price * t.shares, 2),
            "shares":    round(t.shares, 6),
            "direction": "卖出",
            "reason":    t.exit_reason,
        })

    txn_list.sort(key=lambda x: x["time"])
    total = len(txn_list)
    return [{
        "txn_no":    total - i,
        "symbol":    x["symbol"],
        "time":      x["time"],
        "price":     x["price"],
        "amount":    x["amount"],
        "shares":    x["shares"],
        "direction": x["direction"],
        "reason":    x["reason"],
    } for i, x in enumerate(reversed(txn_list))]


def _prepare_report_data(
    all_trades: list[TradeRecord],
    portfolio_log: list[tuple[str, float]],
    stats: dict,
    pos_snapshots: list[list[dict]] | None = None,
) -> dict:
    """将回测结果整理为可 JSON 序列化的报告数据字典。"""
    sample_step = max(1, len(portfolio_log) // 1000)
    sampled_log = portfolio_log[::sample_step]
    sampled_snapshots = pos_snapshots[::sample_step] if pos_snapshots else [[] for _ in sampled_log]

    monthly: dict[str, list[float]] = {}
    if portfolio_log:
        base_val   = INITIAL_CAPITAL
        prev_month = ""
        for ts, val in portfolio_log:
            month = ts[:7]
            if month != prev_month:
                if prev_month:
                    monthly_ret = (val - base_val) / base_val * 100 if base_val else 0
                    monthly.setdefault(prev_month, []).append(monthly_ret)
                    base_val = val
                prev_month = month

    pnl_by_sym: dict[str, float] = {}
    for t in all_trades:
        pnl_by_sym[t.symbol] = pnl_by_sym.get(t.symbol, 0) + t.pnl
    top_syms = sorted(pnl_by_sym.items(), key=lambda x: x[1], reverse=True)[:15]

    return {
        "stats": stats,
        "portfolio": {
            "labels":    [t for t, _ in sampled_log],
            "values":    [round(v, 2) for _, v in sampled_log],
            "snapshots": sampled_snapshots,
        },
        "monthly": {
            "labels": list(monthly.keys()),
            "values": [round(sum(v) / len(v), 2) for v in monthly.values()],
        },
        "symbols_pnl": {
            "labels": [s for s, _ in top_syms],
            "values": [round(p, 2) for _, p in top_syms],
        },
        "positions": _build_positions(all_trades),
        "total_positions": len({(t.symbol, t.entry_time) for t in all_trades}),
        "total_trades": len(all_trades),
        "transactions": _build_transactions(all_trades),
        "symbols": _build_symbols(all_trades),
    }


def save_report_data_json(
    all_trades: list[TradeRecord],
    portfolio_log: list[tuple[str, float]],
    stats: dict,
    output_dir: Path,
    pos_snapshots: list[list[dict]] | None = None,
    run_id: str = "",
) -> None:
    """将报告数据序列化为 JSON 文件，供前端 fetch 加载。"""
    data = _prepare_report_data(all_trades, portfolio_log, stats, pos_snapshots)
    if run_id:
        data["run_id"] = run_id
    path = output_dir / "report_data.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    logger.info("报告数据已保存：%s  共 %d 条交易", path, data["total_trades"])
