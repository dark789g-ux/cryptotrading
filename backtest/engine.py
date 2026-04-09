# -*- coding: utf-8 -*-
"""
回测引擎：主回测循环。

相关模块：
  - position_handler: 单根 K 线持仓处理
  - signal_scanner: 入场信号扫描
  - trade_helper: 交易记录创建辅助
  - cooldown: 冷却期管理
  - loss_tracker: 连续亏损追踪
"""

from __future__ import annotations

import logging

import pandas as pd
from tqdm import tqdm

from .config import (
    INITIAL_CAPITAL,
    MAX_POSITIONS,
    MIN_OPEN_CASH,
    POSITION_RATIO,
    STOP_LOSS_FACTOR,
    COOLDOWN_HOURS,
)
from .data import build_global_timeline
from .indicators import calc_recent_high, calc_recent_low
from .models import Position, TradeRecord
from .position_handler import process_candle, process_entry_candle
from .signal_scanner import scan_signals
from .cooldown import set_cooldown
from .loss_tracker import LossTracker
from .trade_helper import create_trade_record

logger = logging.getLogger(__name__)


def _execute_pending_buys(
    pending_buys: list[tuple[str, str, float]],
    ts: str,
    data: dict[str, pd.DataFrame],
    ts_to_idx: dict[str, dict[str, int]],
    cash: float,
    portfolio_log: list[tuple[str, float]],
    positions: list[Position],
) -> tuple[list[tuple[str, str, float]], float]:
    """
    执行上一时间步挂单的买入。

    返回：(new_pending_buys, updated_cash)
    """
    new_pending: list[tuple[str, str, float]] = []

    for sym, sig_ts, rr_ratio in pending_buys:
        df = data.get(sym)
        if df is None:
            continue
        idx_map = ts_to_idx.get(sym, {})
        cur_idx = idx_map.get(ts)
        if cur_idx is None:
            new_pending.append((sym, sig_ts, rr_ratio))
            continue

        open_price = float(df.at[cur_idx, "open"])
        last_nav = portfolio_log[-1][1] if portfolio_log else INITIAL_CAPITAL
        position_size = last_nav * POSITION_RATIO
        alloc = min(position_size, cash)
        if alloc < MIN_OPEN_CASH or alloc <= 0:
            continue

        shares = alloc / open_price
        rec_low, _ = calc_recent_low(df, cur_idx)
        stop_p = rec_low * STOP_LOSS_FACTOR

        rec_high, rec_high_time = calc_recent_high(df, cur_idx)
        rec_low, rec_low_time = calc_recent_low(df, cur_idx)
        init_stop_loss_pct = (open_price - rec_low) / open_price * 100 if open_price > 0 else 0.0

        entry_rsn = (
            f"盈亏比 {rr_ratio:.2f}\n"
            f"阶段高点 {rec_high_time} {rec_high:.6g}\n"
            f"阶段低点 {rec_low_time} {rec_low:.6g}\n"
            f"初次止损幅度 {init_stop_loss_pct:.2f}%"
        )

        pos = Position(
            symbol=sym,
            entry_price=open_price,
            entry_time=ts,
            entry_idx=cur_idx,
            shares=shares,
            allocated=alloc,
            stop_price=stop_p,
            recent_high=rec_high,
            max_close=open_price,
            stop_reason="阶段低点止损",
            entry_rr_ratio=rr_ratio,
            recent_high_time=rec_high_time,
            recent_low_time=rec_low_time,
            entry_reason=entry_rsn,
        )
        cash -= alloc
        positions.append(pos)
        logger.debug("买入 %s @ %.6f  止损 %.6f  止盈触发 %.6f", sym, open_price, stop_p, rec_high)

    return new_pending, cash


