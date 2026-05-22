"""值域类检查：null_violation + extreme_value。

PIT / 跨表类检查（pit_finance / adj_jump / survivor_bias / cross_table_alignment）
已拆分到 checks_pit.py（06-quality.md 问题 12：单文件超 500 行）。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from quant_pipeline.quality.checks_common import is_trading_day
from quant_pipeline.quality.report import CheckResult

logger = logging.getLogger(__name__)


# 业务上不允许 NULL 的硬约束列（CLAUDE.md "数据集完整性检查的最弱可接受标准"）
DEFAULT_NULL_VIOLATION_COLUMNS: dict[str, list[str]] = {
    "raw.daily_quote": ["open", "high", "low", "close", "vol"],
    "raw.adj_factor": ["adj_factor"],
}


# ----------------------------------------------------------------------
# 3. null_violation —— 业务上不允许 NULL 的列在当日逐行非空
# ----------------------------------------------------------------------

def check_null_violation(
    session: Session,
    trade_date: str,
    params: dict[str, Any] | None = None,
) -> CheckResult:
    """行级硬约束：默认 raw.daily_quote 的 OHLCV 与 raw.adj_factor 的 adj_factor
    在当日每一行都非空（CLAUDE.md "数据集完整性检查的最弱可接受标准"）。
    """

    params = params or {}
    columns: dict[str, list[str]] = dict(DEFAULT_NULL_VIOLATION_COLUMNS)
    columns.update(params.get("null_violation_columns", {}) or {})

    # 交易日 + 该表当日 0 行 = 漏同步（CLAUDE.md 行级硬约束的前提是"当日有数据"）。
    # "至少一行非空"是无意义最弱约束——0 行不得静默判通过。
    is_trading = is_trading_day(session, trade_date)
    empty_tables: list[dict[str, Any]] = []
    for table in columns:
        try:
            cnt = int(
                session.execute(
                    text(f"SELECT count(*) FROM {table} WHERE trade_date = :d"),
                    {"d": trade_date},
                ).scalar_one()
            )
        except Exception as exc:
            logger.warning(
                "null_violation_count_skip", extra={"table": table, "err": str(exc)}
            )
            continue
        if cnt == 0:
            empty_tables.append({"table": table, "row_count": 0})

    if empty_tables and is_trading is not False:
        # is_trading=True：确认交易日漏同步 → critical
        # is_trading=None：trade_cal 未覆盖该日，无法证伪交易日 → 保守判 critical
        #   （宁可误阻断也不放行残缺数据；门禁场景不接受"无法判定即放行"）
        return CheckResult(
            passed=False,
            level="critical",
            rule="null_violation",
            detail={
                "table": empty_tables[0]["table"],
                "column": "<all>",
                "violation_count": 0,
                "sample_keys": [],
                "reason": "empty_table_on_trading_day",
                "is_trading_day": is_trading,
                "empty_tables": empty_tables,
                "date": trade_date,
            },
            trade_date=trade_date,
            name="null_violation",
        )

    violations: list[dict[str, Any]] = []
    for table, cols in columns.items():
        for col in cols:
            sql = text(
                f"""
                SELECT ts_code
                FROM {table}
                WHERE trade_date = :d AND {col} IS NULL
                LIMIT 10
                """
            )
            try:
                rows = session.execute(sql, {"d": trade_date}).all()
            except Exception as exc:
                logger.warning(
                    "null_violation_skip",
                    extra={"table": table, "col": col, "err": str(exc)},
                )
                continue
            if rows:
                count_sql = text(
                    f"SELECT count(*) FROM {table} "
                    f"WHERE trade_date = :d AND {col} IS NULL"
                )
                total = int(session.execute(count_sql, {"d": trade_date}).scalar_one())
                violations.append(
                    {
                        "table": table,
                        "column": col,
                        "violation_count": total,
                        "sample_keys": [r[0] for r in rows],
                    }
                )

    if violations:
        # 单条 detail 必须含 §4.3 字段；多列违约时取第一条作为主 detail，其余进 extras
        primary = violations[0]
        return CheckResult(
            passed=False,
            level="critical",
            rule="null_violation",
            detail={
                "table": primary["table"],
                "column": primary["column"],
                "violation_count": primary["violation_count"],
                "sample_keys": primary["sample_keys"],
                "extras": violations[1:],
                "date": trade_date,
            },
            trade_date=trade_date,
            name="null_violation",
        )
    return CheckResult(
        passed=True,
        level="info",
        rule="null_violation",
        detail={"date": trade_date, "columns_checked": columns},
        trade_date=trade_date,
        name="null_violation",
    )


# ----------------------------------------------------------------------
# 4. extreme_value —— 因子值超出稳健离群边界（median ± N·1.4826·MAD）
# ----------------------------------------------------------------------

def check_extreme_value(
    session: Session,
    trade_date: str,
    params: dict[str, Any] | None = None,
) -> CheckResult:
    """对 factors.daily_factors 各 factor_id 用稳健统计量（中位数 + MAD）
    计算离群边界，超出 [median - N·1.4826·MAD, median + N·1.4826·MAD] 计为离群。

    N 默认 10（极宽，仅捕获明显异常）；任一 factor_id 出现离群即 warn。

    用 median/MAD 而非 μ/σ（06-quality.md 问题 9）：极端污染值会把 σ 抬高、
    使 Nσ 边界变宽，极值反而落界内被漏报（掩蔽效应）。中位数与 MAD 对离群
    稳健，不会被离群点自我稀释。MAD×1.4826 使其在正态下与 σ 同尺度。
    """

    params = params or {}
    sigma_n = float(params.get("extreme_sigma", 10.0))
    factor_version = params.get("factor_version")

    where_clause = "WHERE trade_date = :d"
    bind: dict[str, Any] = {"d": trade_date, "n": sigma_n}
    if factor_version:
        where_clause += " AND factor_version = :v"
        bind["v"] = factor_version

    sql = text(
        f"""
        WITH med AS (
            SELECT factor_id,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY value)::double precision
                       AS med_value
            FROM factors.daily_factors
            {where_clause}
            GROUP BY factor_id
        ),
        stats AS (
            SELECT f.factor_id,
                   m.med_value AS med,
                   percentile_cont(0.5) WITHIN GROUP (
                       ORDER BY abs(f.value - m.med_value)
                   )::double precision AS mad
            FROM factors.daily_factors f
            JOIN med m ON m.factor_id = f.factor_id
            WHERE f.trade_date = :d
            GROUP BY f.factor_id, m.med_value
        ),
        outliers AS (
            SELECT f.factor_id, count(*) AS outlier_count
            FROM factors.daily_factors f
            JOIN stats s ON s.factor_id = f.factor_id
            WHERE f.trade_date = :d
              AND s.mad IS NOT NULL AND s.mad > 0
              AND (f.value > s.med + :n * 1.4826 * s.mad
                   OR f.value < s.med - :n * 1.4826 * s.mad)
            GROUP BY f.factor_id
        )
        SELECT factor_id, outlier_count FROM outliers
        ORDER BY outlier_count DESC
        LIMIT 50
        """
    )
    try:
        rows = session.execute(sql, bind).all()
    except Exception as exc:
        logger.error("extreme_value_failed", extra={"err": str(exc)})
        return CheckResult(
            passed=False,
            level="critical",
            rule="extreme_value",
            detail={"date": trade_date, "error": str(exc)},
            trade_date=trade_date,
            name="extreme_value",
        )

    if rows:
        # detail 必须含 factor_id / date / outlier_count（§4.3）；多 factor 时取最大。
        # SQL 已 LIMIT 50，extras 至多 49 条，不会大面积塞爆 jsonb（问题 18）。
        top = rows[0]
        return CheckResult(
            passed=False,
            level="warn",
            rule="extreme_value",
            detail={
                "factor_id": top[0],
                "date": trade_date,
                "outlier_count": int(top[1]),
                "sigma_threshold": sigma_n,
                "extras": [
                    {"factor_id": r[0], "outlier_count": int(r[1])} for r in rows[1:]
                ],
            },
            trade_date=trade_date,
            name="extreme_value",
        )
    return CheckResult(
        passed=True,
        level="info",
        rule="extreme_value",
        detail={"date": trade_date, "sigma_threshold": sigma_n},
        trade_date=trade_date,
        name="extreme_value",
    )
