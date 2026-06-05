"""labels / features 增量物化底座（P1）。

提供两类物化（`factors.labels` / `factors.feature_matrix`）共用的纯函数与 DB
helper，供后续 P2(labels) / P3(features) runner 复用：

- :func:`gap_subranges`     —— 已物化集合 vs 交易日列表 → 缺口连续子区间
- :func:`coverage_ranges`   —— 已物化集合 → 已覆盖连续区间段（训练校验 / 前端展示）
- :func:`query_materialized_dates` —— 查结果表已物化的 `DISTINCT trade_date` 集合
- :func:`query_trading_days`       —— 从 ``raw.trade_cal`` 取 ``is_open=1`` 升序交易日

设计依据见 spec
``docs/superpowers/specs/2026-06-06-labels-features-incremental-prepare-design/
02-incremental-algorithm.md`` 的「共用基础：覆盖区间 / 缺口查询」节。

**"连续"语义**：均以 ``trading_days`` 序列里的**相邻位置**判定，而非自然日相邻
（节假日/周末导致的自然日跳变不算空洞）。``trade_date`` 为 Tushare YYYYMMDD
定宽字符串（``char(8)``），字典序即时序，可直接做字符串比较。
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

# ----------------------------------------------------------------------
# 纯函数：缺口 / 覆盖区间
# ----------------------------------------------------------------------


def gap_subranges(
    materialized_dates: set[str],
    trading_days: list[str],
) -> list[tuple[str, str]]:
    """把"未物化的交易日"按交易日相邻切成连续子区间。

    Args:
        materialized_dates: 已物化的 ``trade_date`` 集合（来自结果表
            ``DISTINCT trade_date``）。允许含 ``trading_days`` 之外的日期，
            会被忽略。
        trading_days: ``[start, end]`` 内 ``is_open=1`` 的交易日**升序**列表。

    Returns:
        缺口的连续子区间列表 ``[(g0, g1), ...]``，按时间升序、互不相邻。
        "连续" = 在 ``trading_days`` 序列里位置相邻（不是自然日相邻）。
        无缺口（全部已物化）返回 ``[]``。

    Examples:
        >>> gap_subranges({"20260102"}, ["20260102", "20260105", "20260106"])
        [('20260105', '20260106')]
    """

    ranges: list[tuple[str, str]] = []
    run_start: str | None = None
    prev: str | None = None
    for day in trading_days:
        if day in materialized_dates:
            # 命中已物化 → 当前缺口段（若有）在前一交易日处闭合
            if run_start is not None:
                ranges.append((run_start, prev))  # type: ignore[arg-type]
                run_start = None
        else:
            # 未物化 → 开启或延续缺口段
            if run_start is None:
                run_start = day
        prev = day
    if run_start is not None:
        ranges.append((run_start, prev))  # type: ignore[arg-type]
    return ranges


def coverage_ranges(
    materialized_dates: set[str],
    trading_days: list[str],
) -> list[tuple[str, str]]:
    """把"已物化的交易日"按交易日相邻切成连续覆盖段。

    与 :func:`gap_subranges` 对偶：返回已覆盖的连续区间段，供训练前覆盖校验、
    前端展示覆盖区间与空洞（段与段之间的间隙即空洞）。

    Args:
        materialized_dates: 已物化的 ``trade_date`` 集合。``trading_days`` 之外
            的日期会被忽略（只在 ``trading_days`` 框定的范围内判定覆盖）。
        trading_days: ``[start, end]`` 内 ``is_open=1`` 的交易日**升序**列表。

    Returns:
        已覆盖的连续区间段 ``[(s, e), ...]``，按时间升序、互不相邻。
        无覆盖（空集）返回 ``[]``。

    Examples:
        >>> coverage_ranges(
        ...     {"20260102", "20260106"},
        ...     ["20260102", "20260105", "20260106"],
        ... )
        [('20260102', '20260102'), ('20260106', '20260106')]
    """

    ranges: list[tuple[str, str]] = []
    run_start: str | None = None
    prev: str | None = None
    for day in trading_days:
        if day in materialized_dates:
            # 命中已物化 → 开启或延续覆盖段
            if run_start is None:
                run_start = day
        else:
            # 未物化 → 当前覆盖段（若有）在前一交易日处闭合
            if run_start is not None:
                ranges.append((run_start, prev))  # type: ignore[arg-type]
                run_start = None
        prev = day
    if run_start is not None:
        ranges.append((run_start, prev))  # type: ignore[arg-type]
    return ranges


# ----------------------------------------------------------------------
# DB helper
# ----------------------------------------------------------------------

# table → 合法 key_col 白名单。table / key_col **绝不**来自用户输入，仅由 P2/P3
# runner 以代码常量传入；此处白名单是防御性二道闸（杜绝任何路径下的 SQL 注入），
# 命中后才做 literal 字符串拼接进 SQL（标识符无法用绑定参数）。
_MATERIALIZED_TABLES: dict[str, set[str]] = {
    "factors.labels": {"scheme"},
    "factors.feature_matrix": {"feature_set_id"},
}


def query_materialized_dates(
    session: Session,
    table: str,
    key_col: str,
    key_val: str,
    start: str,
    end: str,
) -> set[str]:
    """查结果表中 ``[start, end]`` 内某键已物化的 ``DISTINCT trade_date`` 集合。

    走现成索引（``ix_factors_labels_scheme_date`` /
    ``ix_factors_feature_matrix_set_date``）；``DISTINCT trade_date`` 基数 = 交易
    日数（几百上千），即便每日数千标的也只回几百行。

    Args:
        session: 调用方持有的 SQLAlchemy ``Session``（事务边界由调用方管理）。
        table: 结果表全名，必须 ∈ ``{"factors.labels", "factors.feature_matrix"}``。
        key_col: 过滤键列名，须在该 ``table`` 的白名单内
            （labels→``scheme`` / feature_matrix→``feature_set_id``）。
        key_val: 键值（``scheme`` 或 ``feature_set_id``）；走绑定参数，安全。
        start: 区间起 ``YYYYMMDD``（含）。
        end: 区间止 ``YYYYMMDD``（含）。

    Returns:
        已物化的 ``trade_date`` 字符串集合。

    Raises:
        ValueError: ``table`` 不在白名单，或 ``key_col`` 与该 ``table`` 不匹配。
            （table / key_col 应是 runner 代码常量；命中此异常说明调用方写错。）
    """

    allowed_cols = _MATERIALIZED_TABLES.get(table)
    if allowed_cols is None:
        raise ValueError(
            f"query_materialized_dates: 非法 table={table!r}，"
            f"仅允许 {sorted(_MATERIALIZED_TABLES)}"
        )
    if key_col not in allowed_cols:
        raise ValueError(
            f"query_materialized_dates: table={table!r} 不允许 key_col={key_col!r}，"
            f"仅允许 {sorted(allowed_cols)}"
        )

    # table / key_col 已过白名单校验（仅取自上方常量字典的 key），可安全 literal
    # 拼接——SQL 标识符（表名 / 列名）无法用绑定参数；key_val / start / end 全部
    # 走绑定参数。
    sql = text(
        f"""
        SELECT DISTINCT trade_date
        FROM {table}
        WHERE {key_col} = :k
          AND trade_date BETWEEN :start AND :end
        """
    )
    rows = session.execute(sql, {"k": key_val, "start": start, "end": end}).fetchall()
    return {str(r[0]) for r in rows}


def query_trading_days(
    session: Session,
    start: str,
    end: str,
    exchange: str = "SSE",
) -> list[str]:
    """从 ``raw.trade_cal`` 取 ``[start, end]`` 内 ``is_open=1`` 的交易日升序列表。

    spec 02「步骤 1」要求 ``trading_days`` 取自 ``trade_cal`` 的开市日历（而非
    ``raw.daily_quote`` 的实际报价日）——增量缺口须以"应有的交易日"为基准判定，
    否则全市场零成交日会被误判为"无需物化"。现有 ``factors.data_access`` 只有
    ``count_trade_days_in_window`` / ``trade_cal_covers`` / cli ``trade_cal offset``，
    无"取区间升序交易日列表"helper，故此处新增。

    Args:
        session: 调用方持有的 SQLAlchemy ``Session``。
        start: 区间起 ``YYYYMMDD``（含）。
        end: 区间止 ``YYYYMMDD``（含）。
        exchange: 交易所代码，默认 ``SSE``。

    Returns:
        ``is_open=1`` 的 ``cal_date`` 升序列表（``YYYYMMDD`` 字符串）。

    Note:
        ``cal_date`` 为 Tushare YYYYMMDD 定宽字符串，字典序即时序。
    """

    sql = text(
        """
        SELECT cal_date FROM raw.trade_cal
        WHERE exchange = :ex AND is_open = 1
          AND cal_date BETWEEN :start AND :end
        ORDER BY cal_date
        """
    )
    rows = session.execute(
        sql, {"ex": exchange, "start": start, "end": end}
    ).fetchall()
    return [str(r[0]) for r in rows]


__all__ = [
    "gap_subranges",
    "coverage_ranges",
    "query_materialized_dates",
    "query_trading_days",
]
