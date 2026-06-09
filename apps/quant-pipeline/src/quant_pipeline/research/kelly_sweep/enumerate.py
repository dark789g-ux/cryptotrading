"""信号枚举：给定 base 触发条件，扫描区间内每个 SSE 交易日，
产出满足条件且通过过滤的 (ts_code, signal_date, buy_date) 三元组。

口径对齐来源（逐条落源头）：
  - 交易日历：raw.trade_cal, exchange='SSE', is_open=1
    出处：apps/server/src/strategy-conditions/signal-stats/signal-stats.enumerator.ts:39-48
  - buy_date = signal_date 之后第一个 SSE 交易日（T+1）
    出处：signal-stats.enumerator.ts:109（sigIdx+1）
  - 次新过滤：buy_date 距 list_date 的 SSE 交易日数 < 60 → 剔除
    常量 NEW_LISTING_MIN_TRADING_DAYS = 60
    出处：signal-stats.simulator.ts:109
  - 停牌过滤：buy_date 在 raw.daily_quote 无行 / qfq_open 为空
    出处：signal-stats.simulator.ts:135-137
  - 一字涨停过滤：buy_date 未复权 open >= 未复权 up_limit（来自 raw.stk_limit）
    out处：signal-stats.simulator.ts:139-145
  - 停牌用「无 daily_quote 行」表示，不另查 suspend_d
    出处：signal-stats.simulator.ts:60-64（hasQuote = !!q && qfqOpen !== null && qfqClose !== null）

DB 样本核实（2026-06-09）：
  - raw.daily_indicator: 含 kdj_j, ma5, ma30, atr_14（真实列名，见 T5 口径核查）
  - raw.daily_quote: 含 qfq_open, open；停牌日无行
  - raw.stk_limit: 含 up_limit
  - a_share_symbols: 含 list_date, delist_date（character varying 类型）
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Literal, Optional

from sqlalchemy import text

from quant_pipeline.db.engine import get_engine
from quant_pipeline.research.kelly_sweep.config import SweepConfig
from quant_pipeline.research.kelly_sweep.types import BaseTrigger

logger = logging.getLogger(__name__)

# ── 常量（口径锚定：signal-stats.simulator.ts:109）───────────────────────────
NEW_LISTING_MIN_TRADING_DAYS: int = 60
"""次新过滤阈值：buy_date 距 list_date 的 SSE 交易日数严格小于此值则剔除。
出处：apps/server/src/strategy-conditions/signal-stats/signal-stats.simulator.ts:109"""

# ── 算子映射 ─────────────────────────────────────────────────────────────────
_OP_SQL: dict[str, str] = {
    "lt": "<",
    "lte": "<=",
    "gt": ">",
    "gte": ">=",
    "eq": "=",
    "neq": "!=",
}

# ── 允许的 daily_indicator 字段白名单（防 SQL 注入）────────────────────────────
# 字段名均已落真 DB 查询核实（2026-06-09）
_ALLOWED_INDICATOR_FIELDS: frozenset[str] = frozenset(
    [
        "kdj_k",
        "kdj_d",
        "kdj_j",
        "macd",
        "macd_dif",
        "macd_dea",
        "rsi_6",
        "rsi_12",
        "rsi_24",
        "cci",
        "dmi_pdi",
        "dmi_mdi",
        "dmi_adx",
        "dmi_adxr",
        "boll_upper",
        "boll_mid",
        "boll_lower",
        "ma5",
        "ma10",
        "ma20",
        "ma30",
        "ma60",
        "atr_14",
        "obv",
        "wr",
        "bias",
        "ema5",
        "ema10",
        "ema20",
    ]
)


@dataclass(frozen=True)
class SignalRecord:
    """一条买入信号。"""

    ts_code: str
    signal_date: str
    """触发日 T（YYYYMMDD）。"""
    buy_date: str
    """实际买入日 T+1（YYYYMMDD）。"""


def _build_trigger_clause(trigger: BaseTrigger) -> str:
    """把 BaseTrigger 转成参数化 SQL 片段。

    字段名经白名单校验，防 SQL 注入。
    值用占位符 :trigger_value。
    """
    if trigger.field not in _ALLOWED_INDICATOR_FIELDS:
        raise ValueError(
            f"trigger.field={trigger.field!r} 不在允许的 daily_indicator 字段白名单中"
        )
    op_sql = _OP_SQL.get(trigger.op)
    if op_sql is None:
        raise ValueError(f"未知 op={trigger.op!r}")
    return f"i.{trigger.field} {op_sql} :trigger_value"


def load_sse_calendar(date_start: str | None = None, date_end: str | None = None) -> list[str]:
    """从 raw.trade_cal 取 SSE 交易日历（升序 YYYYMMDD）。

    口径：exchange='SSE' AND is_open=1
    出处：signal-stats.enumerator.ts:39-48

    不传 date_start/date_end 则取全部（用于次新过滤的全局日历，
    对应 enumerator.ts:56-64 listAllSseTradingDays）。
    """
    conditions = ["exchange = 'SSE'", "is_open = 1"]
    params: dict[str, str] = {}
    if date_start is not None:
        conditions.append("cal_date >= :start")
        params["start"] = date_start
    if date_end is not None:
        conditions.append("cal_date <= :end")
        params["end"] = date_end

    where_clause = " AND ".join(conditions)
    sql = text(
        f"SELECT cal_date FROM raw.trade_cal WHERE {where_clause} ORDER BY cal_date"
    )
    engine = get_engine()
    with engine.connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [row[0] for row in rows]


def enumerate_signals(
    config: SweepConfig,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> list[SignalRecord]:
    """枚举 train+valid 区间内满足 base_trigger 且通过入场过滤的信号。

    步骤：
    1. 取全局 SSE 交易日历（次新过滤须用全局索引差）。
    2. 区间 = train_range[0] ~ valid_range[1]，逐日扫 raw.daily_indicator。
    3. 买入日过滤：停牌（daily_quote 无行或 qfq_open 为空）、一字涨停、次新。

    Args:
        config:       SweepConfig，包含 base_trigger / universe / train_range / valid_range。
        on_progress:  可选进度回调 `(done: int, total: int) -> None`；粗粒度，各过滤阶段完成后 emit。
                      默认 None → 不回调，对现有 CLI/单测路径零影响。

    Returns:
        满足过滤的 SignalRecord 列表（按 signal_date 升序，同日按 ts_code 升序）。
    """
    date_start = config.train_range[0]
    date_end = config.valid_range[1]

    logger.info(
        "enumerate_signals: base_trigger=%s, range=%s~%s, universe=%s",
        config.base_trigger,
        date_start,
        date_end,
        config.universe,
    )

    # 1. 全局 SSE 日历（用于 T+1 推进 + 次新过滤）
    all_calendar: list[str] = load_sse_calendar()
    cal_index: dict[str, int] = {d: i for i, d in enumerate(all_calendar)}

    # 2. 区间内 SSE 交易日（筛触发用）
    range_calendar: list[str] = [d for d in all_calendar if date_start <= d <= date_end]

    # 3. 批量预取 list_date（供次新过滤）
    symbol_map = _prefetch_symbol_map(config.universe)

    # 4. 预取买入日过滤数据（按信号日 → 找 buy_date，然后从 DB 取）
    # 为避免 N+1 查询，先枚举全部信号，再批量取 buy_date 的 quote 与 limit。
    raw_signals = _scan_indicator_signals(config.base_trigger, range_calendar, config.universe)
    logger.info("indicator 扫描完毕：%d 条原始信号", len(raw_signals))
    if on_progress is not None:
        on_progress(1, 3)  # 阶段 1/3：indicator 扫描完成

    # 5. 计算 buy_date（T+1），过滤越界信号
    with_buy_date: list[tuple[str, str, str]] = []  # (ts_code, signal_date, buy_date)
    for ts_code, signal_date in raw_signals:
        sig_idx = cal_index.get(signal_date)
        if sig_idx is None or sig_idx + 1 >= len(all_calendar):
            continue  # signal_date 不在日历 或 已是最后一天
        buy_date = all_calendar[sig_idx + 1]
        if buy_date > date_end:
            continue  # buy_date 超出区间
        with_buy_date.append((ts_code, signal_date, buy_date))

    logger.info("T+1 推进后：%d 条信号", len(with_buy_date))
    if on_progress is not None:
        on_progress(2, 3)  # 阶段 2/3：T+1 推进完成

    # 6. 批量取 buy_date 的 quote（停牌过滤）与 limit（一字涨停过滤）
    buy_dates_unique = list({bd for _, _, bd in with_buy_date})
    ts_codes_unique = list({c for c, _, _ in with_buy_date})

    quote_map = _fetch_buy_date_quotes(ts_codes_unique, buy_dates_unique)
    limit_map = _fetch_buy_date_limits(ts_codes_unique, buy_dates_unique)

    # 7. 逐条应用过滤
    results: list[SignalRecord] = []
    suspended_count = 0
    limit_up_count = 0
    new_listing_count = 0

    for ts_code, signal_date, buy_date in with_buy_date:
        key = (ts_code, buy_date)

        # 7a. 停牌过滤：buy_date 无 daily_quote 行 / qfq_open 为空
        # 口径：signal-stats.simulator.ts:135-137
        q = quote_map.get(key)
        if q is None or q[0] is None:  # q = (qfq_open, raw_open)
            suspended_count += 1
            continue

        qfq_open, raw_open = q

        # 7b. 一字涨停过滤：未复权 open >= 未复权 up_limit
        # 口径：signal-stats.simulator.ts:139-145
        up_limit = limit_map.get(key)
        if raw_open is not None and up_limit is not None and raw_open >= up_limit:
            limit_up_count += 1
            continue

        # 7c. 次新过滤：buy_date 距 list_date 的 SSE 交易日数 < 60
        # 口径：signal-stats.simulator.ts:146-150，常量值 60
        sym = symbol_map.get(ts_code)
        if sym is not None and sym["list_date"]:
            list_date = sym["list_date"]
            list_idx = cal_index.get(list_date)
            if list_idx is None:
                # list_date 不在日历：取 <= list_date 的最大日历位置
                list_idx = _find_last_index_le(all_calendar, list_date)
            buy_idx = cal_index.get(buy_date)
            if buy_idx is not None and list_idx >= 0:
                days_since_list = buy_idx - list_idx
                if days_since_list < NEW_LISTING_MIN_TRADING_DAYS:
                    new_listing_count += 1
                    continue

        results.append(SignalRecord(ts_code=ts_code, signal_date=signal_date, buy_date=buy_date))

    logger.info(
        "过滤后：%d 条信号（停牌=%d, 一字涨停=%d, 次新=%d）",
        len(results),
        suspended_count,
        limit_up_count,
        new_listing_count,
    )
    if on_progress is not None:
        on_progress(3, 3)  # 阶段 3/3：过滤完成
    return results


# ─────────────────────────────────────────────────────────────────────────────
# 内部辅助函数
# ─────────────────────────────────────────────────────────────────────────────


def _scan_indicator_signals(
    trigger: BaseTrigger,
    trading_days: list[str],
    universe: Literal["all"] | list[str],
) -> list[tuple[str, str]]:
    """扫 raw.daily_indicator，返回 (ts_code, trade_date) 列表（满足 trigger 的原始信号）。

    按交易日批次执行查询（每批 ≤ BATCH_SIZE 天），避免 ANY(array) 超大。
    universe='all' 全市场；list 时追加 ts_code = ANY(:codes)。
    """
    if not trading_days:
        return []

    BATCH_SIZE = 50  # 每批交易日数
    trigger_clause = _build_trigger_clause(trigger)
    engine = get_engine()
    results: list[tuple[str, str]] = []

    for batch_start in range(0, len(trading_days), BATCH_SIZE):
        batch_days = trading_days[batch_start : batch_start + BATCH_SIZE]

        if isinstance(universe, list) and len(universe) > 0:
            sql = text(
                f"""
                SELECT i.ts_code, i.trade_date
                  FROM raw.daily_indicator i
                 WHERE i.trade_date = ANY(:dates)
                   AND {trigger_clause}
                   AND i.ts_code = ANY(:codes)
                 ORDER BY i.trade_date, i.ts_code
                """
            )
            params: dict = {
                "dates": batch_days,
                "trigger_value": trigger.value,
                "codes": universe,
            }
        elif isinstance(universe, list) and len(universe) == 0:
            # 空列表 universe → 无信号
            continue
        else:
            sql = text(
                f"""
                SELECT i.ts_code, i.trade_date
                  FROM raw.daily_indicator i
                 WHERE i.trade_date = ANY(:dates)
                   AND {trigger_clause}
                 ORDER BY i.trade_date, i.ts_code
                """
            )
            params = {"dates": batch_days, "trigger_value": trigger.value}

        with engine.connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        results.extend((row[0], row[1]) for row in rows)

    return results


def _prefetch_symbol_map(
    universe: Literal["all"] | list[str],
) -> dict[str, dict[str, str | None]]:
    """预取 a_share_symbols 的 list_date / delist_date。

    口径：signal-stats.simulator.db.ts:183-199（prefetchSymbolMap）
    表名：public.a_share_symbols（真 DB 核实，2026-06-09）
    字段：ts_code, list_date, delist_date（character varying，空值为 None 或 ''）
    """
    engine = get_engine()
    if isinstance(universe, list):
        if not universe:
            return {}
        sql = text(
            "SELECT ts_code, list_date, delist_date FROM a_share_symbols"
            " WHERE ts_code = ANY(:codes)"
        )
        with engine.connect() as conn:
            rows = conn.execute(sql, {"codes": universe}).fetchall()
    else:
        sql = text("SELECT ts_code, list_date, delist_date FROM a_share_symbols")
        with engine.connect() as conn:
            rows = conn.execute(sql).fetchall()

    return {
        row[0]: {
            "list_date": row[1] or None,
            "delist_date": row[2] or None,
        }
        for row in rows
    }


def _fetch_buy_date_quotes(
    ts_codes: list[str],
    buy_dates: list[str],
) -> dict[tuple[str, str], tuple[float | None, float | None]]:
    """批量取 buy_date 的 qfq_open（停牌判定）和 open（一字涨停判定）。

    key = (ts_code, trade_date)；停牌日无行 → key 不在 map 中。
    口径：
      - qfq_open 为空 → 停牌（signal-stats.simulator.ts:135-137）
      - open（未复权）用于一字涨停判定（signal-stats.simulator.ts:69）
    真 DB 核实列名（2026-06-09）：raw.daily_quote(qfq_open, open)
    """
    if not ts_codes or not buy_dates:
        return {}

    engine = get_engine()
    sql = text(
        """
        SELECT ts_code, trade_date, qfq_open, open
          FROM raw.daily_quote
         WHERE ts_code = ANY(:codes)
           AND trade_date = ANY(:dates)
        """
    )
    with engine.connect() as conn:
        rows = conn.execute(sql, {"codes": ts_codes, "dates": buy_dates}).fetchall()

    result: dict[tuple[str, str], tuple[float | None, float | None]] = {}
    for row in rows:
        ts_code, trade_date, qfq_open, raw_open = row
        qfq_open_f = float(qfq_open) if qfq_open is not None else None
        raw_open_f = float(raw_open) if raw_open is not None else None
        result[(ts_code, trade_date)] = (qfq_open_f, raw_open_f)

    return result


def _fetch_buy_date_limits(
    ts_codes: list[str],
    buy_dates: list[str],
) -> dict[tuple[str, str], float | None]:
    """批量取 buy_date 的 up_limit（未复权涨停价）。

    口径：signal-stats.simulator.db.ts:223-234（fetchLimits）
    真 DB 核实列名（2026-06-09）：raw.stk_limit(ts_code, trade_date, up_limit)
    缺失日 → key 不在 map 中（None）。
    """
    if not ts_codes or not buy_dates:
        return {}

    engine = get_engine()
    sql = text(
        """
        SELECT ts_code, trade_date, up_limit
          FROM raw.stk_limit
         WHERE ts_code = ANY(:codes)
           AND trade_date = ANY(:dates)
        """
    )
    with engine.connect() as conn:
        rows = conn.execute(sql, {"codes": ts_codes, "dates": buy_dates}).fetchall()

    return {
        (row[0], row[1]): float(row[2]) if row[2] is not None else None
        for row in rows
    }


def _find_last_index_le(sorted_asc: list[str], target: str) -> int:
    """升序列表中 <= target 的最大元素下标；找不到返回 -1。

    口径：signal-stats.simulator.ts:339-352（findLastIndexLE）
    """
    lo, hi, ans = 0, len(sorted_asc) - 1, -1
    while lo <= hi:
        mid = (lo + hi) >> 1
        if sorted_asc[mid] <= target:
            ans = mid
            lo = mid + 1
        else:
            hi = mid - 1
    return ans
