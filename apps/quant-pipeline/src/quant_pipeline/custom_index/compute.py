"""custom_index_compute worker 主入口。"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from quant_pipeline.custom_index.amv import compute_amv_rows
from quant_pipeline.custom_index.indicators import calc_index_indicators
from quant_pipeline.custom_index.money_flow import aggregate_money_flow
from quant_pipeline.custom_index.price_index import compute_price_index_quotes
from quant_pipeline.custom_index.total_return import compute_total_return_quotes
from quant_pipeline.custom_index.types import ComponentBar, ComputeContext, StockMeta
from quant_pipeline.custom_index.weight_resolver import (
    all_member_codes,
    load_weight_versions,
    validate_versions,
)
from quant_pipeline.db.engine import session_scope
from quant_pipeline.sync._upsert import upsert_rows
from quant_pipeline.worker.poller import Job
from quant_pipeline.worker.progress import JobCancelled, check_cancel_requested, update_progress

logger = logging.getLogger(__name__)

QUOTES_TABLE = "custom_index_daily_quotes"
INDICATORS_TABLE = "custom_index_daily_indicators"
MONEY_FLOW_TABLE = "custom_index_money_flow"
AMV_TABLE = "custom_index_amv"


def compute_custom_index(job: Job) -> None:
    """ml.jobs run_type=custom_index_compute 主流程。"""

    params = job.params or {}
    custom_index_id = params.get("custom_index_id")
    user_id = params.get("user_id")
    full_rebuild = bool(params.get("full_rebuild", True))

    if not isinstance(custom_index_id, str) or not isinstance(user_id, str):
        raise ValueError(
            "custom_index_compute params 需要 custom_index_id / user_id 字符串"
        )

    definition = _load_definition(custom_index_id, user_id)
    if definition is None:
        raise ValueError(f"custom_index 不存在或无权限: {custom_index_id}")

    _set_definition_status(
        custom_index_id,
        status="computing",
        progress=0,
        stage="load_members",
        job_id=job.id,
        last_error=None,
    )

    try:
        _run_stages(job, definition, full_rebuild=full_rebuild)
        _set_definition_status(
            custom_index_id,
            status="ready",
            progress=100,
            stage="finalize",
            job_id=job.id,
            last_error=None,
        )
        update_progress(job.id, 100, stage="finalize")
    except JobCancelled:
        raise
    except Exception as exc:
        _set_definition_status(
            custom_index_id,
            status="failed",
            progress=None,
            stage=None,
            job_id=job.id,
            last_error=str(exc),
        )
        raise


def _run_stages(job: Job, definition: dict[str, Any], *, full_rebuild: bool) -> None:
    custom_index_id = str(definition["id"])
    base_date = str(definition["base_date"])
    base_point = float(definition["base_point"])
    index_type = str(definition["index_type"])

    if check_cancel_requested(job.id):
        raise JobCancelled

    update_progress(job.id, 5, stage="load_members")
    with session_scope() as session:
        versions = load_weight_versions(session, custom_index_id)
        validate_versions(versions)

        if full_rebuild:
            _delete_derived_data(session, custom_index_id)

        if check_cancel_requested(job.id):
            raise JobCancelled

        update_progress(job.id, 15, stage="sync_quotes")
        ctx = _load_compute_context(
            session,
            versions=versions,
            base_date=base_date,
        )

        if check_cancel_requested(job.id):
            raise JobCancelled

        update_progress(job.id, 50, stage="quotes")
        warnings: list[dict[str, object]] = []

        def on_warning(wtype: str, detail: dict[str, object]) -> None:
            warnings.append({"type": wtype, **detail})
            _emit_job_warning(job.id, wtype, **detail)

        if index_type == "total_return":
            quotes = compute_total_return_quotes(
                versions=versions,
                ctx=ctx,
                base_date=base_date,
                base_point=base_point,
                on_warning=on_warning,
            )
        else:
            quotes = compute_price_index_quotes(
                versions=versions,
                ctx=ctx,
                base_date=base_date,
                base_point=base_point,
                on_warning=on_warning,
            )

        quote_rows = _quotes_to_db_rows(custom_index_id, quotes)
        upsert_rows(
            session,
            table=QUOTES_TABLE,
            rows=quote_rows,
            pk_cols=("custom_index_id", "trade_date"),
            update_cols=(
                "open",
                "high",
                "low",
                "close",
                "pre_close",
                "change",
                "pct_change",
                "vol_hand",
                "amount",
            ),
        )

        if check_cancel_requested(job.id):
            raise JobCancelled
        update_progress(job.id, 60, stage="indicators")
        indic_rows = calc_index_indicators(quotes)
        indic_db = [
            {"custom_index_id": custom_index_id, **row} for row in indic_rows
        ]
        upsert_rows(
            session,
            table=INDICATORS_TABLE,
            rows=indic_db,
            pk_cols=("custom_index_id", "trade_date"),
            update_cols=(
                "ma5",
                "ma30",
                "ma60",
                "ma120",
                "ma240",
                "dif",
                "dea",
                "macd",
                "kdj_k",
                "kdj_d",
                "kdj_j",
                "bbi",
                "brick",
                "brick_delta",
                "brick_xg",
            ),
        )

        if check_cancel_requested(job.id):
            raise JobCancelled
        update_progress(job.id, 70, stage="money_flow")
        trade_dates = [q.trade_date for q in quotes]
        mf_rows = aggregate_money_flow(
            session,
            custom_index_id=custom_index_id,
            versions=versions,
            trade_dates=trade_dates,
        )
        upsert_rows(
            session,
            table=MONEY_FLOW_TABLE,
            rows=mf_rows,
            pk_cols=("custom_index_id", "trade_date"),
            update_cols=("net_amount", "buy_lg_amount", "buy_md_amount", "buy_sm_amount"),
        )

        if check_cancel_requested(job.id):
            raise JobCancelled
        update_progress(job.id, 80, stage="amv")
        amv_rows = compute_amv_rows(
            custom_index_id=custom_index_id,
            versions=versions,
            ctx=ctx,
            quotes=quotes,
        )
        upsert_rows(
            session,
            table=AMV_TABLE,
            rows=amv_rows,
            pk_cols=("custom_index_id", "trade_date"),
            update_cols=("amv", "amv_ma5", "amv_ma10", "amv_ma20", "amv_ma60"),
        )

    logger.info(
        "custom_index_compute_done",
        extra={
            "custom_index_id": custom_index_id,
            "quote_rows": len(quotes),
            "warnings": len(warnings),
        },
    )


def _load_definition(custom_index_id: str, user_id: str) -> dict[str, Any] | None:
    with session_scope() as session:
        row = session.execute(
            text(
                """
                SELECT id, user_id, ts_code, index_type, base_date, base_point
                FROM custom_index_definitions
                WHERE id = :id AND user_id = :uid
                """
            ),
            {"id": custom_index_id, "uid": user_id},
        ).mappings().first()
        return dict(row) if row else None


def _set_definition_status(
    custom_index_id: str,
    *,
    status: str,
    progress: int | None,
    stage: str | None,
    job_id: UUID,
    last_error: str | None,
) -> None:
    with session_scope() as session:
        session.execute(
            text(
                """
                UPDATE custom_index_definitions
                SET status = :status,
                    compute_progress = :progress,
                    compute_stage = :stage,
                    latest_job_id = :job_id,
                    last_error = :last_error,
                    updated_at = now()
                WHERE id = :id
                """
            ),
            {
                "status": status,
                "progress": progress,
                "stage": stage,
                "job_id": job_id,
                "last_error": last_error,
                "id": custom_index_id,
            },
        )


def _delete_derived_data(session: Session, custom_index_id: str) -> None:
    for table in (QUOTES_TABLE, INDICATORS_TABLE, MONEY_FLOW_TABLE, AMV_TABLE):
        session.execute(
            text(f"DELETE FROM {table} WHERE custom_index_id = :id"),
            {"id": custom_index_id},
        )


def _load_trade_dates(session: Session, start_date: str) -> list[str]:
    rows = session.execute(
        text(
            """
            SELECT cal_date
            FROM raw.trade_cal
            WHERE exchange = 'SSE'
              AND is_open = '1'
              AND cal_date >= :start
            ORDER BY cal_date ASC
            """
        ),
        {"start": start_date},
    ).fetchall()
    return [str(r[0]) for r in rows]


def _load_stock_meta(session: Session, codes: set[str]) -> dict[str, StockMeta]:
    if not codes:
        return {}
    rows = session.execute(
        text(
            """
            SELECT ts_code, list_date, delist_date
            FROM a_share_symbols
            WHERE ts_code = ANY(:codes)
            """
        ),
        {"codes": list(codes)},
    ).mappings().all()
    return {
        str(r["ts_code"]): StockMeta(
            list_date=str(r["list_date"]) if r["list_date"] else None,
            delist_date=str(r["delist_date"]) if r["delist_date"] else None,
        )
        for r in rows
    }


def _load_adj_latest(session: Session, codes: set[str]) -> dict[str, float]:
    if not codes:
        return {}
    rows = session.execute(
        text(
            """
            SELECT DISTINCT ON (ts_code) ts_code, adj_factor
            FROM raw.adj_factor
            WHERE ts_code = ANY(:codes)
            ORDER BY ts_code, trade_date DESC
            """
        ),
        {"codes": list(codes)},
    ).mappings().all()
    out: dict[str, float] = {}
    for row in rows:
        if row["adj_factor"] is not None:
            out[str(row["ts_code"])] = float(row["adj_factor"])
    return out


def _load_daily_quotes(
    session: Session,
    *,
    codes: set[str],
    start_date: str,
) -> list[dict[str, Any]]:
    if not codes:
        return []
    return list(
        session.execute(
            text(
                """
                SELECT ts_code, trade_date,
                       open, high, low, close, pre_close, vol, amount,
                       qfq_open, qfq_high, qfq_low, qfq_close
                FROM raw.daily_quote
                WHERE ts_code = ANY(:codes)
                  AND trade_date >= :start
                ORDER BY trade_date ASC, ts_code ASC
                """
            ),
            {"codes": list(codes), "start": start_date},
        ).mappings().all()
    )


def _load_adj_series(
    session: Session,
    *,
    codes: set[str],
    start_date: str,
) -> dict[tuple[str, str], float]:
    if not codes:
        return {}
    rows = session.execute(
        text(
            """
            SELECT ts_code, trade_date, adj_factor
            FROM raw.adj_factor
            WHERE ts_code = ANY(:codes)
              AND trade_date >= :start
            ORDER BY trade_date ASC
            """
        ),
        {"codes": list(codes), "start": start_date},
    ).mappings().all()
    out: dict[tuple[str, str], float] = {}
    for row in rows:
        if row["adj_factor"] is not None:
            out[(str(row["ts_code"]), str(row["trade_date"]))] = float(row["adj_factor"])
    return out


def _f(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _pick_qfq(row: dict[str, Any], field: str, raw_field: str, adj: float | None, adj_latest: float | None) -> float | None:
    qfq = _f(row.get(field))
    if qfq is not None:
        return qfq
    raw = _f(row.get(raw_field))
    if raw is None:
        return None
    if adj is not None and adj_latest is not None and adj_latest > 0:
        return raw * adj / adj_latest
    return raw


def _load_compute_context(
    session: Session,
    *,
    versions: list,
    base_date: str,
) -> ComputeContext:
    codes = all_member_codes(versions)
    trade_dates = _load_trade_dates(session, base_date)
    stock_meta = _load_stock_meta(session, codes)
    adj_latest = _load_adj_latest(session, codes)
    quote_rows = _load_daily_quotes(session, codes=codes, start_date=base_date)
    adj_series = _load_adj_series(session, codes=codes, start_date=base_date)

    prev_price: dict[str, float] = {}
    prev_raw_close: dict[str, float] = {}
    prev_adj: dict[str, float] = {}
    bars_by_date: dict[str, dict[str, ComponentBar]] = {}

    for row in quote_rows:
        code = str(row["ts_code"])
        trade_date = str(row["trade_date"])
        adj = adj_series.get((code, trade_date))
        adj_lat = adj_latest.get(code)

        close_raw = _f(row["close"])
        price = _pick_qfq(row, "qfq_close", "close", adj, adj_lat)
        open_p = _pick_qfq(row, "qfq_open", "open", adj, adj_lat)
        high_p = _pick_qfq(row, "qfq_high", "high", adj, adj_lat)
        low_p = _pick_qfq(row, "qfq_low", "low", adj, adj_lat)
        if price is None or open_p is None or high_p is None or low_p is None:
            continue

        bar = ComponentBar(
            con_code=code,
            trade_date=trade_date,
            open=_f(row["open"]) or close_raw or price,
            high=_f(row["high"]) or price,
            low=_f(row["low"]) or price,
            close=close_raw or price,
            pre_close=_f(row["pre_close"]),
            vol=_f(row["vol"]),
            amount=_f(row["amount"]),
            price=price,
            price_prev=prev_price.get(code),
            price_prev_raw=prev_raw_close.get(code),
            open_price=open_p,
            high_price=high_p,
            low_price=low_p,
            adj_factor=adj,
            adj_factor_prev=prev_adj.get(code),
        )
        bars_by_date.setdefault(trade_date, {})[code] = bar
        prev_price[code] = price
        if close_raw is not None:
            prev_raw_close[code] = close_raw
        if adj is not None:
            prev_adj[code] = adj

    return ComputeContext(
        trade_dates=trade_dates,
        bars_by_date=bars_by_date,
        stock_meta=stock_meta,
        adj_latest=adj_latest,
    )


def _quotes_to_db_rows(custom_index_id: str, quotes: list) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for q in quotes:
        rows.append(
            {
                "custom_index_id": custom_index_id,
                "trade_date": q.trade_date,
                "open": q.open,
                "high": q.high,
                "low": q.low,
                "close": q.close,
                "pre_close": q.pre_close,
                "change": q.change,
                "pct_change": q.pct_change,
                "vol_hand": q.vol_hand,
                "amount": q.amount,
            }
        )
    return rows


def _emit_job_warning(job_id: UUID, warning_type: str, **detail: Any) -> None:
    item: dict[str, Any] = {
        "type": warning_type,
        "ts": datetime.now(UTC).isoformat(),
    }
    item.update(detail)
    try:
        with session_scope() as session:
            session.execute(
                text(
                    """
                    UPDATE ml.jobs
                    SET warnings = COALESCE(warnings, '[]'::jsonb) || CAST(:w AS jsonb)
                    WHERE id = :id
                    """
                ),
                {"w": json.dumps([item], ensure_ascii=False), "id": job_id},
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "custom_index_emit_warning_failed",
            extra={"job_id": str(job_id), "type": warning_type, "err": str(exc)},
        )
