"""raw.trade_cal —— TuShare trade_cal 接口

字段映射（doc/量化/06、doc/tushare_info.md）：
  exchange      str  交易所（SSE 上交所 / SZSE 深交所）
  cal_date      str  日历日期 YYYYMMDD
  is_open       int  是否交易 0=休市 1=交易
  pretrade_date str  上一交易日 YYYYMMDD

PK：(exchange, cal_date)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from quant_pipeline.db.engine import session_scope
from quant_pipeline.sync._upsert import dedupe_by_pk, to_str_or_none, upsert_rows
from quant_pipeline.sync.tushare_client import TushareClient

logger = logging.getLogger(__name__)

API_NAME = "trade_cal"
TABLE = "raw.trade_cal"
PK_COLS = ("exchange", "cal_date")
UPDATE_COLS = ("is_open", "pretrade_date")

# A 股两个交易所；其它（DCE/CFFEX 等）按需扩展
DEFAULT_EXCHANGES = ("SSE", "SZSE")


@dataclass(frozen=True)
class SyncReport:
    api_name: str
    rows_upserted: int
    empty_path: str | None
    params: dict[str, Any]


def sync_trade_cal(
    *,
    start_date: str,
    end_date: str,
    exchanges: tuple[str, ...] = DEFAULT_EXCHANGES,
    client: TushareClient | None = None,
) -> list[SyncReport]:
    """同步交易日历到 raw.trade_cal。

    每个交易所一次 fetch；空数据时返回 empty_path 非 None 的 SyncReport
    （上层 orchestrator 把它放进 failedItems）。
    """

    client = client or TushareClient()
    reports: list[SyncReport] = []

    for exch in exchanges:
        params = {
            "exchange": exch,
            "start_date": start_date,
            "end_date": end_date,
        }
        result = client.fetch(API_NAME, **params)
        if result.empty_path is not None:
            reports.append(
                SyncReport(
                    api_name=API_NAME,
                    rows_upserted=0,
                    empty_path=result.empty_path,
                    params=dict(params),
                )
            )
            continue

        df = result.df.copy()
        # TuShare 偶尔返回缺列；做一次安全 reindex
        for col in ("exchange", "cal_date", "is_open", "pretrade_date"):
            if col not in df.columns:
                df[col] = None
        df = df[["exchange", "cal_date", "is_open", "pretrade_date"]]
        df = dedupe_by_pk(df, PK_COLS, api_name=API_NAME)

        # is_open 是核心字段（后续所有按交易日循环的表都依赖它）。
        # 缺失（None / NaN）的行不能默默 int() 抛异常让整张表 fetch 失败，
        # 也不能伪造 0/1——显式 warn + drop。
        rows: list[dict[str, Any]] = []
        dropped_is_open = 0
        for r in df.to_dict(orient="records"):
            is_open_raw = r["is_open"]
            if is_open_raw is None or (
                isinstance(is_open_raw, float) and is_open_raw != is_open_raw
            ):
                dropped_is_open += 1
                continue
            try:
                is_open_v = int(is_open_raw)
            except (TypeError, ValueError):
                dropped_is_open += 1
                continue
            rows.append(
                {
                    "exchange": str(r["exchange"]),
                    "cal_date": str(r["cal_date"]),
                    "is_open": is_open_v,
                    "pretrade_date": to_str_or_none(r["pretrade_date"]),
                }
            )
        if dropped_is_open:
            logger.warning(
                "trade_cal_is_open_missing",
                extra={
                    "api_name": API_NAME,
                    "exchange": exch,
                    "dropped": dropped_is_open,
                },
            )
        with session_scope() as session:
            n = upsert_rows(
                session,
                table=TABLE,
                rows=rows,
                pk_cols=PK_COLS,
                update_cols=UPDATE_COLS,
            )
        reports.append(
            SyncReport(api_name=API_NAME, rows_upserted=n, empty_path=None, params=dict(params))
        )
    return reports
