"""CheckResult 数据结构 + 写 ml.quality_reports 的薄包装。

承诺：rule 与 detail 字段名严格对齐 01-pg-schema.md §4.3。
warn 双写复用 worker.progress.warn_with_quality_report，避免重复实现。

本模块同时对外暴露 `gate_check` —— 训练前 / 推理前必检的硬门禁入口
（spec 04-error-quality-testing.md §2）。M2 训练 / 推理 runner 通过
`from quant_pipeline.quality.report import gate_check` 调用。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID

from quant_pipeline.worker.progress import warn_with_quality_report

Level = Literal["info", "warn", "critical"]


# 01-pg-schema §4.3 列表（含 M4 的 feature_drift_psi / ic_drop 占位 + sync 模块用的 *_empty 通配）。
# `*_empty` 由 sync 模块自身拼出 api_name；本模块仅使用其余固定规则名。
ALLOWED_RULES: frozenset[str] = frozenset(
    {
        "row_count_drift",
        "duplicate_pk",
        "null_violation",
        "extreme_value",
        "pit_finance",
        "adj_jump",
        "survivor_bias",
        "cross_table_alignment",
        # M4 占位（本里程碑不写，但允许后续模块复用同一 ALLOWED 集合）
        "feature_drift_psi",
        "ic_drop",
    }
)


@dataclass(frozen=True)
class CheckResult:
    """单条质量检查输出。

    属性：
      passed:     True 表示通过；False 表示需要写 ml.quality_reports
      level:      info / warn / critical；critical 在 strict 模式下阻断
      rule:       01-pg-schema §4.3 列表中的规则名；不允许自创
      detail:     jsonb 内容，字段名严格对齐 §4.3 表的"detail 字段"列
      trade_date: YYYYMMDD；少数全局检查（PIT 审计）可为 '00000000' 占位
    """

    passed: bool
    level: Level
    rule: str
    detail: dict[str, Any]
    trade_date: str
    # 检查名（用于 CLI 打印 / runner 路由）；与 rule 大多数情况相同，
    # 但 PIT 审计中一次检查可能产出多条不同 rule 的 CheckResult，name 用于分组日志。
    name: str = field(default="")

    def __post_init__(self) -> None:
        if self.level not in ("info", "warn", "critical"):
            raise ValueError(f"level must be info|warn|critical, got {self.level!r}")
        if self.rule not in ALLOWED_RULES and not self.rule.endswith("_empty"):
            raise ValueError(
                f"rule {self.rule!r} not in 01-pg-schema §4.3 ALLOWED_RULES; 禁止自创规则名"
            )
        if len(self.trade_date) != 8 or not self.trade_date.isdigit():
            raise ValueError(f"trade_date must be YYYYMMDD, got {self.trade_date!r}")


def emit(result: CheckResult, *, job_id: UUID | None = None) -> None:
    """把一条未通过的 CheckResult 双写到 log + ml.quality_reports。

    passed=True 时一律跳过（不写 DB，不打日志）；info 级的"阈值放宽"留痕也走此函数。
    """

    if result.passed and result.level != "info":
        return

    warn_with_quality_report(
        rule=result.rule,
        trade_date=result.trade_date,
        detail=result.detail,
        level=result.level,
        job_id=job_id,
    )


# ----------------------------------------------------------------------
# 训练前 / 推理前必检入口（spec 04 §2 硬约束）
# ----------------------------------------------------------------------

# spec 04 §2 两套必检规则：
#   training_pregate  —— 训练前：行级硬约束 + 跨表对齐 + PIT 三铁律全绿
#   inference_pregate —— 推理前：raw.daily_quote 完整 + row_count_drift < 5%
GateMode = Literal["training_pregate", "inference_pregate"]

# 各 mode 的必检规则名列表（rule 名严格对齐 §4.3；name 用于挑选 ALL_CHECKS 中的项）
_GATE_RULES: dict[str, tuple[str, ...]] = {
    "training_pregate": (
        "null_violation",          # 行级硬约束
        "duplicate_pk",            # 主键唯一
        "cross_table_alignment",   # factors >= raw 跨表对齐
        "pit_finance",             # PIT 铁律 1（ann_date）
        "survivor_bias",           # 三幽灵 Bug 1
        "adj_jump",                # 三幽灵 Bug 2 副信号
    ),
    "inference_pregate": (
        "null_violation",          # raw.daily_quote OHLC 行级非空
        "row_count_drift",         # 股票数与上一交易日差 < 5%
        "duplicate_pk",            # 推理前同样不允许重复键
    ),
}


def gate_check(
    trade_date: str,
    *,
    mode: GateMode,
    strict: bool = True,
    params: dict[str, Any] | None = None,
    job_id: UUID | None = None,
) -> "QualityRunReport":  # type: ignore[name-defined]  # 运行时导入避免循环
    """训练前 / 推理前的硬门禁入口（spec 04 §2）。

    Args:
        trade_date: YYYYMMDD
        mode:       'training_pregate' | 'inference_pregate'
        strict:     默认 True；critical → raise QualityGateBlocked
                    （dispatcher 抓住后写 status='blocked' + blocked_reason=<rule>）
                    strict=False 时 warn 但不 raise（仅留痕，用于调试 / 灰度）
        params:     透传给 checks（thresholds 等）
        job_id:     可选，写日志用

    Returns:
        QualityRunReport（含 critical_count / warn_count / passed 等汇总）

    Raises:
        ValueError: mode 不识别
        QualityGateBlocked: strict=True 且至少 1 条 critical

    备注：M2 训练 / 推理 runner 在进入核心逻辑前必须调用此函数。spec 明确
    "门禁不可被 --force 绕过"——CLI 不暴露 strict=False 的入口，仅供
    集成测试 / 灰度场景使用。
    """

    if mode not in _GATE_RULES:
        raise ValueError(
            f"gate_check mode must be one of {sorted(_GATE_RULES)}, got {mode!r}"
        )

    # 延迟 import 避免循环：runner 依赖 report；report 又要回调 runner 复用 ALL_CHECKS
    from quant_pipeline.quality.checks import ALL_CHECKS
    from quant_pipeline.quality.runner import QualityGateBlocked, QualityRunReport
    from quant_pipeline.db.engine import session_scope

    rules_to_run = set(_GATE_RULES[mode])
    selected = tuple((name, fn) for name, fn in ALL_CHECKS if name in rules_to_run)

    params = params or {}
    results: list[CheckResult] = []
    with session_scope() as session:
        for name, fn in selected:
            result = fn(session, trade_date, params)
            results.append(result)

    critical_count = 0
    warn_count = 0
    info_count = 0
    for r in results:
        if r.passed:
            info_count += 1
            continue
        if r.level == "critical":
            critical_count += 1
        elif r.level == "warn":
            warn_count += 1
        else:
            info_count += 1
        emit(r, job_id=job_id)

    report = QualityRunReport(
        results=results,
        critical_count=critical_count,
        warn_count=warn_count,
        info_count=info_count,
        passed=critical_count == 0,
    )

    if strict and critical_count > 0:
        first = next(r for r in results if not r.passed and r.level == "critical")
        raise QualityGateBlocked(rule=first.rule, detail=first.detail)

    return report