def _process_positions(
    positions: list[Position],
    ts: str,
    data: dict[str, pd.DataFrame],
    ts_to_idx: dict[str, dict[str, int]],
    cash: float,
    all_trades: list[TradeRecord],
    cooldown_until: dict[str, str],
    loss_tracker: LossTracker,
    ts_to_global_idx: dict[str, int],
) -> tuple[list[Position], float]:
    """
    处理所有持仓，返回存活持仓和更新后的现金。
    """
    surviving: list[Position] = []

    for pos in positions:
        df = data.get(pos.symbol)
        if df is None:
            surviving.append(pos)
            continue
        idx_map = ts_to_idx.get(pos.symbol, {})
        cur_idx = idx_map.get(ts)
        if cur_idx is None:
            surviving.append(pos)
            continue

        # 买入当根特殊处理
        if ts == pos.entry_time:
            cash, trade_recs, exited = process_entry_candle(
                pos, df, cur_idx, ts, cash, cooldown_until
            )
            all_trades.extend(trade_recs)
            if exited:
                # 处理连续亏损
                if trade_recs and not trade_recs[-1].is_half:
                    cur_idx_global = ts_to_global_idx.get(ts, 0)
                    loss_tracker.process_trade(trade_recs[-1], cur_idx_global)
            else:
                surviving.append(pos)
            continue

        # 常规K线处理
        action, cash_delta, trade_recs = process_candle(pos, df, cur_idx, cash)
        cash += cash_delta
        all_trades.extend(trade_recs)

        if action == "exit_full":
            logger.debug(
                "平仓 %s  原因=%s  现金回收=%.2f",
                pos.symbol, trade_recs[-1].exit_reason if trade_recs else "?", cash_delta
            )
            set_cooldown(cooldown_until, pos.symbol, ts)

            # 连续亏损冷却检测
            if trade_recs and not trade_recs[-1].is_half:
                cur_idx_global = ts_to_global_idx.get(ts, 0)
                loss_tracker.process_trade(trade_recs[-1], cur_idx_global)
        else:
            surviving.append(pos)

    return surviving, cash


def _calculate_portfolio_value(
    positions: list[Position],
    ts: str,
    data: dict[str, pd.DataFrame],
    ts_to_idx: dict[str, dict[str, int]],
    cash: float,
) -> tuple[float, list[dict]]:
    """
    计算当前持仓市值和快照。

    返回：(portfolio_value, position_snapshots)
    """
    holding_value = 0.0
    snapshot: list[dict] = []

    for pos in positions:
        df = data.get(pos.symbol)
        if df is None:
            continue
        idx_map = ts_to_idx.get(pos.symbol, {})
        cur_idx = idx_map.get(ts)
        if cur_idx is None:
            continue
        close_price = float(df.at[cur_idx, "close"])
        holding_value += pos.shares * close_price
        pnl_pct = (close_price - pos.entry_price) / pos.entry_price * 100 if pos.entry_price else 0.0
        snapshot.append({
            "symbol": pos.symbol,
            "entry_time": pos.entry_time,
            "hold_h": pos.candle_count,
            "pnl_pct": round(pnl_pct, 2),
        })

    return cash + holding_value, snapshot


def _force_close_positions(
    positions: list[Position],
    timestamps: list[str],
    data: dict[str, pd.DataFrame],
    ts_to_idx: dict[str, dict[str, int]],
    cash: float,
    all_trades: list[TradeRecord],
    loss_tracker: LossTracker,
    ts_to_global_idx: dict[str, int],
) -> float:
    """
    回测结束时强制平仓所有剩余持仓。

    返回：更新后的现金余额
    """
    if not positions or not timestamps:
        return cash

    last_ts = timestamps[-1]

    for pos in positions:
        df = data.get(pos.symbol)
        if df is None:
            continue
        idx_map = ts_to_idx.get(pos.symbol, {})
        cur_idx = idx_map.get(last_ts)
        if cur_idx is None:
            available = [(t, i) for t, i in idx_map.items() if t <= last_ts]
            if not available:
                continue
            cur_idx = max(available, key=lambda x: x[0])[1]

        close_price = float(df.at[cur_idx, "close"])
        proceeds = pos.shares * close_price
        cost_basis = pos.shares * pos.entry_price
        pnl = proceeds - cost_basis
        cash += proceeds

        trade_record = create_trade_record(
            pos, last_ts, close_price, pos.shares, pnl,
            "回测结束", pos.candle_count, is_half=False,
        )
        all_trades.append(trade_record)
        logger.debug(
            "回测结束强制平仓 %s  entry=%s  close=%.6f  pnl=%.2f",
            pos.symbol, pos.entry_time, close_price, pnl
        )

        # 连续亏损冷却检测
        loss_tracker.process_trade(trade_record, ts_to_global_idx.get(last_ts, 0))

    return cash


