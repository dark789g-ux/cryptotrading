"""labels runner：DB IO 层。

职责：
1. 从 raw 表加载 daily_quote / stk_limit / suspend_d / 退市 / 上市 信息
2. 调 strategy_aware.compute_strategy_aware_labels 或 compute_fwd_5d_ret 计算标签
3. upsert 到 factors.labels（PK 去重）
4. 每日进度回写

dispatcher 路由：run_type='labels' → runner_entrypoint。

分类后移改造（spec 2026-06-05）：
  - compute_labels 支持 base_scheme：'strategy-aware' / 'fwd_5d_ret' / 'fwd_ret_h{N}'
    只物化基础连续涨跌幅，不再写入离散 0/1/2 标签。
  - 新路径：fwd_ret_h{N} → compute_fwd_5d_ret(horizon=N)，写 scheme='fwd_ret_h{N}'
    （h=1=次日，h=5='fwd_5d_ret' legacy 别名，由 base_scheme_codec 决定性生成）。
  - dir3_band / dir3_tercile 路径已移除（不靠重跑老代码路径，历史数据在 DB）。
"""

from __future__ import annotations

import logging
import re
from typing import Any
from uuid import UUID

import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.labels._common import (
    PROGRESS_COMPUTE_DONE,
    PROGRESS_DONE,
    PROGRESS_LOAD,
    apply_hfq,
    derive_delist_map,
    derive_suspended_set,
)
from quant_pipeline.labels.fallback import (
    SCHEME_FWD_5D_RET,
    FallbackInputs,
    compute_fwd_5d_ret,
)
from quant_pipeline.labels.strategy_aware import (
    LabelInputs,
    compute_strategy_aware_labels,
)
from quant_pipeline.labels_features_incremental import (
    gap_subranges,
    query_materialized_dates,
    query_trading_days,
)
from quant_pipeline.strategy.exit_rules import MA_WINDOW
from quant_pipeline.worker.progress import (
    JobCancelled,
    ProgressCallback,
    check_cancel_requested,
    update_progress,
)

# fwd_ret_h{N} 新串正则（分类后移改造，spec 2026-06-05）。
_FWD_RET_HN_RE: re.Pattern[str] = re.compile(r"^fwd_ret_h(\d+)$")
# strategy-aware 系串正则（spec 03 §2）：legacy 'strategy-aware' 与多策略
# 'strategy-aware__{id}_{ver}' 都走 strategy_aware 分支。
_STRATEGY_AWARE_RE: re.Pattern[str] = re.compile(r"^strategy-aware(__.+)?$")

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# 数据加载
# ----------------------------------------------------------------------

def _load_daily_quotes(start: str, end_padded: str) -> pd.DataFrame:
    """加载 [start, end_padded] 区间的 daily_quote，并注入后复权列。

    JOIN raw.adj_factor 取复权因子；经 _common.apply_hfq 注入 close_adj/low_adj/high_adj。
    返回列 [ts_code, trade_date, close, low, high, adj_factor,
            close_adj, low_adj, high_adj]。
    high 供 strategy-aware 的 take_profit / trailing_stop 规则用（spec 03 §4）。
    end_padded 含 max_hold 缓冲。
    """

    sql = text(
        """
        SELECT q.ts_code, q.trade_date, q.close, q.low, q.high, a.adj_factor
        FROM raw.daily_quote q
        LEFT JOIN raw.adj_factor a
               ON a.ts_code = q.ts_code AND a.trade_date = q.trade_date
        WHERE q.trade_date >= :start AND q.trade_date <= :end
        ORDER BY q.ts_code, q.trade_date
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql, {"start": start, "end": end_padded}).fetchall()
        cols = ["ts_code", "trade_date", "close", "low", "high", "adj_factor"]
        if not rows:
            return pd.DataFrame(columns=[*cols, "close_adj", "low_adj", "high_adj"])
        df = pd.DataFrame(rows, columns=cols)
        for c in ("close", "low", "high", "adj_factor"):
            df[c] = pd.to_numeric(df[c], errors="coerce")
        return apply_hfq(df)
    except Exception as exc:  # noqa: BLE001
        logger.error("daily_quote_failed", extra={"err": str(exc)})
        raise


def _load_stk_limit(start: str, end: str) -> pd.DataFrame:
    sql = text(
        """
        SELECT ts_code, trade_date, up_limit, down_limit
        FROM raw.stk_limit
        WHERE trade_date >= :start AND trade_date <= :end
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql, {"start": start, "end": end}).fetchall()
        if not rows:
            logger.warning(
                "stk_limit_empty",
                extra={"start": start, "end": end,
                       "note": "stk_limit 为空 → 本次涨停过滤失效"},
            )
            return pd.DataFrame(columns=["ts_code", "trade_date", "up_limit", "down_limit"])
        df = pd.DataFrame(rows, columns=["ts_code", "trade_date", "up_limit", "down_limit"])
        for c in ("up_limit", "down_limit"):
            df[c] = pd.to_numeric(df[c], errors="coerce")
        return df
    except Exception as exc:  # noqa: BLE001
        logger.error("stk_limit_failed", extra={"err": str(exc)})
        raise


