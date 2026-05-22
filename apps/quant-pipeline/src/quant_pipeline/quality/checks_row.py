"""行数 / PK 相关检查：row_count_drift + duplicate_pk。"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from quant_pipeline.quality.report import CheckResult

logger = logging.getLogger(__name__)


# raw 各表的 PK（duplicate_pk 检查用）。
# 注意：raw 表所有权见 01-pg-schema §5，Python 这里只读，不负责建表。
DEFAULT_PK_MAP: dict[str, tuple[str, ...]] = {
    "raw.daily_quote": ("ts_code", "trade_date"),
    "raw.daily_basic": ("ts_code", "trade_date"),
    "raw.adj_factor": ("ts_code", "trade_date"),
    "raw.daily_indicator": ("ts_code", "trade_date"),
    "raw.stk_limit": ("ts_code", "trade_date"),
    "raw.suspend_d": ("ts_code", "trade_date", "suspend_type"),
    # fina_indicator 用 ann_date 入库（PIT 铁律），PK 含 ann_date
    "raw.fina_indicator": ("ts_code", "end_date", "ann_date"),
}


# ----------------------------------------------------------------------
# 1. row_count_drift —— 当日股票数与上一交易日差异
# ----------------------------------------------------------------------

def check_row_count_drift(
    session: Session,
    trade_date: str,
    params: dict[str, Any] | None = None,
) -> CheckResult:
    """股票数检查：与上一交易日差异 > 5% warn；> 10% critical。

    放宽阈值时（params.row_count_drift_threshold > 0.05），额外返回一条
    info 级 CheckResult；由 runner 在 emit 流程中合并写入留痕。
    """

    params = params or {}
    threshold = float(params.get("row_count_drift_threshold", 0.05))
    critical_threshold = max(threshold, 0.10)

    curr_row = session.execute(
        text(
            "SELECT count(DISTINCT ts_code) FROM raw.daily_quote "
            "WHERE trade_date = :d"
        ),
        {"d": trade_date},
    ).scalar_one()
    prev_row = session.execute(
        text(
            """
            SELECT count(DISTINCT ts_code)
            FROM raw.daily_quote
            WHERE trade_date = (
                SELECT max(trade_date) FROM raw.daily_quote
                WHERE trade_date < :d
            )
            """
        ),
        {"d": trade_date},
    ).scalar_one()

    curr_count = int(curr_row or 0)
    prev_count = int(prev_row or 0)

    # 无前一交易日数据：跳过（首日同步场景），返回 info 不阻断
    if prev_count == 0:
        return CheckResult(
            passed=True,
            level="info",
            rule="row_count_drift",
            detail={
                "date": trade_date,
                "prev_count": prev_count,
                "curr_count": curr_count,
                "delta_ratio": 0.0,
                "note": "no_previous_trade_date_data",
            },
            trade_date=trade_date,
            name="row_count_drift",
        )

    delta_ratio = abs(curr_count - prev_count) / float(prev_count)
    detail: dict[str, Any] = {
        "date": trade_date,
        "prev_count": prev_count,
        "curr_count": curr_count,
        "delta_ratio": round(delta_ratio, 6),
    }

    # 结构性缺失检测（06-quality.md 问题 8）：仅比总量级会漏掉
    # "A 股缺行、B 股新增/重复" —— 总数不变但成分变了。改为对比
    # 前后两日 ts_code 集合的对称差，捕获「昨日有、今日缺」的个股。
    try:
        diff_row = session.execute(
            text(
                """
                WITH curr AS (
                    SELECT DISTINCT ts_code FROM raw.daily_quote
                    WHERE trade_date = :d
                ),
                prev AS (
                    SELECT DISTINCT ts_code FROM raw.daily_quote
                    WHERE trade_date = (
                        SELECT max(trade_date) FROM raw.daily_quote
                        WHERE trade_date < :d
                    )
                )
                SELECT
                  (SELECT count(*) FROM prev p
                     WHERE NOT EXISTS (SELECT 1 FROM curr c WHERE c.ts_code = p.ts_code))
                    AS missing_today,
                  (SELECT count(*) FROM curr c
                     WHERE NOT EXISTS (SELECT 1 FROM prev p WHERE p.ts_code = c.ts_code))
                    AS new_today
                """
            ),
            {"d": trade_date},
        ).first()
        missing_today = int(diff_row[0] or 0) if diff_row else 0
        new_today = int(diff_row[1] or 0) if diff_row else 0
    except Exception as exc:
        logger.warning("row_count_drift_set_diff_skip", extra={"err": str(exc)})
        missing_today = 0
        new_today = 0
    detail["missing_today"] = missing_today
    detail["new_today"] = new_today
    # 「昨日有今日缺」的个股占比（结构性缺失，与总量级 delta 独立）
    missing_ratio = missing_today / float(prev_count)
    detail["missing_ratio"] = round(missing_ratio, 6)

    # 结构性缺失即使总量级达标也要拦截：交易日个股大面积缺行同属漏同步。
    if missing_ratio > critical_threshold:
        return CheckResult(
            passed=False,
            level="critical",
            rule="row_count_drift",
            detail={**detail, "reason": "structural_missing_codes"},
            trade_date=trade_date,
            name="row_count_drift",
        )
    if missing_ratio > threshold:
        return CheckResult(
            passed=False,
            level="warn",
            rule="row_count_drift",
            detail={**detail, "reason": "structural_missing_codes"},
            trade_date=trade_date,
            name="row_count_drift",
        )

    if delta_ratio > critical_threshold:
        return CheckResult(
            passed=False,
            level="critical",
            rule="row_count_drift",
            detail=detail,
            trade_date=trade_date,
            name="row_count_drift",
        )
    if delta_ratio > threshold:
        return CheckResult(
            passed=False,
            level="warn",
            rule="row_count_drift",
            detail=detail,
            trade_date=trade_date,
            name="row_count_drift",
        )
    return CheckResult(
        passed=True,
        level="info",
        rule="row_count_drift",
        detail=detail,
        trade_date=trade_date,
        name="row_count_drift",
    )


def make_threshold_relaxation_record(
    trade_date: str,
    original: float,
    relaxed: float,
    *,
    rule: str = "row_count_drift",
    param_name: str = "row_count_drift_threshold",
) -> CheckResult:
    """阈值临时放宽留痕（spec 04 §2 硬约束）。

    runner 在解析 params 发现某项阈值偏离默认值时调用此函数，与 check 结果
    一并 emit 到 ml.quality_reports（level='info'）。

    不止 row_count_drift_threshold：adj_jump_ratio_threshold / extreme_sigma
    等任何放宽都应留痕（06-quality.md 问题 15）。`rule` 必须是 §4.3
    ALLOWED_RULES 中的合法名（如 'adj_jump' / 'extreme_value'），`param_name`
    写进 detail 供审计区分是哪项阈值。
    """

    return CheckResult(
        passed=False,  # 强制 emit；level=info 不算 critical
        level="info",
        rule=rule,
        detail={
            "date": trade_date,
            "event": "threshold_relaxed",
            "param_name": param_name,
            "original_threshold": original,
            "relaxed_threshold": relaxed,
        },
        trade_date=trade_date,
        name=f"{rule}_relaxation",
    )


# ----------------------------------------------------------------------
# 2. duplicate_pk —— raw 各表 PK 重复
# ----------------------------------------------------------------------

def check_duplicate_pk(
    session: Session,
    trade_date: str,
    params: dict[str, Any] | None = None,
) -> CheckResult:
    """raw 各表是否存在 PK 重复（按当日 partition 查）。

    实现策略：对每张含 trade_date 列的 raw 表跑一次 GROUP BY HAVING count>1，
    找到第一张违约表即返回 critical（重复 PK 一定是数据 bug）。
    """

    params = params or {}
    pk_map: dict[str, tuple[str, ...]] = dict(DEFAULT_PK_MAP)
    pk_map.update(params.get("pk_map", {}) or {})

    violations: list[dict[str, Any]] = []
    for table, pk_cols in pk_map.items():
        # fina_indicator 用 ann_date，不按 trade_date 过滤
        has_trade_date = "trade_date" in pk_cols
        where_clause = "WHERE trade_date = :d" if has_trade_date else ""
        bind = {"d": trade_date} if has_trade_date else {}

        cols = ", ".join(pk_cols)
        sql = text(
            f"""
            SELECT {cols}, count(*) AS c
            FROM {table}
            {where_clause}
            GROUP BY {cols}
            HAVING count(*) > 1
            LIMIT 5
            """
        )
        try:
            rows = session.execute(sql, bind).mappings().all()
        except Exception as exc:  # 表不存在等场景：记日志不阻断
            logger.warning(
                "duplicate_pk_skip_table",
                extra={"table": table, "err": str(exc)},
            )
            continue
        if rows:
            violations.append(
                {
                    "table": table,
                    "pk": list(pk_cols),
                    "sample_rows": [dict(r) for r in rows],
                }
            )

    if violations:
        return CheckResult(
            passed=False,
            level="critical",
            rule="duplicate_pk",
            detail={"violations": violations, "date": trade_date},
            trade_date=trade_date,
            name="duplicate_pk",
        )
    return CheckResult(
        passed=True,
        level="info",
        rule="duplicate_pk",
        detail={"date": trade_date, "tables_checked": list(pk_map.keys())},
        trade_date=trade_date,
        name="duplicate_pk",
    )
