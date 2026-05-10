# -*- coding: utf-8 -*-
"""
0AMV 历史转折点分析

用 14 个择时验证的历史转折点，归纳 0AMV 涨幅阈值规则。
"""

import os
import sys
from datetime import datetime, timedelta

import pandas as pd
import tushare as ts

# 加载 0AMV 计算模块
_curr_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _curr_dir)
import importlib.util
_spec = importlib.util.spec_from_file_location(
    "oamv_formula", os.path.join(_curr_dir, "0amv_formula.py")
)
_oamv_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_oamv_mod)
calc_0amv = _oamv_mod.calc_0amv

TUSHARE_TOKEN = "65acf52fb110ef6d30b3c37017cc1b93a8bf963855b98934ed2ada42"
TS_CODE = "930903.CSI"

# 14 个历史转折点（按时间倒序排列）
HISTORICAL_TURNS = [
    ("2026-04-08", "空转多"),
    ("2026-02-02", "多转空"),
    ("2025-12-08", "空转多"),
    ("2025-09-04", "多转空"),
    ("2025-06-24", "空转多"),
    ("2025-05-15", "多转空"),
    ("2025-05-06", "空转多"),
    ("2025-04-16", "多转空"),
    ("2025-04-08", "空转多"),
    ("2025-02-28", "多转空"),
    ("2025-02-06", "空转多"),
    ("2025-01-27", "多转空"),
    ("2025-01-14", "空转多"),
    ("2024-12-17", "多转空"),
]


def fetch_history(start: str, end: str) -> pd.DataFrame:
    """拉取指定日期范围的 930903 数据"""
    pro = ts.pro_api(TUSHARE_TOKEN)
    df = pro.index_daily(ts_code=TS_CODE, start_date=start, end_date=end)
    df = df.sort_values("trade_date").reset_index(drop=True)
    return df


def analyze_turns(df: pd.DataFrame) -> pd.DataFrame:
    """
    分析 14 个转折点
    """
    results = []
    for date_str, turn_type in HISTORICAL_TURNS:
        row = df[df["trade_date"] == date_str.replace("-", "")]
        if row.empty:
            results.append({
                "date": date_str,
                "turn": turn_type,
                "oamvc": None,
                "oamv_zdf": None,
                "oamv_smx": None,
                "note": "无数据",
            })
            continue

        idx = row.index[0]
        oamvc = row["oamvc"].values[0]
        zdf = row["oamv_zdf"].values[0]
        smx = row["oamv_smx"].values[0]

        # 提取前后 5 天的涨幅序列
        start_idx = max(0, idx - 5)
        end_idx = min(len(df) - 1, idx + 5)
        window = df.iloc[start_idx:end_idx + 1][["trade_date", "oamv_zdf"]].copy()
        window["days_from_turn"] = list(range(start_idx - idx, end_idx - idx + 1))

        # 提取前 5 天涨幅序列（转折前）
        pre_window = df.iloc[max(0, idx - 5):idx][["trade_date", "oamv_zdf", "oamvc"]].copy()
        pre_zdf_list = pre_window["oamv_zdf"].tolist()
        pre_dates = pre_window["trade_date"].tolist()

        # 提取后 5 天涨幅序列（转折后）
        post_window = df.iloc[idx + 1:min(len(df), idx + 6)][["trade_date", "oamv_zdf", "oamvc"]].copy()
        post_zdf_list = post_window["oamv_zdf"].tolist()

        results.append({
            "date": date_str,
            "turn": turn_type,
            "oamvc": oamvc,
            "oamv_zdf": zdf,
            "oamv_smx": smx,
            "pre_5d_zdf": pre_zdf_list,
            "pre_5d_dates": pre_dates,
            "post_5d_zdf": post_zdf_list,
            "pre_sum_2d": sum(pre_zdf_list[-2:]) if len(pre_zdf_list) >= 2 else None,
            "pre_sum_3d": sum(pre_zdf_list[-3:]) if len(pre_zdf_list) >= 3 else None,
            "pre_sum_5d": sum(pre_zdf_list) if len(pre_zdf_list) >= 5 else None,
            "post_sum_2d": sum(post_zdf_list[:2]) if len(post_zdf_list) >= 2 else None,
            "post_sum_3d": sum(post_zdf_list[:3]) if len(post_zdf_list) >= 3 else None,
            "max_pre_single": max(pre_zdf_list) if pre_zdf_list else None,
            "min_pre_single": min(pre_zdf_list) if pre_zdf_list else None,
        })

    return pd.DataFrame(results)


