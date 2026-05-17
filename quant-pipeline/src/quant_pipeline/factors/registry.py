"""因子注册表。

提供 `@register(...)` 装饰器与 `list_factors() / get_factor(...)` 查询。
runner 通过 registry 拿到全部待计算因子。

约束（spec m1-factor-library §交付物 2）：
- (factor_id, factor_version) 全局唯一；重复注册抛 ValueError
- 注册时调用 `Factor.validate_meta()` 强校验必填类属性
- registry 提供"按 category 过滤"接口，runner 据此分组取数
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar

from quant_pipeline.factors.base import Factor, FactorCategory

# (factor_id, factor_version) → Factor 实例
_REGISTRY: dict[tuple[str, str], Factor] = {}

T = TypeVar("T", bound=Factor)


def register(factor_id: str, factor_version: str) -> Callable[[type[T]], type[T]]:
    """类装饰器：把 Factor 子类实例化并注册到 registry。

    用法：
        @register(factor_id='momentum_20d', factor_version='v1')
        class Momentum20d(Factor):
            ...

    装饰器会**覆盖**子类的 factor_id / factor_version 类属性，
    确保装饰器参数即最终生效的元数据。
    """

    def _decorator(cls: type[T]) -> type[T]:
        # 装饰器参数优先（防止类属性与 register() 调用不一致时出现"两份事实"）
        cls.factor_id = factor_id
        cls.factor_version = factor_version

        cls.validate_meta()  # 必填校验

        key = (factor_id, factor_version)
        if key in _REGISTRY:
            raise ValueError(
                f"factor already registered: factor_id={factor_id!r}, "
                f"factor_version={factor_version!r}; cls={cls.__name__}"
            )
        _REGISTRY[key] = cls()
        return cls

    return _decorator


def get_factor(factor_id: str, factor_version: str) -> Factor:
    """按 (factor_id, factor_version) 取因子实例；不存在抛 KeyError。"""

    key = (factor_id, factor_version)
    if key not in _REGISTRY:
        raise KeyError(
            f"factor not registered: factor_id={factor_id!r}, "
            f"factor_version={factor_version!r}; 已注册: {sorted(_REGISTRY.keys())}"
        )
    return _REGISTRY[key]


def list_factors(
    *,
    factor_version: str | None = None,
    category: FactorCategory | None = None,
    factor_ids: list[str] | None = None,
) -> list[Factor]:
    """列出已注册因子。

    过滤参数：
        factor_version: 仅返回该 version 的因子
        category:       仅返回该数据源类别的因子
        factor_ids:     仅返回这些 id 的因子（None = 全部）
    """

    out: list[Factor] = []
    factor_id_set = set(factor_ids) if factor_ids is not None else None
    for (fid, fver), inst in _REGISTRY.items():
        if factor_version is not None and fver != factor_version:
            continue
        if category is not None and inst.category != category:
            continue
        if factor_id_set is not None and fid not in factor_id_set:
            continue
        out.append(inst)
    # 排序：按 category（price < industry < fundamental < mixed） + factor_id，
    # 保证 runner 输出顺序稳定，便于日志比对
    _ORDER = {"price": 0, "industry": 1, "fundamental": 2, "mixed": 3}
    out.sort(key=lambda f: (_ORDER.get(f.category, 99), f.factor_id))
    return out


def clear_registry() -> None:
    """测试专用：清空 registry（避免单测之间互相污染）。"""

    _REGISTRY.clear()


def import_all_factors() -> None:
    """显式导入所有内置因子模块，触发装饰器副作用，把它们登记到 registry。

    runner 启动前调用一次即可；factors 子包的 `__init__.py` 也会调用本函数，
    使 `from quant_pipeline.factors.registry import list_factors` 后立即可用。
    """

    # 量价因子（11 个）
    from quant_pipeline.factors.price import (  # noqa: F401
        amihud_illiq_20d,
        bollinger_position_20d,
        close_to_high_60d,
        ma_ratio_20d,
        momentum_20d,
        momentum_60d,
        price_max_drawdown_60d,
        rsi_14,
        turnover_mean_20d,
        volatility_20d,
        volume_ratio_20d,
    )

    # 行业派生因子（5 个）
    from quant_pipeline.factors.industry import (  # noqa: F401
        industry_momentum_20d,
        industry_neutral_momentum,
        industry_rank_in_sector,
        industry_relative_strength,
        sector_volume_concentration,
    )
