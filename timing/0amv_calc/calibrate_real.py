# -*- coding: utf-8 -*-
"""
真实 0AMV 数据校准分析

读取登月者6477 提供的真实 0AMV 历史数据，与计算值对比，重新校准阈值。
"""

import os
import re
import pandas as pd
import numpy as np
from datetime import datetime

# 0AMV 计算模块
_curr_dir = os.path.dirname(os.path.abspath(__file__))
import sys
sys.path.insert(0, _curr_dir)
import importlib.util
_spec = importlib.util.spec_from_file_location("oamv_formula", os.path.join(_curr_dir, "0amv_formula.py"))
_oamv_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_oamv_mod)
calc_0amv = _oamv_mod.calc_0amv

def parse_real_data(filepath):
    """解析真实 0AMV 数据文件"""
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 按空行分隔成块
    blocks = content.strip().split('\n\n')
    
    records = []
    seen_dates = set()
    
    for block in blocks:
        lines = block.strip().split('\n')
        if len(lines) < 6:
            continue
        
        # 第一行: 20260508 周五
        date_match = re.match(r'(\d{4})(\d{2})(\d{2})', lines[0].strip())
        if not date_match:
            continue
        year, month, day = date_match.groups()
        trade_date = f"{year}{month}{day}"
        
        # 跳过重复日期
        if trade_date in seen_dates:
            continue
        seen_dates.add(trade_date)
        
        # 解析开/高/低/收
        def parse_line(line):
            match = re.search(r'[:：]([\d.]+)', line)
            return float(match.group(1)) if match else None
        
        oamvo = parse_line(lines[1])  # 开
        oamvh = parse_line(lines[2])  # 高
        oamvl = parse_line(lines[3])  # 低
        oamvc = parse_line(lines[4])  # 收
        
        # 解析最后一行（幅/量/额/盘/率/振）
        last_line = lines[5]
        
        # 幅: 取了绝对值，需要结合开盘和收盘价差确定方向
        pct_match = re.search(r'幅[:：]([\d.]+)%', last_line)
        pct_abs = float(pct_match.group(1)) if pct_match else None
        
        # 确定涨跌幅方向：收 > 开 则正，收 < 开 则负
        if oamvo is not None and oamvc is not None:
            if oamvc > oamvo:
                pct_chg = pct_abs
            elif oamvc < oamvo:
                pct_chg = -pct_abs
            else:
                pct_chg = 0.0
        else:
            pct_chg = None
        
        # 成交额（亿）
        amount_match = re.search(r'额[:：]([\d.]+)亿', last_line)
        amount_yi = float(amount_match.group(1)) if amount_match else None
        
        # 成交量（亿手 = 亿股）
        vol_match = re.search(r'量[:：]([\d.]+)亿', last_line)
        vol_yi = float(vol_match.group(1)) if vol_match else None
        
        # 换手（亿）
        turnover_match = re.search(r'盘[:：]([\d.]+)亿', last_line)
        turnover_yi = float(turnover_match.group(1)) if turnover_match else None
        
        records.append({
            'trade_date': trade_date,
            'real_oamvo': oamvo,
            'real_oamvh': oamvh,
            'real_oamvl': oamvl,
            'real_oamvc': oamvc,
            'real_pct_abs': pct_abs,
            'real_pct_chg': pct_chg,
            'real_amount_yi': amount_yi,
            'real_vol_yi': vol_yi,
            'real_turnover_yi': turnover_yi,
        })
    
    df = pd.DataFrame(records)
    df = df.sort_values('trade_date').reset_index(drop=True)
    return df


def compare_with_calculated(df_real, calc_result_file):
    """对比真实数据与计算数据"""
    df_calc = pd.read_csv(calc_result_file)
    
    # 确保 trade_date 是字符串
    df_calc['trade_date'] = df_calc['trade_date'].astype(str)
    df_real['trade_date'] = df_real['trade_date'].astype(str)
    
    # 合并
    df_merged = pd.merge(df_real, df_calc[['trade_date', 'oamvc', 'oamv_zdf']], 
                         on='trade_date', how='left', suffixes=('_real', '_calc'))
    
    # 计算误差
    df_merged['abs_error'] = df_merged['real_oamvc'] - df_merged['oamvc']
    df_merged['pct_error'] = df_merged['abs_error'] / df_merged['real_oamvc'] * 100
    
    return df_merged


