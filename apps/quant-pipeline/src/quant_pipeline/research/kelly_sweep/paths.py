"""前向路径加载：按信号列表取 buy_date 起的 qfq O/H/L/C 序列，带 parquet 缓存。

口径对齐来源（逐条落源头）：
  - 停牌日跳过：raw.daily_quote 无行 / qfq_open 或 qfq_close 为空 → 不占 max_window 额度
    出处：signal-stats.simulator.ts:239（停牌日 hasQuote=false 跳过，不计 holdDays/额度）
  - buy_price = buy_date 的 qfq_open
    出处：signal-stats.simulator.ts:154（buyPrice = buyDay.qfqOpen）
  - 前向路径字段：qfq_open/qfq_high/qfq_low/qfq_close
    真 DB 核实（2026-06-09）：raw.daily_quote 含此四列
  - delist_date 来源：a_share_symbols.delist_date（character varying，空字符串表示未退市）
    真 DB 核实（2026-06-09）：psql 'backslash-d a_share_symbols'
  - atr14_at_signal：raw.daily_indicator.atr_14，基于前复权价计算
    真 DB 核实（2026-06-09）：ma5 与 qfq_close 对齐，可推断 atr_14 同口径

ma5/ma30/atr_14 复权口径确认（2026-06-09 DB 样本）：
  600519.SH 20240102: close=1685.01, qfq_close=1567.55, ma5=1576.48
  ma5 与 qfq_close 数量级一致（非原始价 1685），确认 raw.daily_indicator 的 ma*/atr_14
  均基于前复权（qfq）价计算。
  dev_ma 计算时应使用 qfq_close / ma - 1，atr_14 单位为前复权元/点。
"""

from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
from typing import Optional

import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import get_engine
from quant_pipeline.research.kelly_sweep.enumerate import (
    SignalRecord,
    _find_last_index_le,
    load_sse_calendar,
)
from quant_pipeline.research.kelly_sweep.types import Bar, ForwardPath

logger = logging.getLogger(__name__)

# 缓存目录（优先取 CACHE_DIR 环境变量，否则 cwd/cache/kelly_sweep）
_DEFAULT_CACHE_SUBDIR = "cache/kelly_sweep"


def _cache_root() -> Path:
    env = os.environ.get("CACHE_DIR", "").strip()
    if env:
        return Path(env).resolve()
    return (Path.cwd() / _DEFAULT_CACHE_SUBDIR).resolve()


def _parquet_cache_path(cache_key: str) -> Path:
    """构造 parquet 缓存文件路径。cache_key 为 sha256 截断 16 位。"""
    short = cache_key[:16]
    root = _cache_root()
    root.mkdir(parents=True, exist_ok=True)
    return root / f"paths_{short}.parquet"


# bars 语义版本：bars 改为「buy_date 之后第一个可交易日起」（不含 buy_date 当日）。
# 任何会改变缓存内容含义的口径调整都应 bump 此字面量，使旧缓存自动失效。
_CACHE_SEMANTIC_VERSION = "v2_bars_after_buy"


def _make_cache_key(
    signals: list[SignalRecord],
    max_window: int,
    date_end: str,
) -> str:
    """缓存 key：sha256(语义版本 + 信号列表内容 + max_window + date_end)。

    信号列表内容 = 排序后的 (ts_code, signal_date, buy_date) 三元组序列。
    语义版本 = _CACHE_SEMANTIC_VERSION；bars 口径变更后 bump 它即可自动失效旧缓存。
    """
    sorted_sigs = sorted(
        (f"{s.ts_code}|{s.signal_date}|{s.buy_date}" for s in signals)
    )
    blob = (
        f"version={_CACHE_SEMANTIC_VERSION}\n"
        + "\n".join(sorted_sigs)
        + f"\nmax_window={max_window}\ndate_end={date_end}"
    )
    return hashlib.sha256(blob.encode()).hexdigest()