def _load_suspend(start: str, end: str) -> pd.DataFrame:
    sql = text(
        """
        SELECT ts_code, trade_date
        FROM raw.suspend_d
        WHERE trade_date >= :start AND trade_date <= :end
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql, {"start": start, "end": end}).fetchall()
        if not rows:
            logger.warning("suspend_d_empty", extra={"start": start, "end": end})
            return pd.DataFrame(columns=["ts_code", "trade_date"])
        return pd.DataFrame(rows, columns=["ts_code", "trade_date"])
    except Exception as exc:  # noqa: BLE001
        logger.error("suspend_d_failed", extra={"err": str(exc)})
        raise


def _compute_end_padded(end: str, *, n_trade_days: int = 30) -> str:
    """按交易日历取 end 之后第 n_trade_days 个交易日作为 end_padded。

    缓冲需 > MAX_HOLD_DAYS(20) + T+1 入场偏移 + 余量，取 30 个交易日。
    数据来源 raw.trade_cal（is_open=1），参考 factors/runner._query_trade_dates。
    若 raw.trade_cal 在 end 之后不足 n_trade_days 个交易日（数据本身到期）→
    取能取到的最后一日并 logger.warning。
    """

    # cal_date / trade_date 均为 Tushare YYYYMMDD 定宽字符串，字典序即时序。
    sql = text(
        """
        SELECT cal_date FROM raw.trade_cal
        WHERE is_open = 1 AND cal_date > :end
        ORDER BY cal_date
        LIMIT :limit
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(
                sql, {"end": end, "limit": n_trade_days}
            ).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.error("trade_cal_failed", extra={"err": str(exc)})
        raise
    dates = [str(r[0]) for r in rows]
    if len(dates) < n_trade_days:
        logger.warning(
            "labels_end_padded_insufficient",
            extra={
                "end": end,
                "requested": n_trade_days,
                "available": len(dates),
            },
        )
        if not dates:
            return end
    return dates[-1]


def _compute_g0_load(g0: str, head_pad: int, start: str) -> str:
    """缺口子区间头部 padding：取 g0 之前第 head_pad 个交易日，且不早于 start。

    仅 strategy_aware scheme（含 ma_break）需要头部 padding：simulate_exit 先对整个
    加载窗口算滚动 MA（rolling(ma_window, min_periods=ma_window)）再切 buy_date，故
    MA(t) 在加载窗口起点后 ma_window−1 个交易日内为 NaN。整段算从 start 加载 → MA(t)
    非 NaN ⟺ t ≥ start+(ma_window−1)。增量要逐行复现这一 NaN 边界，缺口加载起点须
    g0_load = max(start, g0 − head_pad 交易日)，其中 head_pad = ma_window−1。

    - head_pad=0（fwd_ret / 无 ma_break）→ 直接返回 g0（不回看）。
    - 不早于 start：clamp 到 start，否则 g0=start 时增量 MA 比整段算更准、反而不一致
      （整段算在 start 附近本就 NaN）。spec 02 §「padding 判定」坐实。
    - 交易日历来源 raw.trade_cal（is_open=1），与 _compute_end_padded 同源。
    """

    if head_pad <= 0:
        return g0
    # cal_date / trade_date 均为 Tushare YYYYMMDD 定宽字符串，字典序即时序。
    # 取 g0 之前 head_pad 个交易日（降序取第 head_pad 个）。
    sql = text(
        """
        SELECT cal_date FROM raw.trade_cal
        WHERE is_open = 1 AND cal_date < :g0
        ORDER BY cal_date DESC
        LIMIT :limit
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql, {"g0": g0, "limit": head_pad}).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.error("trade_cal_failed", extra={"err": str(exc)})
        raise
    dates = [str(r[0]) for r in rows]
    # rows 降序，最后一个即"g0 之前第 head_pad 个交易日"；不足 head_pad 个则取最早可得。
    candidate = dates[-1] if dates else g0
    # clamp 到 start：不早于 date_range.start（复现整段算在 start 附近的 NaN 边界）。
    return max(candidate, start)


def _resolve_ma_window(
    *, is_strategy_aware: bool, exit_rules: list[dict] | None
) -> int | None:
    """解析头部 padding 所需的 ma_window（= strategy_aware exit 规则里 ma_break 的 period）。

    与 strategy_aware.compute_strategy_aware_labels（:456-461）的 ma_window 解析逐行对齐：
      - 非 strategy_aware（fwd_ret 系）→ None（不经 simulate_exit，无 MA，head_pad=0）。
      - strategy_aware 且 exit_rules is None → MA_WINDOW(5)（default_rules() 默认窗口）。
      - strategy_aware 且 exit_rules 为 list → 取唯一 ma_break 的 period；无 ma_break → None
        （build_exit_rules :383-391 同语义：ma 列恒 NaN，head_pad=0）。

    注：这里**只读取** period，不调 build_exit_rules（避免对 max_hold 等做无关校验；真正的
    规则构造与校验仍由下游 compute_strategy_aware_labels 内的 build_exit_rules 完成）。
    """

    if not is_strategy_aware:
        return None
    if exit_rules is None:
        return MA_WINDOW
    for item in exit_rules:
        if isinstance(item, dict) and item.get("type") == "ma_break":
            params = item.get("params") or {}
            return int(params["period"])
    return None


def _load_listing_info() -> tuple[pd.DataFrame, pd.DataFrame]:
    """加载上市/退市信息（list_date / delist_date）。

    数据来源：public.a_share_symbols（NestJS syncSymbols 维护）。
    """

    sql = text(
        """
        SELECT ts_code, list_date, delist_date
        FROM public.a_share_symbols
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql).fetchall()
        if not rows:
            logger.error("a_share_symbols_empty")
            raise RuntimeError(
                "a_share_symbols returned 0 rows — cannot compute survivorship bias"
            )
        df = pd.DataFrame(rows, columns=["ts_code", "list_date", "delist_date"])
        listing = df[["ts_code", "list_date"]].dropna()
        delist = df[df["delist_date"].notna()][["ts_code", "delist_date"]]
        return listing, delist
    except Exception as exc:  # noqa: BLE001
        logger.error("stock_basic_failed", extra={"err": str(exc)})
        raise


def _load_strategy_definition(strategy_id: str, strategy_version: str) -> list[dict]:
    """查 factors.strategy_definitions 取 exit_rules（jsonb → list[dict]）。

    spec 03 §3.1：取不到行 → raise RuntimeError（fail-fast，CLAUDE.md data-integrity，
    禁静默吞错）。jsonb 列由驱动反序列化为 Python list；非 list（如被改坏）→ raise。
    """

    sql = text(
        """
        SELECT exit_rules
        FROM factors.strategy_definitions
        WHERE strategy_id = :sid AND strategy_version = :sver
        """
    )
    try:
        with session_scope() as session:
            row = session.execute(
                sql, {"sid": strategy_id, "sver": strategy_version}
            ).fetchone()
    except Exception as exc:  # noqa: BLE001
        logger.error("strategy_definitions_failed", extra={"err": str(exc)})
        raise
    if row is None:
        raise RuntimeError(
            f"strategy {strategy_id}@{strategy_version} not found "
            f"in factors.strategy_definitions"
        )
    exit_rules = row[0]
    if not isinstance(exit_rules, list):
        raise RuntimeError(
            f"strategy {strategy_id}@{strategy_version} exit_rules is not a list, "
            f"got {type(exit_rules).__name__}"
        )
    return exit_rules


# ----------------------------------------------------------------------
# upsert
# ----------------------------------------------------------------------

def _upsert_labels(rows: list[dict[str, Any]]) -> int:
    """按 PK (trade_date, ts_code, scheme) 去重后 upsert 到 factors.labels。"""

    if not rows:
        return 0
    seen: dict[tuple[str, str, str], dict[str, Any]] = {}
    for r in rows:
        key = (str(r["trade_date"]), str(r["ts_code"]), str(r["scheme"]))
        seen[key] = r
    deduped = list(seen.values())
    if len(deduped) != len(rows):
        logger.warning(
            "labels_dedup",
            extra={"raw": len(rows), "deduped": len(deduped)},
        )

    sql = text(
        """
        INSERT INTO factors.labels
            (trade_date, ts_code, scheme, value, exit_reason, hold_days)
        VALUES
            (:trade_date, :ts_code, :scheme, :value, :exit_reason, :hold_days)
        ON CONFLICT (trade_date, ts_code, scheme)
        DO UPDATE SET value       = EXCLUDED.value,
                      exit_reason = EXCLUDED.exit_reason,
                      hold_days   = EXCLUDED.hold_days
        """
    )
    with session_scope() as session:
        session.execute(sql, deduped)
    return len(deduped)


# ----------------------------------------------------------------------
# 主入口
# ----------------------------------------------------------------------

def compute_labels(
    *,
    scheme: str,
    date_range: str,
    new_listing_min_days: int | None = None,
    fwd_horizon_days: int | None = None,
    exit_rules: list[dict] | None = None,
    label_winsorize: tuple[float, float] | None = None,
    job_id: UUID | None = None,
    progress_callback: ProgressCallback | None = None,
) -> int:
    """计算并 upsert 标签；返回写入的行数。

    参数：
        scheme:                "strategy-aware" / "strategy-aware__{id}_{ver}" /
                               "fwd_5d_ret" / "fwd_ret_h{N}"
        date_range:            "YYYYMMDD:YYYYMMDD"
        new_listing_min_days:  新股门槛交易日阈值。None → 走默认 60；0 表示不过滤。
                               非法值由 _validate_min_days 抛 ValueError。
        fwd_horizon_days:      仅 fwd_5d_ret 生效（spec 02）。None → 走 fallback 默认
                               FWD_HORIZON_DAYS(5)；其它 scheme 忽略。
        exit_rules:            仅 strategy-aware 系生效（spec 03 §3.2）。出场规则配置
                               （list[dict]，见 strategy.exit_rules.build_exit_rules）。
                               None → 走 default_rules()（止损-8%/跌破MA5/最大持仓20日），
                               与 default_exit@v1 逐行等价；其它 scheme 忽略。
        label_winsorize:       spec 02 §「只截一次」：标签截尾**统一在 features.builder
                               执行**（features 层 winsorize_label_value），本函数
                               不在标签阶段再截一次（避免双重 winsorize）。此入参仅
                               为与 train_e2e._step_labels 调用签名对齐而保留，labels
                               阶段不消费；实际值由 _step_features 透传给 builder。
        job_id:                可选，传入则在每日完成后写 progress
        progress_callback:     可选，CLI 终端进度条回调 (progress, stage) -> None
    """

    # spec 02 §「只截一次」：label_winsorize 不在 labels 阶段消费（见 docstring）。
    # 显式忽略以避免误用；保留入参仅为签名对齐。
    _ = label_winsorize

    def _progress(progress: int, stage: str) -> None:
        if progress_callback is not None:
            progress_callback(progress, stage)
        if job_id is not None:
            update_progress(job_id, progress, stage=stage)

    # strategy-aware 系：'strategy-aware'（legacy）/ 'strategy-aware__{id}_{ver}'（多策略）
    # fwd 系：'fwd_5d_ret'（legacy）/ 'fwd_ret_h{N}'（分类后移改造，spec 2026-06-05）
    # dir3_band / dir3_tercile 路径已移除（历史数据在 DB，不靠重跑老代码路径）
    fwd_ret_hn_match = _FWD_RET_HN_RE.match(scheme)
    is_strategy_aware = _STRATEGY_AWARE_RE.match(scheme) is not None
    if (
        not is_strategy_aware
        and scheme != SCHEME_FWD_5D_RET
        and fwd_ret_hn_match is None
    ):
        raise NotImplementedError(
            f"labels scheme={scheme!r} not implemented "
            f"(supported: 'strategy-aware', 'strategy-aware__{{id}}_{{ver}}', "
            f"{SCHEME_FWD_5D_RET!r}, fwd_ret_h{{N}})"
        )
    start, end = date_range.split(":")
    if len(start) != 8 or len(end) != 8:
        raise ValueError(f"date_range must be 'YYYYMMDD:YYYYMMDD', got {date_range!r}")

    # 拉数据：报价需要往后多取 max_hold + 缓冲，让 simulate_exit 能完整模拟尾部入场。
    # end_padded 按交易日历取 end 之后第 30 个交易日（spec 03 §item-5）。
    end_padded = _compute_end_padded(end)

    quotes = _load_daily_quotes(start, end_padded)
    stk_limit = _load_stk_limit(start, end)
    suspend = _load_suspend(start, end_padded)
    listing, delist = _load_listing_info()

    if quotes.empty:
        # 窗口内一行 daily_quote 都没有 → 确凿数据缺口（CLAUDE.md 硬约束）
        raise RuntimeError(
            f"labels: no daily_quote rows in window "
            f"date_range={date_range!r} scheme={scheme!r} end_padded={end_padded!r}"
        )

    # 目标入场日范围内的 entries（信号日 T；trade_date 为 YYYYMMDD 定宽字符串，
    # 字典序即时序，可直接做字符串比较）
    entries = quotes.loc[
        (quotes["trade_date"] >= start) & (quotes["trade_date"] <= end),
        ["ts_code", "trade_date"],
    ].copy()

    if job_id is not None and check_cancel_requested(job_id):
        raise JobCancelled
    _progress(PROGRESS_LOAD, "labels:load")

    if is_strategy_aware:
        labels_df = compute_strategy_aware_labels(
            LabelInputs(
                daily_quotes=quotes,
                stk_limit=stk_limit if not stk_limit.empty else None,
                suspend_d=suspend if not suspend.empty else None,
                delist=delist if not delist.empty else None,
                listing=listing if not listing.empty else None,
                entries=entries,
                end=end,
                new_listing_min_days=new_listing_min_days,
                # spec 03 §3.2：仅 strategy-aware 系生效；None → default_rules()
                # （与 default_exit@v1 逐行等价）。
                exit_rules=exit_rules,
            ),
            # scheme 透传：写入 records.scheme（legacy 'strategy-aware' 或
            # 多策略 'strategy-aware__{id}_{ver}'），与 factors.labels PK 对齐。
            scheme=scheme,
            progress_callback=_progress if progress_callback is not None else None,
        )
        # compute_* 原始输出为空 → candidates 被过滤光 / 模拟全失败属真异常
        if labels_df.empty:
            raise RuntimeError(
                f"labels: compute_strategy_aware_labels produced 0 rows "
                f"date_range={date_range!r} scheme={scheme!r}"
            )
    else:
        # fwd_5d_ret（legacy）或 fwd_ret_h{N}（新路径）。
        # 新路径：从 scheme 串解析 horizon（例 fwd_ret_h1 → horizon=1）。
        # 旧路径：fwd_5d_ret → horizon 由 fwd_horizon_days 参数或默认值(5) 决定。
        if fwd_ret_hn_match is not None:
            resolved_horizon: int | None = int(fwd_ret_hn_match.group(1))
        else:
            # fwd_5d_ret：fwd_horizon_days 参数或 None（下游走 FWD_HORIZON_DAYS=5）
            resolved_horizon = fwd_horizon_days

        # fwd_ret / fwd_5d_ret（doc/04 §4.1）。listing 透传以支持新股过滤（D-1 缺口补齐）。
        labels_df = compute_fwd_5d_ret(
            FallbackInputs(
                daily_quotes=quotes,
                suspended_set=derive_suspended_set(suspend if not suspend.empty else None),
                delist_map=derive_delist_map(delist if not delist.empty else None),
                listing=listing if not listing.empty else None,
                new_listing_min_days=new_listing_min_days,
            ),
            fwd_horizon_days=resolved_horizon,
        )
        # compute_* 原始输出（区间过滤前）为空 → 真异常
        if labels_df.empty:
            raise RuntimeError(
                f"labels: compute_fwd_5d_ret produced 0 rows "
                f"date_range={date_range!r} scheme={scheme!r}"
            )
        # 区间过滤（trade_date 为 YYYYMMDD 定宽字符串，字典序即时序）。
        # compute_fwd_5d_ret 用 end_padded 的 quotes，每票末 horizon 行被 shift 丢弃属正常；
        # 区间过滤之后合法地为空 → 仅 warning + return 0，不 raise。
        labels_df = labels_df.loc[
            (labels_df["trade_date"] >= start) & (labels_df["trade_date"] <= end)
        ].reset_index(drop=True)
    _progress(PROGRESS_COMPUTE_DONE, "labels:compute")

    if labels_df.empty:
        logger.warning(
            "labels_empty_after_range_filter",
            extra={"date_range": date_range, "scheme": scheme},
        )
        _progress(PROGRESS_DONE, "labels:done")
        return 0

    rows = labels_df.to_dict("records")
    n = _upsert_labels(rows)

    _progress(PROGRESS_DONE, "labels:done")
    logger.info(
        "labels_written",
        extra={"date_range": date_range, "scheme": scheme, "rows": n},
    )
    return n


def runner_entrypoint(job: object) -> None:
    """供 worker.dispatcher 调用（dispatcher 直跑路径，非 train_e2e 主路径）。

    job.params schema（01-pg-schema §4.1）：
        {"scheme": "strategy-aware", "date_range": "YYYYMMDD:YYYYMMDD"}
        可选 {"strategy_id": "...", "strategy_version": "v1"}：含则按 codec 算
        scheme + 从 factors.strategy_definitions 加载 exit_rules（spec 03 §3.4）；
        否则裸 scheme（如 "strategy-aware"）走 default_exit（exit_rules=None）。

    scheme 解析优先级（三选一，互斥）：
        1. 显式 params.scheme（最高优先，直接使用）
        2. top-level params.strategy_id + strategy_version（legacy 直传路径）
        3. params.base_type + params.base_params（expandForTraining 注入路径）：
           - base_type='strategy_aware' → 从 base_params 提 strategy_id/version，
             复用分支 2 的语义（codec + _load_strategy_definition）
           - 其它 base_type（如 'fwd_ret'）→ base_scheme_codec(base_type, base_params)
        三者全缺 → ValueError fail-fast。
    """

    # 延迟 import 避免循环依赖（dir3_scheme 不依赖本模块，但保持与其它入口一致）
    from quant_pipeline.labels.dir3_scheme import base_scheme_codec

    params = getattr(job, "params", {}) or {}
    scheme = params.get("scheme")
    date_range = params.get("date_range")
    strategy_id = params.get("strategy_id")
    strategy_version = params.get("strategy_version")

    # 含 strategy_id+version → 用 codec 算 scheme + 加载该策略的 exit_rules。
    # 此分支不要求 params 里的 scheme（codec 算出权威 scheme，避免双源真理）。
    exit_rules: list[dict] | None = None
    if strategy_id and strategy_version:
        scheme = base_scheme_codec(
            "strategy_aware",
            {"strategy_id": strategy_id, "strategy_version": strategy_version},
        )
        exit_rules = _load_strategy_definition(str(strategy_id), str(strategy_version))

    elif not scheme:
        # 第三优先：expandForTraining 注入的 base_type/base_params 路径。
        # 仅当显式 scheme 与 top-level strategy_id/version 均不存在时触发。
        base_type = params.get("base_type")
        if base_type:
            base_params: dict = params.get("base_params") or {}
            if base_type == "strategy_aware":
                # 从 base_params 提取 strategy_id/version，复用分支 2 语义。
                strategy_id = base_params.get("strategy_id")
                strategy_version = base_params.get("strategy_version")
                scheme = base_scheme_codec(
                    "strategy_aware",
                    {"strategy_id": strategy_id, "strategy_version": strategy_version},
                )
                exit_rules = _load_strategy_definition(
                    str(strategy_id), str(strategy_version)
                )
            else:
                # fwd_ret 等其它类型：codec 算 scheme，无需 exit_rules。
                scheme = base_scheme_codec(base_type, base_params)

    if not scheme or not date_range:
        raise ValueError(
            f"labels job missing required params: scheme/date_range "
            f"(or strategy_id/strategy_version, or base_type/base_params), got {params!r}"
        )
    # new_listing_min_days 可选；None 时由 compute_labels 走默认 60。
    # 校验由下游 _validate_min_days 抛 ValueError，worker 顶层捕获标记 job=failed。
    new_listing_min_days = params.get("new_listing_min_days")
    job_id = getattr(job, "id", None)
    compute_labels(
        scheme=str(scheme),
        date_range=str(date_range),
        new_listing_min_days=new_listing_min_days,
        exit_rules=exit_rules,
        job_id=job_id,
    )


__all__ = ["compute_labels", "runner_entrypoint"]
