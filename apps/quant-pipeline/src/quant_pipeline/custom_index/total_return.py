"""全收益指数：adj_factor 分解 + 缺失 fallback（spec 03）。"""

from __future__ import annotations

import math
from collections.abc import Callable

from quant_pipeline.custom_index.price_index import compute_price_index_quotes, default_price_return
from quant_pipeline.custom_index.types import ComponentBar, ComputeContext, IndexQuoteRow, WeightVersion


def total_return_from_adj(bar: ComponentBar) -> float | None:
    """全收益成分收益：close*adj / (prev_close*prev_adj) - 1。"""

    adj = bar.adj_factor
    adj_prev = bar.adj_factor_prev
    if adj is None or adj_prev is None or adj <= 0 or adj_prev <= 0:
        return None
    if not bar.close or not bar.price_prev_raw:
        return None
    cur = bar.close * adj
    prev = bar.price_prev_raw * adj_prev
    if prev <= 0:
        return None
    return cur / prev - 1.0


def make_total_return_fn(
    *,
    on_warning: Callable[[str, dict[str, object]], None] | None = None,
) -> Callable[[ComponentBar], float | None]:
    """构造全收益 return_fn：adj 缺失时 fallback 价格指数口径 + warning。"""

    def _fn(bar: ComponentBar) -> float | None:
        tr = total_return_from_adj(bar)
        if tr is not None and math.isfinite(tr):
            return tr
        if on_warning:
            on_warning(
                "custom_index_total_return_fallback",
                {"con_code": bar.con_code, "trade_date": bar.trade_date},
            )
        return default_price_return(bar)

    return _fn


def compute_total_return_quotes(
    *,
    versions: list[WeightVersion],
    ctx: ComputeContext,
    base_date: str,
    base_point: float,
    on_warning: Callable[[str, dict[str, object]], None] | None = None,
) -> list[IndexQuoteRow]:
    """全收益指数链式链接。"""

    return compute_price_index_quotes(
        versions=versions,
        ctx=ctx,
        base_date=base_date,
        base_point=base_point,
        return_fn=make_total_return_fn(on_warning=on_warning),
        on_warning=on_warning,
    )
