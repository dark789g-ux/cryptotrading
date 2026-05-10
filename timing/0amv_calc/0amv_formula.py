# -*- coding: utf-8 -*-
"""
0AMV 精确计算模块 - 核心公式实现

数据源：中证A股指数 930903.CSI（tushare index_daily）
公式来源：登月者6477 提供的通达信风格公式

核心参数：
    OAMVN = 10      # SMA 平滑周期
    OAMVK = 0.937   # 拟合系数（针对 930903 优化）

注意：tushare index_daily 返回的 amount 字段单位是【千元】，
      公式中的 AMOUNT 默认单位是【元】，因此计算前需先 ×1000 换算。
"""

import pandas as pd
import numpy as np

# ==================== 参数配置 ====================
OAMVN = 10          # SMA 平滑周期
OAMVK = 0.87        # 拟合系数（登月者6477 校准后，从 0.937 调低）
OAMV_AMOUNT_DIV = 1_000_000  # 公式中的固定除数


# ==================== 通达信风格递推计算 ====================

def td_sma(series: pd.Series, n: int = 10, m: int = 1) -> pd.Series:
    """
    通达信风格 SMA 递推计算

    递推公式: SMA_t = (M * X_t + (N - M) * SMA_{t-1}) / N
    当 M=1, N=10 时: SMA_t = (X_t + 9 * SMA_{t-1}) / 10

    初始值：取第一个有效数据点
    """
    result = np.empty(len(series))
    result[:] = np.nan

    sma = None
    for i in range(len(series)):
        x = series.iloc[i]
        if pd.isna(x):
            result[i] = np.nan
            continue
        if sma is None:
            sma = x  # 初始值
        else:
            sma = (m * x + (n - m) * sma) / n
        result[i] = sma

    return pd.Series(result, index=series.index)


def td_ema(series: pd.Series, n: int = 12) -> pd.Series:
    """
    通达信风格 EMA 递推计算

    递推公式: EMA_t = (2 * X_t + (N - 1) * EMA_{t-1}) / (N + 1)
    当 N=12 时: EMA_t = (2 * X_t + 11 * EMA_{t-1}) / 13

    初始值：取第一个有效数据点
    """
    result = np.empty(len(series))
    result[:] = np.nan

    ema = None
    for i in range(len(series)):
        x = series.iloc[i]
        if pd.isna(x):
            result[i] = np.nan
            continue
        if ema is None:
            ema = x  # 初始值
        else:
            ema = (2 * x + (n - 1) * ema) / (n + 1)
        result[i] = ema

    return pd.Series(result, index=series.index)


# ==================== 0AMV 核心计算 ====================

def calc_0amv(df: pd.DataFrame) -> pd.DataFrame:
    """
    计算 0AMV 指标

    输入：中证A股指数 930903.CSI 的日线数据 DataFrame
          必须包含列: trade_date, open, high, low, close, amount
          其中 amount 单位是【千元】（tushare 标准）

    输出：DataFrame 增加以下列：
        oamvv1      : 成交额平滑值（亿元量级）
        oamvv3      : 价格基准（前一日收盘价的5日均线）
        oamvo       : 0AMV 开盘价
        oamvh       : 0AMV 最高价
        oamvl       : 0AMV 最低价
        oamvc       : 0AMV 收盘价（核心指标）
        oamv_zdf    : 0AMV 涨幅（%）
        oamv_smx    : 生命线（OAMVC 的 EMA12）
    """
    df = df.copy()

    # 按日期排序，确保递推正确
    df = df.sort_values("trade_date").reset_index(drop=True)

    # --- Step 1: 成交额平滑 ---
    # 注意：tushare amount 单位是千元，公式默认单位是元，需先 ×1000
    amount_yuan = df["amount"] * 1000.0
    oamvv1_raw = td_sma(amount_yuan, n=OAMVN, m=1)
    df["oamvv1"] = oamvv1_raw / OAMV_AMOUNT_DIV

    # --- Step 2: 价格基准（前一日收盘价的5日均线）---
    ref_close_1 = df["close"].shift(1)  # REF(CLOSE, 1)
    df["oamvv3"] = ref_close_1.rolling(window=5, min_periods=1).mean()

    # --- Step 3: OAMV 四价 ---
    # OAMV_price = OAMVV1 * price / OAMVV3 * 0.1 * OAMVK
    multiplier = 0.1 * OAMVK
    df["oamvo"] = df["oamvv1"] * df["open"] / df["oamvv3"] * multiplier
    df["oamvh"] = df["oamvv1"] * df["high"] / df["oamvv3"] * multiplier
    df["oamvl"] = df["oamvv1"] * df["low"] / df["oamvv3"] * multiplier
    df["oamvc"] = df["oamvv1"] * df["close"] / df["oamvv3"] * multiplier

    # --- Step 4: 衍生指标 ---
    # OAMV涨幅 = (OAMVC - REF(OAMVC, 1)) / REF(OAMVC, 1) * 100
    ref_oamvc_1 = df["oamvc"].shift(1)
    df["oamv_zdf"] = (df["oamvc"] - ref_oamvc_1) / ref_oamvc_1 * 100.0

    # 生命线 = EMA(OAMVC, 12)
    df["oamv_smx"] = td_ema(df["oamvc"], n=12)

    return df


def validate_0amv_values(df: pd.DataFrame) -> dict:
    """
    验证 0AMV 计算结果是否在合理范围

    正常范围参考（基于历史观察）：
        OAMVC 通常在 15万 ~ 30万 量级
        若出现负值、< 1万 或 > 100万，需检查公式或数据
    """
    oamvc = df["oamvc"]
    valid = oamvc.dropna()

    issues = []
    if (oamvc < 0).any():
        issues.append("存在负值，请检查输入数据")
    if valid.min() < 10_000:
        issues.append(f"最小值过低 ({valid.min():.2f})，可能单位换算有误")
    if valid.max() > 1_000_000:
        issues.append(f"最大值过高 ({valid.max():.2f})，可能单位换算有误")

    stats = {
        "count": len(valid),
        "min": valid.min(),
        "max": valid.max(),
        "mean": valid.mean(),
        "latest": oamvc.iloc[-1] if not oamvc.empty else None,
        "latest_date": df["trade_date"].iloc[-1] if not df.empty else None,
        "issues": issues,
        "ok": len(issues) == 0,
    }
    return stats
