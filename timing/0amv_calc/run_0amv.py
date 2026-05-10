# -*- coding: utf-8 -*-
"""
0AMV 一键执行脚本

流程：
    1. 拉取中证A股指数 930903.CSI 最近 N 天日线数据
    2. 保存原始数据到 data/930903_daily.csv
    3. 调用 0amv_formula.py 计算 0AMV 指标
    4. 输出结果到 data/0amv_result.csv
    5. 打印验证报告

用法：
    python run_0amv.py
    python run_0amv.py --days 120    # 拉取最近 120 天
"""

import os
import sys
import argparse
from datetime import datetime, timedelta

import pandas as pd
import tushare as ts

# 0AMV 计算模块（文件名以数字开头，需通过 importlib 加载）
_curr_dir = os.path.dirname(os.path.abspath(__file__))
import importlib.util
_spec = importlib.util.spec_from_file_location("oamv_formula", os.path.join(_curr_dir, "0amv_formula.py"))
_oamv_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_oamv_mod)
calc_0amv = _oamv_mod.calc_0amv
validate_0amv_values = _oamv_mod.validate_0amv_values

# Tushare Token（复用择时模块配置）
TUSHARE_TOKEN = "65acf52fb110ef6d30b3c37017cc1b93a8bf963855b98934ed2ada42"

