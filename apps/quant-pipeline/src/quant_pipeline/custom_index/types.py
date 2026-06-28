"""自定义指数计算共享类型。"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class MemberWeight:
    con_code: str
    weight: float


@dataclass(frozen=True)
class WeightVersion:
    id: int
    effective_date: str
    expire_date: str | None
    weight_method: str
    members: tuple[MemberWeight, ...]


@dataclass(frozen=True)
class StockMeta:
    list_date: str | None
    delist_date: str | None


@dataclass
class ComponentBar:
    """单日单成分行情（已含用于指数计算的价位）。"""

    con_code: str
    trade_date: str
    open: float
    high: float
    low: float
    close: float
    pre_close: float | None
    vol: float | None
    amount: float | None
    price: float
    price_prev: float | None
    price_prev_raw: float | None
    open_price: float
    high_price: float
    low_price: float
    adj_factor: float | None = None
    adj_factor_prev: float | None = None


@dataclass
class IndexQuoteRow:
    trade_date: str
    open: float | None = None
    high: float | None = None
    low: float | None = None
    close: float | None = None
    pre_close: float | None = None
    change: float | None = None
    pct_change: float | None = None
    vol_hand: float | None = None
    amount: float | None = None


@dataclass
class ComputeContext:
    """内存态：成分行情 + 复权 + 元数据。"""

    trade_dates: list[str]
    bars_by_date: dict[str, dict[str, ComponentBar]]
    stock_meta: dict[str, StockMeta]
    adj_latest: dict[str, float]
    warnings: list[dict[str, object]] = field(default_factory=list)
