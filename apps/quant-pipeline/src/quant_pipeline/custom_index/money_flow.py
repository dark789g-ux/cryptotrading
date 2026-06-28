"""自定义指数资金流等权聚合（spec 06-derived-metrics）。"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from quant_pipeline.custom_index.weight_resolver import resolve_pit_members
from quant_pipeline.custom_index.types import WeightVersion


def aggregate_money_flow(
    session: Session,
    *,
    custom_index_id: str,
    versions: list[WeightVersion],
    trade_dates: list[str],
) -> list[dict[str, Any]]:
    """等权 SUM 成分 money_flow_stocks（PIT 成员，缺失跳过不补零）。"""

    if not trade_dates:
        return []

    min_date = min(trade_dates)
    max_date = max(trade_dates)
    all_codes: set[str] = set()
    for version in versions:
        for member in version.members:
            all_codes.add(member.con_code)
    if not all_codes:
        return []

    rows = session.execute(
        text(
            """
            SELECT ts_code, trade_date, net_amount, buy_lg_amount, buy_md_amount, buy_sm_amount
            FROM money_flow_stocks
            WHERE ts_code = ANY(:codes)
              AND trade_date >= :start
              AND trade_date <= :end
            ORDER BY trade_date ASC
            """
        ),
        {"codes": list(all_codes), "start": min_date, "end": max_date},
    ).mappings().all()

    flow_by_date_code: dict[str, dict[str, dict[str, float | None]]] = {}
    for row in rows:
        td = str(row["trade_date"])
        code = str(row["ts_code"])
        flow_by_date_code.setdefault(td, {})[code] = {
            "net_amount": _f(row["net_amount"]),
            "buy_lg_amount": _f(row["buy_lg_amount"]),
            "buy_md_amount": _f(row["buy_md_amount"]),
            "buy_sm_amount": _f(row["buy_sm_amount"]),
        }

    out: list[dict[str, Any]] = []
    for trade_date in trade_dates:
        members = resolve_pit_members(versions, trade_date)
        pit_codes = {m.con_code for m in members}
        day_flow = flow_by_date_code.get(trade_date, {})

        net = 0.0
        lg = 0.0
        md = 0.0
        sm = 0.0
        net_has = lg_has = md_has = sm_has = False
        for code in pit_codes:
            item = day_flow.get(code)
            if item is None:
                continue
            if item["net_amount"] is not None:
                net += item["net_amount"]
                net_has = True
            if item["buy_lg_amount"] is not None:
                lg += item["buy_lg_amount"]
                lg_has = True
            if item["buy_md_amount"] is not None:
                md += item["buy_md_amount"]
                md_has = True
            if item["buy_sm_amount"] is not None:
                sm += item["buy_sm_amount"]
                sm_has = True

        if not net_has and not lg_has and not md_has and not sm_has:
            continue

        out.append(
            {
                "custom_index_id": custom_index_id,
                "trade_date": trade_date,
                "net_amount": net if net_has else None,
                "buy_lg_amount": lg if lg_has else None,
                "buy_md_amount": md if md_has else None,
                "buy_sm_amount": sm if sm_has else None,
            }
        )
    return out


def _f(v: Any) -> float | None:
    if v is None:
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x
