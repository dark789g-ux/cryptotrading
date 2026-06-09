"""SweepConfig：凯利上界网格扫描的全局参数模型。

日期字段统一 8 位 YYYYMMDD 字符串（与项目其它日期一致）。
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from quant_pipeline.research.kelly_sweep.types import BaseTrigger

# 8 位日期字符串，如 20230101
_DATE_RE = re.compile(r"^\d{8}$")


def _is_valid_date_str(s: str) -> bool:
    return bool(_DATE_RE.match(s))


class SweepConfig(BaseModel):
    """凯利上界网格扫描参数。

    所有日期用 8 位字符串（YYYYMMDD）表示，与项目 raw.* 表 trade_date 字段一致。
    """

    base_trigger: BaseTrigger = Field(
        default_factory=lambda: BaseTrigger(field="kdj_j", op="lt", value=0.0),
        description="信号枚举的 base 触发条件",
    )
    universe: Literal["all"] | list[str] = Field(
        default="all",
        description="扫描标的范围：'all' 表示全市场，或给定 ts_code 列表",
    )
    max_window: int = Field(
        default=20,
        ge=1,
        description="前向最长可交易日数（停牌日不计）",
    )
    max_entry_filters: int = Field(
        default=2,
        ge=0,
        description="单入场变体最多附加特征数（0 = 仅 base_trigger）",
    )
    train_range: tuple[str, str] = Field(
        default=("20230101", "20241231"),
        description="训练区间 [start, end]，含两端，8 位 YYYYMMDD",
    )
    valid_range: tuple[str, str] = Field(
        default=("20250101", "20260608"),
        description="验证区间 [start, end]，含两端，8 位 YYYYMMDD",
    )
    min_samples: int = Field(
        default=300,
        ge=1,
        description="验证集最低信号样本数；低于此值时跳过该变体",
    )
    bootstrap_iters: int = Field(
        default=1000,
        ge=1,
        description="Kelly CI bootstrap 重采样次数",
    )
    same_day_rule: Literal["sl_first", "tp_first"] = Field(
        default="sl_first",
        description="同日同时触发止损与止盈时的优先规则",
    )
    rs_benchmark: list[Literal["hs300", "zz500", "industry"]] = Field(
        default_factory=lambda: ["hs300"],
        description="相对强度基准，可多选",
    )
    rs_lookback: int = Field(
        default=5,
        ge=1,
        description="相对强度回看可交易日数",
    )
    top_k: int = Field(
        default=30,
        ge=1,
        description="排行榜输出前 K 条",
    )

    @model_validator(mode="after")
    def _validate_date_ranges(self) -> SweepConfig:
        """校验区间格式、内部顺序、以及 train_start ≤ valid_start。"""
        for name, (start, end) in (
            ("train_range", self.train_range),
            ("valid_range", self.valid_range),
        ):
            if not _is_valid_date_str(start):
                raise ValueError(
                    f"{name}[0]='{start}' 不是 8 位 YYYYMMDD 字符串"
                )
            if not _is_valid_date_str(end):
                raise ValueError(
                    f"{name}[1]='{end}' 不是 8 位 YYYYMMDD 字符串"
                )
            if start > end:
                raise ValueError(
                    f"{name} 起点 '{start}' 晚于终点 '{end}'"
                )

        if self.train_range[0] > self.valid_range[0]:
            raise ValueError(
                f"train_range 起点 '{self.train_range[0]}' 晚于 valid_range 起点"
                f" '{self.valid_range[0]}'"
            )

        return self