def threshold_validation(df_real):
    """用真实数据验证阈值"""
    print("\n" + "=" * 80)
    print("真实 0AMV 阈值验证")
    print("=" * 80)
    
    # 2月2日多转空 -> 4月8日空转多 -> 至今
    # 关键日期
    key_dates = {
        '20260202': '多转空',
        '20260408': '空转多',
    }
    
    print("\n【一】关键转折点验证")
    print("-" * 80)
    for date_str, event in key_dates.items():
        row = df_real[df_real['trade_date'] == date_str]
        if row.empty:
            print(f"  {date_str} {event}: 无数据")
            continue
        row = row.iloc[0]
        print(f"  {date_str} {event}: 收={row['real_oamvc']:,.1f}, 涨幅={row['real_pct_chg']:+.2f}%")
    
    # 假性空转多检测
    print("\n【二】假性空转多检测（2月2日 ~ 4月8日区间）")
    print("-" * 80)
    df_bear = df_real[(df_real['trade_date'] >= '20260202') & (df_real['trade_date'] <= '20260408')].copy()
    
    # 找涨幅较大的日子（可能触发多头信号的"假性"信号）
    df_bear['flag'] = ''
    df_bear.loc[df_bear['real_pct_chg'] >= 3.0, 'flag'] = '[可能假多]'
    df_bear.loc[df_bear['real_pct_chg'] <= -2.0, 'flag'] = '[确认空头]'
    
    print(f"  区间共 {len(df_bear)} 个交易日")
    print(f"  涨幅 >= +3.0% 的天数: {len(df_bear[df_bear['real_pct_chg'] >= 3.0])}")
    print(f"  跌幅 <= -2.0% 的天数: {len(df_bear[df_bear['real_pct_chg'] <= -2.0])}")
    
    print("\n  涨幅 >= +2.5% 的明细（假性多头信号测试）:")
    big_rise = df_bear[df_bear['real_pct_chg'] >= 2.5].copy()
    if len(big_rise) > 0:
        for _, row in big_rise.iterrows():
            print(f"    {row['trade_date']} 收={row['real_oamvc']:,.1f} 涨={row['real_pct_chg']:+.2f}% {row['flag']}")
    else:
        print("    无")
    
    # 整体涨幅分布
    print("\n【三】真实 0AMV 涨幅分布")
    print("-" * 80)
    zdf = df_real['real_pct_chg'].dropna()
    print(f"  中位数: {zdf.median():+.3f}%")
    print(f"  均值: {zdf.mean():+.3f}%")
    print(f"  标准差: {zdf.std():.3f}%")
    print(f"  95% 分位: {zdf.quantile(0.95):+.3f}%")
    print(f"  5% 分位: {zdf.quantile(0.05):+.3f}%")
    print(f"  最大涨幅: {zdf.max():+.3f}%")
    print(f"  最大跌幅: {zdf.min():+.3f}%")
    
    print("\n  涨幅分布（按 1% 分箱）:")
    bins = [-float("inf"), -5, -3, -2, -1, 0, 1, 2, 3, 5, float("inf")]
    labels = ["<-5%", "-5~-3%", "-3~-2%", "-2~-1%", "-1~0%", "0~1%", "1~2%", "2~3%", "3~5%", ">5%"]
    counts = pd.cut(zdf, bins=bins, labels=labels).value_counts().sort_index()
    for label, count in counts.items():
        bar = "█" * int(count / max(counts.max(), 1) * 30)
        print(f"    {label:10s} {count:4d} {bar}")
    
    # 14 个转折点中的有数据部分
    print("\n【四】14个转折点中有数据的部分")
    print("-" * 80)
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
    
    for date_str, turn_type in HISTORICAL_TURNS:
        row = df_real[df_real['trade_date'] == date_str.replace('-', '')]
        if not row.empty:
            r = row.iloc[0]
            print(f"  {date_str} {turn_type:6s}: 真实收={r['real_oamvc']:>12,.1f} 真实涨={r['real_pct_chg']:>+6.2f}%")
    
    return df_bear


