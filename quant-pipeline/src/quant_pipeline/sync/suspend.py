"""raw.suspend_d —— TuShare suspend_d 接口

字段映射（doc/量化/06、tushare 文档）：
  ts_code         str  TS 代码
  trade_date      str  停复牌日期 YYYYMMDD
  suspend_timing  str  日内停牌时间段（全天停牌时为 None）
  suspend_type    str  S=停牌 R=复牌

按 trade_date 循环；不传 suspend_type 时 TuShare 返回 S+R 混合。
PK：(ts_code, trade_date, suspend_type)
"""

from __future__ import annotations

import logging
from typing import Any

from quant_pipeline.db.engine import session_scope
from quant_pipeline.sync._upsert import dedupe_by_pk, upsert_rows
from quant_pipeline.sync.trade_cal import SyncReport
from quant_pipeline.sync.tushare_client import TushareClient

logger = logging.getLogger(__name__)

API_NAME = "suspend_d"
TABLE = "raw.suspend_d"
PK_COLS = ("ts_code", "trade_date", "suspend_type")
UPDATE_COLS = ("suspend_timing",)


def sync_suspend_by_date(
    *,
    trade_date: str,
    client: TushareClient | None = None,
) -> SyncReport:
    """同步单个交易日的停复牌信息。"""

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
    for col in ("ts_code", "trade_date", "suspend_timing", "suspend_type"):
        if col not in df.columns:
            df[col] = None
    df = df[["ts_code", "trade_date", "suspend_timing", "suspend_type"]]
    df = dedupe_by_pk(df, PK_COLS, api_name=API_NAME)

    rows = [
        {
            "ts_code": str(r["ts_code"]),
            "trade_date": str(r["trade_date"]),
            "suspend_type": str(r["suspend_type"]),
            "suspend_timing": (
                str(r["suspend_timing"]) if r["suspend_timing"] is not None else None
            ),
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
