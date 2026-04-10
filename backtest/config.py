# -*- coding: utf-8 -*-
"""
回测运行配置：全局默认常量、BacktestConfig dataclass、参数注入函数。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import List

# ══════════════════════════════════════════════════════════════
#  模块级全局常量（默认值 / 单机运行时使用）
#  调用 apply_config(cfg) 可在回测前覆盖这些值
# ══════════════════════════════════════════════════════════════

INITIAL_CAPITAL: float = 1000000.0
POSITION_RATIO:  float = 0.40
MAX_POSITIONS:   int   = 2
MIN_OPEN_CASH:   float = 100.0
MAX_INIT_LOSS:   float = 0.01
MIN_RISK_REWARD_RATIO: float = 4.0

KDJ_K_MAX: float = 200.0
KDJ_D_MAX: float = 200.0
KDJ_J_MAX: float = 0.0

STOP_LOSS_FACTOR: float = 1.0
ENABLE_PARTIAL_PROFIT: bool = False
COOLDOWN_HOURS: int = 2
CONSECUTIVE_LOSSES_THRESHOLD: int = 2
BASE_COOLDOWN_CANDLES: int = 1
MAX_COOLDOWN_CANDLES: int = 10000
CONSECUTIVE_LOSSES_REDUCE_ON_PROFIT: int = 2

TIMEFRAME: str = "1h"
KLINES_DIR  = Path(f"cache/{TIMEFRAME}_klines")
OUTPUT_DIR  = Path("backtest_results")

WARMUP_BARS: int = 240
MAX_BACKTEST_BARS: int = 10000
RECENT_WINDOW: int = 9
LOOKBACK_BUFFER: int = 50

EXCLUDED_SYMBOLS: set[str] = {
    "USDCUSDT", "FDUSD", "TUSD", "BUSD", "DAI", "FRAX",
    "USDP", "EURC", "EURI", "EURUSDT", "FDUSDUSDT",
    "BFUSDUSDT", "XUSDUSDT", "USD1USDT",
}

# ──────────────────────────── 日志 ────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


# ══════════════════════════════════════════════════════════════
#  BacktestConfig dataclass
# ══════════════════════════════════════════════════════════════

@dataclass
class BacktestConfig:
    """可序列化的回测参数配置，通过 apply_config() 注入全局常量。"""

    # 资金与仓位
    initial_capital: float = 1000000.0
    position_ratio: float = 0.40
    max_positions: int = 2

    # 时间框架与日期范围
    timeframe: str = "1h"
    date_start: str = ""   # "YYYY-MM-DD"，空字符串表示不限制
    date_end: str = ""     # "YYYY-MM-DD"，空字符串表示今天

    # MA 周期列表（用于信号检测，至少需要 4 个）
    ma_periods: List[int] = field(default_factory=lambda: [30, 60, 120, 240])

    # KDJ 阈值
    kdj_k_max: float = 200.0
    kdj_d_max: float = 200.0
    kdj_j_max: float = 0.0

    # 止损与止盈
    stop_loss_factor: float = 1.0
    enable_partial_profit: bool = False
    max_init_loss: float = 0.01
    min_risk_reward_ratio: float = 4.0

    # 冷却期
    cooldown_hours: int = 2
    consecutive_losses_threshold: int = 2
    base_cooldown_candles: int = 1
    max_cooldown_candles: int = 10000
    consecutive_losses_reduce_on_profit: int = 2

    # 回测范围
    warmup_bars: int = 240
    max_backtest_bars: int = 10000
    lookback_buffer: int = 50
    min_open_cash: float = 100.0


def apply_config(cfg: BacktestConfig) -> None:
    """
    将 BacktestConfig 的值写入本模块的全局常量，
    同时更新依赖这些常量的其他子模块。

    注意：本函数不是线程安全的，调用方需确保同一时刻只有一个回测在运行。
    """
    import backtest.config as _cfg_mod
    import backtest.engine as _eng_mod
    import backtest.data as _data_mod
    import backtest.report as _rpt_mod
    import backtest.signal_scanner as _sig_mod
    import backtest.position_handler as _pos_mod
    import backtest.cooldown as _cd_mod
    import backtest.loss_tracker as _lt_mod

    # ── 本模块全局常量 ──
    _cfg_mod.INITIAL_CAPITAL          = cfg.initial_capital
    _cfg_mod.POSITION_RATIO           = cfg.position_ratio
    _cfg_mod.MAX_POSITIONS            = cfg.max_positions
    _cfg_mod.MIN_OPEN_CASH            = cfg.min_open_cash
    _cfg_mod.MAX_INIT_LOSS            = cfg.max_init_loss
    _cfg_mod.MIN_RISK_REWARD_RATIO    = cfg.min_risk_reward_ratio
    _cfg_mod.KDJ_K_MAX                = cfg.kdj_k_max
    _cfg_mod.KDJ_D_MAX                = cfg.kdj_d_max
    _cfg_mod.KDJ_J_MAX                = cfg.kdj_j_max
    _cfg_mod.STOP_LOSS_FACTOR         = cfg.stop_loss_factor
    _cfg_mod.ENABLE_PARTIAL_PROFIT    = cfg.enable_partial_profit
    _cfg_mod.COOLDOWN_HOURS           = cfg.cooldown_hours
    _cfg_mod.CONSECUTIVE_LOSSES_THRESHOLD       = cfg.consecutive_losses_threshold
    _cfg_mod.BASE_COOLDOWN_CANDLES              = cfg.base_cooldown_candles
    _cfg_mod.MAX_COOLDOWN_CANDLES               = cfg.max_cooldown_candles
    _cfg_mod.CONSECUTIVE_LOSSES_REDUCE_ON_PROFIT = cfg.consecutive_losses_reduce_on_profit
    _cfg_mod.TIMEFRAME                = cfg.timeframe
    _cfg_mod.KLINES_DIR               = Path(f"cache/{cfg.timeframe}_klines")
    _cfg_mod.WARMUP_BARS              = cfg.warmup_bars
    _cfg_mod.MAX_BACKTEST_BARS        = cfg.max_backtest_bars
    _cfg_mod.LOOKBACK_BUFFER          = cfg.lookback_buffer

    # ── 传播到依赖模块 ──
    _eng_mod.INITIAL_CAPITAL   = cfg.initial_capital
    _eng_mod.MAX_POSITIONS     = cfg.max_positions
    _eng_mod.MIN_OPEN_CASH     = cfg.min_open_cash
    _eng_mod.POSITION_RATIO    = cfg.position_ratio
    _eng_mod.STOP_LOSS_FACTOR  = cfg.stop_loss_factor
    _eng_mod.COOLDOWN_HOURS    = cfg.cooldown_hours

    _data_mod.EXCLUDED_SYMBOLS  = _cfg_mod.EXCLUDED_SYMBOLS
    _data_mod.LOOKBACK_BUFFER   = cfg.lookback_buffer
    _data_mod.MAX_BACKTEST_BARS = cfg.max_backtest_bars
    _data_mod.WARMUP_BARS       = cfg.warmup_bars

    _rpt_mod.INITIAL_CAPITAL   = cfg.initial_capital

    _sig_mod.KDJ_K_MAX              = cfg.kdj_k_max
    _sig_mod.KDJ_D_MAX              = cfg.kdj_d_max
    _sig_mod.KDJ_J_MAX              = cfg.kdj_j_max
    _sig_mod.MAX_INIT_LOSS          = cfg.max_init_loss
    _sig_mod.MIN_RISK_REWARD_RATIO  = cfg.min_risk_reward_ratio

    _pos_mod.ENABLE_PARTIAL_PROFIT  = cfg.enable_partial_profit

    _cd_mod.COOLDOWN_HOURS          = cfg.cooldown_hours

    _lt_mod.CONSECUTIVE_LOSSES_THRESHOLD            = cfg.consecutive_losses_threshold
    _lt_mod.BASE_COOLDOWN_CANDLES                   = cfg.base_cooldown_candles
    _lt_mod.MAX_COOLDOWN_CANDLES                    = cfg.max_cooldown_candles
    _lt_mod.CONSECUTIVE_LOSSES_REDUCE_ON_PROFIT     = cfg.consecutive_losses_reduce_on_profit
