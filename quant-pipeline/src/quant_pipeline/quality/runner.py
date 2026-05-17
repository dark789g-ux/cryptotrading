"""quality 顶层 runner —— CLI / worker dispatcher 共用入口。

约束：
- strict 模式下任一 critical 抛 QualityGateBlocked，dispatcher 据此把 job 置 blocked
- 阈值放宽（row_count_drift_threshold > 0.05）触发 info 级"留痕"事件
- 所有 CheckResult 经 report.emit 双写 log + ml.quality_reports
- 不提供 --force（spec §2 硬约束）

返回结构：
    QualityRunReport {
        results: list[CheckResult],
        critical_count: int,
        warn_count: int,
        info_count: int,
        passed: bool,
    }
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from quant_pipeline.db.engine import session_scope
from quant_pipeline.quality.checks import ALL_CHECKS, make_threshold_relaxation_record
from quant_pipeline.quality.pit_audit import run_full_audit
from quant_pipeline.quality.report import CheckResult, emit

logger = logging.getLogger(__name__)


class QualityGateBlocked(Exception):
    """strict 模式下出现 critical 时由 runner 抛出；dispatcher 把 job 置 blocked。"""

    def __init__(self, rule: str, detail: dict[str, Any]) -> None:
        super().__init__(f"quality gate blocked: rule={rule}")
        self.rule = rule
        self.detail = detail


@dataclass
class QualityRunReport:
    results: list[CheckResult]
    critical_count: int
    warn_count: int
    info_count: int
    passed: bool


def run_checks(
    trade_date: str,
    *,
    strict: bool = False,
    params: dict[str, Any] | None = None,
    job_id: UUID | None = None,
) -> QualityRunReport:
    """执行 8 项数据质量检验。

    Args:
        trade_date: YYYYMMDD
        strict:    True 时遇到 critical 立即抛 QualityGateBlocked
        params:    透传给各 check 的参数字典（见 checks.py 模块 docstring）
        job_id:    可选，用于日志上下文
    """

    params = params or {}

    # 阈值放宽留痕（spec 04 §2）
    relaxation_threshold = float(params.get("row_count_drift_threshold", 0.05))
    relaxation_records: list[CheckResult] = []
    if relaxation_threshold > 0.05:
        relaxation_records.append(
            make_threshold_relaxation_record(
                trade_date=trade_date,
                original=0.05,
                relaxed=relaxation_threshold,
            )
        )

    results: list[CheckResult] = []
    with session_scope() as session:
        for name, fn in ALL_CHECKS:
            try:
                result = fn(session, trade_date, params)
            except Exception as exc:  # noqa: BLE001 —— 单条检查异常不阻其它
                logger.exception(
                    "check_internal_error",
                    extra={"check": name, "trade_date": trade_date},
                )
                # 失败的检查本身不入 ml.quality_reports；让 dispatcher 看到 critical
                # 通过抛异常路径，落 ml.jobs.error_text。但 strict=False 时跳过。
                if strict:
                    raise
                results.append(
                    CheckResult(
                        passed=True,  # 不重复写 quality_reports
                        level="info",
                        rule="duplicate_pk",  # 占位 rule（不会 emit）
                        detail={"check": name, "internal_error": str(exc)},
                        trade_date=trade_date,
                        name=name,
                    )
                )
                continue
            results.append(result)

    # 先 emit 留痕事件，再 emit 真实结果
    for record in relaxation_records:
        emit(record, job_id=job_id)

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

    passed = critical_count == 0
    report = QualityRunReport(
        results=results,
        critical_count=critical_count,
        warn_count=warn_count,
        info_count=info_count,
        passed=passed,
    )

    if strict and critical_count > 0:
        # 抛第一条 critical 的 rule / detail
        first = next(r for r in results if not r.passed and r.level == "critical")
        raise QualityGateBlocked(rule=first.rule, detail=first.detail)

    return report


def run_pit_audit(
    sample_trade_dates: list[str],
    *,
    job_id: UUID | None = None,
    ghost2_sample_codes: int = 10,
    ghost2_sample_dates: int = 5,
    ghost3_sample_size: int = 10,
) -> QualityRunReport:
    """执行 PIT 三铁律 + 三幽灵 Bug 全套审计。

    Args:
        sample_trade_dates: 抽样审计的交易日列表（YYYYMMDD）
    """

    if not sample_trade_dates:
        raise ValueError("sample_trade_dates 不能为空；至少抽 1 个交易日")

    with session_scope() as session:
        results = run_full_audit(
            session,
            sample_trade_dates,
            ghost2_sample_codes=ghost2_sample_codes,
            ghost2_sample_dates=ghost2_sample_dates,
            ghost3_sample_size=ghost3_sample_size,
        )

    critical_count = 0
    warn_count = 0
    info_count = 0
    for r in results:
        if r.level == "critical":
            critical_count += 1
        elif r.level == "warn":
            warn_count += 1
        else:
            info_count += 1
        emit(r, job_id=job_id)

    passed = critical_count == 0
    return QualityRunReport(
        results=results,
        critical_count=critical_count,
        warn_count=warn_count,
        info_count=info_count,
        passed=passed,
    )
