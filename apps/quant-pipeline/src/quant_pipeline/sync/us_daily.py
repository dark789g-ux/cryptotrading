"""raw.us_daily_quote / us_adj_factor / us_daily_indicator —— 美股逐 ticker 同步。

每只 ticker：单次抓 Yahoo 日线（含 close 与 adj_close），
派生乘法复权因子 factor = adj_close / close（恒正，永不为负），
按 A 股同款 qfq_x = raw_x × factor / 最新factor 算前复权，
用前复权价算技术指标（us_indicators，移植自 indicators.ts）。
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Any

from quant_pipeline.db.engine import session_scope
from quant_pipeline.sync._upsert import upsert_rows
from quant_pipeline.sync.yahoo_client import YahooClient
from quant_pipeline.sync.us_indicators import calc_us_indicators

logger = logging.getLogger(__name__)

QUOTE_TABLE = "raw.us_daily_quote"
FACTOR_TABLE = "raw.us_adj_factor"
INDICATOR_TABLE = "raw.us_daily_indicator"

QUOTE_PK = ("ticker", "trade_date")
QUOTE_UPDATE = (
    "open", "high", "low", "close", "pre_close", "pct_chg", "volume",
    "qfq_open", "qfq_high", "qfq_low", "qfq_close", "qfq_pre_close", "qfq_pct_chg",
)
FACTOR_PK = ("ticker", "trade_date")
FACTOR_UPDATE = ("adj_factor",)
INDICATOR_PK = ("ticker", "trade_date")


@dataclass
class UsDailyReport:
    ticker: str
    quote_rows: int = 0
    factor_rows: int = 0
    indicator_rows: int = 0
    empty_path: str | None = None      # data_null / items_empty / window_empty
    factor_empty: bool = False         # qfq/因子缺失 → 退化, 标 us_factor_empty


def _f(v: Any) -> float | None:
    """NaN / inf / None → None；否则 float。"""
    if v is None:
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return None if not math.isfinite(x) else x


def sync_us_daily_for_ticker(
    *, ticker: str, start_date: str, end_date: str, client: YahooClient
) -> UsDailyReport:
    import pandas as pd

    raw_res = client.fetch_us_daily(ticker, start_date, end_date)
    if raw_res.empty_path is not None:
        return UsDailyReport(ticker=ticker, empty_path=raw_res.empty_path, factor_empty=True)

    raw = raw_res.df.copy()
    raw["trade_date"] = pd.to_datetime(raw["date"]).dt.strftime("%Y%m%d")
    raw = raw[(raw["trade_date"] >= start_date) & (raw["trade_date"] <= end_date)]
    raw = raw.sort_values("trade_date").drop_duplicates("trade_date", keep="last").reset_index(drop=True)
    if len(raw) == 0:
        return UsDailyReport(ticker=ticker, empty_path="window_empty", factor_empty=True)

    raw_close = raw["close"].astype(float)
    pre_close = raw_close.shift(1)
    pct_chg = (raw_close / pre_close - 1.0) * 100.0

    # ---- 前复权因子（Yahoo adj_close / close：乘法、恒正，永不为负） ----
    factor_empty = True
    factor_series = None
    adj_close = raw["adj_close"].astype(float).reset_index(drop=True)
    f = adj_close / raw_close.reset_index(drop=True)
    if f.notna().all() and (f > 0).all() and math.isfinite(float(f.iloc[-1])) and float(f.iloc[-1]) > 0:
        factor_series = f
        factor_empty = False
        latest = float(f.iloc[-1])
        if abs(latest - 1.0) > 0.05:
            logger.warning("us_factor_latest_not_one",
                           extra={"ticker": ticker, "latest_factor": latest})
    else:
        # 乘法因子下守门是恒成立的不变量哨兵；触发即 Yahoo adj_close 异常
        # （含 NaN / 非正）→ factor_empty 走 us_factor_empty failed_item，fail-loud。
        logger.warning("us_factor_invalid", extra={"ticker": ticker})
    if factor_empty:
        logger.warning("us_factor_empty", extra={"ticker": ticker})

    # ---- 组装并 upsert 行情 ----
    n = len(raw)
    qfq_o = qfq_h = qfq_l = qfq_c = [None] * n
    qfq_pc = qfq_pct = [None] * n
    if not factor_empty:
        latest = float(factor_series.iloc[-1])
        fac = factor_series.reset_index(drop=True)
        qfq_c = (raw_close.reset_index(drop=True) * fac / latest)
        qfq_o = (raw["open"].astype(float).reset_index(drop=True) * fac / latest)
        qfq_h = (raw["high"].astype(float).reset_index(drop=True) * fac / latest)
        qfq_l = (raw["low"].astype(float).reset_index(drop=True) * fac / latest)
        qfq_pc = qfq_c.shift(1)
        qfq_pct = (qfq_c / qfq_pc - 1.0) * 100.0
        qfq_o, qfq_h, qfq_l, qfq_c = list(qfq_o), list(qfq_h), list(qfq_l), list(qfq_c)
        qfq_pc, qfq_pct = list(qfq_pc), list(qfq_pct)

    quote_rows: list[dict[str, Any]] = []
    for i in range(n):
        quote_rows.append({
            "ticker": ticker,
            "trade_date": str(raw["trade_date"].iloc[i]),
            "open": _f(raw["open"].iloc[i]),
            "high": _f(raw["high"].iloc[i]),
            "low": _f(raw["low"].iloc[i]),
            "close": _f(raw["close"].iloc[i]),
            "pre_close": _f(pre_close.iloc[i]),
            "pct_chg": _f(pct_chg.iloc[i]),
            "volume": _f(raw["volume"].iloc[i]),
            "qfq_open": _f(qfq_o[i]),
            "qfq_high": _f(qfq_h[i]),
            "qfq_low": _f(qfq_l[i]),
            "qfq_close": _f(qfq_c[i]),
            "qfq_pre_close": _f(qfq_pc[i]),
            "qfq_pct_chg": _f(qfq_pct[i]),
        })

    report = UsDailyReport(ticker=ticker, factor_empty=factor_empty)
    with session_scope() as session:
        report.quote_rows = upsert_rows(
            session, table=QUOTE_TABLE, rows=quote_rows,
            pk_cols=QUOTE_PK, update_cols=QUOTE_UPDATE,
        )

    if factor_empty:
        return report

    # ---- 复权因子 ----
    factor_rows = [
        {"ticker": ticker, "trade_date": str(raw["trade_date"].iloc[i]),
         "adj_factor": _f(factor_series.iloc[i])}
        for i in range(n)
    ]
    with session_scope() as session:
        report.factor_rows = upsert_rows(
            session, table=FACTOR_TABLE, rows=factor_rows,
            pk_cols=FACTOR_PK, update_cols=FACTOR_UPDATE,
        )

    # ---- 技术指标（输入 qfq 价） ----
    indic = calc_us_indicators(
        opens=[float(x) for x in qfq_o],
        highs=[float(x) for x in qfq_h],
        lows=[float(x) for x in qfq_l],
        closes=[float(x) for x in qfq_c],
    )
    indic_rows: list[dict[str, Any]] = []
    for i in range(n):
        row: dict[str, Any] = {"ticker": ticker, "trade_date": str(raw["trade_date"].iloc[i])}
        for k, v in indic[i].items():
            row[k] = _f(v)
        indic_rows.append(row)
    indicator_update = tuple(indic[0].keys()) if indic else ()
    with session_scope() as session:
        report.indicator_rows = upsert_rows(
            session, table=INDICATOR_TABLE, rows=indic_rows,
            pk_cols=INDICATOR_PK, update_cols=indicator_update,
        )
    return report
