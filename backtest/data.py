# -*- coding: utf-8 -*-
"""
K 线数据加载与全局时间轴构建。
"""

from __future__ import annotations

import logging
from pathlib import Path

import pandas as pd

from .config import (
    EXCLUDED_SYMBOLS,
    LOOKBACK_BUFFER,
    MAX_BACKTEST_BARS,
    WARMUP_BARS,
)

logger = logging.getLogger(__name__)


def load_all_klines(
    klines_dir: Path,
) -> tuple[dict[str, pd.DataFrame], dict[str, int]]:
    """
    加载 klines_dir 下所有 *_1h.csv。

    返回：
      data            : symbol -> DataFrame
                        每个 DataFrame 包含「回测区间」前额外保留的 LOOKBACK_BUFFER 行，
                        这些行不参与信号生成，仅供 calc_recent_high/low 向前回溯使用。
      backtest_start  : symbol -> 回测起始行下标
                        该下标之前的行属于回溯缓冲区，不产生交易信号。
    """
    required_cols = {"open_time", "open", "high", "low", "close",
                     "DIF", "MACD", "KDJ.J", "10_quote_volume",
                     "MA5", "MA30", "MA60", "MA120", "MA240"}

    data: dict[str, pd.DataFrame] = {}
    backtest_start: dict[str, int] = {}
    csv_files = sorted(klines_dir.glob("*_1h.csv"))

    if not csv_files:
        raise FileNotFoundError(f"在 {klines_dir} 下未找到任何 *_1h.csv 文件")

    logger.info("正在加载 %d 个 CSV 文件…", len(csv_files))

    for path in csv_files:
        symbol = path.stem.replace("_1h", "")
        if symbol in EXCLUDED_SYMBOLS:
            logger.debug("跳过 %s：在不交易列表中", symbol)
            continue
        try:
            df = pd.read_csv(path, encoding="utf-8-sig")
        except Exception as exc:
            logger.warning("跳过 %s：读取失败 (%s)", path.name, exc)
            continue

        if not required_cols.issubset(df.columns):
            logger.warning("跳过 %s：缺少必要列", path.name)
            continue

        for col in ("open", "high", "low", "close", "DIF", "MACD",
                    "KDJ.J", "10_quote_volume",
                    "MA5", "MA30", "MA60", "MA120", "MA240"):
            df[col] = pd.to_numeric(df[col], errors="coerce")

        df["_dt"] = pd.to_datetime(df["open_time"], format="%Y-%m-%d %H:%M:%S")
        df = df.sort_values("_dt").reset_index(drop=True)

        # 丢弃前 WARMUP_BARS 行（指标预热期）
        df = df.iloc[WARMUP_BARS:].reset_index(drop=True)

        # 截取最新的 MAX_BACKTEST_BARS + LOOKBACK_BUFFER 根 K 线
        # LOOKBACK_BUFFER 行置于前端，仅供近期高低价回溯，不生成信号
        if MAX_BACKTEST_BARS > 0:
            keep = MAX_BACKTEST_BARS + LOOKBACK_BUFFER
            if len(df) > keep:
                df = df.iloc[-keep:].reset_index(drop=True)
            bstart = max(0, len(df) - MAX_BACKTEST_BARS)
        else:
            bstart = 0

        if len(df) < 10:
            continue

        data[symbol] = df
        backtest_start[symbol] = bstart

    logger.info("成功加载 %d 个交易对", len(data))
    return data, backtest_start


def build_global_timeline(
    data: dict[str, pd.DataFrame],
    backtest_start: dict[str, int],
) -> list[str]:
    """取所有交易对回测起始后的 open_time 并集，升序排列。"""
    times: set[str] = set()
    for symbol, df in data.items():
        bstart = backtest_start.get(symbol, 0)
        times.update(df["open_time"].iloc[bstart:].tolist())
    return sorted(times)
