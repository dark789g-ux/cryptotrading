"""八项数据质量检验（M1 Part E）—— 注册表入口。

规则名 / detail 字段名严格对齐 01-pg-schema.md §4.3；不允许自创规则名。

实际 check 函数已拆分到：
  - checks_row.py   — row_count_drift + duplicate_pk
  - checks_value.py — null_violation + extreme_value + pit_finance + adj_jump + survivor_bias + cross_table_alignment

调用契约：
    每个 check 函数签名：
        def check_xxx(session: Session, trade_date: str, params: dict) -> CheckResult

    - 输入 trade_date 为 YYYYMMDD 字符串（A 股规范，CLAUDE.md 硬约束）
    - params 由调用方（CLI / runner）透传；§5 文档化了支持的键
    - 返回 CheckResult：失败时 passed=False，CLI runner 负责调 report.emit 双写

支持的 params 键（§5 通用）：
    row_count_drift_threshold:  float, 默认 0.05；阈值放宽到 0.10 时同时写一条
                                level='info' 的"阈值放宽留痕"事件（spec 04 §2 硬约束）
    adj_jump_ratio_threshold:   float, 默认 5.0；单日 adj_factor 相对变化倍数
    extreme_sigma:              float, 默认 10.0；因子值 μ±N σ 外算极值
    null_violation_columns:     dict[str, list[str]]，
                                eg {"raw.daily_quote": ["open","high","low","close"]}
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

# 从拆分模块 re-export 所有 check 函数（保持外部 import 路径不变）
from quant_pipeline.quality.checks_row import (  # noqa: F401
    check_duplicate_pk,
    check_row_count_drift,
    make_threshold_relaxation_record,
)
from quant_pipeline.quality.checks_value import (  # noqa: F401
    check_adj_jump,
    check_cross_table_alignment,
    check_extreme_value,
    check_null_violation,
    check_pit_finance,
    check_survivor_bias,
)


# ----------------------------------------------------------------------
# 注册表 —— runner 用此顺序跑 8 项
# ----------------------------------------------------------------------

ALL_CHECKS: tuple[tuple[str, Any], ...] = (
    ("row_count_drift", check_row_count_drift),
    ("duplicate_pk", check_duplicate_pk),
    ("null_violation", check_null_violation),
    ("extreme_value", check_extreme_value),
    ("pit_finance", check_pit_finance),
    ("adj_jump", check_adj_jump),
    ("survivor_bias", check_survivor_bias),
    ("cross_table_alignment", check_cross_table_alignment),
)


def iter_checks() -> Iterable[tuple[str, Any]]:
    return iter(ALL_CHECKS)
