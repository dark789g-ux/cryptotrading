# -*- coding: utf-8 -*-
"""
回测运行配置：所有常量、路径与日志初始化。
"""

from __future__ import annotations

import logging
from pathlib import Path

# ══════════════════════════════════════════════════════════════
#  运行配置
# ══════════════════════════════════════════════════════════════

INITIAL_CAPITAL: float = 1000000.0   # 初始资金（USDT）
POSITION_RATIO:  float = 0.40       # 单仓资金占比
MAX_POSITIONS:   int   = 2          # 正常最大持仓数
MIN_OPEN_CASH:   float = 100.0      # 开仓所需最低现金门槛
MAX_INIT_LOSS:   float = 0.01       # 初次止损最大亏损比例（如 0.01 = 1%）
MIN_RISK_REWARD_RATIO: float = 4   # 最小盈亏比（盈亏比必须大于此值才能入场）

# KDJ 阈值设置：K、D、J 必须同时小于对应阈值才允许入场
KDJ_K_MAX: float = 200.0   # K 值最大阈值
KDJ_D_MAX: float = 200.0   # D 值最大阈值
KDJ_J_MAX: float = 0.0   # J 值最大阈值

# 止损价系数：阶段低点 × 此系数 = 初始止损价（如 0.98 表示给2%缓冲空间）
STOP_LOSS_FACTOR: float = 1

# 是否启用阶段止盈：当 high >= 近期高点时卖出一半仓位
ENABLE_PARTIAL_PROFIT: bool = False

# 冷却期：同一交易对平仓后多少小时内禁止再次入场（防止过度交易）
COOLDOWN_HOURS: int = 2

# 连续亏损冷却配置（全局冷却）
CONSECUTIVE_LOSSES_THRESHOLD: int = 2   # 触发冷却的连续亏损笔数
BASE_COOLDOWN_CANDLES: int = 1          # 基础冷却周期数（1个K线）
MAX_COOLDOWN_CANDLES: int = 10000          # 最大冷却周期数上限
CONSECUTIVE_LOSSES_REDUCE_ON_PROFIT: int = 2  # 盈利后连续亏损计数器减少的数值

# 回测使用的 K 线时间框架：可选 "1h" / "4h" / "1d"
TIMEFRAME: str = "1h"

KLINES_DIR  = Path(f"cache/{TIMEFRAME}_klines")
OUTPUT_DIR  = Path("backtest_results")

# 指标预热期：至少需要 240 根有效 K 线才开始参与回测（MA240 需要 240 根稳定）
WARMUP_BARS: int = 240

# 每个交易对参与回测的最大 K 线数（0 = 不限制，使用全部数据）
# 1h K线：8760 ≈ 1年，4380 ≈ 半年，2190 ≈ 3个月
MAX_BACKTEST_BARS: int = 10000

# calc_recent_high/low 初始窗口：买入点前 N 根 K 线作为阶段高/低点的起始范围
RECENT_WINDOW: int = 9

# calc_recent_high/low 向前回溯的最大 K 线数
# 这些额外的行不参与信号生成，只用于计算近期高低价
LOOKBACK_BUFFER: int = 50

# 不参与交易的交易对（稳定币、与 USDT 高度锚定的币种等）
# symbol 格式：不含 USDT 后缀，直接写 base asset，如 "USDC" 对应 USDCUSDT
EXCLUDED_SYMBOLS: set[str] = {
    "USDCUSDT",        # USD Coin
    "FDUSD",       # First Digital USD
    "TUSD",        # TrueUSD
    "BUSD",        # Binance USD（已下架，保留以防缓存中残留）
    "DAI",         # Dai
    "FRAX",        # Frax
    "USDP",        # Pax Dollar
    "EURC",        # EUR Coin
    "EURI",        # EURi Stablecoin
    "EURUSDT",         # Euro（法币锚定）
    "FDUSDUSDT",   # 防止带全名的情况
    "BFUSDUSDT",   # Bitfinex USD
    "XUSDUSDT",    # XUSDUSDT
    "USD1USDT"
}

# ──────────────────────────── 日志 ────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)
