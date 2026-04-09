# -*- coding: utf-8 -*-
"""
持仓处理器：单根 K 线持仓处理逻辑。
"""

from __future__ import annotations

import pandas as pd

from .config import ENABLE_PARTIAL_PROFIT
from .models import Position, TradeRecord
from .trade_helper import create_trade_record


def process_candle(
    pos: Position,
    df: pd.DataFrame,
    cur_idx: int,
    available_cash: float,
) -> tuple[str | None, float, list[TradeRecord]]:
    """
    处理持仓 pos 在 cur_idx 这根 K 线上的事件。

    返回：(action, cash_delta, trade_records)
      action      : None | "exit_full" | "half_sold"
      cash_delta  : 本根 K 线返还的现金（正数）
      trade_records: 本根 K 线产生的已完结交易记录
    """
    row = df.iloc[cur_idx]
    open_ = float(row["open"])
    high = float(row["high"])
    low = float(row["low"])
    close = float(row["close"])
    ma5 = float(row["MA5"])
    time_ = str(row["open_time"])

    trades: list[TradeRecord] = []
    cash_delta = 0.0

    if cur_idx > 0:
        prev_ma5 = float(df.at[cur_idx - 1, "MA5"])
    else:
        prev_ma5 = ma5

    # ────────────────────────────────────────────────
    # 步骤 1+2：阶段止盈 与 止损
    # 同一根 K 线同时触发时：先阶段止盈（对全仓的一半），再止损（对剩余仓位）
    # ────────────────────────────────────────────────
    hit_profit = ENABLE_PARTIAL_PROFIT and (not pos.half_sold) and high >= pos.recent_high
    hit_stop = low <= pos.stop_price

    if hit_profit:
        half_shares = pos.shares / 2.0
        sell_price = pos.recent_high
        proceeds_half = half_shares * sell_price
        cost_half = half_shares * pos.entry_price
        pnl_half = proceeds_half - cost_half

        trades.append(create_trade_record(
            pos, time_, sell_price, half_shares, pnl_half,
            "阶段止盈", pos.candle_count, is_half=True,
        ))
        pos.shares -= half_shares
        pos.half_sold = True
        pos.half_sell_price = sell_price
        pos.half_sell_time = time_
        cash_delta += proceeds_half

    if hit_stop:
        exit_price = open_ if open_ < pos.stop_price else pos.stop_price
        proceeds = pos.shares * exit_price
        cost_basis = pos.shares * pos.entry_price
        pnl = proceeds - cost_basis
        cash_delta += proceeds
        trades.append(create_trade_record(
            pos, time_, exit_price, pos.shares, pnl,
            pos.stop_reason, pos.candle_count, is_half=False,
        ))
        return "exit_full", cash_delta, trades

    # ────────────────────────────────────────────────
    # 步骤 3：收盘处理
    # 顺序：①' 阶段止盈后止损调节（仅 hit_profit 时）→ ② MA5 规则 A/B/C
    # ────────────────────────────────────────────────

    # ①' 阶段止盈后止损调节（本根触发了半仓止盈才执行）
    if hit_profit:
        pos.max_close = max(pos.max_close, close)
        new_stop = (pos.entry_price + pos.max_close) / 2
        new_stop = max(pos.stop_price, new_stop)
        pos.stop_price = new_stop
        pos.stop_reason = "阶段止盈后止损"
        if close < new_stop:
            proceeds = pos.shares * close
            cost_basis = pos.shares * pos.entry_price
            pnl = proceeds - cost_basis
            cash_delta += proceeds
            trades.append(create_trade_record(
                pos, time_, close, pos.shares, pnl,
                "阶段止盈后收盘止损", pos.candle_count, is_half=False,
            ))
            return "exit_full", cash_delta, trades

    # ② MA5 收盘规则
    pos.max_close = max(pos.max_close, close)

    # 规则 A：首次 close > MA5 → 设置突破标记
    if not pos.broke_ma5 and close > ma5:
        pos.broke_ma5 = True

    # 规则 B：MA5 下跌破线出场（优先于规则 C）
    if close < ma5 and ma5 <= prev_ma5 and pos.broke_ma5:
        proceeds = pos.shares * close
        cost_basis = pos.shares * pos.entry_price
        pnl = proceeds - cost_basis
        cash_delta += proceeds
        trades.append(create_trade_record(
            pos, time_, close, pos.shares, pnl,
            "MA5下跌破线", pos.candle_count, is_half=False,
        ))
        return "exit_full", cash_delta, trades

    # 规则 C：MA5 首次上升 → 调节动态止损
    if not pos.ma5_stop_adjusted and ma5 > prev_ma5:
        new_stop = (pos.entry_price + pos.max_close) / 2
        new_stop = max(pos.stop_price, new_stop)
        if close < new_stop:
            proceeds = pos.shares * close
            cost_basis = pos.shares * pos.entry_price
            pnl = proceeds - cost_basis
            cash_delta += proceeds
            trades.append(create_trade_record(
                pos, time_, close, pos.shares, pnl,
                "MA5上升后止损", pos.candle_count, is_half=False,
            ))
            return "exit_full", cash_delta, trades
        else:
            if new_stop > pos.stop_price:
                pos.stop_reason = "MA5首次上升止损"
            pos.stop_price = new_stop
            pos.ma5_stop_adjusted = True

    pos.candle_count += 1
    return None, cash_delta, trades


