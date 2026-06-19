"""raw.us_symbol —— 美股精选清单播种。

v1：从 CSV（股票代码/股票名称/行业/类型）播种 tracked 集（seed 显式置 tracked=true，
这是建立"要同步哪些"的权威操作）。全名单批量同步另写、不动 tracked。
"""

from __future__ import annotations

import csv
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from quant_pipeline.db.engine import session_scope
from quant_pipeline.sync._upsert import dedupe_by_pk, upsert_rows

logger = logging.getLogger(__name__)

TABLE = "raw.us_symbol"
PK_COLS = ("ticker",)
# seed 显式建立 tracked 集，故 tracked 进 update_cols（与 P2 名单同步不同）
UPDATE_COLS = ("name", "theme", "stock_type", "tracked")

# CSV 表头 → 列名
_CSV_MAP = {
    "股票代码": "ticker",
    "股票名称": "name",
    "行业": "theme",
    "类型": "stock_type",
}


@dataclass(frozen=True)
class SeedReport:
    rows_upserted: int
    tickers: list[str]


def seed_us_symbols_from_csv(csv_path: str | Path) -> SeedReport:
    path = Path(csv_path)
    if not path.exists():
        raise FileNotFoundError(f"CSV 不存在：{path}")

    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        missing = [h for h in _CSV_MAP if h not in (reader.fieldnames or [])]
        if missing:
            raise ValueError(f"CSV 缺列 {missing!r}；实际表头 {reader.fieldnames!r}")
        for r in reader:
            ticker = (r.get("股票代码") or "").strip().upper()
            if not ticker:
                continue
            rows.append(
                {
                    "ticker": ticker,
                    "name": (r.get("股票名称") or "").strip() or None,
                    "theme": (r.get("行业") or "").strip() or None,
                    "stock_type": (r.get("类型") or "").strip() or None,
                    "tracked": True,
                }
            )

    if not rows:
        logger.warning("us_symbol_seed_empty", extra={"csv": str(path)})
        return SeedReport(rows_upserted=0, tickers=[])

    import pandas as pd

    df = dedupe_by_pk(pd.DataFrame(rows), PK_COLS, api_name="us_symbol_seed")
    deduped = df.to_dict(orient="records")
    with session_scope() as session:
        n = upsert_rows(
            session,
            table=TABLE,
            rows=deduped,
            pk_cols=PK_COLS,
            update_cols=UPDATE_COLS,
        )
    tickers = [str(r["ticker"]) for r in deduped]
    logger.info("us_symbol_seeded", extra={"csv": str(path), "rows": n})
    return SeedReport(rows_upserted=n, tickers=tickers)


def list_tracked_tickers() -> list[str]:
    from sqlalchemy import text

    with session_scope() as session:
        res = session.execute(
            text("SELECT ticker FROM raw.us_symbol WHERE tracked = true ORDER BY ticker")
        ).all()
    return [r[0] for r in res]
