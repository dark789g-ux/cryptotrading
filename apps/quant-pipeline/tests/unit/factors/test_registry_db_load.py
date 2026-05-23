"""registry DB 加载 / 启停 / 缓存语义单测。

覆盖 spec 06 §1 中 `test_registry_db_load.py` 的 5 个用例：
- load_from_db 填充缓存（不连真实 DB，monkeypatch session_scope）
- reload_from_db 替换旧值
- DB 缺行 → 实例化抛 FactorMetaMissing
- enabled=false 不出现在 list_active 输出
- 启停一个因子 → builder feature_set_id SHA256 哈希变化

不依赖真实 DB：构造假 session.execute 返回固定 rows。
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator

import pytest

from quant_pipeline.factors.base import FactorMetaMissing
from quant_pipeline.factors.registry import (
    FactorMeta,
    _meta_cache,
    list_active,
    list_factors,
)


class _FakeResult:
    def __init__(self, rows: list[tuple]) -> None:
        self._rows = rows

    def fetchall(self) -> list[tuple]:
        return list(self._rows)


class _FakeSession:
    def __init__(self, rows: list[tuple]) -> None:
        self._rows = rows
        self.executed: list[Any] = []

    def execute(self, sql: Any, params: dict[str, Any] | None = None) -> _FakeResult:
        self.executed.append((sql, params))
        return _FakeResult(self._rows)


def _make_fake_scope(rows: list[tuple]):
    """构造一个上下文管理器版的 fake session_scope。"""

    @contextmanager
    def _scope() -> Iterator[_FakeSession]:
        yield _FakeSession(rows)

    return _scope


def _baseline_rows() -> list[tuple]:
    """与 conftest seed 一致的 16 行（factor_id 一致；其余值可不同，
    便于断言"DB 值取代了 conftest seed"）。

    列顺序对齐 registry.load_from_db 的 SELECT：
      factor_id, factor_version, description, category,
      pit_window_days, pit_anchor, enabled, display_order
    """

    return [
        ("momentum_20d", "v1", "DB 描述: 20d", "price", 35, "trade_date", True, 140),
        ("momentum_60d", "v1", "DB 描述: 60d", "price", 115, "trade_date", True, 150),
        ("amihud_illiq_20d", "v1", "Amihud", "price", 35, "trade_date", True, 100),
        ("bollinger_position_20d", "v1", "Bollinger", "price", 35, "trade_date", True, 110),
        ("close_to_high_60d", "v1", "close_to_high", "price", 115, "trade_date", True, 120),
        ("ma_ratio_20d", "v1", "ma_ratio", "price", 35, "trade_date", True, 130),
        ("price_max_drawdown_60d", "v1", "max_dd", "price", 115, "trade_date", True, 160),
        ("rsi_14", "v1", "rsi_14", "price", 60, "trade_date", True, 170),
        ("turnover_mean_20d", "v1", "turnover", "price", 35, "trade_date", True, 180),
        ("volatility_20d", "v1", "vol", "price", 35, "trade_date", True, 190),
        ("volume_ratio_20d", "v1", "vol_ratio", "price", 35, "trade_date", True, 200),
        ("industry_momentum_20d", "v1", "ind_mom", "industry", 35, "trade_date", True, 300),
        ("momentum_20d_neu", "v1", "ind_neu", "industry", 35, "trade_date", True, 310),
        ("industry_rank_in_sector_mom20", "v1", "ind_rank", "industry", 35, "trade_date", True, 320),
        ("industry_relative_strength", "v1", "ind_rel", "industry", 35, "trade_date", True, 330),
        ("sector_volume_concentration", "v1", "hhi", "industry", 5, "trade_date", True, 340),
    ]


def _patch_session_scope(monkeypatch: pytest.MonkeyPatch, rows: list[tuple]) -> None:
    """monkeypatch registry 模块里那条 `from ... import session_scope`。

    registry.load_from_db 是 `from quant_pipeline.db.engine import session_scope`
    形式的延迟 import；patch engine 模块的属性即可生效。
    """

    import quant_pipeline.db.engine as _engine_mod

    monkeypatch.setattr(_engine_mod, "session_scope", _make_fake_scope(rows))


def test_load_from_db_populates_meta_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """一次加载 16 个因子，缓存键齐全。"""

    rows = _baseline_rows()
    _patch_session_scope(monkeypatch, rows)

    from quant_pipeline.factors.registry import load_from_db

    load_from_db()
    assert len(_meta_cache) == 16
    # 抽样：DB 描述覆盖 conftest seed 描述
    assert _meta_cache[("momentum_20d", "v1")].description == "DB 描述: 20d"
    # 全 16 个 factor_id 都在缓存里
    expected_ids = {r[0] for r in rows}
    actual_ids = {k[0] for k in _meta_cache}
    assert actual_ids == expected_ids


def test_reload_from_db_refreshes_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """先用一组 rows load，改 rows 后 reload，新值必须替换旧值。"""

    rows_v1 = _baseline_rows()
    _patch_session_scope(monkeypatch, rows_v1)
    from quant_pipeline.factors.registry import load_from_db, reload_from_db

    load_from_db()
    assert _meta_cache[("momentum_20d", "v1")].pit_window_days == 35

    # 第二轮：把 momentum_20d 的窗口改成 42
    rows_v2 = [
        ("momentum_20d", "v1", "new desc", "price", 42, "trade_date", True, 140),
        *rows_v1[1:],
    ]
    _patch_session_scope(monkeypatch, rows_v2)
    reload_from_db()
    assert _meta_cache[("momentum_20d", "v1")].pit_window_days == 42
    assert _meta_cache[("momentum_20d", "v1")].description == "new desc"


def test_missing_meta_raises_factor_meta_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """类已注册但 DB 无对应行 → 实例化抛 FactorMetaMissing。"""

    # load 一组**缺 momentum_20d** 的 rows
    rows = [r for r in _baseline_rows() if r[0] != "momentum_20d"]
    _patch_session_scope(monkeypatch, rows)
    from quant_pipeline.factors.registry import (
        _REGISTRY_INSTANCES,
        get_factor,
        load_from_db,
    )

    load_from_db()
    # 同步清掉旧实例（load_from_db 内部已 clear，但保险显式调用）
    _REGISTRY_INSTANCES.pop(("momentum_20d", "v1"), None)

    with pytest.raises(FactorMetaMissing) as ei:
        get_factor("momentum_20d", "v1")
    assert ei.value.factor_id == "momentum_20d"


def test_disabled_factor_excluded_from_list_active(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`enabled=false` 不出现在 `list_active` 输出，但仍出现在 `list_factors`。"""

    rows = _baseline_rows()
    # 把 amihud_illiq_20d 改成 disabled
    rows = [
        (fid, fver, desc, cat, win, anc, (fid != "amihud_illiq_20d"), order)
        for (fid, fver, desc, cat, win, anc, _, order) in rows
    ]
    _patch_session_scope(monkeypatch, rows)
    from quant_pipeline.factors.registry import load_from_db

    load_from_db()
    active_ids = {f.factor_id for f in list_active("v1")}
    assert "amihud_illiq_20d" not in active_ids
    assert "momentum_20d" in active_ids
    assert len(active_ids) == 15  # 16 - 1

    # `list_factors` 包含全部 16 个（启停只过滤 list_active）
    all_ids = {f.factor_id for f in list_factors(factor_version="v1")}
    assert "amihud_illiq_20d" in all_ids
    assert len(all_ids) == 16


