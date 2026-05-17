"""factors.base + factors.registry 单测。

校验：
- Factor.validate_meta 拒绝缺失/非法元数据
- @register 正确写入 registry 且重复注册抛错
- list_factors 过滤参数行为正确
"""

from __future__ import annotations

import pandas as pd
import pytest

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import (
    get_factor,
    list_factors,
    register,
)


class _NoopFactor(Factor):
    factor_id = "x"
    factor_version = "v1"
    category = "price"
    pit_window_days = 10
    description = "noop"
    required_columns = ("close_adj",)

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        return pd.Series(dtype=float)


def test_validate_meta_requires_factor_id() -> None:
    class _Bad(_NoopFactor):
        factor_id = ""

    with pytest.raises(ValueError, match="factor_id"):
        _Bad.validate_meta()


def test_validate_meta_requires_positive_window() -> None:
    class _Bad(_NoopFactor):
        pit_window_days = 0

    with pytest.raises(ValueError, match="pit_window_days"):
        _Bad.validate_meta()


def test_validate_meta_rejects_invalid_category() -> None:
    class _Bad(_NoopFactor):
        category = "bogus"  # type: ignore[assignment]

    with pytest.raises(ValueError, match="category"):
        _Bad.validate_meta()


def test_validate_meta_fundamental_requires_ann_date_anchor() -> None:
    class _Bad(_NoopFactor):
        category = "fundamental"
        pit_anchor = "trade_date"  # 错：财务因子必须 ann_date

    with pytest.raises(ValueError, match="ann_date"):
        _Bad.validate_meta()


def test_register_writes_registry_and_rejects_duplicate() -> None:
    # 用一个一定不与内置因子冲突的临时 id；测试结束后从 registry 摘除，
    # 不调 clear_registry 以免破坏其它测试（已注册的内置因子无法重新装载，
    # 因为装饰器副作用只在 import 时执行一次）。
    from quant_pipeline.factors.registry import _REGISTRY

    @register(factor_id="dummy_test_only", factor_version="v1")
    class _A(_NoopFactor):
        pass

    assert get_factor("dummy_test_only", "v1") is not None
    assert get_factor("dummy_test_only", "v1").factor_id == "dummy_test_only"

    # 重复注册抛错
    with pytest.raises(ValueError, match="already registered"):

        @register(factor_id="dummy_test_only", factor_version="v1")
        class _B(_NoopFactor):
            pass

    # 测试后摘除（保持 registry 干净）
    _REGISTRY.pop(("dummy_test_only", "v1"), None)


def test_list_factors_filters() -> None:
    # 内置 16 个因子（11 量价 + 5 行业）
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
