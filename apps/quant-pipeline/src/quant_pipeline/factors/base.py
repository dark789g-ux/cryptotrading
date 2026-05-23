"""因子抽象基类。

设计要点（doc/量化/03 + spec 2026-05-23-factor-registry-frontend-design）：

1. **元信息单一权威**：`description / category / pit_window_days / pit_anchor`
   不再是子类的类属性，而是从 DB 表 `factors.factor_definitions` 加载到
   `registry._meta_cache`。`Factor.__init__` 用 `(factor_id, factor_version)`
   作为 key 从缓存读取并写入实例属性。
   - 缓存缺失 → 立即抛 `FactorMetaMissing`（fail-fast，CLAUDE.md 禁止静默吞错）
   - 启动加载流程：`registry.load_from_db()` → `Factor()` 实例化才能成功

2. **PIT 窗口语义**：`pit_window_days` 表示 T 日计算需回看的"日历窗口"
   （含交易日 + 非交易日的近似）。对纯量价因子，N 个交易日 * 1.6 取整即可。
   runner 在调用 `compute` 前保证窗口内只含 T 日及之前的交易日，**绝不**含
   T+1。financial 因子的 PIT 锚点用 `ann_date`；base 通过 `pit_anchor` 字段
   将 'trade_date' / 'ann_date' 区分。

3. **数据源类别（category）**：决定 runner 需要预取哪几张 raw 表
   - `price`：仅需 `raw.daily_quote` + `raw.adj_factor`
   - `fundamental`：需 `raw.fina_indicator`（PIT 锚点 = `ann_date`）
   - `industry`：需 `raw.daily_quote` + `raw.adj_factor` + `raw.index_member`
   - `mixed`：跨多源（如行业中性化的个股动量）

4. **compute 输入契约**（df）：
   `df` 是按 PIT 窗口预取的"多日 × 多股"长格式 DataFrame，索引为
   `[trade_date, ts_code]`，列包含因子需要的字段。**调用方**（runner）负责：
   - 已用 `adj_factor` 反推后复权价并填入 `close_adj` / `open_adj` 等列
   - 窗口内只含 T 日及之前的交易日
   - 行业归属 `industry_l1` 已按 PIT 安全的 `raw.index_member` 解析
     （**当时**成份股，不是当前）

5. **compute 输出契约**：`pd.Series`，索引为 T 日的 `ts_code`，
   值为因子值（float）。停牌 / 数据不足时返回 NaN（runner 不会写入 PG）。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Literal

import pandas as pd

# 数据源类别（决定 runner 预取哪几张 raw 表）
FactorCategory = Literal["price", "fundamental", "industry", "mixed"]

# PIT 锚点（决定窗口字段）
PitAnchor = Literal["trade_date", "ann_date"]


class FactorMetaMissing(LookupError):
    """`(factor_id, factor_version)` 在 `_meta_cache` 中找不到对应行。

    抛出场景：
      - DB 表 `factors.factor_definitions` 没有该因子的元数据行
      - 调用方忘了在进程启动期调 `registry.load_from_db()`

    fail-fast：worker 启动失败比"静默用类默认值"安全（CLAUDE.md 反静默吞错）。
    """

    def __init__(self, factor_id: str, factor_version: str) -> None:
        super().__init__(
            f"factor meta missing in cache: factor_id={factor_id!r}, "
            f"factor_version={factor_version!r}; "
            "did you forget to call registry.load_from_db()? "
            "Or the DB row was deleted/never inserted."
        )
        self.factor_id = factor_id
        self.factor_version = factor_version


class Factor(ABC):
    """因子抽象基类。

    子类必须通过 ``@register(factor_id=..., factor_version=...)`` 装饰器声明
    标识符；其余元信息（description / category / pit_window_days / pit_anchor）
    由 DB `factors.factor_definitions` 表提供，运行时从 `_meta_cache` 注入。

    子类必须实现：
        compute(self, df, trade_date) -> pd.Series

    可选类属性：
        required_columns: 显式声明 compute 所需的 df 列（runner 按需取列）；
                          为空时由 category 推断。
    """

    # --- 由 @register 装饰器写入 ---
    factor_id: str = ""
    factor_version: str = ""

    # --- 由子类按需声明（compute 取数提示，不入 DB）---
    required_columns: tuple[str, ...] = ()

    # --- 由 Factor.__init__ 从 _meta_cache 注入到实例 ---
    # 类属性占位：仅供 type-checker / IDE 看到字段存在；
    # 真正取值统一走 `self.<attr>`（实例属性），不要在类层访问以免误读默认空值。
    category: FactorCategory = "price"
    pit_window_days: int = 0
    pit_anchor: PitAnchor = "trade_date"
    description: str = ""

    def __init__(self) -> None:
        # 延迟 import 防循环：base.py ↔ registry.py
        from quant_pipeline.factors import registry as _registry

        key = (type(self).factor_id, type(self).factor_version)
        meta = _registry._meta_cache.get(key)
        if meta is None:
            raise FactorMetaMissing(key[0], key[1])
        # 写实例属性（运行时唯一权威），覆盖类层默认占位值
        self.category = meta.category  # type: ignore[assignment]
        self.pit_window_days = meta.pit_window_days
        self.pit_anchor = meta.pit_anchor  # type: ignore[assignment]
        self.description = meta.description

    @abstractmethod
    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        """计算单个 trade_date 的因子值。

        参数：
            df:         预取好的 PIT 窗口数据（多日 × 多股长格式）；索引为
                        MultiIndex [trade_date, ts_code]；列依 `required_columns`
                        与 category。runner 保证只含 T 日及之前的交易日。
            trade_date: 目标交易日（YYYYMMDD）。

        返回：
            按 ts_code 索引的因子值 Series（float）。停牌 / 数据不足返回 NaN。
        """

    # ------------------------------------------------------------------
    # 工具：从实例属性 + 缓存衍生的元数据访问
    # ------------------------------------------------------------------

    def meta(self) -> dict[str, object]:
        """返回因子元数据 dict（供 registry / 文档自动生成）。

        与旧版相比：现在依赖实例属性（DB 加载后写入），不再读类属性。
        """

        return {
            "factor_id": type(self).factor_id,
            "factor_version": type(self).factor_version,
            "category": self.category,
            "pit_window_days": self.pit_window_days,
            "pit_anchor": self.pit_anchor,
            "description": self.description,
            "required_columns": list(self.required_columns),
        }