def run_backtest(
    data: dict[str, pd.DataFrame],
    backtest_start: dict[str, int],
) -> tuple[list[TradeRecord], list[tuple[str, float]], list[list[dict]]]:
    """
    执行完整回测。

    返回：
      all_trades    : 所有已完结的交易记录
      portfolio_log : [(open_time, portfolio_value), ...]
      pos_snapshots : 与 portfolio_log 等长，每项为当根收盘后持仓快照列表
    """
    # 初始化索引映射
    ts_to_idx: dict[str, dict[str, int]] = {}
    for symbol, df in data.items():
        ts_to_idx[symbol] = dict(zip(df["open_time"], df.index))

    timestamps = build_global_timeline(data, backtest_start)
    ts_to_global_idx: dict[str, int] = {ts: i for i, ts in enumerate(timestamps)}

    # 初始化状态
    cash = INITIAL_CAPITAL
    positions: list[Position] = []
    pending_buys: list[tuple[str, str, float]] = []
    all_trades: list[TradeRecord] = []
    portfolio_log: list[tuple[str, float]] = []
    pos_snapshots: list[list[dict]] = []
    cooldown_until: dict[str, str] = {}
    loss_tracker = LossTracker()

    for ts in tqdm(timestamps, desc="回测进度", unit="bar", dynamic_ncols=True):
        # ── 1. 执行上一时间步挂单的买入 ──
        pending_buys, cash = _execute_pending_buys(
            pending_buys, ts, data, ts_to_idx, cash, portfolio_log, positions
        )

        # ── 2. 处理每个持仓 ──
        positions, cash = _process_positions(
            positions, ts, data, ts_to_idx, cash, all_trades,
            cooldown_until, loss_tracker, ts_to_global_idx
        )

        # ── 3. 计算当前持仓市值，同步记录持仓快照 ──
        portfolio_val, snapshot = _calculate_portfolio_value(
            positions, ts, data, ts_to_idx, cash
        )
        portfolio_log.append((ts, portfolio_val))
        pos_snapshots.append(snapshot)

        # ── 4. 判断是否允许开新仓，再按需扫描入场信号 ──
        n_pos = len(positions)
        all_half = (n_pos == MAX_POSITIONS and all(p.half_sold for p in positions))
        allow_new = (n_pos < MAX_POSITIONS) or all_half

        # 检查全局冷却期
        cur_global_idx = ts_to_global_idx.get(ts, 0)
        if loss_tracker.is_in_cooldown(cur_global_idx):
            remaining = loss_tracker.get_remaining_cooldown(cur_global_idx)
            logger.debug("全局冷却中，剩余%d个周期，跳过入场扫描", remaining)

        if allow_new and cash >= MIN_OPEN_CASH and not loss_tracker.is_in_cooldown(cur_global_idx):
            slots_to_fill = (MAX_POSITIONS + 1 - n_pos) if all_half else (MAX_POSITIONS - n_pos)

            if slots_to_fill > 0:
                held_symbols = {p.symbol for p in positions}
                held_symbols |= {sym for sym, _ in pending_buys}
                candidates = scan_signals(data, ts, ts_to_idx, held_symbols, cooldown_until)
                if candidates:
                    sym, rr = candidates[0]
                    pending_buys.append((sym, ts, rr))

    # ── 5. 回测结束：强制平仓所有剩余持仓 ──
    cash = _force_close_positions(
        positions, timestamps, data, ts_to_idx, cash,
        all_trades, loss_tracker, ts_to_global_idx
    )

    return all_trades, portfolio_log, pos_snapshots
