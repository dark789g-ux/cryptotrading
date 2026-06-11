
"""
底部放天量涨停 - 次日开盘买入策略 量化分析
分析日期: 2026-06-05
数据源: ifind A股历史行情数据
"""
import pandas as pd
import numpy as np

def comprehensive_bottom_analysis(df_stock):
    """综合分析: 识别'底部放天量涨停'信号"""
    df = df_stock.copy().sort_values('time').reset_index(drop=True)
    if len(df) < 130:
        return None

    # 涨跌幅
    df['price_change_pct'] = df['close'].pct_change() * 100

    # 涨停判断
    ticker = df['thscode'].iloc[0]
    if '.SH' in ticker and ticker.startswith('688'):
        up_limit = 19.5  # 科创板 20%
    elif '.SZ' in ticker and (ticker.startswith('300') or ticker.startswith('301')):
        up_limit = 19.5  # 创业板 20%
    else:
        up_limit = 9.5   # 主板 10%
    df['is_limit_up'] = df['price_change_pct'] >= up_limit

    # 底部定义1: 120日价格区间底部25%
    df['low_120'] = df['low'].rolling(120, min_periods=120).min()
    df['high_120'] = df['high'].rolling(120, min_periods=120).max()
    df['range_120'] = df['high_120'] - df['low_120']
    df['pos_120'] = (df['close'] - df['low_120']) / (df['range_120'] + 1e-10)
    df['is_bottom_120'] = df['pos_120'] < 0.25

    # 底部定义2: 60日价格区间底部20%
    df['low_60'] = df['low'].rolling(60, min_periods=60).min()
    df['high_60'] = df['high'].rolling(60, min_periods=60).max()
    df['range_60'] = df['high_60'] - df['low_60']
    df['pos_60'] = (df['close'] - df['low_60']) / (df['range_60'] + 1e-10)
    df['is_bottom_60'] = df['pos_60'] < 0.20

    # 底部定义3: 收盘价低于60日均线10%
    df['ma_60'] = df['close'].rolling(60, min_periods=60).mean()
    df['is_below_ma'] = df['close'] < df['ma_60'] * 0.90

    # 成交量分析
    df['avg_vol_60'] = df['volume'].rolling(60, min_periods=60).mean()
    df['avg_vol_120'] = df['volume'].rolling(120, min_periods=120).mean()
    df['vol_ratio_60'] = df['volume'] / (df['avg_vol_60'] + 1)
    df['vol_ratio_120'] = df['volume'] / (df['avg_vol_120'] + 1)
    df['is_heavy_vol'] = (df['vol_ratio_60'] > 2.0) | (df['vol_ratio_120'] > 2.0)

    # 综合信号
    df['is_bottom'] = df['is_bottom_120'] | df['is_bottom_60'] | df['is_below_ma']
    df['signal'] = df['is_bottom'] & df['is_heavy_vol'] & df['is_limit_up']

    return df

def calculate_next_day_performance(df_stock, signal_date):
    """计算次日开盘买入,当日收盘卖出的收益"""
    df = df_stock.sort_values('time').reset_index(drop=True)
    signal_idx = df[df['time'] == signal_date].index
    if len(signal_idx) == 0 or signal_idx[0] + 1 >= len(df):
        return None

    signal_idx = signal_idx[0]
    next_day = df.iloc[signal_idx + 1]

    buy_price = next_day['open']
    sell_price = next_day['close']
    profit_pct = (sell_price - buy_price) / buy_price * 100

    return {
        'buy_price': buy_price,
        'sell_price': sell_price,
        'profit_pct': profit_pct,
        'is_profit': profit_pct > 0
    }