def process_entry_candle(
    pos: Position,
    df: pd.DataFrame,
    cur_idx: int,
    ts: str,
    cash: float,
    cooldown_until: dict[str, str],
) -> tuple[float, list[TradeRecord], bool]:
    """
    处理买入当根 K 线的止盈与止损检查。

    返回：(new_cash, trades, exited)
      new_cash : 更新后的现金余额
      trades   : 产生的交易记录
      exited   : 是否已平仓（True=已平仓，False=继续持有）
    """
    from .cooldown import set_cooldown

    trades: list[TradeRecord] = []
    entry_low = float(df.at[cur_idx, "low"])
    entry_high = float(df.at[cur_idx, "high"])
    hit_profit = ENABLE_PARTIAL_PROFIT and (not pos.half_sold) and entry_high >= pos.recent_high
    hit_stop = entry_low <= pos.stop_price

    if hit_profit:
        half_shares = pos.shares / 2.0
        sell_price = pos.recent_high
        proceeds_half = half_shares * sell_price
        cost_half = half_shares * pos.entry_price
        pnl_half = proceeds_half - cost_half
        cash += proceeds_half
        trades.append(create_trade_record(
            pos, ts, sell_price, half_shares, pnl_half,
            "阶段止盈", 0, is_half=True,
        ))
        pos.shares -= half_shares
        pos.half_sold = True
        pos.half_sell_price = sell_price
        pos.half_sell_time = ts

    if hit_stop:
        exit_p = pos.stop_price
        proceeds = pos.shares * exit_p
        cost_basis = pos.shares * pos.entry_price
        pnl = proceeds - cost_basis
        cash += proceeds
        trades.append(create_trade_record(
            pos, ts, exit_p, pos.shares, pnl,
            pos.stop_reason, 0, is_half=False,
        ))
        set_cooldown(cooldown_until, pos.symbol, ts)
        return cash, trades, True

    close = float(df.at[cur_idx, "close"])
    ma5_cur = float(df.at[cur_idx, "MA5"])
    if cur_idx > 0:
        ma5_prev = float(df.at[cur_idx - 1, "MA5"])
    else:
        ma5_prev = ma5_cur

    exited = False

    # ①' 阶段止盈后止损调节（仅本根触发了半仓止盈时执行）
    if hit_profit:
        pos.max_close = max(pos.max_close, close)
        new_stop = (pos.entry_price + pos.max_close) / 2
        new_stop = max(pos.stop_price, new_stop)
        pos.stop_price = new_stop
        pos.stop_reason = "阶段止盈后止损"
        if close < new_stop:
            proceeds = pos.shares * close
            cost_basis = pos.shares * pos.entry_price
            pnl = proceeds - cost_basis
            cash += proceeds
            trades.append(create_trade_record(
                pos, ts, close, pos.shares, pnl,
                "阶段止盈后收盘止损", 0, is_half=False,
            ))
            set_cooldown(cooldown_until, pos.symbol, ts)
            return cash, trades, True

    # ② MA5 收盘规则
    pos.max_close = max(pos.max_close, close)

    # 规则 A：首次 close > MA5
    if not pos.broke_ma5 and close > ma5_cur:
        pos.broke_ma5 = True

    # 规则 B：MA5 下跌破线出场
    if close < ma5_cur and ma5_cur <= ma5_prev and pos.broke_ma5:
        proceeds = pos.shares * close
        cost_basis = pos.shares * pos.entry_price
        pnl = proceeds - cost_basis
        cash += proceeds
        trades.append(create_trade_record(
            pos, ts, close, pos.shares, pnl,
            "MA5下跌破线", 0, is_half=False,
        ))
        set_cooldown(cooldown_until, pos.symbol, ts)
        return cash, trades, True

    # 规则 C：MA5 首次上升 → 调节动态止损
    if not pos.ma5_stop_adjusted and ma5_cur > ma5_prev:
        new_stop = (pos.entry_price + pos.max_close) / 2
        new_stop = max(pos.stop_price, new_stop)
        if close < new_stop:
            proceeds = pos.shares * close
            cost_basis = pos.shares * pos.entry_price
            pnl = proceeds - cost_basis
            cash += proceeds
            trades.append(create_trade_record(
                pos, ts, close, pos.shares, pnl,
                "MA5上升后止损", 0, is_half=False,
            ))
            set_cooldown(cooldown_until, pos.symbol, ts)
            return cash, trades, True
        else:
            if new_stop > pos.stop_price:
                pos.stop_reason = "MA5首次上升止损"
            pos.stop_price = new_stop
            pos.ma5_stop_adjusted = True

    return cash, trades, False
