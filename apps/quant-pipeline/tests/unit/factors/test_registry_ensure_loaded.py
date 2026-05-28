"""registry.ensure_loaded 幂等性单测。

ensure_loaded 是 CLI 入口共享的预热 helper，要求重复调用不抛错、不留残态。
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator

import pytest

from quant_pipeline.factors.registry import (
    _meta_cache,
    ensure_loaded,
    list_active,
)


class _FakeResult:
    def __init__(self, rows: list[tuple]) -> None:
        self._rows = rows

    def fetchall(self) -> list[tuple]:
        return list(self._rows)


class _FakeSession:
    def execute(self, sql: Any, params: dict[str, Any] | None = None) -> _FakeResult:
        return _FakeResult(_BASELINE_ROWS)


@contextmanager
def _fake_scope() -> Iterator[_FakeSession]:
    yield _FakeSession()


_BASELINE_ROWS: list[tuple] = [
    ("momentum_20d", "v1", "DB 描述: 20d", "price", 42, "trade_date", True, 140, 21),
    ("momentum_60d", "v1", "DB 描述: 60d", "price", 122, "trade_date", True, 150, 61),
    ("amihud_illiq_20d", "v1", "Amihud", "price", 42, "trade_date", True, 100, 21),
    ("bollinger_position_20d", "v1", "Bollinger", "price", 40, "trade_date", True, 110, 20),
    ("close_to_high_60d", "v1", "close_to_high", "price", 120, "trade_date", True, 120, 60),
    ("ma_ratio_20d", "v1", "ma_ratio", "price", 40, "trade_date", True, 130, 20),
    ("price_max_drawdown_60d", "v1", "max_dd", "price", 120, "trade_date", True, 160, 60),
    ("rsi_14", "v1", "rsi_14", "price", 60, "trade_date", True, 170, 15),
    ("turnover_mean_20d", "v1", "turnover", "price", 40, "trade_date", True, 180, 20),
    ("volatility_20d", "v1", "vol", "price", 42, "trade_date", True, 190, 21),
    ("volume_ratio_20d", "v1", "vol_ratio", "price", 42, "trade_date", True, 200, 21),
    ("industry_momentum_20d", "v1", "ind_mom", "industry", 42, "trade_date", True, 300, 21),
    ("momentum_20d_neu", "v1", "ind_neu", "industry", 42, "trade_date", True, 310, 21),
    ("industry_rank_in_sector_mom20", "v1", "ind_rank", "industry", 42, "trade_date", True, 320, 21),
    ("industry_relative_strength", "v1", "ind_rel", "industry", 42, "trade_date", True, 330, 21),
    ("sector_volume_concentration", "v1", "hhi", "industry", 5, "trade_date", True, 340, 1),
]


def _patch_session_scope(monkeypatch: pytest.MonkeyPatch) -> None:
    import quant_pipeline.db.engine as _engine_mod

    monkeypatch.setattr(_engine_mod, "session_scope", _fake_scope)


def test_ensure_loaded_populates_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """首次调用应填满 16 行元数据；list_active 立即可用、不抛 FactorMetaMissing。"""

    _patch_session_scope(monkeypatch)
    ensure_loaded()

    assert len(_meta_cache) == 16
    active = list_active("v1")
    assert len(active) == 16


def test_ensure_loaded_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    """连调三次不抛错（import_all_factors 命中 Python 模块缓存；reload_from_db
    清空重填）；缓存大小、active 集合保持一致。"""

    _patch_session_scope(monkeypatch)
    ensure_loaded()
    snapshot1 = sorted(_meta_cache.keys())
    active1 = sorted(f.factor_id for f in list_active("v1"))

    ensure_loaded()
    ensure_loaded()
    snapshot2 = sorted(_meta_cache.keys())
    active2 = sorted(f.factor_id for f in list_active("v1"))

    assert snapshot1 == snapshot2
    assert active1 == active2
    assert len(_meta_cache) == 16
