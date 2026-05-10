# -*- coding: utf-8 -*-
"""
择时模块配置文件
"""

import os

# 择时模块根目录
TIMING_ROOT = os.path.dirname(os.path.abspath(__file__))

# 复用 version 1 的 tushare token
TUSHARE_TOKEN = "65acf52fb110ef6d30b3c37017cc1b93a8bf963855b98934ed2ada42"

# 数据存储目录（复用已有数据目录）
PROJECT_ROOT = os.path.dirname(TIMING_ROOT)
STOCK_DATA_DIR = os.path.join(PROJECT_ROOT, "stock_data")

# 择时数据缓存目录
TIMING_DATA_DIR = os.path.join(TIMING_ROOT, "data")
os.makedirs(TIMING_DATA_DIR, exist_ok=True)

# ==================== 数据源配置 ====================

# 指数代码
INDEX_CODES = {
    "sh": "000001.SH",      # 上证指数
    "sz": "399001.SZ",      # 深证成指
    "cy": "399006.SZ",      # 创业板指
}

# A股平均股价（通达信代码，tushare可能不支持，需fallback）
AVG_PRICE_CODE = "880003.SH"

# 融资余额数据路径（已有本地数据）
MARGIN_FILE = os.path.join(STOCK_DATA_DIR, "macro_data", "market_margin.csv")

# 指数数据路径
INDEX_DATA_DIR = os.path.join(STOCK_DATA_DIR, "index_data")
INDEX_DAILYBASIC_DIR = os.path.join(STOCK_DATA_DIR, "index_dailybasic")

# ==================== 择时参数配置 ====================

# 均线周期
MA_SHORT = 20      # 短期均线（趋势判断）
MA_LONG = 60       # 长期均线（破位判断）

# 破位阈值：跌破近期N日低点
LOW_WINDOW = 30

# 成交额判断阈值
VOLUME_RATIO_THRESHOLD = 1.1   # 放量/缩量比例阈值

# 信号权重（可调整）
FACTOR_WEIGHTS = {
    "avg_price": 1.0,      # A股平均股价
    "margin": 1.0,         # 融资余额
    "turnover": 0.8,       # 两市成交额
    "index_trend": 1.0,    # 指数趋势（三指数综合）
    "active_mv": 1.5,      # 活跃市值（0AMV，拐点信号，权重稍高）
}

# ============== 0AMV 阈值配置 ==============
OAMV_BULL_THRESHOLD = 2.5       # 空转多单日阈值：单日涨幅 >= +2.5%
OAMV_BEAR_THRESHOLD = -1.8      # 多转空单日阈值：单日跌幅 <= -1.8%
OAMV_BULL_CUM2_THRESHOLD = 2.8    # 空转多2日累计备份：2日累计涨幅 >= +2.8%

# ============== 二档信号阈值（严格模式，目标准确率95%+） ==============
# 只有"多头"和"空头"两档，无中性/强多头/强空头
# 多头阈值：所有因子必须同时看涨（score >= 全部因子加权正值之和）
# 实际运行中，当 score >= BULL_THRESHOLD 时输出"多头"，否则"空头"

# 5个因子最大加权正值 = 1.0 + 1.0 + 0.8 + 1.0 + 1.5 = 5.3
BULL_THRESHOLD = 2.0    # 多头阈值：放宽到2.0，允许部分因子中性/偏差
BEAR_THRESHOLD = -1.0   # 空头阈值：低于此严格判定为空头（实际非多头即空头）

# 二档仓位映射
POSITION_MAP = {
    "多头": 1.00,   # 满仓/加杠杆
    "空头": 0.00,   # 空仓/只卖不买
}
