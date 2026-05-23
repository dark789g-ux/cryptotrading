"""因子注册表 + DB 元信息加载。

- `@register(factor_id, factor_version)` 把 Factor 子类登记为类（不立即实例化）
- `load_from_db()` / `reload_from_db()` 从 `factors.factor_definitions` 拉一次
  全表填进 `_meta_cache`，供 `Factor.__init__` 读取
- `list_active(factor_version)` 仅返回 `enabled=true` 的因子（builder 哈希契约用）
- `list_factors(...)`、`get_factor(...)` 为 runner / 测试用的查询接口

设计要点（spec 2026-05-23-factor-registry-frontend-design 02-pipeline-refactor.md）：

1. **延迟实例化**：装饰器只记录 *类*，不调 `cls()`。理由：仓库根
   `factors/__init__.py` import 时就会触发装饰器副作用；如果此时 DB 缓存还
   未加载，`Factor.__init__` 会抛 `FactorMetaMissing`。延迟到 `get_factor()`
   / `list_factors()` 第一次取用时再实例化，调用方有机会先 `load_from_db()`。

2. **fail-fast**：DB 缺行 → 实例化阶段抛 `FactorMetaMissing`，禁止用类属性
   静默兜底（CLAUDE.md 反静默吞错）。

3. **per-job 缓存**：train_e2e 入口调 `reload_from_db()`；job 进程结束随之
   释放。不做长驻进程级缓存（worker 同时跑多 job 时会污染语义）。
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import TypeVar

from quant_pipeline.factors.base import Factor, FactorCategory, FactorMetaMissing

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 元数据缓存
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FactorMeta:
    """单个因子的 DB 元数据快照（frozen 防意外修改）。

    字段集与 spec 02-pipeline-refactor.md §`FactorMeta` 数据类 对齐。
    `formula` / `data_source` **不**进缓存——它们仅供阅读，不需要在 Python
    端使用。
    """

    factor_id: str
    factor_version: str
    description: str
    category: str
    pit_window_days: int
    pit_anchor: str
    enabled: bool
    display_order: int


# (factor_id, factor_version) → FactorMeta（DB 拉取后填）
_meta_cache: dict[tuple[str, str], FactorMeta] = {}

# (factor_id, factor_version) → Factor 子类（@register 立即写入，但不实例化）
_REGISTRY_CLASSES: dict[tuple[str, str], type[Factor]] = {}

# (factor_id, factor_version) → Factor 实例（首次需要时材料化）
_REGISTRY_INSTANCES: dict[tuple[str, str], Factor] = {}


T = TypeVar("T", bound=Factor)


# ---------------------------------------------------------------------------
# 注册与查询
# ---------------------------------------------------------------------------


def register(factor_id: str, factor_version: str) -> Callable[[type[T]], type[T]]:
    """类装饰器：登记 Factor 子类。**不立即实例化**——实例化推迟到
    `get_factor` / `list_factors`，避免在 DB 缓存未加载时抛 FactorMetaMissing。

    用法：
        @register(factor_id='momentum_20d', factor_version='v1')
        class Momentum20d(Factor):
            ...

    重复注册抛 ValueError（CLAUDE.md：暴露权衡，不要静默覆盖）。
    """

    def _decorator(cls: type[T]) -> type[T]:
        # 装饰器参数即唯一来源（防类属性与 register() 不一致出现"两份事实"）
        cls.factor_id = factor_id
        cls.factor_version = factor_version

        key = (factor_id, factor_version)
        if key in _REGISTRY_CLASSES:
            raise ValueError(
                f"factor already registered: factor_id={factor_id!r}, "
                f"factor_version={factor_version!r}; cls={cls.__name__}"
            )
        _REGISTRY_CLASSES[key] = cls
        return cls

    return _decorator


def _materialize(key: tuple[str, str]) -> Factor:
    """惰性实例化：第一次取用时调 `cls()`，需 `_meta_cache` 已就绪。"""

    if key not in _REGISTRY_CLASSES:
        raise KeyError(
            f"factor not registered: factor_id={key[0]!r}, "
            f"factor_version={key[1]!r}; 已注册: {sorted(_REGISTRY_CLASSES.keys())}"
        )
    inst = _REGISTRY_INSTANCES.get(key)
    if inst is None:
        # __init__ 会查 _meta_cache；缺失抛 FactorMetaMissing
        inst = _REGISTRY_CLASSES[key]()
        _REGISTRY_INSTANCES[key] = inst
    return inst


def get_factor(factor_id: str, factor_version: str) -> Factor:
    """按 (factor_id, factor_version) 取因子实例；不存在抛 KeyError。"""

    return _materialize((factor_id, factor_version))


def list_factors(
    *,
    factor_version: str | None = None,
    category: FactorCategory | None = None,
    factor_ids: list[str] | None = None,
) -> list[Factor]:
    """列出已注册因子（**包含 enabled=false**；用于 runner 计算 daily_factors
    时全量跑——是否启停只在 features/builder 的 feature_set_id 哈希处生效）。

    过滤参数：
        factor_version: 仅返回该 version 的因子
        category:       仅返回该数据源类别的因子
        factor_ids:     仅返回这些 id 的因子（None = 全部）
    """

    factor_id_set = set(factor_ids) if factor_ids is not None else None
    out: list[Factor] = []
    for key in _REGISTRY_CLASSES:
        fid, fver = key
        if factor_version is not None and fver != factor_version:
            continue
        if factor_id_set is not None and fid not in factor_id_set:
            continue
        inst = _materialize(key)
        if category is not None and inst.category != category:
            continue
        out.append(inst)
    _ORDER = {"price": 0, "industry": 1, "fundamental": 2, "mixed": 3}
    out.sort(key=lambda f: (_ORDER.get(f.category, 99), f.factor_id))
    return out


def list_active(factor_version: str) -> list[Factor]:
    """仅返回 `enabled=true` 的因子（builder.py 的 feature_set_id 哈希源）。

    与 `list_factors(factor_version=...)` 的区别：本函数依据 `_meta_cache[key]
    .enabled` 过滤。若缓存未加载（任何 key 都缺失），下游 `_materialize` 会
    抛 `FactorMetaMissing`，调用方应在入口处先 `reload_from_db()`。
    """

    out: list[Factor] = []
    for key in _REGISTRY_CLASSES:
        fid, fver = key
        if fver != factor_version:
            continue
        meta = _meta_cache.get(key)
        if meta is None:
            # fail-fast：要么 DB 没行，要么调用方忘了 load_from_db
            raise FactorMetaMissing(fid, fver)
        if not meta.enabled:
            continue
        out.append(_materialize(key))
    _ORDER = {"price": 0, "industry": 1, "fundamental": 2, "mixed": 3}
    out.sort(key=lambda f: (_ORDER.get(f.category, 99), f.factor_id))
    return out


# ---------------------------------------------------------------------------
# DB 加载
# ---------------------------------------------------------------------------


def load_from_db() -> None:
    """从 `factors.factor_definitions` 拉一次全表填进 `_meta_cache`。

    每次都先 `clear` 再写入，等价于"重置缓存"。session 拿到数据后立即释放，
    不持长会话。

    DB 连接失败由 SQLAlchemy 上抛 `OperationalError` 等异常；调用方
    （train_e2e_runner）应在入口处包成 `RuntimeError("factor_definitions
    unreachable")` 让 dispatcher 写 error_text。本函数本身不吞错。
    """

    from sqlalchemy import text

    from quant_pipeline.db.engine import session_scope

    sql = text(
        """
        SELECT factor_id, factor_version, description, category,
               pit_window_days, pit_anchor, enabled, display_order
          FROM factors.factor_definitions
        """
    )
    rows: list[tuple] = []
    with session_scope() as session:
        result = session.execute(sql)
        rows = list(result.fetchall())

    _meta_cache.clear()
    # 同步清空惰性实例缓存：实例属性是首次实例化时 snapshot 的，元数据变更后
    # 必须重新实例化才能反映新值
    _REGISTRY_INSTANCES.clear()

    for r in rows:
        meta = FactorMeta(
            factor_id=r[0],
            factor_version=r[1],
            description=r[2],
            category=r[3],
            pit_window_days=int(r[4]),
            pit_anchor=r[5],
            enabled=bool(r[6]),
            display_order=int(r[7]),
        )
        _meta_cache[(meta.factor_id, meta.factor_version)] = meta

    logger.info("factor_meta_loaded_from_db", extra={"n": len(_meta_cache)})


def reload_from_db() -> None:
    """`load_from_db` 的语义别名，明确"清空并重新拉"的意图。"""

    load_from_db()


# ---------------------------------------------------------------------------
# 测试 / 工具
# ---------------------------------------------------------------------------


def clear_registry() -> None:
    """测试专用：清空 registry 类登记 + 实例缓存 + 元数据缓存。"""

    _REGISTRY_CLASSES.clear()
    _REGISTRY_INSTANCES.clear()
    _meta_cache.clear()


# 兼容旧 API：部分老测试通过 `from quant_pipeline.factors.registry import _REGISTRY`
# 直接操作内部映射。`_REGISTRY` 保留为类登记表（不是实例表），跟新内部状态一致。
_REGISTRY = _REGISTRY_CLASSES


def import_all_factors() -> None:
    """显式导入所有内置因子模块，触发装饰器副作用，把它们登记到 registry。

    runner 启动前调用一次即可；factors 子包的 `__init__.py` 也会调用本函数，
    使 `from quant_pipeline.factors.registry import list_factors` 后立即可用
    （元数据需另行 `load_from_db()`）。
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
