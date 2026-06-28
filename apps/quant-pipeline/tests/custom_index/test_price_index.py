"""价格指数 Laspeyres 链式链接单元测试。"""

from __future__ import annotations

from quant_pipeline.custom_index.price_index import (
    compute_price_index_quotes,
    compute_two_stock_equal_index,
)
from quant_pipeline.custom_index.types import (
    ComponentBar,
    ComputeContext,
    MemberWeight,
    StockMeta,
    WeightVersion,
)


def _bar(
    *,
    code: str,
    trade_date: str,
    close: float,
    prev: float | None,
    vol: float = 1000.0,
) -> ComponentBar:
    return ComponentBar(
        con_code=code,
        trade_date=trade_date,
        open=close,
        high=close,
        low=close,
        close=close,
        pre_close=prev,
        vol=vol,
        amount=100.0,
        price=close,
        price_prev=prev,
        price_prev_raw=prev,
        open_price=close,
        high_price=close,
        low_price=close,
    )


def test_two_stock_equal_manual_close_levels() -> None:
    levels = compute_two_stock_equal_index(
        dates=["20240102", "20240103", "20240104"],
        stock_a_prices=[10.0, 11.0, 12.1],
        stock_b_prices=[20.0, 22.0, 24.2],
        base_point=1000.0,
    )
    assert len(levels) == 3
    assert abs(levels[0] - 1000.0) < 1e-6
    assert abs(levels[1] - 1100.0) < 1e-6
    assert abs(levels[2] - 1210.0) < 1e-4


def test_compute_price_index_equal_weight_two_members() -> None:
    members = (
        MemberWeight("600000.SH", 0.5),
        MemberWeight("600001.SH", 0.5),
    )
    versions = [
        WeightVersion(
            id=1,
            effective_date="20240102",
            expire_date=None,
            weight_method="equal",
            members=members,
        )
    ]
    dates = ["20240102", "20240103", "20240104"]
    bars_by_date = {
        "20240102": {
            "600000.SH": _bar(code="600000.SH", trade_date="20240102", close=10.0, prev=None),
            "600001.SH": _bar(code="600001.SH", trade_date="20240102", close=20.0, prev=None),
        },
        "20240103": {
            "600000.SH": _bar(code="600000.SH", trade_date="20240103", close=11.0, prev=10.0),
            "600001.SH": _bar(code="600001.SH", trade_date="20240103", close=22.0, prev=20.0),
        },
        "20240104": {
            "600000.SH": _bar(code="600000.SH", trade_date="20240104", close=12.1, prev=11.0),
            "600001.SH": _bar(code="600001.SH", trade_date="20240104", close=24.2, prev=22.0),
        },
    }
    ctx = ComputeContext(
        trade_dates=dates,
        bars_by_date=bars_by_date,
        stock_meta={
            "600000.SH": StockMeta(None, None),
            "600001.SH": StockMeta(None, None),
        },
        adj_latest={},
    )

    quotes = compute_price_index_quotes(
        versions=versions,
        ctx=ctx,
        base_date="20240102",
        base_point=1000.0,
    )
    closes = [q.close for q in quotes]
    expected = compute_two_stock_equal_index(
        dates=dates,
        stock_a_prices=[10.0, 11.0, 12.1],
        stock_b_prices=[20.0, 22.0, 24.2],
        base_point=1000.0,
    )
    assert len(closes) == len(expected)
    for got, want in zip(closes, expected, strict=True):
        assert got is not None
        assert abs(got - want) < 1e-4
