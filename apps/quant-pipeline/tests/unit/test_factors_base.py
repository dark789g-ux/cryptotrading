"""factors.base + factors.registry 单测。

校验（refactor 后；spec 2026-05-23-factor-registry-frontend-design）：
- `@register` 正确登记类（不立即实例化）
- 重复注册抛 ValueError
- `list_factors` 过滤参数行为正确（依赖 conftest 已 seed `_meta_cache`）
- `_meta_cache` 缺失 → 实例化抛 `FactorMetaMissing`
- `meta()` 返回 dict 反映实例属性
"""

from __future__ import annotations

import pandas as pd
import pytest

from quant_pipeline.factors.base import Factor, FactorMetaMissing
from quant_pipeline.factors.registry import (
    FactorMeta,
    _REGISTRY_INSTANCES,
    _meta_cache,
    get_factor,
    list_factors,
    register,
)


class _NoopFactor(Factor):
    """空 compute；元数据**全部**来自 `_meta_cache`（无类属性兜底）。"""

    required_columns = ("close_adj",)

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        return pd.Series(dtype=float)


def test_register_writes_registry_and_rejects_duplicate() -> None:
    """`@register` 登记类（不立即 cls()），重复 key 抛 ValueError。"""

    from quant_pipeline.factors.registry import _REGISTRY_CLASSES

    @register(factor_id="dummy_test_only", factor_version="v1", min_trade_days=5)
    class _A(_NoopFactor):
        pass

    # 同步在 _meta_cache 喂一条，使 _materialize 不抛 FactorMetaMissing
    _meta_cache[("dummy_test_only", "v1")] = FactorMeta(
        factor_id="dummy_test_only",
        factor_version="v1",
        description="dummy",
        category="price",
        pit_window_days=10,
        pit_anchor="trade_date",
        enabled=True,
        display_order=1,
        min_trade_days=5,
    )

    inst = get_factor("dummy_test_only", "v1")
    assert inst.factor_id == "dummy_test_only"
    assert inst.category == "price"

    with pytest.raises(ValueError, match="already registered"):

        @register(factor_id="dummy_test_only", factor_version="v1", min_trade_days=5)
        class _B(_NoopFactor):
            pass

    # 测试后清理：避免污染后续测试
    from quant_pipeline.factors.registry import _CLASS_DECLARATIONS

    _REGISTRY_CLASSES.pop(("dummy_test_only", "v1"), None)
    _REGISTRY_INSTANCES.pop(("dummy_test_only", "v1"), None)
    _meta_cache.pop(("dummy_test_only", "v1"), None)
    _CLASS_DECLARATIONS.pop(("dummy_test_only", "v1"), None)


def test_list_factors_filters() -> None:
    # 内置 16 个因子（11 量价 + 5 行业），conftest autouse 已 seed _meta_cache
    all_factors = list_factors()
    assert len(all_factors) == 16

    v1_factors = list_factors(factor_version="v1")
    assert len(v1_factors) == 16

    price_factors = list_factors(category="price")
    assert len(price_factors) == 11
    assert all(f.category == "price" for f in price_factors)

    industry_factors = list_factors(category="industry")
    assert len(industry_factors) == 5
    assert all(f.category == "industry" for f in industry_factors)

    subset = list_factors(factor_ids=["momentum_20d", "rsi_14"])
    assert {f.factor_id for f in subset} == {"momentum_20d", "rsi_14"}


def test_registry_meta_dict() -> None:
    f = get_factor("momentum_20d", "v1")
    meta = f.meta()
    assert meta["factor_id"] == "momentum_20d"
    assert meta["factor_version"] == "v1"
    assert meta["category"] == "price"
    assert meta["pit_window_days"] > 0


def test_get_factor_missing_raises() -> None:
    with pytest.raises(KeyError):
        get_factor("not_exist", "v1")


def test_factor_init_raises_when_meta_missing() -> None:
    """`_meta_cache` 没对应行 → 实例化抛 `FactorMetaMissing` (fail-fast)。"""

    from quant_pipeline.factors.registry import _REGISTRY_CLASSES

    @register(factor_id="meta_missing_probe", factor_version="v1", min_trade_days=3)
    class _Probe(_NoopFactor):
        pass

    # 故意不喂 _meta_cache → 实例化必抛
    with pytest.raises(FactorMetaMissing) as ei:
        get_factor("meta_missing_probe", "v1")
    assert ei.value.factor_id == "meta_missing_probe"
    assert ei.value.factor_version == "v1"

    from quant_pipeline.factors.registry import _CLASS_DECLARATIONS

    _REGISTRY_CLASSES.pop(("meta_missing_probe", "v1"), None)
    _REGISTRY_INSTANCES.pop(("meta_missing_probe", "v1"), None)
    _CLASS_DECLARATIONS.pop(("meta_missing_probe", "v1"), None)
