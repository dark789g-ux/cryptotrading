"""因子抽象基类 + PIT 窗口声明 API。

设计要点（doc/量化/03 + spec m1-factor-library §交付物 1）：

1. **PIT 窗口语义**：`pit_window_days` 表示因子 T 日计算需要回看的"日历窗口"
   （含交易日 + 非交易日的近似），用于 runner 在拉取数据时一次性截取
   `(T - pit_window_days, T]` 窗口的数据。为简化起见统一按"日历日数"声明，
   实际数据按 `raw.daily_quote` 的交易日返回——runner 在调用 `compute` 前
   保证窗口内只含 T 日及之前的交易日切片，**绝不**含 T+1。
   注：对纯量价因子，窗口下限按 N 交易日 * 1.6（节假日缓冲）取整即可；
   见各因子实现的 `pit_window_days` 注释。

2. **数据源类别**：决定 runner 需要从哪几张 raw 表预取数据
   - `price`：仅需 `raw.daily_quote` + `raw.adj_factor`
   - `fundamental`：需 `raw.fina_indicator`（PIT 锚点 = `ann_date`）
   - `industry`：需 `raw.daily_quote` + `raw.adj_factor` + `raw.index_member`
   - `mixed`：跨多源（如行业中性化的个股动量）

3. **compute 输入契约**（df）：
   `df` 是按 PIT 窗口预取的"多日 × 多股"长格式 DataFrame，索引为
   `[trade_date, ts_code]`，列包含因子需要的字段（如 `close_adj`, `vol`,
   `industry_l1` 等）。**调用方**（runner）负责：
   - 已用 `adj_factor` 反推后复权价并填入 `close_adj` / `open_adj` 等列
   - 窗口内只含 T 日及之前的交易日
   - 行业归属 `industry_l1` 已按 PIT 安全的 `raw.index_member` 解析
     （**当时**成份股，不是当前）

4. **compute 输出契约**：`pd.Series`，索引为 T 日的 `ts_code`，
   值为因子值（float）。停牌 / 数据不足时返回 NaN（runner 不会写入 PG）。

5. **factor_id + factor_version**：进入 `factors.daily_factors` 主键。
   factor_version 改动语义见 doc/03 §3.5（同 (ts_code, trade_date)
   不同 factor_version 可共存）。

6. **financial 因子的 PIT 锚点**：spec 要求 financial 因子用 `ann_date`
   作为窗口起点，本次未交付（占位）。base 已通过 `pit_anchor` 字段
   将 'trade_date' / 'ann_date' 区分清楚——runner 据此选择窗口字段。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Literal

import pandas as pd

# 数据源类别（决定 runner 预取哪几张 raw 表）
FactorCategory = Literal["price", "fundamental", "industry", "mixed"]

# PIT 锚点（决定窗口字段）
PitAnchor = Literal["trade_date", "ann_date"]


class Factor(ABC):
    """因子抽象基类。

    子类必须声明类属性：
        factor_id:        全局唯一 ID（建议 `<域>_<语义>_<参数>` 命名）
        factor_version:   版本号（'v1' / 'v2' / ...）
        category:         FactorCategory
        pit_window_days:  PIT 窗口（日历日；runner 据此预取数据）
        description:      因子语义中文描述（README 自动收集）

    可选类属性：
        pit_anchor:       默认 'trade_date'；财务因子覆盖为 'ann_date'
        required_columns: 显式声明 compute 所需的 df 列（runner 按需取列）；
                          为空时由 category 推断。

    子类必须实现：
        compute(self, df, trade_date) -> pd.Series
    """

    # --- 子类必须覆盖 ---
    factor_id: str = ""
    factor_version: str = ""
    category: FactorCategory = "price"
    pit_window_days: int = 0
    description: str = ""

    # --- 子类按需覆盖 ---
    pit_anchor: PitAnchor = "trade_date"
    required_columns: tuple[str, ...] = ()

    def __init_subclass__(cls, **kwargs: object) -> None:
        super().__init_subclass__(**kwargs)
        # 允许基类作为中间抽象类（不强校验），具体因子在 registry 注册时再校验

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
    # 工具：从基类衍生的元数据访问
    # ------------------------------------------------------------------

    @classmethod
    def meta(cls) -> dict[str, object]:
        """返回因子元数据 dict（供 registry / 文档自动生成）。"""

        return {
            "factor_id": cls.factor_id,
            "factor_version": cls.factor_version,
            "category": cls.category,
            "pit_window_days": cls.pit_window_days,
            "pit_anchor": cls.pit_anchor,
            "description": cls.description,
            "required_columns": list(cls.required_columns),
        }

    @classmethod
    def validate_meta(cls) -> None:
        """在 registry 注册时调用：校验必填类属性已被子类覆盖。

        抛 ValueError 比静默注册一个非法因子更安全（CLAUDE.md 反静默吞错）。
        """

        if not cls.factor_id:
            raise ValueError(f"{cls.__name__}: factor_id must be set")
        if not cls.factor_version:
            raise ValueError(f"{cls.__name__}: factor_version must be set")
        if cls.pit_window_days <= 0:
            raise ValueError(
                f"{cls.__name__}: pit_window_days must be > 0, got {cls.pit_window_days}"
            )
        if cls.category not in ("price", "fundamental", "industry", "mixed"):
            raise ValueError(f"{cls.__name__}: invalid category {cls.category!r}")
        if cls.pit_anchor not in ("trade_date", "ann_date"):
            raise ValueError(f"{cls.__name__}: invalid pit_anchor {cls.pit_anchor!r}")
        if cls.category == "fundamental" and cls.pit_anchor != "ann_date":
            raise ValueError(
                f"{cls.__name__}: fundamental factor must use pit_anchor='ann_date' "
                "(doc/量化/03 PIT 铁律)"
            )