def load_forward_paths(
    signals: list[SignalRecord],
    max_window: int,
    date_end: str,
    use_cache: bool = True,
) -> list[ForwardPath]:
    """取每个信号 buy_date **之后**第一个可交易日起未来 ≤max_window 个可交易日的 qfq 路径。

    bars 口径（v2，对齐 NestJS fixed_n）：
      - bars[0] = buy_date **之后**第一个可交易日（**不含 buy_date 当日**），按时间升序。
      - 停牌日（raw.daily_quote 无行或 qfq_open/qfq_close 为空）跳过，不占 max_window 额度。
        口径：signal-stats.simulator.ts:239
      - NestJS fixed_n(N) 锚点：买在 open(buy_date)、第 N 个出场日 = buy_date 之后第 N 个
        可交易日的 qfq_close。证据 signal_test_trade run 06239e89：signal 20230206 →
        buy_date 20230207 → exit_date 20230208（hold_days=1），即卖在 buy_date 之后第一个
        可交易日的 close，而非 buy_date 当日。故 bars 不含 buy_date，exits.py 的
        bars[0] 即对应 NestJS 的第 1 个持有日，逻辑透明。
      - buy_date 之后无可交易日（数据边界）→ bars 为空 → 该信号无法成交，按「空 bars」
        过滤（与 NestJS 尾部 insufficient_data 一致）。

    buy_price = buy_date 当日的 qfq_open（口径：simulator.ts:154）。注意 buy_date 现在
      **不在 bars 里**，须单独取其 qfq_open。
    delist_date 来自 a_share_symbols.delist_date（口径：simulator.db.ts:183-199）。
    atr14_at_signal = signal_date 的 raw.daily_indicator.atr_14（前复权口径，见模块 docstring）。

    Args:
        signals: enumerate_signals 产出的信号列表。
        max_window: 前向最长可交易日数（停牌日不计；从 buy_date 之后第一个可交易日起算）。
        date_end: 路径数据截止日（YYYYMMDD），通常为 valid_range[1]。
        use_cache: 是否使用 parquet 缓存（默认 True）。

    Returns:
        ForwardPath 列表（过滤 buy_date 当日无 qfq_open、或 buy_date 之后无可交易日的条目）。
    """
    if not signals:
        return []

    # 缓存
    cache_key = _make_cache_key(signals, max_window, date_end)
    cache_path = _parquet_cache_path(cache_key)

    if use_cache and cache_path.exists():
        logger.info("load_forward_paths: 命中缓存 %s", cache_path)
        return _load_paths_from_parquet(cache_path)

    logger.info(
        "load_forward_paths: %d 信号, max_window=%d, date_end=%s",
        len(signals),
        max_window,
        date_end,
    )

    # 全局 SSE 日历（用于窗口推进）
    all_calendar = load_sse_calendar(date_end=date_end)
    cal_index = {d: i for i, d in enumerate(all_calendar)}

    # 按 ts_code 分组，批量预取数据
    groups: dict[str, list[SignalRecord]] = {}
    for sig in signals:
        groups.setdefault(sig.ts_code, []).append(sig)

    ts_codes = list(groups.keys())

    # 预取 symbol 元数据（delist_date）
    symbol_map = _prefetch_symbol_meta(ts_codes)

    # 预取 atr_14（按 ts_code + signal_date）
    atr_map = _prefetch_atr14(signals)

    # 预取每个 ts_code 在其联合窗口内的 quote 数据
    result_paths: list[ForwardPath] = []
    skipped = 0

    for ts_code, group_signals in groups.items():
        sym = symbol_map.get(ts_code)
        delist_date: str | None = sym.get("delist_date") if sym else None

        # 计算该组所有信号覆盖的日期范围（unionWindow）
        min_buy_date = min(sig.buy_date for sig in group_signals)
        union_window_start_idx = cal_index.get(min_buy_date)
        if union_window_start_idx is None:
            union_window_start_idx = _find_last_index_le(all_calendar, min_buy_date)
        if union_window_start_idx < 0:
            skipped += len(group_signals)
            continue

        # 取 buy_date 起直到 date_end 的全部日历日作为 union_dates（口径：simulator.db.ts:131
        # sseCalendar.slice(minBuyIdx).filter(d <= dateEnd)），不设 max_window*3 上界。
        # 去掉 ×3 截断后，即使停牌密集或信号 buy_date 离散，也能凑满 max_window 个可交易日。
        union_dates = [d for d in all_calendar[union_window_start_idx:] if d <= date_end]

        if not union_dates:
            skipped += len(group_signals)
            continue

        # 一次性预取该 ts_code 在 union_dates 内的 quote
        quote_map = _fetch_quotes_for_ts(ts_code, union_dates)

        # 为每个信号构建 ForwardPath
        for sig in group_signals:
            buy_idx = cal_index.get(sig.buy_date)
            if buy_idx is None:
                skipped += 1
                continue

            # buy_price = buy_date 当日的 qfq_open（buy_date 不进 bars，须单独取）。
            # 口径：signal-stats.simulator.ts:154。buy_date 行情已在 quote_map 内（union
            # 从 min_buy_date 起预取）。buy_date 当日停牌/无 qfq_open → 无法成交，跳过。
            buy_q = quote_map.get(sig.buy_date)
            if buy_q is None or buy_q[0] is None:
                skipped += 1
                continue
            buy_price = buy_q[0]

            # bars 从 buy_date **之后**第一个可交易日起收集 ≤max_window 个有效可交易日
            # （不含 buy_date 当日）。口径对齐 NestJS fixed_n（见 docstring）。
            bars: list[Bar] = []
            tradable_count = 0

            for d in all_calendar[buy_idx + 1:]:
                if d > date_end:
                    break
                if tradable_count >= max_window:
                    break
                q = quote_map.get(d)
                if q is None:
                    # 停牌日：无 daily_quote 行，跳过、不占额度
                    # 口径：signal-stats.simulator.ts:239
                    continue
                qfq_open, qfq_high, qfq_low, qfq_close = q
                if qfq_open is None or qfq_close is None:
                    # qfq 价为空 → 视为停牌，跳过
                    continue
                bars.append(
                    Bar(
                        trade_date=d,
                        qfq_open=qfq_open,
                        qfq_high=qfq_high if qfq_high is not None else qfq_open,
                        qfq_low=qfq_low if qfq_low is not None else qfq_open,
                        qfq_close=qfq_close,
                    )
                )
                tradable_count += 1

            if not bars:
                # buy_date 之后无可交易日（数据边界）→ 无法成交，与 NestJS 尾部
                # insufficient_data 一致，过滤掉。
                skipped += 1
                continue

            result_paths.append(
                ForwardPath(
                    ts_code=ts_code,
                    signal_date=sig.signal_date,
                    buy_date=sig.buy_date,
                    buy_price=buy_price,
                    bars=bars,
                    delist_date=delist_date or None,
                    atr14_at_signal=atr_map.get((ts_code, sig.signal_date)),
                )
            )

    logger.info(
        "load_forward_paths 完成：%d 路径，跳过 %d 条",
        len(result_paths),
        skipped,
    )

    if use_cache:
        _save_paths_to_parquet(result_paths, cache_path)

    return result_paths


