# -*- coding: utf-8 -*-
"""
连续亏损追踪器：管理全局冷却状态。
"""

from __future__ import annotations

import logging

from .config import (
    CONSECUTIVE_LOSSES_THRESHOLD,
    BASE_COOLDOWN_CANDLES,
    MAX_COOLDOWN_CANDLES,
    CONSECUTIVE_LOSSES_REDUCE_ON_PROFIT,
)
from .models import TradeRecord

logger = logging.getLogger(__name__)


class LossTracker:
    """
    追踪连续亏损并管理全局冷却状态。
    """

    def __init__(self) -> None:
        self.consecutive_losses: int = 0
        self.global_cooldown_end_idx: int = -1
        self.current_cooldown_candles: int = BASE_COOLDOWN_CANDLES

    def process_trade(self, trade: TradeRecord, ts_idx: int) -> None:
        """
        处理一笔已完结交易，更新连续亏损计数器和冷却状态。

        Args:
            trade: 已完结的交易记录
            ts_idx: 当前时间戳的全局索引
        """
        if trade.is_half:
            return  # 半仓交易不计入

        if trade.pnl < 0:
            # 亏损：递增计数器
            self.consecutive_losses += 1
            # 检查是否达到冷却阈值
            if self.consecutive_losses >= CONSECUTIVE_LOSSES_THRESHOLD:
                self.current_cooldown_candles = min(
                    BASE_COOLDOWN_CANDLES + (self.consecutive_losses - CONSECUTIVE_LOSSES_THRESHOLD),
                    MAX_COOLDOWN_CANDLES,
                )
                self.global_cooldown_end_idx = ts_idx + self.current_cooldown_candles
                logger.info(
                    "连续%d笔亏损，触发全局冷却%d个周期",
                    self.consecutive_losses, self.current_cooldown_candles
                )
        else:
            # 盈利：减少连续亏损计数器（而非重置为0）
            if self.consecutive_losses > 0:
                old_count = self.consecutive_losses
                self.consecutive_losses = max(0, self.consecutive_losses - CONSECUTIVE_LOSSES_REDUCE_ON_PROFIT)
                logger.info("交易盈利，连续亏损计数器从%d减至%d", old_count, self.consecutive_losses)
                # 如果减到0以下阈值，取消冷却状态
                if self.consecutive_losses < CONSECUTIVE_LOSSES_THRESHOLD:
                    self.current_cooldown_candles = BASE_COOLDOWN_CANDLES
                    self.global_cooldown_end_idx = -1

    def is_in_cooldown(self, cur_idx: int) -> bool:
        """
        检查当前是否处于全局冷却期。

        Args:
            cur_idx: 当前时间戳的全局索引

        Returns:
            True 如果处于冷却期，否则 False
        """
        return cur_idx < self.global_cooldown_end_idx

    def get_remaining_cooldown(self, cur_idx: int) -> int:
        """
        获取剩余冷却周期数。

        Args:
            cur_idx: 当前时间戳的全局索引

        Returns:
            剩余冷却周期数（0 表示不在冷却期）
        """
        if cur_idx >= self.global_cooldown_end_idx:
            return 0
        return self.global_cooldown_end_idx - cur_idx
