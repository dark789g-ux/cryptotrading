# -*- coding: utf-8 -*-
"""
活跃市值(0AMV)数据获取 - 通过 stock.svip886.com API

API: https://stock.svip886.com/api/indexes
返回文本格式:
  活跃市值(0AMV)：231888.8（+0.91%）
  上证指数（000001）：4179.95（+-0.00%）
  深证成指（399001）：15563.80（-0.50%）
  创业板指（399006）：3796.13（-0.96%）
  两市成交额：30485 亿（+0.00%）
  ...

数据更新时间: 盘中实时（约1-5分钟延迟）
"""

import re
import urllib.request
from datetime import datetime
import pandas as pd
import os

from timing.config import TIMING_DATA_DIR


def fetch_0amv_via_api():
    """
    从 stock.svip886.com API 获取活跃市值及市场数据

    Returns:
        dict: {
            'trade_date': str,
            '0amv': float,
            '0amv_chg_pct': float,
            'sh_close': float,
            'sh_chg_pct': float,
            'sz_close': float,
            'sz_chg_pct': float,
            'cy_close': float,
            'cy_chg_pct': float,
            'total_amount_yi': float,
            'amount_chg_pct': float,
        }
        或 None (请求失败)
    """
    url = "https://stock.svip886.com/api/indexes"
    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                "Accept": "text/plain",
            },
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            text = resp.read().decode("utf-8")
    except Exception as e:
        print(f"[WARN] 0AMV API 请求失败: {e}")
        return None

    # 解析文本
    result = {
        "trade_date": datetime.now().strftime("%Y%m%d"),
        "fetch_time": datetime.now().strftime("%H:%M:%S"),
    }

    # 活跃市值: 活跃市值(0AMV)：231888.8（+0.91%）
    match = re.search(r"0AMV\u00ef\u00bc\u009a\u00ef\u00bc\u0090([\d.]+)\u00ef\u00bc\u0088([+-]?[\d.]+)%\u00ef\u00bc\u0089", text)
    if not match:
        # Try another pattern
        match = re.search(r"0AMV.*?([\d,.]+).*?([+-]?[\d.]+)%", text)
    if match:
        result["0amv"] = float(match.group(1).replace(",", ""))
        result["0amv_chg_pct"] = float(match.group(2))
    else:
        # Fallback: search for the numbers near 0AMV
        lines = text.split("\n")
        for line in lines:
            if "0AMV" in line or "\u6d3b\u8dc3\u5e02\u503c" in line:
                nums = re.findall(r"[\d,.]+", line)
                if len(nums) >= 2:
                    result["0amv"] = float(nums[0].replace(",", ""))
                    result["0amv_chg_pct"] = float(nums[1].replace(",", ""))
                break

    # 上证指数: 上证指数（000001）：4179.95（+-0.00%）
    match = re.search(r"000001\u00ef\u00bc\u0089\u00ef\u00bc\u009a([\d.]+)\u00ef\u00bc\u0088([+-]?[\d.]+)%\u00ef\u00bc\u0089", text)
    if match:
        result["sh_close"] = float(match.group(1))
        result["sh_chg_pct"] = float(match.group(2))

    # 深证成指: 深证成指（399001）：15563.80（-0.50%）
    match = re.search(r"399001\u00ef\u00bc\u0089\u00ef\u00bc\u009a([\d.]+)\u00ef\u00bc\u0088([+-]?[\d.]+)%\u00ef\u00bc\u0089", text)
    if match:
        result["sz_close"] = float(match.group(1))
        result["sz_chg_pct"] = float(match.group(2))

    # 创业板指: 创业板指（399006）：3796.13（-0.96%）
    match = re.search(r"399006\u00ef\u00bc\u0089\u00ef\u00bc\u009a([\d.]+)\u00ef\u00bc\u0088([+-]?[\d.]+)%\u00ef\u00bc\u0089", text)
    if match:
        result["cy_close"] = float(match.group(1))
        result["cy_chg_pct"] = float(match.group(2))

    # 两市成交额: 两市成交额：30485 亿（+0.00%）
    match = re.search(r"([\d,.]+)\s*\u4ebf\u00ef\u00bc\u0088([+-]?[\d.]+)%\u00ef\u00bc\u0089", text)
    if match:
        result["total_amount_yi"] = float(match.group(1).replace(",", ""))
        result["amount_chg_pct"] = float(match.group(2))

    return result if "0amv" in result else None


def fetch_0amv_history():
    """
    获取本地缓存的 0AMV 历史数据

    Returns:
        pd.DataFrame or None
    """
    cache_path = os.path.join(TIMING_DATA_DIR, "0amv_history.csv")
    if os.path.exists(cache_path):
        df = pd.read_csv(cache_path, dtype={"trade_date": str})
        df["trade_date"] = pd.to_datetime(df["trade_date"])
        return df
    return None


def save_0amv_snapshot(data: dict):
    """
    将 API 获取的 0AMV 快照追加到本地缓存
    """
    cache_path = os.path.join(TIMING_DATA_DIR, "0amv_history.csv")
    os.makedirs(TIMING_DATA_DIR, exist_ok=True)

    # 转为 DataFrame
    df_new = pd.DataFrame([data])

    # 合并已有数据
    if os.path.exists(cache_path):
        df_old = pd.read_csv(cache_path, dtype={"trade_date": str})
        df_combined = pd.concat([df_old, df_new], ignore_index=True)
        # 去重
        df_combined = df_combined.drop_duplicates(subset=["trade_date"], keep="last")
    else:
        df_combined = df_new

    df_combined.to_csv(cache_path, index=False, encoding="utf-8-sig")
    return df_combined


def get_0amv_data():
    """
    获取 0AMV 数据（优先 API，fallback 本地缓存）

    Returns:
        pd.DataFrame: 包含 0AMV 历史数据
    """
    # 先尝试 API 获取最新
    api_data = fetch_0amv_via_api()
    if api_data:
        df = save_0amv_snapshot(api_data)
        print(f"[0AMV] API 获取成功: {api_data['0amv']}, 涨跌: {api_data.get('0amv_chg_pct', 'N/A')}%")
        return df
    else:
        print("[0AMV] API 失败，回退到本地缓存")
        return fetch_0amv_history()


if __name__ == "__main__":
    data = fetch_0amv_via_api()
    if data:
        print("API 获取成功:")
        for k, v in data.items():
            print(f"  {k}: {v}")
    else:
        print("API 获取失败")
