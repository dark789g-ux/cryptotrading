# -*- coding: utf-8 -*-
"""
标的列表与 K 线数据 API。
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse

router = APIRouter()

CACHE_DIR = Path("cache")
INTERVALS = {
    "1h": CACHE_DIR / "1h_klines",
    "4h": CACHE_DIR / "4h_klines",
    "1d": CACHE_DIR / "1d_klines",
}
STRATEGY_MAX_WORKERS = 8

# ── 标的筛选策略 ──────────────────────────────────────────────

FILTER_STRATEGIES = [
    {"id": "", "name": "无"},
    {"id": "jdj_ma", "name": "KDJ超卖+均线多头"},
]


def _get_last_row_indicators(path: Path) -> tuple[float | None, float | None]:
    try:
        df = pd.read_csv(path, encoding="utf-8-sig")
        if df.empty:
            return None, None
        row = df.iloc[-1]
        sl = pd.to_numeric(row.get("stop_loss_pct"), errors="coerce")
        rr = pd.to_numeric(row.get("risk_reward_ratio"), errors="coerce")
        return (float(sl) if pd.notna(sl) else None), (float(rr) if pd.notna(rr) else None)
    except Exception:
        return None, None


def _check_strategy_jdj_ma(path: Path) -> tuple[bool, float | None, float | None]:
    try:
        df = pd.read_csv(path, encoding="utf-8-sig")
        if df.empty:
            return False, None, None
        row = df.iloc[-1]
        j     = pd.to_numeric(row.get("KDJ.J"), errors="coerce")
        close = pd.to_numeric(row.get("close"), errors="coerce")
        ma30  = pd.to_numeric(row.get("MA30"), errors="coerce")
        ma60  = pd.to_numeric(row.get("MA60"), errors="coerce")
        ma120 = pd.to_numeric(row.get("MA120"), errors="coerce")
        sl    = pd.to_numeric(row.get("stop_loss_pct"), errors="coerce")
        rr    = pd.to_numeric(row.get("risk_reward_ratio"), errors="coerce")
        if any(pd.isna(v) for v in [j, close, ma30, ma60, ma120]):
            return False, None, None
        ok = j < 10 and close > ma60 and ma30 > ma60 and ma60 > ma120
        return ok, (float(sl) if pd.notna(sl) else None), (float(rr) if pd.notna(rr) else None)
    except Exception:
        return False, None, None


STRATEGY_CHECKERS: dict[str, object] = {
    "jdj_ma": _check_strategy_jdj_ma,
}


# ── 路由 ──────────────────────────────────────────────────────

@router.get("/intervals")
def get_intervals():
    return [
        {"id": "1h", "name": "1 小时"},
        {"id": "4h", "name": "4 小时"},
        {"id": "1d", "name": "日线"},
    ]


@router.get("/filter-strategies")
def get_filter_strategies():
    return FILTER_STRATEGIES


@router.get("/symbols")
def get_symbols(
    interval: str = Query("1d"),
    strategy: str = Query(""),
):
    if interval not in INTERVALS:
        raise HTTPException(400, f"不支持的周期: {interval}")

    klines_dir = INTERVALS[interval]
    if not klines_dir.exists():
        return []

    suffix = f"_{interval}.csv"
    candidates = [
        (f, f.stem.replace(f"_{interval}", ""))
        for f in sorted(klines_dir.glob(f"*{suffix}"))
        if f.is_file()
    ]

    def _build(sym: str, sl, rr):
        return {"symbol": sym, "interval": interval, "stop_loss_pct": sl, "risk_reward_ratio": rr}

    checker = STRATEGY_CHECKERS.get(strategy) if strategy else None

    if checker:
        filtered = []
        with ThreadPoolExecutor(max_workers=STRATEGY_MAX_WORKERS) as ex:
            futures = {ex.submit(checker, f): sym for f, sym in candidates}
            for fut in as_completed(futures):
                sym = futures[fut]
                res = fut.result()
                passed, sl, rr = res[0], res[1], res[2]
                if passed:
                    filtered.append(_build(sym, sl, rr))
        return sorted(filtered, key=lambda x: x["symbol"])

    with ThreadPoolExecutor(max_workers=STRATEGY_MAX_WORKERS) as ex:
        futures = {ex.submit(_get_last_row_indicators, f): sym for f, sym in candidates}
        result = []
        for fut in as_completed(futures):
            sym = futures[fut]
            sl, rr = fut.result()
            result.append(_build(sym, sl, rr))
    return sorted(result, key=lambda x: x["symbol"])


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