# ─────────────────────────────────────────────────────────────────────────────
# 附加 loaders（供 T4/T6 使用）
# ─────────────────────────────────────────────────────────────────────────────


def load_feature_inputs(
    signals: list[SignalRecord],
    history_window: int = 20,
) -> tuple[pd.DataFrame, dict[tuple[str, str], pd.DataFrame]]:
    """取各信号 signal_date 的截面特征及历史窗口数据（供 T4 入场特征计算）。

    返回值是一个二元组 (cross_section_df, history_map)，二者契约如下：

    cross_section_df — signal_date 单日截面，列：
        ts_code (str), signal_date (str), qfq_close (float), ma5 (float),
        ma30 (float), atr_14 (float), kdj_j (float), vol (float)
      - 每行对应一个 (ts_code, signal_date) 组合（唯一）。
      - 仅包含 raw.daily_indicator 有记录的组合（无记录的信号行被自然滤掉）。

    history_map — 键：(ts_code, signal_date)，值：DataFrame
        截至 signal_date（含）最近 history_window 个**可交易日**的历史序列，列：
          trade_date (str), qfq_pct_chg (float), vol (float)
        按 trade_date 升序排列，停牌日（无 raw.daily_quote 行）已剔除。
        实际长度 ≤ history_window（数据起始前可能不足 history_window 行）。
      - 用途：
          down_streak：T4 调 entry_features.down_streak(row['qfq_pct_chg']) 计算连续阴线数；
                       可识别的连阴上限受 history_window 约束。
          vol_contract：T4 调 entry_features.vol_contract(row['vol']) 计算缩量比；
                        vol_contract 需至少 6 行（1 当日 + 5 历史），不足时返回 NaN。
      - 若某 (ts_code, signal_date) 无历史数据，映射中无此键（不放空 DataFrame 占位）。

    复权口径（见模块 docstring）：
      - qfq_close/ma5/ma30/atr_14 均基于前复权，dev_ma = qfq_close/ma30 - 1 可直接用。
      - qfq_pct_chg/vol 均来自 raw.daily_quote，qfq_pct_chg 为前复权涨跌幅（%），
        vol 为原始成交量（手/100股，非复权），vol_contract 用比值，对复权不敏感。

    Args:
        signals:        enumerate_signals 产出的信号列表。
        history_window: 每个信号向前回看的最大可交易日数（默认 20）。
                        down_streak 可识别的连阴上限由此决定；vol_contract 需 ≥ 6。
    """
    if not signals:
        cross = pd.DataFrame(
            columns=["ts_code", "signal_date", "qfq_close", "ma5", "ma30", "atr_14", "kdj_j", "vol"]
        )
        return cross, {}

    ts_codes = list({s.ts_code for s in signals})
    signal_dates = list({s.signal_date for s in signals})

    engine = get_engine()

    # ── 1. signal_date 截面：indicator + quote ────────────────────────────────
    sql_cross = text(
        """
        SELECT i.ts_code,
               i.trade_date  AS signal_date,
               q.qfq_close,
               i.ma5,
               i.ma30,
               i.atr_14,
               i.kdj_j,
               q.vol
          FROM raw.daily_indicator i
          LEFT JOIN raw.daily_quote q
            ON q.ts_code = i.ts_code AND q.trade_date = i.trade_date
         WHERE i.ts_code  = ANY(:codes)
           AND i.trade_date = ANY(:dates)
        """
    )
    with engine.connect() as conn:
        rows = conn.execute(sql_cross, {"codes": ts_codes, "dates": signal_dates}).fetchall()

    cross_df = pd.DataFrame(
        rows, columns=["ts_code", "signal_date", "qfq_close", "ma5", "ma30", "atr_14", "kdj_j", "vol"]
    )
    for col in ["qfq_close", "ma5", "ma30", "atr_14", "kdj_j", "vol"]:
        cross_df[col] = pd.to_numeric(cross_df[col], errors="coerce")

    # ── 2. 历史窗口：按 ts_code 分组批量预取 ─────────────────────────────────
    # 取「截至 signal_date 最近 history_window 个可交易日」的 qfq_pct_chg 和 vol。
    # 批量策略：对每只 ts_code，取该标的所有 signal_date 中最早的那个作下界粗算，
    # 然后一次性取出足量历史，在内存中为每个 (ts_code, signal_date) 切窗。

    # 按 ts_code 分组信号
    groups_sig: dict[str, list[str]] = {}
    for s in signals:
        groups_sig.setdefault(s.ts_code, []).append(s.signal_date)

    history_map: dict[tuple[str, str], pd.DataFrame] = {}

    # 一次 SQL 取出所有 ts_code 的历史，用 ROW_NUMBER() 窗口函数取截至每个 signal_date
    # 最近 history_window 行；直接用一次批量查询避免 N 次往返。
    #
    # 方法：对每个 (ts_code, signal_date) 组合，取 trade_date <= signal_date 的最近
    # history_window 行。用 LATERAL + ROW_NUMBER 实现。
    # 但 LATERAL 需逐 (ts_code, signal_date) 枚举；signal_date 数量有限，
    # 构造 VALUES 表即可。
    pairs = list({(s.ts_code, s.signal_date) for s in signals})

    # 构造 VALUES 参数：(:ts_code_0, :sig_date_0), ...
    # 用单次 SQL 批量拿所有历史，然后在 Python 端切窗
    sql_hist = text(
        """
        WITH pairs(ts_code, signal_date) AS (
            SELECT unnest(CAST(:pair_codes AS text[])), unnest(CAST(:pair_dates AS text[]))
        ),
        ranked AS (
            SELECT q.ts_code,
                   q.trade_date,
                   q.qfq_pct_chg,
                   q.vol,
                   p.signal_date,
                   ROW_NUMBER() OVER (
                       PARTITION BY q.ts_code, p.signal_date
                       ORDER BY q.trade_date DESC
                   ) AS rn
              FROM raw.daily_quote q
              JOIN pairs p
                ON q.ts_code = p.ts_code
               AND q.trade_date <= p.signal_date
             WHERE q.ts_code = ANY(:codes)
               AND q.qfq_pct_chg IS NOT NULL
        )
        SELECT ts_code, signal_date, trade_date, qfq_pct_chg, vol
          FROM ranked
         WHERE rn <= :hw
         ORDER BY ts_code, signal_date, trade_date
        """
    )
    pair_codes = [p[0] for p in pairs]
    pair_dates = [p[1] for p in pairs]

    with engine.connect() as conn:
        hist_rows = conn.execute(
            sql_hist,
            {
                "pair_codes": pair_codes,
                "pair_dates": pair_dates,
                "codes": ts_codes,
                "hw": history_window,
            },
        ).fetchall()

    hist_df = pd.DataFrame(
        hist_rows, columns=["ts_code", "signal_date", "trade_date", "qfq_pct_chg", "vol"]
    )
    for col in ["qfq_pct_chg", "vol"]:
        hist_df[col] = pd.to_numeric(hist_df[col], errors="coerce")

    # 切窗：按 (ts_code, signal_date) 分组，保留 trade_date 升序
    for (ts_code, signal_date), grp in hist_df.groupby(
        ["ts_code", "signal_date"], sort=False
    ):
        window = grp[["trade_date", "qfq_pct_chg", "vol"]].sort_values("trade_date").reset_index(drop=True)
        if not window.empty:
            history_map[(ts_code, signal_date)] = window

    return cross_df, history_map


