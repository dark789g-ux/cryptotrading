"""kelly_sweep：按「入场条件变体 × 出场参数」网格扫描凯利上界的研究 harness。

公共符号：
    config  — SweepConfig（扫描参数模型）
    types   — BaseTrigger / Bar / ForwardPath / TradeResult / MetricResult
    sweep   — run_sweep / ResultRow / valid_rets_for
    report  — compute_pareto_frontier / rank_top_k / render_report
    cli     — main
"""

from quant_pipeline.research.kelly_sweep.config import SweepConfig
from quant_pipeline.research.kelly_sweep.report import (
    compute_pareto_frontier,
    rank_top_k,
    render_report,
)
from quant_pipeline.research.kelly_sweep.sweep import (
    ResultRow,
    run_sweep,
    valid_rets_for,
)
from quant_pipeline.research.kelly_sweep.types import (
    Bar,
    BaseTrigger,
    ForwardPath,
    MetricResult,
    TradeResult,
)

__all__ = [
    # config
    "SweepConfig",
    # types
    "BaseTrigger",
    "Bar",
    "ForwardPath",
    "TradeResult",
    "MetricResult",
    # sweep
    "run_sweep",
    "ResultRow",
    "valid_rets_for",
    # report
    "compute_pareto_frontier",
    "rank_top_k",
    "render_report",
]
