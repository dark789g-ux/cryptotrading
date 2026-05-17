"""raw.index_member —— TuShare index_member_all 接口（PIT 关键）

字段映射（tushare 文档 wctapi/documents/335）：
  l1_code / l1_name  一级行业代码 / 名称
  l2_code / l2_name  二级行业代码 / 名称
  l3_code / l3_name  三级行业代码 / 名称
  ts_code            成分股代码
  name               成分股名称
  in_date            纳入日期 YYYYMMDD
  out_date           剔除日期 YYYYMMDD（NULL 表示仍在）
  is_new             是否最新 Y / N

PIT 关键：因子计算行业归属必须用"当时"成份股（doc/03 三幽灵 Bug 之一）。
单次最大 2000 行；本 M1 实现按 l1_code 循环拉取（spec 默认 is_new 不传，
让历史与当前快照都收进来，避免幽灵 bug）。
PK：(l3_code, ts_code, in_date)
"""

from __future__ import annotations

import logging
from typing import Any

from quant_pipeline.db.engine import session_scope
from quant_pipeline.sync._upsert import dedupe_by_pk, upsert_rows
from quant_pipeline.sync.trade_cal import SyncReport
from quant_pipeline.sync.tushare_client import TushareClient

logger = logging.getLogger(__name__)

API_NAME = "index_member_all"
TABLE = "raw.index_member"
PK_COLS = ("l3_code", "ts_code", "in_date")
UPDATE_COLS = (
    "out_date",
    "l1_code",
    "l1_name",
    "l2_code",
    "l2_name",
    "l3_name",
    "name",
    "is_new",
)

OUT_COLS = [
    "l3_code",
    "ts_code",
    "in_date",
    "out_date",
    "l1_code",
    "l1_name",
    "l2_code",
    "l2_name",
    "l3_name",
    "name",
    "is_new",
]


def sync_index_member(
    *,
    l1_codes: tuple[str, ...] | None = None,
    is_new: str | None = None,
    client: TushareClient | None = None,
) -> list[SyncReport]:
    """同步申万行业成份历史快照。

    参数：
      l1_codes: 限定一级行业代码集合；None 时一次拉全量（受 2000 行单次上限影响，
        推荐按 l1_code 逐个调用）
      is_new: 'Y' / 'N' / None；None 时 TuShare 默认 'Y'（最新成份）
        ※ PIT 计算需要历史段：M1 建议 is_new=None 由调用方按需切换
    """

    client = client or TushareClient()
    reports: list[SyncReport] = []

    if l1_codes is None:
        # 单次全量调用
        params: dict[str, Any] = {}
        if is_new is not None:
            params["is_new"] = is_new
        reports.extend(_fetch_and_upsert(client, params))
    else:
        for l1 in l1_codes:
            params = {"l1_code": l1}
            if is_new is not None:
                params["is_new"] = is_new
            reports.extend(_fetch_and_upsert(client, params))
    return reports


def _fetch_and_upsert(client: TushareClient, params: dict[str, Any]) -> list[SyncReport]:
    result = client.fetch(API_NAME, **params)
    if result.empty_path is not None:
        return [
            SyncReport(
                api_name=API_NAME,
                rows_upserted=0,
                empty_path=result.empty_path,
                params=dict(params),
            )
        ]

    df = result.df.copy()
    for col in OUT_COLS:
        if col not in df.columns:
            df[col] = None
    df = df[OUT_COLS]
    # in_date 缺失的行直接丢弃（PK 缺值无法 upsert），并 warn
    null_in = df["in_date"].isna() | (df["in_date"].astype(str).str.len() == 0)
    if null_in.any():
        logger.warning(
            "index_member_null_in_date",
            extra={"api_name": API_NAME, "dropped": int(null_in.sum()), "params": params},
        )
        df = df[~null_in]
    df = dedupe_by_pk(df, PK_COLS, api_name=API_NAME)

    def _s(v: Any) -> str | None:
        return None if v is None or (isinstance(v, float) and v != v) else str(v)

    rows = [
        {
            "l3_code": str(r["l3_code"]),
            "ts_code": str(r["ts_code"]),
            "in_date": str(r["in_date"]),
            "out_date": _s(r["out_date"]),
            "l1_code": _s(r["l1_code"]),
            "l1_name": _s(r["l1_name"]),
            "l2_code": _s(r["l2_code"]),
            "l2_name": _s(r["l2_name"]),
            "l3_name": _s(r["l3_name"]),
            "name": _s(r["name"]),
            "is_new": _s(r["is_new"]),
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
    return [
        SyncReport(api_name=API_NAME, rows_upserted=n, empty_path=None, params=dict(params))
    ]
