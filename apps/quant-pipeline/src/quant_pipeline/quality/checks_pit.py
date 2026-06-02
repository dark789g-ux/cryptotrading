"""PIT / 跨表类检查：pit_finance + adj_jump + survivor_bias + cross_table_alignment。

从 checks_value.py 拆出（06-quality.md 问题 12：单文件超 500 行）。
值域类检查（null_violation / extreme_value）仍在 checks_value.py。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from quant_pipeline.quality.checks_common import is_trading_day
from quant_pipeline.quality.report import CheckResult

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# 5. pit_finance —— 财务因子用 ann_date 而非 end_date
# ----------------------------------------------------------------------

def check_pit_finance(
    session: Session,
    trade_date: str,
    params: dict[str, Any] | None = None,
) -> CheckResult:
    """财报延迟检查：raw.fina_indicator 入库必须按 ann_date PIT；
    扫描 trade_date >= ann_date 的样本 → 找到 trade_date < ann_date 的 fundamental
    因子样本说明偷看未来。

    本检查比对：对 factors.daily_factors 中 factor_id 以 'fin_' 开头的因子，
    join raw.fina_indicator 按 ts_code 取最近 ann_date <= trade_date 的记录；
    若 join 不到（说明该因子根本没用到 fina），单独标注；若 join 出 ann_date > trade_date
    说明 PIT 被破坏。
    """

    params = params or {}
    factor_prefix = params.get("fundamental_factor_prefix", "fin_")

    # 直接检查 raw.fina_indicator 自身是否存在 ann_date IS NULL（PIT 入库的必要条件）
    null_ann_sql = text(
        """
        SELECT count(*) FROM raw.fina_indicator
        WHERE ann_date IS NULL
        """
    )
    try:
        null_ann_count = int(session.execute(null_ann_sql).scalar_one() or 0)
    except Exception as exc:
        logger.error("pit_finance_failed_null_ann", extra={"err": str(exc)})
        return CheckResult(
            passed=False,
            level="critical",
            rule="pit_finance",
            detail={"date": trade_date, "error": str(exc)},
            trade_date=trade_date,
            name="pit_finance",
        )

    # 扫描 fundamental 类因子的 ts_code 样本，看是否能在 trade_date 当日找到对应
    # ann_date <= trade_date 的 fina_indicator 记录；找不到说明用了 end_date。
    sample_sql = text(
        """
        WITH ff AS (
            SELECT factor_id, ts_code
            FROM factors.daily_factors
            WHERE trade_date = :d
              AND factor_id LIKE :prefix
            LIMIT 200
        ),
        bad AS (
            SELECT ff.factor_id, ff.ts_code
            FROM ff
            WHERE NOT EXISTS (
                SELECT 1 FROM raw.fina_indicator fi
                WHERE fi.ts_code = ff.ts_code
                  AND fi.ann_date IS NOT NULL
                  AND fi.ann_date <= :d
            )
        )
        SELECT factor_id, array_agg(ts_code) AS sample_ts_codes
        FROM bad
        GROUP BY factor_id
        """
    )
    try:
        rows = session.execute(
            sample_sql, {"d": trade_date, "prefix": f"{factor_prefix}%"}
        ).all()
    except Exception as exc:
        logger.error("pit_finance_failed_sample", extra={"err": str(exc)})
        return CheckResult(
            passed=False,
            level="critical",
            rule="pit_finance",
            detail={"date": trade_date, "error": str(exc)},
            trade_date=trade_date,
            name="pit_finance",
        )

    if null_ann_count > 0 or rows:
        primary_factor = rows[0][0] if rows else "<raw.fina_indicator>"
        primary_codes = list(rows[0][1]) if rows else []
        return CheckResult(
            passed=False,
            level="critical",
            rule="pit_finance",
            detail={
                "factor_id": primary_factor,
                "sample_ts_codes": primary_codes[:20],
                "null_ann_date_count": null_ann_count,
                "extras": [
                    {"factor_id": r[0], "sample_ts_codes": list(r[1])[:20]}
                    for r in rows[1:]
                ],
            },
            trade_date=trade_date,
            name="pit_finance",
        )

    return CheckResult(
        passed=True,
        level="info",
        rule="pit_finance",
        detail={"date": trade_date, "prefix": factor_prefix},
        trade_date=trade_date,
        name="pit_finance",
    )


# ----------------------------------------------------------------------
# 6. adj_jump —— adj_factor 单日相对变化 > 阈值
# ----------------------------------------------------------------------

def check_adj_jump(
    session: Session,
    trade_date: str,
    params: dict[str, Any] | None = None,
) -> CheckResult:
    """adj_factor 单日相对变化 > 阈值（默认 5×）：很可能是分红 / 拆股错位。"""

    params = params or {}
    ratio_threshold = float(params.get("adj_jump_ratio_threshold", 5.0))

    sql = text(
        """
        WITH today AS (
            SELECT ts_code, adj_factor::double precision AS curr_factor
            FROM raw.adj_factor WHERE trade_date = :d
        ),
        prev AS (
            SELECT ts_code, adj_factor::double precision AS prev_factor
            FROM raw.adj_factor
            WHERE trade_date = (
                SELECT max(trade_date) FROM raw.adj_factor WHERE trade_date < :d
            )
        )
        SELECT t.ts_code, p.prev_factor, t.curr_factor,
               CASE WHEN p.prev_factor > 0
                    THEN t.curr_factor / p.prev_factor
                    ELSE NULL END AS ratio
        FROM today t
        JOIN prev p ON p.ts_code = t.ts_code
        WHERE p.prev_factor > 0
          AND (t.curr_factor / p.prev_factor > :r
               OR p.prev_factor / NULLIF(t.curr_factor, 0) > :r)
        LIMIT 20
        """
    )
    try:
        rows = session.execute(sql, {"d": trade_date, "r": ratio_threshold}).all()
    except Exception as exc:
        logger.error("adj_jump_failed", extra={"err": str(exc)})
        return CheckResult(
            passed=False,
            level="critical",
            rule="adj_jump",
            detail={"date": trade_date, "error": str(exc)},
            trade_date=trade_date,
            name="adj_jump",
        )

    if rows:
        top = rows[0]
        return CheckResult(
            passed=False,
            level="warn",
            rule="adj_jump",
            detail={
                "ts_code": top[0],
                "date": trade_date,
                "prev_factor": float(top[1]),
                "curr_factor": float(top[2]),
                "ratio": float(top[3]) if top[3] is not None else None,
                "threshold": ratio_threshold,
                "extras": [
                    {
                        "ts_code": r[0],
                        "prev_factor": float(r[1]),
                        "curr_factor": float(r[2]),
                        "ratio": float(r[3]) if r[3] is not None else None,
                    }
                    for r in rows[1:]
                ],
            },
            trade_date=trade_date,
            name="adj_jump",
        )
    return CheckResult(
        passed=True,
        level="info",
        rule="adj_jump",
        detail={"date": trade_date, "threshold": ratio_threshold},
        trade_date=trade_date,
        name="adj_jump",
    )


# ----------------------------------------------------------------------
# 7. survivor_bias —— 历史日因子用到了未来才存在的股票
# ----------------------------------------------------------------------

def check_survivor_bias(
    session: Session,
    trade_date: str,
    params: dict[str, Any] | None = None,
) -> CheckResult:
    """对 factors.daily_factors 当日的每个 ts_code，验证其在 raw.daily_quote 当日存在；
    不存在说明用了"上市后"或"摘牌后"的股票回填，构成幸存偏差。
    """

    sql = text(
        """
        SELECT count(DISTINCT f.ts_code), count(DISTINCT f.factor_id)
        FROM factors.daily_factors f
        WHERE f.trade_date = :d
          AND NOT EXISTS (
              SELECT 1 FROM raw.daily_quote q
              WHERE q.ts_code = f.ts_code AND q.trade_date = :d
          )
        """
    )
    try:
        row = session.execute(sql, {"d": trade_date}).first()
    except Exception as exc:
        logger.error("survivor_bias_failed", extra={"err": str(exc)})
        return CheckResult(
            passed=False,
            level="critical",
            rule="survivor_bias",
            detail={"date": trade_date, "error": str(exc)},
            trade_date=trade_date,
            name="survivor_bias",
        )

    bad_ts_count = int(row[0]) if row else 0
    bad_factor_count = int(row[1]) if row else 0

    if bad_ts_count > 0:
        # 取个样本作为 sample_ts_codes
        sample_sql = text(
            """
            SELECT DISTINCT f.factor_id, f.ts_code
            FROM factors.daily_factors f
            WHERE f.trade_date = :d
              AND NOT EXISTS (
                  SELECT 1 FROM raw.daily_quote q
                  WHERE q.ts_code = f.ts_code AND q.trade_date = :d
              )
            LIMIT 20
            """
        )
        sample = session.execute(sample_sql, {"d": trade_date}).all()
        primary_factor = sample[0][0] if sample else "<unknown>"
        return CheckResult(
            passed=False,
            level="critical",
            rule="survivor_bias",
            detail={
                "factor_id": primary_factor,
                "date": trade_date,
                "count": bad_ts_count,
                "factor_count": bad_factor_count,
                "samples": [{"factor_id": r[0], "ts_code": r[1]} for r in sample],
            },
            trade_date=trade_date,
            name="survivor_bias",
        )
    return CheckResult(
        passed=True,
        level="info",
        rule="survivor_bias",
        detail={"date": trade_date},
        trade_date=trade_date,
        name="survivor_bias",
    )


# ----------------------------------------------------------------------
# 8. cross_table_alignment —— 派生表行数 >= 基础表行数
# ----------------------------------------------------------------------

def check_cross_table_alignment(
    session: Session,
    trade_date: str,
    params: dict[str, Any] | None = None,
) -> CheckResult:
    """CLAUDE.md 跨表行数对齐：
        count(factors.daily_factors WHERE trade_date=X)
            >= count(raw.daily_quote WHERE trade_date=X)

    factors.daily_factors 是长格式，行数应为 N(stock) * M(factor)，
    因此严格 >= raw.daily_quote 的行数；不满足说明因子计算未覆盖全市场。
    """

    sql = text(
        """
        SELECT
          (SELECT count(*) FROM raw.daily_quote      WHERE trade_date = :d) AS base_rows,
          (SELECT count(*) FROM factors.daily_factors WHERE trade_date = :d) AS derived_rows,
          (SELECT count(DISTINCT ts_code) FROM raw.daily_quote      WHERE trade_date = :d) AS base_codes,
          (SELECT count(DISTINCT ts_code) FROM factors.daily_factors WHERE trade_date = :d) AS derived_codes
        """
    )
    try:
        row = session.execute(sql, {"d": trade_date}).first()
    except Exception as exc:
        logger.error("cross_table_alignment_failed", extra={"err": str(exc)})
        return CheckResult(
            passed=False,
            level="critical",
            rule="cross_table_alignment",
            detail={"date": trade_date, "error": str(exc)},
            trade_date=trade_date,
            name="cross_table_alignment",
        )

    # 注：上面的 SELECT 是无 FROM 的标量子查询组合，PG 恒返回 1 行，row 不会是
    # None。但为防御 SQL 改写仍保留判空，0 行按"无法取数"保守判 critical。
    if row is None:
        return CheckResult(
            passed=False,
            level="critical",
            rule="cross_table_alignment",
            detail={"date": trade_date, "error": "alignment_query_returned_no_row"},
            trade_date=trade_date,
            name="cross_table_alignment",
        )

    base_rows = int(row[0] or 0)
    derived_rows = int(row[1] or 0)
    base_codes = int(row[2] or 0)
    derived_codes = int(row[3] or 0)

    # 基础表当日 0 行：不得无条件 passed=True。交叉 raw.trade_cal 区分：
    #   - 非交易日（is_open=0）：合法空，info 跳过；
    #   - 交易日（is_open=1）：raw.daily_quote 漏同步，门禁必须拦截 → critical；
    #   - trade_cal 未覆盖该日（None）：无法证伪，保守判 critical。
    if base_rows == 0:
        is_trading = is_trading_day(session, trade_date)
        if is_trading is False:
            return CheckResult(
                passed=True,
                level="info",
                rule="cross_table_alignment",
                detail={
                    "date": trade_date,
                    "base_rows": 0,
                    "derived_rows": derived_rows,
                    "note": "non_trading_day",
                },
                trade_date=trade_date,
                name="cross_table_alignment",
            )
        return CheckResult(
            passed=False,
            level="critical",
            rule="cross_table_alignment",
            detail={
                "date": trade_date,
                "base_table": "raw.daily_quote",
                "derived_table": "factors.daily_factors",
                "base_rows": 0,
                "derived_rows": derived_rows,
                "reason": "base_table_empty_on_trading_day",
                "is_trading_day": is_trading,
            },
            trade_date=trade_date,
            name="cross_table_alignment",
        )

    # 派生表行数应 >= 基础表行数（长格式）；派生股票数 >= 基础股票数
    if derived_rows < base_rows or derived_codes < base_codes:
        return CheckResult(
            passed=False,
            level="critical",
            rule="cross_table_alignment",
            detail={
                "date": trade_date,
                "base_table": "raw.daily_quote",
                "derived_table": "factors.daily_factors",
                "base_rows": base_rows,
                "derived_rows": derived_rows,
                "base_codes": base_codes,
                "derived_codes": derived_codes,
            },
            trade_date=trade_date,
            name="cross_table_alignment",
        )
    return CheckResult(
        passed=True,
        level="info",
        rule="cross_table_alignment",
        detail={
            "date": trade_date,
            "base_rows": base_rows,
            "derived_rows": derived_rows,
        },
        trade_date=trade_date,
        name="cross_table_alignment",
    )
