"""价格指数 Laspeyres 链式链接（spec 03-index-computation）。"""

from __future__ import annotations

import math
from collections.abc import Callable

from quant_pipeline.custom_index.types import (
    ComponentBar,
    ComputeContext,
    IndexQuoteRow,
    MemberWeight,
    StockMeta,
    WeightVersion,
)
from quant_pipeline.custom_index.weight_resolver import (
    normalize_weights,
    resolve_pit_members,
)


def _is_finite(x: float | None) -> bool:
    return x is not None and math.isfinite(x) and x > 0


def is_component_valid(
    *,
    con_code: str,
    trade_date: str,
    bar: ComponentBar | None,
    meta: StockMeta | None,
) -> bool:
    """成分在 trade_date 是否可参与计算。"""

    if bar is None or not _is_finite(bar.price):
        return False
    if meta is not None:
        if meta.list_date and trade_date < meta.list_date:
            return False
        if meta.delist_date and trade_date > meta.delist_date:
            return False
    # 停牌：无成交（vol=0 或缺失）视为不可交易
    if bar.vol is not None and bar.vol <= 0:
        return False
    return True


def filter_valid_members(
    *,
    trade_date: str,
    members: tuple[MemberWeight, ...],
    bars: dict[str, ComponentBar],
    stock_meta: dict[str, StockMeta],
) -> dict[str, float]:
    """返回有效成分的归一化权重。"""

    raw: dict[str, float] = {}
    for member in members:
        meta = stock_meta.get(member.con_code)
        bar = bars.get(member.con_code)
        if is_component_valid(
            con_code=member.con_code,
            trade_date=trade_date,
            bar=bar,
            meta=meta,
        ):
            raw[member.con_code] = member.weight
    return normalize_weights(raw)


def find_actual_start_date(
    *,
    trade_dates: list[str],
    base_date: str,
    initial_members: tuple[MemberWeight, ...],
    ctx: ComputeContext,
) -> str | None:
    """actual_start_date：≥ base_date 且全部初始成分均有有效收盘价的首日。"""

    candidates = [d for d in trade_dates if d >= base_date]
    required = {m.con_code for m in initial_members}
    for trade_date in candidates:
        day_bars = ctx.bars_by_date.get(trade_date, {})
        ok = True
        for code in required:
            meta = ctx.stock_meta.get(code)
            bar = day_bars.get(code)
            if not is_component_valid(
                con_code=code,
                trade_date=trade_date,
                bar=bar,
                meta=meta,
            ):
                ok = False
                break
        if ok:
            return trade_date
    return None


def compute_component_return(
    bar: ComponentBar,
    *,
    return_fn: Callable[[ComponentBar], float | None],
) -> float | None:
    ret = return_fn(bar)
    if ret is None or not math.isfinite(ret):
        return None
    return ret


def default_price_return(bar: ComponentBar) -> float | None:
    """价格指数成分收益：P(D)/P(D-1)-1。"""

    if not _is_finite(bar.price) or not _is_finite(bar.price_prev):
        return None
    return bar.price / bar.price_prev - 1.0


def compute_weighted_return(
    weights: dict[str, float],
    bars: dict[str, ComponentBar],
    *,
    return_fn: Callable[[ComponentBar], float | None],
) -> float | None:
    if len(weights) < 2:
        return None
    total = 0.0
    for code, weight in weights.items():
        bar = bars.get(code)
        if bar is None:
            return None
        ret = compute_component_return(bar, return_fn=return_fn)
        if ret is None:
            return None
        total += weight * ret
    return total


def synthesize_ohlc(
    *,
    index_close: float,
    index_pre_close: float,
    weights: dict[str, float],
    bars: dict[str, ComponentBar],
) -> tuple[float, float, float]:
    """由成分 OHLC 与收盘点位反推指数 open/high/low。"""

    if index_pre_close <= 0:
        return index_close, index_close, index_close

    open_ret = 0.0
    high_ratio = 0.0
    low_ratio = 0.0
    for code, weight in weights.items():
        bar = bars.get(code)
        if bar is None or not _is_finite(bar.price):
            continue
        if _is_finite(bar.open_price) and _is_finite(bar.price_prev):
            open_ret += weight * (bar.open_price / bar.price_prev - 1.0)
        if _is_finite(bar.high_price):
            high_ratio += weight * (bar.high_price / bar.price - 1.0)
        if _is_finite(bar.low_price):
            low_ratio += weight * (bar.low_price / bar.price - 1.0)

    index_open = index_pre_close * (1.0 + open_ret)
    index_high = index_close * (1.0 + high_ratio)
    index_low = index_close * (1.0 + low_ratio)
    return index_open, max(index_high, index_low, index_close), min(index_high, index_low, index_close)