# 工作目录
WORK_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(WORK_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

# 数据文件路径
RAW_DATA_FILE = os.path.join(DATA_DIR, "930903_daily.csv")
RESULT_FILE = os.path.join(DATA_DIR, "0amv_result.csv")

# 中证A股指数代码（tushare 使用 930903.CSI）
TS_CODE = "930903.CSI"


def fetch_930903(days: int = 60) -> pd.DataFrame:
    """
    从 tushare 拉取 930903.CSI 最近 N 天日线数据

    优先读取本地缓存，如本地最新日期滞后则从 tushare 补全并合并保存。
    """
    pro = ts.pro_api(TUSHARE_TOKEN)

    end_date = datetime.now().strftime("%Y%m%d")
    start_date = (datetime.now() - timedelta(days=days + 20)).strftime("%Y%m%d")

    df_local = None
    if os.path.exists(RAW_DATA_FILE):
        df_local = pd.read_csv(RAW_DATA_FILE, dtype={"trade_date": str})
        df_local = df_local.sort_values("trade_date").reset_index(drop=True)

    need_fetch = False
    fetch_start = start_date

    if df_local is None or df_local.empty:
        need_fetch = True
    else:
        last_date = str(df_local["trade_date"].iloc[-1])
        today = end_date
        if last_date < today:
            need_fetch = True
            fetch_start = last_date  # 从本地最后一天开始（后续去重）

    if need_fetch:
        print(f"[FETCH] 从 tushare 拉取 {TS_CODE} 数据 ({fetch_start} ~ {end_date}) ...")
        try:
            df_new = pro.index_daily(ts_code=TS_CODE, start_date=fetch_start, end_date=end_date)
            if df_new is not None and not df_new.empty:
                df_new = df_new.sort_values("trade_date").reset_index(drop=True)
                if df_local is not None:
                    df_merged = pd.concat([df_local, df_new], ignore_index=True)
                    df_merged = df_merged.drop_duplicates(subset=["trade_date"], keep="last")
                    df_merged = df_merged.sort_values("trade_date").reset_index(drop=True)
                    df_merged.to_csv(RAW_DATA_FILE, index=False, encoding="utf-8-sig")
                    return df_merged
                else:
                    df_new.to_csv(RAW_DATA_FILE, index=False, encoding="utf-8-sig")
                    return df_new
        except Exception as e:
            print(f"[WARN] tushare 拉取失败: {e}")

    if df_local is not None:
        print(f"[CACHE] 使用本地缓存: {RAW_DATA_FILE}")
        return df_local

    raise RuntimeError("无法获取 930903.CSI 数据（tushare 失败且本地无缓存）")


def main():
    parser = argparse.ArgumentParser(description="0AMV 计算一键执行")
    parser.add_argument("--days", type=int, default=60, help="拉取最近 N 天数据（默认 60）")
    args = parser.parse_args()

    print("=" * 60)
    print("0AMV 精确计算模块")
    print(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    # Step 1: 拉取数据
    print("\n[1/4] 拉取原始数据 ...")
    df_raw = fetch_930903(days=args.days)
    print(f"       获取到 {len(df_raw)} 条日线数据")

    # Step 2: 计算 0AMV
    print("\n[2/4] 计算 0AMV 指标 ...")
    df_result = calc_0amv(df_raw)
    print(f"       SMA 周期: N=10, M=1")
    print(f"       拟合系数: K=0.87")

    # Step 3: 保存结果
    print("\n[3/4] 保存结果 ...")
    df_result.to_csv(RESULT_FILE, index=False, encoding="utf-8-sig")
    print(f"       原始数据: {RAW_DATA_FILE}")
    print(f"       计算结果: {RESULT_FILE}")

    # Step 4: 验证报告
    print("\n[4/4] 验证计算结果 ...")
    stats = validate_0amv_values(df_result)

    if stats["ok"]:
        print("       [OK] 数值范围正常")
    else:
        print("       [WARN] 发现异常:")
        for issue in stats["issues"]:
            print(f"          - {issue}")

    print(f"\n{'=' * 60}")
    print("计算统计")
    print(f"{'=' * 60}")
    print(f"  数据条数:     {stats['count']}")
    print(f"  最新日期:     {stats['latest_date']}")
    print(f"  OAMVC 最新值: {stats['latest']:,.2f}")
    print(f"  OAMVC 最小值: {stats['min']:,.2f}")
    print(f"  OAMVC 最大值: {stats['max']:,.2f}")
    print(f"  OAMVC 平均值: {stats['mean']:,.2f}")

    # 打印最近 10 天明细
    print(f"\n{'=' * 60}")
    print("最近 10 天 0AMV 明细")
    print(f"{'=' * 60}")
    cols = [
        "trade_date",
        "close",
        "oamvv1",
        "oamvv3",
        "oamvc",
        "oamv_zdf",
        "oamv_smx",
    ]
    display = df_result[cols].tail(10).copy()
    # 格式化
    for c in ["oamvv1", "oamvv3", "oamvc", "oamv_smx"]:
        display[c] = display[c].apply(lambda x: f"{x:,.2f}" if pd.notna(x) else "")
    display["oamv_zdf"] = display["oamv_zdf"].apply(lambda x: f"{x:+.2f}%" if pd.notna(x) else "")
    print(display.to_string(index=False))

    # 涨幅分布（初步判断阈值）
    print(f"\n{'=' * 60}")
    print("0AMV 涨幅分布（用于初步判断阈值）")
    print(f"{'=' * 60}")
    zdf = df_result["oamv_zdf"].dropna()
    if len(zdf) > 0:
        print(f"  涨幅中位数: {zdf.median():+.3f}%")
        print(f"  涨幅标准差: {zdf.std():.3f}%")
        print(f"  涨幅 95% 分位: {zdf.quantile(0.95):+.3f}%")
        print(f"  涨幅 5% 分位:  {zdf.quantile(0.05):+.3f}%")
        print(f"  最大单日涨幅: {zdf.max():+.3f}%")
        print(f"  最大单日跌幅: {zdf.min():+.3f}%")
        print(f"\n  涨幅分布（按 1% 分箱）:")
        bins = [-float("inf"), -5, -3, -2, -1, 0, 1, 2, 3, 5, float("inf")]
        labels = ["<-5%", "-5~-3%", "-3~-2%", "-2~-1%", "-1~0%", "0~1%", "1~2%", "2~3%", "3~5%", ">5%"]
        counts = pd.cut(zdf, bins=bins, labels=labels).value_counts().sort_index()
        for label, count in counts.items():
            bar = "█" * int(count / max(counts.max(), 1) * 30)
            print(f"    {label:10s} {count:4d} {bar}")

    print(f"\n{'=' * 60}")
    print("执行完成")
    print(f"{'=' * 60}")

    return df_result


if __name__ == "__main__":
    main()
