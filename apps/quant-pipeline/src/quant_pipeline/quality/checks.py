"""八项数据质量检验（M1 Part E）。

规则名 / detail 字段名严格对齐 01-pg-schema.md §4.3；不允许自创规则名。

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

import logging
from collections.abc import Iterable
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
    detail = {
        "date": trade_date,
        "prev_count": prev_count,
        "curr_count": curr_count,
        "delta_ratio": round(delta_ratio, 6),
    }

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
    trade_date: str, original: float, relaxed: float
) -> CheckResult:
    """阈值临时放宽留痕（spec 04 §2 硬约束）。

    runner 在解析 params 发现阈值 > 默认 0.05 时调用此函数，
    与 check 结果一并 emit 到 ml.quality_reports（level='info'）。
    """

    return CheckResult(
        passed=False,  # 强制 emit；level=info 不算 critical
        level="info",
        rule="row_count_drift",
        detail={
            "date": trade_date,
            "event": "threshold_relaxed",
            "original_threshold": original,
            "relaxed_threshold": relaxed,
        },
        trade_date=trade_date,
        name="row_count_drift_relaxation",
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
