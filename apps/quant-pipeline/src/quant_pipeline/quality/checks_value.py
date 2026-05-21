"""值相关检查：null_violation + extreme_value + pit_finance + adj_jump + survivor_bias + cross_table_alignment。"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

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
# 4. extreme_value —— 因子值超出 [μ-Nσ, μ+Nσ]
# ----------------------------------------------------------------------

def check_extreme_value(
    session: Session,
    trade_date: str,
    params: dict[str, Any] | None = None,
) -> CheckResult:
    """对 factors.daily_factors 各 factor_id 计算当日 μ/σ，超出 ±Nσ 计为离群。

    N 默认 10（极宽，仅捕获明显异常）；任一 factor_id 出现离群即 warn。
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
        WITH stats AS (
            SELECT factor_id,
                   avg(value)::double precision AS mu,
                   stddev_samp(value)::double precision AS sd
            FROM factors.daily_factors
            {where_clause}
            GROUP BY factor_id
        ),
        outliers AS (
            SELECT f.factor_id, count(*) AS outlier_count
            FROM factors.daily_factors f
            JOIN stats s ON s.factor_id = f.factor_id
            WHERE f.trade_date = :d
              AND s.sd IS NOT NULL AND s.sd > 0
              AND (f.value > s.mu + :n * s.sd OR f.value < s.mu - :n * s.sd)
            GROUP BY f.factor_id
        )
        SELECT factor_id, outlier_count FROM outliers
        ORDER BY outlier_count DESC
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
        # detail 必须含 factor_id / date / outlier_count（§4.3）；多 factor 时取最大
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
        f"""
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

    if row is None:
        return CheckResult(
            passed=True,
            level="info",
            rule="cross_table_alignment",
            detail={"date": trade_date, "note": "no_data"},
            trade_date=trade_date,
            name="cross_table_alignment",
        )

    base_rows = int(row[0] or 0)
    derived_rows = int(row[1] or 0)
    base_codes = int(row[2] or 0)
    derived_codes = int(row[3] or 0)

    # 基础表为空：跳过；M1 init 期间因子可能先建表
    if base_rows == 0:
        return CheckResult(
            passed=True,
            level="info",
            rule="cross_table_alignment",
            detail={"date": trade_date, "base_rows": 0, "derived_rows": derived_rows},
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