def print_analysis(df_result: pd.DataFrame):
    """打印分析报告"""
    print("=" * 80)
    print("0AMV 历史转折点分析报告")
    print("=" * 80)

    # 1. 每个转折点的当日数据
    print("\n【一】14 个转折点当日 0AMV 数据")
    print("-" * 80)
    for _, row in df_result.iterrows():
        zdf_str = f"{row['oamv_zdf']:+.2f}%" if pd.notna(row['oamv_zdf']) else "N/A"
        oamvc_str = f"{row['oamvc']:,.2f}" if pd.notna(row['oamvc']) else "N/A"
        print(f"  {row['date']}  {row['turn']:6s}  OAMVC={oamvc_str:>14s}  涨幅={zdf_str:>8s}")

    # 2. 空转多分析
    print("\n【二】空转多 转折点分析（共 {} 个）".format(len(df_result[df_result["turn"] == "空转多"])))
    print("-" * 80)
    bull_turns = df_result[df_result["turn"] == "空转多"].copy()
    print("  当日涨幅分布:")
    bull_zdf = bull_turns["oamv_zdf"].dropna()
    print(f"    中位数: {bull_zdf.median():+.2f}%")
    print(f"    平均值: {bull_zdf.mean():+.2f}%")
    print(f"    最小值: {bull_zdf.min():+.2f}%")
    print(f"    最大值: {bull_zdf.max():+.2f}%")

    print("\n  转折前 2 日累计涨幅:")
    pre2 = bull_turns["pre_sum_2d"].dropna()
    print(f"    中位数: {pre2.median():+.2f}%")
    print(f"    平均值: {pre2.mean():+.2f}%")
    print(f"    最小值: {pre2.min():+.2f}%")
    print(f"    最大值: {pre2.max():+.2f}%")

    print("\n  转折前 3 日累计涨幅:")
    pre3 = bull_turns["pre_sum_3d"].dropna()
    print(f"    中位数: {pre3.median():+.2f}%")
    print(f"    平均值: {pre3.mean():+.2f}%")
    print(f"    最小值: {pre3.min():+.2f}%")
    print(f"    最大值: {pre3.max():+.2f}%")

    print("\n  转折前 5 日累计涨幅:")
    pre5 = bull_turns["pre_sum_5d"].dropna()
    print(f"    中位数: {pre5.median():+.2f}%")
    print(f"    平均值: {pre5.mean():+.2f}%")
    print(f"    最小值: {pre5.min():+.2f}%")
    print(f"    最大值: {pre5.max():+.2f}%")

    # 打印每个空转多的前 5 天明细
    print("\n  空转多 前 5 日涨幅序列:")
    for _, row in bull_turns.iterrows():
        zdfs = row["pre_5d_zdf"]
        dates = row["pre_5d_dates"]
        if zdfs:
            seq = "  ".join([f"{d[-4:]}:{z:+.2f}%" for d, z in zip(dates, zdfs)])
            print(f"    {row['date']}  [{seq}]")

    # 3. 多转空分析
    print("\n【三】多转空 转折点分析（共 {} 个）".format(len(df_result[df_result["turn"] == "多转空"])))
    print("-" * 80)
    bear_turns = df_result[df_result["turn"] == "多转空"].copy()
    print("  当日跌幅分布:")
    bear_zdf = bear_turns["oamv_zdf"].dropna()
    print(f"    中位数: {bear_zdf.median():+.2f}%")
    print(f"    平均值: {bear_zdf.mean():+.2f}%")
    print(f"    最小值: {bear_zdf.min():+.2f}%")
    print(f"    最大值: {bear_zdf.max():+.2f}%")

    print("\n  转折前 2 日累计跌幅:")
    pre2_b = bear_turns["pre_sum_2d"].dropna()
    print(f"    中位数: {pre2_b.median():+.2f}%")
    print(f"    平均值: {pre2_b.mean():+.2f}%")
    print(f"    最小值: {pre2_b.min():+.2f}%")
    print(f"    最大值: {pre2_b.max():+.2f}%")

    print("\n  转折前 3 日累计跌幅:")
    pre3_b = bear_turns["pre_sum_3d"].dropna()
    print(f"    中位数: {pre3_b.median():+.2f}%")
    print(f"    平均值: {pre3_b.mean():+.2f}%")
    print(f"    最小值: {pre3_b.min():+.2f}%")
    print(f"    最大值: {pre3_b.max():+.2f}%")

    print("\n  转折前 5 日累计跌幅:")
    pre5_b = bear_turns["pre_sum_5d"].dropna()
    print(f"    中位数: {pre5_b.median():+.2f}%")
    print(f"    平均值: {pre5_b.mean():+.2f}%")
    print(f"    最小值: {pre5_b.min():+.2f}%")
    print(f"    最大值: {pre5_b.max():+.2f}%")

    print("\n  多转空 前 5 日跌幅序列:")
    for _, row in bear_turns.iterrows():
        zdfs = row["pre_5d_zdf"]
        dates = row["pre_5d_dates"]
        if zdfs:
            seq = "  ".join([f"{d[-4:]}:{z:+.2f}%" for d, z in zip(dates, zdfs)])
            print(f"    {row['date']}  [{seq}]")

    # 4. 对比 MA 系统延迟
    print("\n【四】与 MA 系统延迟对比")
    print("-" * 80)
    print("  MA 系统通常滞后 3~5 个交易日才能确认趋势转折")
    print("  观察 0AMV 在转折点当天的表现:")
    print(f"    空转多 当天涨幅: 中位数 {bull_zdf.median():+.2f}%, 最大 {bull_zdf.max():+.2f}%")
    print(f"    多转空 当天跌幅: 中位数 {bear_zdf.median():+.2f}%, 最小 {bear_zdf.min():+.2f}%")
    print(f"    空转多 前 2 日累计: 中位数 {pre2.median():+.2f}%, 最大 {pre2.max():+.2f}%")
    print(f"    多转空 前 2 日累计: 中位数 {pre2_b.median():+.2f}%, 最小 {pre2_b.min():+.2f}%")

    # 5. 推荐阈值
    print("\n【五】推荐阈值（基于历史数据归纳）")
    print("-" * 80)

    # 空转多阈值：取前 2 日累计涨幅的 75% 分位作为触发线
    pre2_75 = pre2.quantile(0.75) if len(pre2) > 0 else None
    pre2_25 = pre2.quantile(0.25) if len(pre2) > 0 else None
    bull_single_75 = bull_zdf.quantile(0.75) if len(bull_zdf) > 0 else None

    # 多转空阈值：取前 2 日累计跌幅的 25% 分位作为触发线
    pre2_b_25 = pre2_b.quantile(0.25) if len(pre2_b) > 0 else None
    pre2_b_75 = pre2_b.quantile(0.75) if len(pre2_b) > 0 else None
    bear_single_25 = bear_zdf.quantile(0.25) if len(bear_zdf) > 0 else None

    print(f"  多头触发（空转多）:")
    print(f"    单日涨幅 >= {bull_single_75:.2f}%  （75% 分位）")
    print(f"    或 2 日累计涨幅 >= {pre2_75:.2f}%")
    print(f"    参考范围: {pre2_25:.2f}% ~ {pre2.max():.2f}%")

    print(f"\n  空头触发（多转空）:")
    print(f"    单日跌幅 <= {bear_single_25:.2f}%  （25% 分位）")
    print(f"    或 2 日累计跌幅 <= {pre2_b_25:.2f}%")
    print(f"    参考范围: {pre2_b.min():.2f}% ~ {pre2_b_75:.2f}%")

    # 更严格的推荐
    print(f"\n  【保守推荐】（减少误触发）:")
    print(f"    多头: 单日涨幅 >= +3.0%  或 2日累计 >= +4.0%")
    print(f"    空头: 单日跌幅 <= -2.0%  或 2日累计 <= -3.0%")

    print(f"\n  【激进推荐】（更快响应）:")
    print(f"    多头: 单日涨幅 >= +1.5%  或 2日累计 >= +2.5%")
    print(f"    空头: 单日跌幅 <= -1.0%  或 2日累计 <= -2.0%")

    print("\n" + "=" * 80)


def main():
    print("拉取历史数据 (2024-11-01 ~ 2026-05-08) ...")
    start = "20241101"
    end = "20260508"
    df_raw = fetch_history(start, end)
    print(f"  获取到 {len(df_raw)} 条数据")

    print("\n计算 0AMV ...")
    df = calc_0amv(df_raw)

    print("\n分析 14 个转折点 ...")
    df_result = analyze_turns(df)

    print_analysis(df_result)

    # 保存结果
    out_path = os.path.join(_curr_dir, "data", "turn_analysis.csv")
    df_result.to_csv(out_path, index=False, encoding="utf-8-sig")
    print(f"\n分析结果已保存: {out_path}")


if __name__ == "__main__":
    main()
