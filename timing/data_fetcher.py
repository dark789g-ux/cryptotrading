# -*- coding: utf-8 -*-
"""
择时模块数据获取层
封装 tushare 及本地数据读取，为各因子提供统一数据接口
"""

import os
import pandas as pd
import tushare as ts
from datetime import datetime, timedelta

from timing.config import (
    TUSHARE_TOKEN,
    TIMING_DATA_DIR,
    STOCK_DATA_DIR,
    INDEX_CODES,
    AVG_PRICE_CODE,
    MARGIN_FILE,
    INDEX_DATA_DIR,
)

# 初始化 tushare pro
pro = ts.pro_api(TUSHARE_TOKEN)


def _cache_path(name: str) -> str:
    """生成缓存文件路径"""
    return os.path.join(TIMING_DATA_DIR, f"{name}.csv")


def _save_cache(name: str, df: pd.DataFrame):
    """保存数据到缓存"""
    if df is not None and not df.empty:
        path = _cache_path(name)
        df.to_csv(path, index=False, encoding="utf-8-sig")


def _load_cache(name: str, max_days: int = 1) -> pd.DataFrame:
    """
    读取缓存数据
    :param max_days: 缓存最大有效期（天），超过则返回None
    """
    path = _cache_path(name)
    if not os.path.exists(path):
        return None
    mtime = datetime.fromtimestamp(os.path.getmtime(path))
    if (datetime.now() - mtime).days > max_days:
        return None
    return pd.read_csv(path)


def fetch_index_daily(ts_code: str, start_date: str = None, end_date: str = None) -> pd.DataFrame:
    """
    获取指数日线数据
    优先读本地已有数据，如本地最新日期滞后，则从 tushare 补全并合并保存
    """
    local_file = os.path.join(INDEX_DATA_DIR, f"{ts_code}.csv")
    df_local = None

    if os.path.exists(local_file):
        df_local = pd.read_csv(local_file)
        # 统一列名格式
        if "trade_date" in df_local.columns:
            df_local["trade_date"] = df_local["trade_date"].astype(str)
        df_local = df_local.sort_values("trade_date").reset_index(drop=True)

    # 检查是否需要补数据
    today = datetime.now().strftime("%Y%m%d")
    need_fetch = False
    fetch_start = None

    if df_local is None or df_local.empty:
        need_fetch = True
        if end_date is None:
            end_date = today
        if start_date is None:
            start_date = (datetime.now() - timedelta(days=365 * 3)).strftime("%Y%m%d")
        fetch_start = start_date
    else:
        last_date = str(df_local["trade_date"].iloc[-1])
        # 如果最新日期不是今天（或更晚），需要补数据
        if last_date < today:
            need_fetch = True
            fetch_start = last_date  # 从本地最后一天开始（会包含重复，后续去重）
        if end_date is None:
            end_date = today

    if need_fetch:
        try:
            df_new = pro.index_daily(ts_code=ts_code, start_date=fetch_start, end_date=end_date)
            if df_new is not None and not df_new.empty:
                df_new = df_new.sort_values("trade_date").reset_index(drop=True)
                if df_local is not None:
                    # 合并去重，新数据优先
                    df_merged = pd.concat([df_local, df_new], ignore_index=True)
                    df_merged = df_merged.drop_duplicates(subset=["trade_date"], keep="last")
                    df_merged = df_merged.sort_values("trade_date").reset_index(drop=True)
                    # 保存回本地
                    df_merged.to_csv(local_file, index=False, encoding="utf-8-sig")
                    return df_merged
                else:
                    # 首次获取，直接保存
                    df_new.to_csv(local_file, index=False, encoding="utf-8-sig")
                    return df_new
        except Exception as e:
            print(f"[WARN] tushare 补数据失败 {ts_code}: {e}")

    return df_local


def fetch_avg_price(start_date: str = None, end_date: str = None) -> pd.DataFrame:
    """
    获取 A股平均股价（880003.SH）
    880003 是通达信自定义指数，tushare 标准接口可能不支持，
    尝试 pro_bar(asset='I')，失败则返回 None（由调用方处理 fallback）
    """
    cache = _load_cache("avg_price_880003", max_days=1)
    if cache is not None:
        return cache

    if end_date is None:
        end_date = datetime.now().strftime("%Y%m%d")
    if start_date is None:
        start_date = (datetime.now() - timedelta(days=365 * 2)).strftime("%Y%m%d")

    try:
        # 尝试用 pro_bar 获取指数数据
        df = ts.pro_bar(
            ts_code=AVG_PRICE_CODE,
            asset="I",
            start_date=start_date,
            end_date=end_date,
        )
        if df is not None and not df.empty:
            df = df.sort_values("trade_date").reset_index(drop=True)
            _save_cache("avg_price_880003", df)
            return df
    except Exception as e:
        print(f"[WARN] tushare 获取平均股价 {AVG_PRICE_CODE} 失败: {e}")

    return None


def fetch_margin_data() -> pd.DataFrame:
    """
    获取融资余额数据
    优先读取本地 market_margin.csv，如本地无数据或不全，再考虑 tushare margin 接口
    """
    if os.path.exists(MARGIN_FILE):
        df = pd.read_csv(MARGIN_FILE)
        # 统一列名
        df.rename(
            columns={
                "mkt_rzye": "rzye",
                "mkt_rzmre": "rzmre",
                "mkt_rzrqye": "rzrqye",
            },
            inplace=True,
        )
        df["trade_date"] = df["trade_date"].astype(str)
        df = df.sort_values("trade_date").reset_index(drop=True)
        return df

    # 本地无数据，尝试 tushare margin 接口（日度数据量较大，取最近2年）
    try:
        end_date = datetime.now().strftime("%Y%m%d")
        start_date = (datetime.now() - timedelta(days=365 * 2)).strftime("%Y%m%d")
        df = pro.margin(start_date=start_date, end_date=end_date)
        if df is not None and not df.empty:
            df = df.sort_values("trade_date").reset_index(drop=True)
            return df
    except Exception as e:
        print(f"[WARN] tushare 获取融资余额失败: {e}")

    return None


def fetch_moneyflow_summary(start_date: str = None, end_date: str = None) -> pd.DataFrame:
    """
    获取两市成交额汇总数据
    由于 tushare 无直接的全市场成交额接口，这里用上证指数+深证成指的 amount 近似
    """
    sh_df = fetch_index_daily(INDEX_CODES["sh"], start_date, end_date)
    sz_df = fetch_index_daily(INDEX_CODES["sz"], start_date, end_date)

    if sh_df is None or sz_df is None:
        return None

    # 合并上证+深证的 amount（注意 amount 单位通常是千元）
    sh = sh_df[["trade_date", "amount"]].copy()
    sh.rename(columns={"amount": "sh_amount"}, inplace=True)

    sz = sz_df[["trade_date", "amount"]].copy()
    sz.rename(columns={"amount": "sz_amount"}, inplace=True)

    merged = pd.merge(sh, sz, on="trade_date", how="inner")
    merged["total_amount"] = merged["sh_amount"] + merged["sz_amount"]
    merged = merged.sort_values("trade_date").reset_index(drop=True)
    return merged


def fetch_all_index_data(start_date: str = None, end_date: str = None) -> dict:
    """
    批量获取所有关注指数的日线数据
    返回 dict: {name: DataFrame}
    """
    result = {}
    for name, code in INDEX_CODES.items():
        df = fetch_index_daily(code, start_date, end_date)
        if df is not None:
            result[name] = df
    return result
