# -*- coding: utf-8 -*-
"""
交易辅助函数：创建 TradeRecord 等。
"""

from __future__ import annotations

from .models import Position, TradeRecord


def create_trade_record(
    pos: Position,
    exit_time: str,
    exit_price: float,
    shares: float,
    pnl: float,
    exit_reason: str,
    hold_candles: int,
    is_half: bool = False,
) -> TradeRecord:
    """
    根据持仓信息创建交易记录。
    """
    cost_basis = shares * pos.entry_price
    return TradeRecord(
        symbol=pos.symbol,
        entry_time=pos.entry_time,
        entry_price=pos.entry_price,
        exit_time=exit_time,
        exit_price=exit_price,
        shares=shares,
        pnl=pnl,
        return_pct=pnl / cost_basis * 100 if cost_basis else 0.0,
        exit_reason=exit_reason,
        hold_candles=hold_candles,
        is_half=is_half,
        entry_reason=pos.entry_reason,
    )
