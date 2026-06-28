"""自定义指数 AMV 序列（spec 06-derived-metrics）。"""

from __future__ import annotations

import math
from typing import Any

from quant_pipeline.custom_index.indicators import calc_simple_ma
from quant_pipeline.custom_index.types import ComputeContext, IndexQuoteRow
from quant_pipeline.custom_index.weight_resolver import resolve_pit_members
from quant_pipeline.custom_index.types import WeightVersion

# 与行业 AMV calcAmvSeries MULT 对齐，使副图量级可读
AMV_SCALE_K = 0.1


def compute_amv_rows(
    *,
    custom_index_id: str,
    versions: list[WeightVersion],
    ctx: ComputeContext,
    quotes: list[IndexQuoteRow],
) -> list[dict[str, Any]]:
    """amv(D) = Σ(close×vol) / index_close × K。"""

    quote_close = {q.trade_date: q.close for q in quotes if q.close is not None}
    trade_dates = [q.trade_date for q in quotes]
    amv_values: list[float | None] = []

    for trade_date in trade_dates:
        index_close = quote_close.get(trade_date)
        if index_close is None or index_close <= 0:
            amv_values.append(None)
            continue

        members = resolve_pit_members(versions, trade_date)
        day_bars = ctx.bars_by_date.get(trade_date, {})
        turnover = 0.0
        has_data = False
        for member in members:
            bar = day_bars.get(member.con_code)
            if bar is None or bar.vol is None or bar.vol <= 0:
                continue
            turnover += bar.close * bar.vol
            has_data = True

        if not has_data:
            amv_values.append(None)
            continue

        amv_values.append(turnover / index_close * AMV_SCALE_K)

    ma5 = calc_simple_ma(amv_values, 5)
    ma10 = calc_simple_ma(amv_values, 10)
    ma20 = calc_simple_ma(amv_values, 20)
    ma60 = calc_simple_ma(amv_values, 60)

    rows: list[dict[str, Any]] = []
    for i, trade_date in enumerate(trade_dates):
        amv = amv_values[i]
        if amv is None or (isinstance(amv, float) and math.isnan(amv)):
            continue
        rows.append(
            {
                "custom_index_id": custom_index_id,
                "trade_date": trade_date,
                "amv": amv,
                "amv_ma5": ma5[i],
                "amv_ma10": ma10[i],
                "amv_ma20": ma20[i],
                "amv_ma60": ma60[i],
            }
        )
    return rows
