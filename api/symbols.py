# -*- coding: utf-8 -*-
"""
标的列表与 K 线数据 API。
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Literal

import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field, field_validator

router = APIRouter()

CACHE_DIR = Path("cache")
INTERVALS = {
    "1h": CACHE_DIR / "1h_klines",
    "4h": CACHE_DIR / "4h_klines",
    "1d": CACHE_DIR / "1d_klines",
}
QUERY_MAX_WORKERS = 8
MAX_PAGE_SIZE = 100
MAX_CONDITIONS = 10

OPS = {"lt", "lte", "gt", "gte", "eq", "neq"}


class SortModel(BaseModel):
    field: str = "symbol"
    asc: bool = True


class ConditionModel(BaseModel):
    field: str
    op: Literal["lt", "lte", "gt", "gte", "eq", "neq"]
    value: float


class SymbolsQueryBody(BaseModel):
    interval: str = "1d"
    page: int = Field(1, ge=1)
    page_size: int = Field(20, ge=1, le=MAX_PAGE_SIZE)
    sort: SortModel = Field(default_factory=SortModel)
    q: str = ""
    conditions: list[ConditionModel] = Field(default_factory=list)
    fields: list[str] = Field(default_factory=list)

    @field_validator("conditions")
    @classmethod
    def _cap_conditions(cls, v: list[ConditionModel]) -> list[ConditionModel]:
        if len(v) > MAX_CONDITIONS:
            raise ValueError(f"条件最多 {MAX_CONDITIONS} 条")
        return v


def _interval_dir(interval: str) -> Path:
    if interval not in INTERVALS:
        raise HTTPException(400, f"不支持的周期: {interval}")
    return INTERVALS[interval]


def _list_csv_candidates(interval: str) -> list[tuple[Path, str]]:
    klines_dir = _interval_dir(interval)
    if not klines_dir.exists():
        return []
    suffix = f"_{interval}.csv"
    return [
        (f, f.stem.replace(f"_{interval}", ""))
        for f in sorted(klines_dir.glob(f"*{suffix}"))
        if f.is_file()
    ]


def _read_header_columns(path: Path) -> list[str]:
    try:
        return list(pd.read_csv(path, encoding="utf-8-sig", nrows=0).columns)
    except Exception:
        return []


def _union_columns(paths: list[Path]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for p in paths:
        for c in _read_header_columns(p):
            if c not in seen:
                seen.add(c)
                ordered.append(c)
    return ordered


def _read_last_row_series(path: Path) -> pd.Series | None:
    try:
        df = pd.read_csv(path, encoding="utf-8-sig")
        if df.empty:
            return None
        return df.iloc[-1]
    except Exception:
        return None


def _numeric_cell(row: pd.Series, field: str) -> float | None:
    if row is None or field not in row.index:
        return None
    v = pd.to_numeric(row[field], errors="coerce")
    if pd.isna(v):
        return None
    return float(v)


def _cmp(op: str, left: float, right: float) -> bool:
    if op == "lt":
        return left < right
    if op == "lte":
        return left <= right
    if op == "gt":
        return left > right
    if op == "gte":
        return left >= right
    if op == "eq":
        return left == right
    if op == "neq":
        return left != right
    return False


def _passes_conditions(row: pd.Series | None, conditions: list[ConditionModel]) -> bool:
    if row is None:
        return False
    for c in conditions:
        val = _numeric_cell(row, c.field)
        if val is None:
            return False
        if not _cmp(c.op, val, c.value):
            return False
    return True


def _build_item(symbol: str, row: pd.Series | None, fields: list[str]) -> dict[str, Any]:
    item: dict[str, Any] = {"symbol": symbol}
    if row is None:
        for f in fields:
            item[f] = None
        return item
    for f in fields:
        if f not in row.index:
            item[f] = None
            continue
        v = pd.to_numeric(row[f], errors="coerce")
        item[f] = None if pd.isna(v) else float(v)
    return item


def _sort_key_symbol(sym: str) -> str:
    return sym.lower()


def _sort_rows(rows_out: list[dict[str, Any]], sf: str, asc: bool) -> None:
    if sf == "symbol":
        rows_out.sort(key=lambda i: _sort_key_symbol(i["symbol"]), reverse=not asc)
        return

    def num_key(item: dict[str, Any]) -> tuple[int, float]:
        v = item.get(sf)
        if v is None or (isinstance(v, float) and pd.isna(v)):
            return (1, 0.0)
        fv = float(v)
        return (0, fv if asc else -fv)

    rows_out.sort(key=num_key)


def _query_worker(
    path: Path,
    symbol: str,
    q: str,
    conditions: list[ConditionModel],
    fields: list[str],
) -> dict[str, Any] | None:
    qn = q.strip().lower()
    if qn and qn not in symbol.lower():
        return None
    row = _read_last_row_series(path)
    if not _passes_conditions(row, conditions):
        return None
    return _build_item(symbol, row, fields)


@router.get("/intervals")
def get_intervals():
    return [
        {"id": "1h", "name": "1 小时"},
        {"id": "4h", "name": "4 小时"},
        {"id": "1d", "name": "日线"},
    ]


@router.get("/symbols/kline-columns")
def get_kline_columns(interval: str = Query("1d")):
    _interval_dir(interval)
    candidates = _list_csv_candidates(interval)
    if not candidates:
        return []
    paths = [p for p, _ in candidates]
    return _union_columns(paths)


@router.get("/symbols/names")
def get_symbol_names(interval: str = Query("1d")):
    _interval_dir(interval)
    return [sym for _, sym in _list_csv_candidates(interval)]


@router.post("/symbols/query")
def post_symbols_query(body: SymbolsQueryBody):
    interval = body.interval
    _interval_dir(interval)
    candidates = _list_csv_candidates(interval)
    paths_only = [p for p, _ in candidates]

    union_cols = _union_columns(paths_only) if paths_only else []
    allowed = set(union_cols)

    for f in body.fields:
        if f not in allowed:
            raise HTTPException(400, f"非法列名: {f}")

    if body.sort.field != "symbol" and body.sort.field not in body.fields:
        raise HTTPException(400, f"排序字段必须是 symbol 或已请求的 fields 之一: {body.sort.field}")

    for c in body.conditions:
        if c.field not in allowed:
            raise HTTPException(400, f"条件列不存在: {c.field}")

    if not candidates:
        return {"items": [], "total": 0, "page": body.page, "page_size": body.page_size}

    rows_out: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=QUERY_MAX_WORKERS) as ex:
        futs = {
            ex.submit(_query_worker, path, sym, body.q, body.conditions, body.fields): sym
            for path, sym in candidates
        }
        for fut in as_completed(futs):
            item = fut.result()
            if item is not None:
                rows_out.append(item)

    _sort_rows(rows_out, body.sort.field, body.sort.asc)

    total = len(rows_out)
    start = (body.page - 1) * body.page_size
    end = start + body.page_size
    page_items = rows_out[start:end]

    return {
        "items": page_items,
        "total": total,
        "page": body.page,
        "page_size": body.page_size,
    }


@router.get("/klines/{interval}/{symbol}")
def get_klines(interval: str, symbol: str):
    if interval not in INTERVALS:
        raise HTTPException(400, f"不支持的周期: {interval}")

    path = INTERVALS[interval] / f"{symbol}_{interval}.csv"
    if not path.exists():
        raise HTTPException(404, f"未找到: {symbol} ({interval})")

    try:
        body = path.read_text(encoding="utf-8-sig")
    except Exception as e:
        raise HTTPException(500, str(e))

    return PlainTextResponse(body, media_type="text/csv; charset=utf-8")