def load_index_daily(codes: list[str], date_range: tuple[str, str]) -> pd.DataFrame:
    """取 public.ths_index_daily_quotes 的日线数据。

    真 DB 核实列名（2026-06-09）：ts_code, trade_date, open, high, low, close, pct_change
    出处：psql 'backslash-d public.ths_index_daily_quotes'（2026-06-09 查得）

    Args:
        codes: 指数代码列表，如 ['883300.TI', '883304.TI']。
        date_range: (start, end) YYYYMMDD，含两端。
    """
    if not codes:
        return pd.DataFrame(
            columns=["ts_code", "trade_date", "open", "high", "low", "close", "pct_change"]
        )

    engine = get_engine()
    sql = text(
        """
        SELECT ts_code, trade_date, open, high, low, close, pct_change
          FROM public.ths_index_daily_quotes
         WHERE ts_code = ANY(:codes)
           AND trade_date BETWEEN :start AND :end
         ORDER BY ts_code, trade_date
        """
    )
    with engine.connect() as conn:
        rows = conn.execute(
            sql, {"codes": codes, "start": date_range[0], "end": date_range[1]}
        ).fetchall()

    cols = ["ts_code", "trade_date", "open", "high", "low", "close", "pct_change"]
    df = pd.DataFrame(rows, columns=cols)
    for col in ["open", "high", "low", "close", "pct_change"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def load_member_map() -> pd.DataFrame:
    """取 public.ths_member_stocks 全表（个股→行业指数映射）。

    真 DB 核实列名（2026-06-09）：ts_code（指数）, con_code（个股）, con_name, is_new
    出处：psql 'backslash-d public.ths_member_stocks'（2026-06-09 查得）
    """
    engine = get_engine()
    sql = text(
        "SELECT ts_code, con_code, con_name, is_new FROM public.ths_member_stocks"
    )
    with engine.connect() as conn:
        rows = conn.execute(sql).fetchall()
    return pd.DataFrame(rows, columns=["ts_code", "con_code", "con_name", "is_new"])


# ─────────────────────────────────────────────────────────────────────────────
# parquet 缓存 I/O
# ─────────────────────────────────────────────────────────────────────────────


def _save_paths_to_parquet(paths: list[ForwardPath], cache_path: Path) -> None:
    """把 ForwardPath 列表序列化为 parquet（扁平化 bars）。

    每行 = 一个 (signal, bar) 对；ForwardPath 的标量字段重复存储（冗余换查询方便）。
    """
    rows = []
    for fp in paths:
        for i, bar in enumerate(fp.bars):
            rows.append(
                {
                    "ts_code": fp.ts_code,
                    "signal_date": fp.signal_date,
                    "buy_date": fp.buy_date,
                    "buy_price": fp.buy_price,
                    "delist_date": fp.delist_date,
                    "atr14_at_signal": fp.atr14_at_signal,
                    "bar_index": i,
                    "trade_date": bar.trade_date,
                    "qfq_open": bar.qfq_open,
                    "qfq_high": bar.qfq_high,
                    "qfq_low": bar.qfq_low,
                    "qfq_close": bar.qfq_close,
                }
            )
    if not rows:
        return
    df = pd.DataFrame(rows)
    df.to_parquet(cache_path, index=False)
    logger.info("paths 缓存已写入 %s（%d 行）", cache_path, len(rows))


def _load_paths_from_parquet(cache_path: Path) -> list[ForwardPath]:
    """从 parquet 缓存还原 ForwardPath 列表。"""
    df = pd.read_parquet(cache_path)
    if df.empty:
        return []

    paths: list[ForwardPath] = []
    grouped = df.groupby(["ts_code", "signal_date", "buy_date"], sort=False)
    for (ts_code, signal_date, buy_date), grp in grouped:
        grp = grp.sort_values("bar_index")
        first = grp.iloc[0]
        bars = [
            Bar(
                trade_date=row["trade_date"],
                qfq_open=float(row["qfq_open"]),
                qfq_high=float(row["qfq_high"]),
                qfq_low=float(row["qfq_low"]),
                qfq_close=float(row["qfq_close"]),
            )
            for _, row in grp.iterrows()
        ]
        paths.append(
            ForwardPath(
                ts_code=ts_code,
                signal_date=signal_date,
                buy_date=buy_date,
                buy_price=float(first["buy_price"]),
                bars=bars,
                delist_date=first["delist_date"] if pd.notna(first["delist_date"]) else None,
                atr14_at_signal=(
                    float(first["atr14_at_signal"])
                    if pd.notna(first["atr14_at_signal"])
                    else None
                ),
            )
        )
    return paths


# ─────────────────────────────────────────────────────────────────────────────
# 内部 DB 辅助
# ─────────────────────────────────────────────────────────────────────────────


def _prefetch_symbol_meta(ts_codes: list[str]) -> dict[str, dict[str, Optional[str]]]:
    """批量取 a_share_symbols.delist_date。
    口径：signal-stats.simulator.db.ts:183-199；空字符串 → None。
    """
    if not ts_codes:
        return {}
    engine = get_engine()
    sql = text("SELECT ts_code, delist_date FROM a_share_symbols WHERE ts_code = ANY(:codes)")
    with engine.connect() as conn:
        rows = conn.execute(sql, {"codes": ts_codes}).fetchall()
    return {row[0]: {"delist_date": row[1] or None} for row in rows}


def _fetch_quotes_for_ts(
    ts_code: str,
    dates: list[str],
) -> dict[str, tuple[float | None, float | None, float | None, float | None]]:
    """取某标的在指定日期集合内的 qfq_open/high/low/close。

    key = trade_date；停牌日无行，不在 map 中。
    """
    if not dates:
        return {}
    engine = get_engine()
    sql = text(
        """
        SELECT trade_date, qfq_open, qfq_high, qfq_low, qfq_close
          FROM raw.daily_quote
         WHERE ts_code = :ts_code
           AND trade_date = ANY(:dates)
        """
    )
    with engine.connect() as conn:
        rows = conn.execute(sql, {"ts_code": ts_code, "dates": dates}).fetchall()

    def to_f(v: object) -> float | None:
        return float(v) if v is not None else None  # type: ignore[arg-type]

    return {
        row[0]: (to_f(row[1]), to_f(row[2]), to_f(row[3]), to_f(row[4]))
        for row in rows
    }


def _prefetch_atr14(signals: list[SignalRecord]) -> dict[tuple[str, str], float | None]:
    """批量取 raw.daily_indicator.atr_14（signal_date 截面，前复权口径）。key=(ts_code, signal_date)。"""
    if not signals:
        return {}
    ts_codes = list({s.ts_code for s in signals})
    signal_dates = list({s.signal_date for s in signals})
    engine = get_engine()
    sql = text(
        "SELECT ts_code, trade_date, atr_14 FROM raw.daily_indicator"
        " WHERE ts_code = ANY(:codes) AND trade_date = ANY(:dates)"
    )
    with engine.connect() as conn:
        rows = conn.execute(sql, {"codes": ts_codes, "dates": signal_dates}).fetchall()
    return {(row[0], row[1]): float(row[2]) if row[2] is not None else None for row in rows}
