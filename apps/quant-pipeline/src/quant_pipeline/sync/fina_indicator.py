"""raw.fina_indicator —— TuShare fina_indicator 接口（强制 ann_date PIT 入库）

字段映射（tushare 文档 wctapi/documents/79）：
  ts_code     str   TS 代码
  ann_date    str   公告日期 YYYYMMDD  ← PIT 关键字段，必入 PK
  end_date    str   报告期 YYYYMMDD
  + 80+ 财务指标（eps / roe / debt_to_assets / ...）

接口限制：
  - **单次最多 100 条**（文档明示）；超 5000 积分可用 fina_indicator_vip（横截面）
  - 当前 7000 积分理论可调 fina_indicator_vip，但 spec 文件统一以
    fina_indicator 实现（保守路径，按 ts_code 循环；M2 视进度再切 VIP）

入库策略：
  - 全量字段以 jsonb 存（indicators 列），避免 80+ 列扁平化与 schema 漂移耦合
  - PK 含 ann_date：同一报告期可能有修正公告（多次 ann_date），全部保留
  - **禁止以 end_date 单独作为 key 入库**（CLAUDE.md / spec 硬约束）

PK：(ts_code, end_date, ann_date)
"""

from __future__ import annotations

import json
import logging
import math
from typing import Any

from quant_pipeline.db.engine import session_scope
from quant_pipeline.sync._upsert import dedupe_by_pk, upsert_rows
from quant_pipeline.sync.trade_cal import SyncReport
from quant_pipeline.sync.tushare_client import TushareClient

logger = logging.getLogger(__name__)

API_NAME = "fina_indicator"
TABLE = "raw.fina_indicator"
PK_COLS = ("ts_code", "end_date", "ann_date")
UPDATE_COLS = ("indicators", "update_flag")


def sync_fina_indicator_by_ts_code(
    *,
    ts_code: str,
    start_date: str | None = None,
    end_date: str | None = None,
    client: TushareClient | None = None,
) -> SyncReport:
    """按单只股票拉取财务指标（fina_indicator 接口仅支持单股调用）。

    参数：
      ts_code: 必填，e.g. '600000.SH'
      start_date / end_date: 可选；TuShare 文档将其解释为"报告期开始/结束日期"
    """

    client = client or TushareClient()
    params: dict[str, Any] = {"ts_code": ts_code}
    if start_date is not None:
        params["start_date"] = start_date
    if end_date is not None:
        params["end_date"] = end_date

    result = client.fetch(API_NAME, **params)
    if result.empty_path is not None:
        return SyncReport(
            api_name=API_NAME,
            rows_upserted=0,
            empty_path=result.empty_path,
            params=dict(params),
        )

    df = result.df.copy()
    # PK 三列缺失：直接丢，绝不入库无 PK 的行
    for must in ("ts_code", "ann_date", "end_date"):
        if must not in df.columns:
            df[must] = None
    null_pk = (
        df["ts_code"].isna()
        | df["ann_date"].isna()
        | df["end_date"].isna()
        | (df["ann_date"].astype(str).str.len() == 0)
        | (df["end_date"].astype(str).str.len() == 0)
    )
    if null_pk.any():
        logger.warning(
            "fina_indicator_null_pk",
            extra={"api_name": API_NAME, "dropped": int(null_pk.sum()), "params": params},
        )
        df = df[~null_pk]
    if df.empty:
        return SyncReport(
            api_name=API_NAME,
            rows_upserted=0,
            empty_path="items_empty",  # 等价于空数据，调用方放入 failedItems
            params=dict(params),
        )

    df = dedupe_by_pk(df, PK_COLS, api_name=API_NAME)

    # 把除 PK 与 update_flag 外的所有列收进 indicators jsonb
    rows: list[dict[str, Any]] = []
    for r in df.to_dict(orient="records"):
        ts_code_v = str(r["ts_code"])
        ann_date_v = str(r["ann_date"])
        end_date_v = str(r["end_date"])
        update_flag_v = r.get("update_flag")
        update_flag_v = str(update_flag_v) if update_flag_v is not None else None
        indicators = {
            k: _jsonable(v)
            for k, v in r.items()
            if k not in ("ts_code", "ann_date", "end_date", "update_flag")
        }
        rows.append(
            {
                "ts_code": ts_code_v,
                "ann_date": ann_date_v,
                "end_date": end_date_v,
                "indicators": json.dumps(indicators, ensure_ascii=False),
                "update_flag": update_flag_v,
            }
        )

    # indicators 是 json 文本字符串；交给 upsert_rows 的 jsonb_cols 生成
    # CAST(:indicators AS jsonb) 占位符，避免 driver 把 jsonb 当 text 绑定。
    with session_scope() as session:
        n = upsert_rows(
            session,
            table=TABLE,
            rows=rows,
            pk_cols=PK_COLS,
            update_cols=UPDATE_COLS,
            jsonb_cols=("indicators",),
        )

    return SyncReport(api_name=API_NAME, rows_upserted=n, empty_path=None, params=dict(params))


def _jsonable(v: Any) -> Any:
    """把 pandas / numpy 值转为 jsonable 原始类型。"""

    if v is None:
        return None
    if isinstance(v, float):
        return None if math.isnan(v) else v
    if isinstance(v, str | int | bool):
        return v
    # numpy 标量
    try:
        import numpy as np

        if isinstance(v, np.generic):
            if isinstance(v, np.floating):
                f = float(v)
                return None if math.isnan(f) else f
            return v.item()
    except ImportError:
        pass
    return str(v)
