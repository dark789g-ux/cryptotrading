"""raw.index_classify —— TuShare index_classify 接口

字段映射（tushare 文档 wctapi/documents/181）：
  index_code     str  指数代码（如 801010.SI）
  industry_name  str  行业名称
  parent_code    str  父级代码（一级行业为 '0' 或 NULL）
  level          str  L1 / L2 / L3
  industry_code  str  行业代码（如 110000）
  src            str  SW2014 / SW2021

按 (src, level) 组合拉取；7 个组合（SW2014 L1/L2/L3 + SW2021 L1/L2/L3 + 兜底全量）。
PK：(src, index_code)
"""

from __future__ import annotations

import logging
from typing import Any

from quant_pipeline.db.engine import session_scope
from quant_pipeline.sync._upsert import dedupe_by_pk, upsert_rows
from quant_pipeline.sync.trade_cal import SyncReport
from quant_pipeline.sync.tushare_client import TushareClient

logger = logging.getLogger(__name__)

API_NAME = "index_classify"
TABLE = "raw.index_classify"
PK_COLS = ("src", "index_code")
UPDATE_COLS = ("industry_code", "industry_name", "parent_code", "level")

# 申万两版本 × 三级（M1 优先 SW2021）
DEFAULT_COMBOS: tuple[tuple[str, str], ...] = (
    ("SW2021", "L1"),
    ("SW2021", "L2"),
    ("SW2021", "L3"),
    ("SW2014", "L1"),
    ("SW2014", "L2"),
    ("SW2014", "L3"),
)


def sync_index_classify(
    *,
    combos: tuple[tuple[str, str], ...] = DEFAULT_COMBOS,
    client: TushareClient | None = None,
) -> list[SyncReport]:
    """同步申万行业分类表。

    每个 (src, level) 组合一次 fetch。
    """

    client = client or TushareClient()
    reports: list[SyncReport] = []

    for src, level in combos:
        params: dict[str, Any] = {"src": src, "level": level}
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
        # 把 src 列补上（接口可能不默认返回，文档示例输出无 src）
        if "src" not in df.columns:
            df["src"] = src
        for col in ("index_code", "industry_name", "parent_code", "level", "industry_code"):
            if col not in df.columns:
                df[col] = None
        df = df[["src", "index_code", "industry_code", "industry_name", "parent_code", "level"]]
        df = dedupe_by_pk(df, PK_COLS, api_name=API_NAME)

        rows = [
            {
                "src": str(r["src"]),
                "index_code": str(r["index_code"]),
                "industry_code": (
                    str(r["industry_code"]) if r["industry_code"] is not None else None
                ),
                "industry_name": (
                    str(r["industry_name"]) if r["industry_name"] is not None else None
                ),
                "parent_code": (
                    str(r["parent_code"]) if r["parent_code"] is not None else None
                ),
                "level": str(r["level"]) if r["level"] is not None else None,
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
        reports.append(
            SyncReport(api_name=API_NAME, rows_upserted=n, empty_path=None, params=dict(params))
        )
    return reports
