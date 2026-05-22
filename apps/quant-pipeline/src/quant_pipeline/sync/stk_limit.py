"""raw.stk_limit —— TuShare stk_limit 接口

字段映射（doc/量化/06、tushare 文档）：
  ts_code     str   TS 股票代码
  trade_date  str   YYYYMMDD
  pre_close   float 昨日收盘价（单位：元）
  up_limit    float 涨停价（元）
  down_limit  float 跌停价（元）

按 trade_date 循环（每日一次 ≈ 5800 条上限内，无需分页）。
PK：(ts_code, trade_date)
"""

from __future__ import annotations

import logging
from typing import Any

from quant_pipeline.db.engine import session_scope
from quant_pipeline.sync._upsert import dedupe_by_pk, upsert_rows
from quant_pipeline.sync.trade_cal import SyncReport
from quant_pipeline.sync.tushare_client import TushareClient

logger = logging.getLogger(__name__)

API_NAME = "stk_limit"
TABLE = "raw.stk_limit"
PK_COLS = ("ts_code", "trade_date")
UPDATE_COLS = ("pre_close", "up_limit", "down_limit")


def sync_stk_limit_by_date(
    *,
    trade_date: str,
    client: TushareClient | None = None,
) -> SyncReport:
    """同步单个交易日的涨跌停价格。"""

    client = client or TushareClient()
    params: dict[str, Any] = {"trade_date": trade_date}
    result = client.fetch(API_NAME, **params)
    if result.empty_path is not None:
        return SyncReport(
            api_name=API_NAME,
            rows_upserted=0,
            empty_path=result.empty_path,
            params=dict(params),
        )

    df = result.df.copy()
    for col in ("ts_code", "trade_date", "pre_close", "up_limit", "down_limit"):
        if col not in df.columns:
            df[col] = None
    df = df[["ts_code", "trade_date", "pre_close", "up_limit", "down_limit"]]
    df = dedupe_by_pk(df, PK_COLS, api_name=API_NAME)

    rows = [
        {
            "ts_code": str(r["ts_code"]),
            "trade_date": str(r["trade_date"]),
            "pre_close": _to_float(r["pre_close"]),
            "up_limit": _to_float(r["up_limit"]),
            "down_limit": _to_float(r["down_limit"]),
        }
        for r in df.to_dict(orient="records")
    ]
    with session_scope() as session:
        n = upsert_rows(
            session,
            table=TABLE,
            rows=rows,
            pk_cols=PK_COLS,
            update_cols=UPDATE_COLS,
        )
    return SyncReport(api_name=API_NAME, rows_upserted=n, empty_path=None, params=dict(params))


def _to_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    # pandas 缺失值是 float('nan')，float(nan) 不抛异常会原样返回；
    # NaN 入 PG numeric 列行为依赖 driver，统一归一为 None。
    if f != f:  # NaN
        return None
    return f