def compute_price_index_quotes(
    *,
    versions: list[WeightVersion],
    ctx: ComputeContext,
    base_date: str,
    base_point: float,
    return_fn: Callable[[ComponentBar], float | None] | None = None,
    on_warning: Callable[[str, dict[str, object]], None] | None = None,
) -> list[IndexQuoteRow]:
    """Laspeyres 链式链接合成指数日线。"""

    ret_fn = return_fn or default_price_return
    initial_members = resolve_pit_members(versions, base_date)
    if not initial_members:
        initial_members = versions[0].members

    actual_start = find_actual_start_date(
        trade_dates=ctx.trade_dates,
        base_date=base_date,
        initial_members=initial_members,
        ctx=ctx,
    )
    if actual_start is None:
        if on_warning:
            on_warning(
                "custom_index_no_actual_start",
                {"base_date": base_date},
            )
        return []

    quotes: list[IndexQuoteRow] = []
    index_level: float | None = None
    prev_close: float | None = None

    for trade_date in ctx.trade_dates:
        if trade_date < actual_start:
            continue

        members = resolve_pit_members(versions, trade_date)
        day_bars = ctx.bars_by_date.get(trade_date, {})
        weights = filter_valid_members(
            trade_date=trade_date,
            members=members,
            bars=day_bars,
            stock_meta=ctx.stock_meta,
        )

        if len(weights) < 2:
            if on_warning:
                on_warning(
                    "custom_index_insufficient_members",
                    {"trade_date": trade_date, "valid_count": len(weights)},
                )
            continue

        if trade_date == actual_start:
            index_level = base_point
        else:
            weighted_ret = compute_weighted_return(weights, day_bars, return_fn=ret_fn)
            if weighted_ret is None:
                if on_warning:
                    on_warning(
                        "custom_index_return_missing",
                        {"trade_date": trade_date},
                    )
                continue
            if index_level is None:
                continue
            index_level = index_level * (1.0 + weighted_ret)

        assert index_level is not None
        index_pre = prev_close if prev_close is not None else index_level
        index_open, index_high, index_low = synthesize_ohlc(
            index_close=index_level,
            index_pre_close=index_pre,
            weights=weights,
            bars=day_bars,
        )

        vol_sum = 0.0
        amt_sum = 0.0
        vol_has = False
        amt_has = False
        for code in weights:
            bar = day_bars.get(code)
            if bar is None:
                continue
            if bar.vol is not None and math.isfinite(bar.vol):
                vol_sum += bar.vol
                vol_has = True
            if bar.amount is not None and math.isfinite(bar.amount):
                amt_sum += bar.amount
                amt_has = True

        change = index_level - index_pre if prev_close is not None else 0.0
        pct = (change / index_pre * 100.0) if prev_close and index_pre > 0 else 0.0

        quotes.append(
            IndexQuoteRow(
                trade_date=trade_date,
                open=index_open,
                high=index_high,
                low=index_low,
                close=index_level,
                pre_close=index_pre if prev_close is not None else index_level,
                change=change,
                pct_change=pct,
                vol_hand=vol_sum if vol_has else None,
                amount=amt_sum if amt_has else None,
            )
        )
        prev_close = index_level

    return quotes


def compute_two_stock_equal_index(
    *,
    dates: list[str],
    stock_a_prices: list[float],
    stock_b_prices: list[float],
    base_point: float = 1000.0,
) -> list[float]:
    """测试辅助：两成分等权手工验算（仅 close 序列）。"""

    if len(dates) != len(stock_a_prices) or len(dates) != len(stock_b_prices):
        raise ValueError("dates/prices length mismatch")
    if len(dates) < 1:
        return []

    levels = [base_point]
    for i in range(1, len(dates)):
        ra = stock_a_prices[i] / stock_a_prices[i - 1] - 1.0
        rb = stock_b_prices[i] / stock_b_prices[i - 1] - 1.0
        r = 0.5 * ra + 0.5 * rb
        levels.append(levels[-1] * (1.0 + r))
    return levels
