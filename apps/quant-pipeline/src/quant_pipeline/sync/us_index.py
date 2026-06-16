"""raw.us_index_daily / us_index_indicator —— 美股指数逐 symbol 同步。

镜像 us_daily 但**更简单**：单次抓取、无 qfq、无 adj_factor（指数无复权概念）。
抓 → 规整 trade_date → 裁窗去重 → upsert 行情 → calc_us_indicators（直接吃 OHLC）
→ upsert 指标。空/0 行各路径透出 empty_path，不静默（见 spec 03、data-integrity 规范）。
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Any

from quant_pipeline.db.engine import session_scope
from quant_pipeline.sync._upsert import upsert_rows
from quant_pipeline.sync.akshare_client import AkShareClient
from quant_pipeline.sync.us_indicators import calc_us_indicators

logger = logging.getLogger(__name__)

DAILY_TABLE = "raw.us_index_daily"
INDICATOR_TABLE = "raw.us_index_indicator"

DAILY_PK = ("index_code", "trade_date")
DAILY_UPDATE = ("open", "high", "low", "close", "volume")
INDICATOR_PK = ("index_code", "trade_date")


@dataclass
class UsIndexReport:
    index_code: str
    rows: int = 0
    indicator_rows: int = 0
    empty_path: str | None = None      # data_null / items_empty / window_empty


def _f(v: Any) -> float | None:
    """NaN / inf / None → None；否则 float。"""
    if v is None:
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return None if not math.isfinite(x) else x


def sync_us_index_for_symbol(
    *, index_code: str, start_date: str, end_date: str, client: AkShareClient
) -> UsIndexReport:
    import pandas as pd

    res = client.fetch_us_index(index_code)
    if res.empty_path is not None:
        return UsIndexReport(index_code=index_code, empty_path=res.empty_path)

    df = res.df.copy()
    # date 可能是 datetime.date 或 'YYYY-MM-DD' 字符串；pd.to_datetime 兼容两者
    df["trade_date"] = pd.to_datetime(df["date"]).dt.strftime("%Y%m%d")
    df = df[(df["trade_date"] >= start_date) & (df["trade_date"] <= end_date)]
    df = (
        df.sort_values("trade_date")
        .drop_duplicates("trade_date", keep="last")
        .reset_index(drop=True)
    )
    if len(df) == 0:
        return UsIndexReport(index_code=index_code, empty_path="window_empty")

    n = len(df)

    # ---- 组装并 upsert 行情（仅 OHLCV，无复权列）----
    daily_rows: list[dict[str, Any]] = []
    for i in range(n):
        daily_rows.append({
            "index_code": index_code,
            "trade_date": str(df["trade_date"].iloc[i]),
            "open": _f(df["open"].iloc[i]),
            "high": _f(df["high"].iloc[i]),
            "low": _f(df["low"].iloc[i]),
            "close": _f(df["close"].iloc[i]),
            "volume": _f(df["volume"].iloc[i]),
        })

    report = UsIndexReport(index_code=index_code)
    with session_scope() as session:
        report.rows = upsert_rows(
            session, table=DAILY_TABLE, rows=daily_rows,
            pk_cols=DAILY_PK, update_cols=DAILY_UPDATE,
        )

    # ---- 技术指标（直接吃裁切后 OHLC，无 qfq）----
    indic = calc_us_indicators(
        opens=[float(x) for x in df["open"].astype(float)],
        highs=[float(x) for x in df["high"].astype(float)],
        lows=[float(x) for x in df["low"].astype(float)],
        closes=[float(x) for x in df["close"].astype(float)],
    )
    indic_rows: list[dict[str, Any]] = []
    for i in range(n):
        row: dict[str, Any] = {
            "index_code": index_code,
            "trade_date": str(df["trade_date"].iloc[i]),
        }
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
