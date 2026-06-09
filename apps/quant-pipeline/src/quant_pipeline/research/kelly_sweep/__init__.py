"""kelly_sweep：按「入场条件变体 × 出场参数」网格扫描凯利上界的研究 harness。

公共符号：
    config  — SweepConfig（扫描参数模型）
    types   — BaseTrigger / Bar / ForwardPath / TradeResult / MetricResult
"""

from quant_pipeline.research.kelly_sweep.config import SweepConfig
from quant_pipeline.research.kelly_sweep.types import (
    Bar,
    BaseTrigger,
    ForwardPath,
    MetricResult,
    TradeResult,
)

__all__ = [
    "SweepConfig",
    "BaseTrigger",
    "Bar",
    "ForwardPath",
    "TradeResult",
    "MetricResult",
]
