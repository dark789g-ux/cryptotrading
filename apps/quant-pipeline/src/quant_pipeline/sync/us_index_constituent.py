"""raw.us_index_constituent —— 美股指数成分名单 seed + 读取。

成分名单从 CSV（列：index_code/ticker/name/weight_pct）seed 到 raw.us_index_constituent。
镜像 us_symbol seed（dedupe_by_pk + upsert_rows），但 PK 是 (index_code, ticker)、
不写 raw.us_symbol（无外键、零污染美股个股 Tab，见 spec 04 §1）。

load_constituents(index_code) 读名单供 AMV 取数 / Σ 聚合用（裸 Σ 不读 weight_pct）。
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

TABLE = "raw.us_index_constituent"
PK_COLS = ("index_code", "ticker")
UPDATE_COLS = ("name", "weight_pct")

# CSV 必需表头（与 data/us_index_constituent_ndx.csv 一致）
_REQUIRED_HEADERS = ("index_code", "ticker", "name", "weight_pct")


@dataclass(frozen=True)
class ConstituentSeedReport:
    rows_upserted: int
    tickers: list[str]


def _parse_weight(raw: str | None) -> float | None:
    """把 CSV 的 weight_pct 文本归一为 float | None（容忍 '7.10%' 或裸数 '7.1' 或空）。"""
    if raw is None:
        return None
    s = raw.strip().rstrip("%").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def seed_us_index_constituent_from_csv(csv_path: str | Path) -> ConstituentSeedReport:
    """从 CSV upsert raw.us_index_constituent（幂等：重跑同 (index_code,ticker) 不增行）。

    CSV 列：index_code,ticker,name,weight_pct（name/weight_pct 可空）。
    """
    path = Path(csv_path)
    if not path.exists():
        raise FileNotFoundError(f"CSV 不存在：{path}")

    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        missing = [h for h in _REQUIRED_HEADERS if h not in (reader.fieldnames or [])]
        if missing:
            raise ValueError(f"CSV 缺列 {missing!r}；实际表头 {reader.fieldnames!r}")
        for r in reader:
            index_code = (r.get("index_code") or "").strip()
            ticker = (r.get("ticker") or "").strip().upper()
            if not index_code or not ticker:
                continue
            rows.append(
                {
                    "index_code": index_code,
                    "ticker": ticker,
                    "name": (r.get("name") or "").strip() or None,
                    "weight_pct": _parse_weight(r.get("weight_pct")),
                }
            )

    if not rows:
        logger.warning("us_index_constituent_seed_empty", extra={"csv": str(path)})
        return ConstituentSeedReport(rows_upserted=0, tickers=[])

    import pandas as pd

    df = dedupe_by_pk(pd.DataFrame(rows), PK_COLS, api_name="us_index_constituent_seed")
    deduped = df.to_dict(orient="records")
    # pandas to_dict 把可空列的 None 还原成 float('nan')（name/weight_pct 均可空）；
    # NaN 写进库会变 "nan" 文本 / NaN 浮点，统一回填 None（NaN 是唯一不等于自身的值）。
    for r in deduped:
        for k in ("name", "weight_pct"):
            v = r.get(k)
            if isinstance(v, float) and v != v:  # NaN
                r[k] = None
    with session_scope() as session:
        n = upsert_rows(
            session,
            table=TABLE,
            rows=deduped,
            pk_cols=PK_COLS,
            update_cols=UPDATE_COLS,
        )
    tickers = [str(r["ticker"]) for r in deduped]
    logger.info(
        "us_index_constituent_seeded",
        extra={"csv": str(path), "rows": n, "tickers": len(tickers)},
    )
    return ConstituentSeedReport(rows_upserted=n, tickers=tickers)


def load_constituents(index_code: str) -> list[str]:
    """读取某指数的成分 ticker 名单（升序）。裸 Σ 聚合只用 ticker，不读 weight_pct。"""
    from sqlalchemy import text

    with session_scope() as session:
        res = session.execute(
            text(
                "SELECT ticker FROM raw.us_index_constituent "
                "WHERE index_code = :idx ORDER BY ticker"
            ),
            {"idx": index_code},
        ).all()
    return [str(r[0]) for r in res]