def main():
    real_file = os.path.join(_curr_dir, "test_0amv_real.txt")
    calc_file = os.path.join(_curr_dir, "data", "0amv_result.csv")
    
    print("=" * 80)
    print("真实 0AMV 数据校准分析 —— 拟合系数 0.87")
    print("=" * 80)
    
    # Step 1: 解析真实数据
    print("\n[1/5] 解析真实 0AMV 数据 ...")
    df_real = parse_real_data(real_file)
    print(f"       解析到 {len(df_real)} 条记录")
    print(f"       日期范围: {df_real['trade_date'].iloc[0]} ~ {df_real['trade_date'].iloc[-1]}")
    
    # Step 2: 对比计算值
    print("\n[2/5] 对比计算值 ...")
    if os.path.exists(calc_file):
        df_comp = compare_with_calculated(df_real, calc_file)
        # 只打印有计算值的日期
        df_valid = df_comp.dropna(subset=['oamvc'])
        if len(df_valid) > 0:
            print(f"       重叠日期: {len(df_valid)} 天")
            print(f"       平均绝对误差: {df_valid['abs_error'].mean():,.1f}")
            print(f"       平均百分比误差: {df_valid['pct_error'].mean():+.2f}%")
            print(f"       最大绝对误差: {df_valid['abs_error'].abs().max():,.1f}")
            
            print("\n       最近 10 天对比:")
            show = df_valid[['trade_date', 'real_oamvc', 'oamvc', 'abs_error', 'pct_error']].tail(10).copy()
            show['real_oamvc'] = show['real_oamvc'].apply(lambda x: f"{x:>12,.1f}")
            show['oamvc'] = show['oamvc'].apply(lambda x: f"{x:>12,.1f}")
            show['abs_error'] = show['abs_error'].apply(lambda x: f"{x:>+10,.1f}")
            show['pct_error'] = show['pct_error'].apply(lambda x: f"{x:>+7.2f}%")
            print(show.to_string(index=False))
        else:
            print("       无重叠日期（计算数据可能不够新）")
    else:
        print(f"       计算数据文件不存在: {calc_file}")
    
    # Step 3: 阈值验证
    print("\n[3/5] 真实数据阈值验证 ...")
    df_bear = threshold_validation(df_real)
    
    # Step 4: 保存结果
    print("\n[4/5] 保存结果 ...")
    out_path = os.path.join(_curr_dir, "data", "real_0amv_parsed.csv")
    df_real.to_csv(out_path, index=False, encoding="utf-8-sig")
    print(f"       已保存: {out_path}")
    
    # Step 5: 校准建议
    print("\n[5/5] 校准建议")
    print("=" * 80)
    zdf = df_real['real_pct_chg'].dropna()
    
    # 真实数据中 2026-04-08 空转多 = +6.13%，2026-02-02 多转空 = -3.42%
    apr08 = df_real[df_real['trade_date'] == '20260408']
    feb02 = df_real[df_real['trade_date'] == '20260202']
    
    print(f"  真实数据中最关键的两个转折点:")
    if not apr08.empty:
        print(f"    2026-04-08 空转多: 真实涨幅 = {apr08.iloc[0]['real_pct_chg']:+.2f}%")
    if not feb02.empty:
        print(f"    2026-02-02 多转空: 真实跌幅 = {feb02.iloc[0]['real_pct_chg']:+.2f}%")
    
    print(f"\n  基于真实数据的涨幅分布:")
    print(f"    中位数: {zdf.median():+.3f}%")
    print(f"    95% 分位: {zdf.quantile(0.95):+.3f}%")
    print(f"    5% 分位: {zdf.quantile(0.05):+.3f}%")
    
    print(f"\n  推荐阈值（基于真实 0AMV 数据，约 3 个月样本）:")
    print(f"    多头: 单日涨幅 >= +{zdf.quantile(0.90):.2f}%  （90% 分位，较严格）")
    print(f"         或 >= +{zdf.quantile(0.85):.2f}%  （85% 分位，平衡）")
    print(f"    空头: 单日跌幅 <= {zdf.quantile(0.10):+.2f}%  （10% 分位，较严格）")
    print(f"         或 <= {zdf.quantile(0.15):+.2f}%  （15% 分位，平衡）")
    
    # 假性空转多分析
    fake_signals = df_bear[df_bear['real_pct_chg'] >= 2.5]
    print(f"\n  假性信号分析（2月2日~4月8日空头区间中，涨幅>=+2.5%的天数）:")
    print(f"    共 {len(fake_signals)} 天触发 +2.5% 多头阈值")
    if len(fake_signals) > 0:
        for _, row in fake_signals.iterrows():
            print(f"      {row['trade_date']} 收={row['real_oamvc']:,.1f} 涨={row['real_pct_chg']:+.2f}%")
    
    print("\n" + "=" * 80)
    print("分析完成")
    print("=" * 80)


if __name__ == "__main__":
    main()