def test_feature_set_id_changes_on_enabled_toggle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """启停一个因子 → list_active 输出变化 → builder SHA256 哈希变化 →
    新 feature_set_id。"""

    from quant_pipeline.features.builder import build_feature_set_id
    from quant_pipeline.factors.registry import load_from_db

    # 第一轮：全部启用
    _patch_session_scope(monkeypatch, _baseline_rows())
    load_from_db()
    ids_all = tuple(sorted(f.factor_id for f in list_active("v1")))
    fsid_all = build_feature_set_id(
        "v1", "strategy-aware", new_listing_min_days=60, factor_ids=ids_all
    )

    # 第二轮：把 amihud_illiq_20d 关掉
    rows = [
        (fid, fver, desc, cat, win, anc, (fid != "amihud_illiq_20d"), order)
        for (fid, fver, desc, cat, win, anc, _, order) in _baseline_rows()
    ]
    _patch_session_scope(monkeypatch, rows)
    load_from_db()
    ids_off = tuple(sorted(f.factor_id for f in list_active("v1")))
    fsid_off = build_feature_set_id(
        "v1", "strategy-aware", new_listing_min_days=60, factor_ids=ids_off
    )

    assert ids_all != ids_off
    assert fsid_all != fsid_off
    # 形如 fs_<sha12>
    assert fsid_all.startswith("fs_") and fsid_off.startswith("fs_")
