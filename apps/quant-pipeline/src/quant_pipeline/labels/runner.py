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
from quant_pipeline.labels.band_lock_labels import compute_band_lock_labels
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
# 支持 fwd_ret_h{N}__{variant} 变体 scheme（与 strategy-aware 对称，
# 用于把 fwd 算进临时 scheme 做重算/探查，如 fwd_ret_h1__recheck）。
# horizon 仍从 group(1) 提取，group(2) 为可选后缀，不影响计算逻辑。
_FWD_RET_HN_RE: re.Pattern[str] = re.compile(r"^fwd_ret_h(\d+)(__.+)?$")
# strategy-aware 系串正则（spec 03 §2）：legacy 'strategy-aware' 与多策略
# 'strategy-aware__{id}_{ver}' 都走 strategy_aware 分支。
_STRATEGY_AWARE_RE: re.Pattern[str] = re.compile(r"^strategy-aware(__.+)?$")
# band_lock 系串正则（trailing-lock-exit-design spec 03 §二）：legacy 'band_lock'
# 与变体 'band_lock__{variant}' 都走 band_lock 独立有状态分支（共享核
# simulate_band_lock，绕开 strategy_aware 的 first-match build_exit_rules）。
_BAND_LOCK_RE: re.Pattern[str] = re.compile(r"^band_lock(__.+)?$")
# band_lock__mh{N} 变体：max_hold 硬上限编进 scheme 串（与 fwd_ret_h{N} 对称，
# 由 dir3_scheme.base_scheme_codec 决定性生成）。从 scheme 解析 max_hold，使
# scheme 串自描述、增量重算决定性（同 scheme → 同 max_hold → 同标签）。
_BAND_LOCK_MH_RE: re.Pattern[str] = re.compile(r"^band_lock__mh(\d+)$")

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# 数据加载
# ----------------------------------------------------------------------

def _load_daily_quotes(
    start: str, end_padded: str, *, head_rows_per_code: int = 0
) -> pd.DataFrame:
    """加载 [start, end_padded] 主窗口 daily_quote，并注入后复权列。

    JOIN raw.adj_factor 取复权因子；经 _common.apply_hfq 注入
    close_adj/low_adj/high_adj/open_adj。返回列 [ts_code, trade_date, open, close,
    low, high, adj_factor, close_adj, low_adj, high_adj, open_adj]。
    high 供 strategy-aware 的 take_profit / trailing_stop 规则用（spec 03 §4）；
    open / open_adj 供 band_lock scheme 用（买在 T+1 开盘 hfq open_adj，限停板判定
    用 raw open；其它 scheme 不读 open 列，无影响）。raw open/high 的列名亲查真 DB
    确认（raw.daily_quote 同行含 open/high/low/close 原始列）。
    end_padded 含 max_hold 缓冲。

    head_rows_per_code > 0（仅 strategy_aware 含 ma_break；bug5 修复）：除主窗口外，对
    **每个在主窗口出现的 ts_code** 再补该股 trade_date < start 的最近 head_rows_per_code
    个**在场行**（停牌日 raw.daily_quote 无行 → 自然不计入）。

    为何需要（bug5）：simulate_exit 的 _ensure_ma 用**行位移** close.shift(j) 求 MA，
    MA(t)=最近 ma_window 个**在场行** close 之和/w，只依赖在场行、与日历无关。但主窗口
    下界 g0_load（_compute_g0_load）按**日历交易日**回看 ma_window-1 天 —— 停牌股在该日历
    窗内在场行不足 ma_window-1 个 → MA shift 取不到足够前序在场行 → NaN/取行更少 →
    MABreakRule 的严格 `close < ma` 翻转 → exit_reason/hold_days/value 增量与整段重算分歧
    （违反约束 1）。补够每股 ma_window-1 个 start 前在场行，使 MA 真正窗口无关、逐位一致。

    实现用 LATERAL + 索引 idx_a_share_daily_quotes_code_date(ts_code, trade_date DESC)，
    每股仅索引下推读 head_rows_per_code 行（不同于 spec 建议的 ROW_NUMBER 全扫 start 前
    全量 —— 后者在缺口靠后的月度 chunk 上会扫近一年数据；LATERAL+LIMIT 等价且高效）。
    head 行 trade_date < start，与主窗口 [start, end] 不相交 → 拼接无重复；head 行 < g0 ≤
    entries 起点，绝不进 entries/不写库，只参与 _ensure_ma（详见 compute_labels）。
    """

    main_sql = text(
        """
        SELECT q.ts_code, q.trade_date, q.open, q.close, q.low, q.high, a.adj_factor
        FROM raw.daily_quote q
        LEFT JOIN raw.adj_factor a
               ON a.ts_code = q.ts_code AND a.trade_date = q.trade_date
        WHERE q.trade_date >= :start AND q.trade_date <= :end
        ORDER BY q.ts_code, q.trade_date
        """
    )
    # 每股 start 前最近 head_rows_per_code 个在场行（LATERAL top-N，走 code_date 索引）。
    # codes = 主窗口出现过的 ts_code（含且仅含本次会算到的股）；h = 该股 trade_date < start
    # 降序前 N 行；LEFT JOIN adj_factor 与主窗口同口径，复权因子缺则该行 close_adj=NaN。
    head_sql = text(
        """
        SELECT codes.ts_code, h.trade_date, h.open, h.close, h.low, h.high, a.adj_factor
        FROM (
            SELECT DISTINCT ts_code FROM raw.daily_quote
            WHERE trade_date >= :start AND trade_date <= :end
        ) codes
        CROSS JOIN LATERAL (
            SELECT q2.trade_date, q2.open, q2.close, q2.low, q2.high
            FROM raw.daily_quote q2
            WHERE q2.ts_code = codes.ts_code AND q2.trade_date < :start
            ORDER BY q2.trade_date DESC
            LIMIT :head_rows
        ) h
        LEFT JOIN raw.adj_factor a
               ON a.ts_code = codes.ts_code AND a.trade_date = h.trade_date
        """
    )
    cols = ["ts_code", "trade_date", "open", "close", "low", "high", "adj_factor"]
    try:
        with session_scope() as session:
            rows = session.execute(
                main_sql, {"start": start, "end": end_padded}
            ).fetchall()
            head_rows: list = []
            if head_rows_per_code > 0:
                head_rows = session.execute(
                    head_sql,
                    {"start": start, "end": end_padded,
                     "head_rows": head_rows_per_code},
                ).fetchall()
        all_rows = list(rows) + list(head_rows)
        if not all_rows:
            return pd.DataFrame(
                columns=[*cols, "close_adj", "low_adj", "high_adj", "open_adj"]
            )
        df = pd.DataFrame(all_rows, columns=cols)
        for c in ("open", "close", "low", "high", "adj_factor"):
            df[c] = pd.to_numeric(df[c], errors="coerce")
        if head_rows:
            # 主窗口已 ORDER BY，head 行追加在后 → 拼接后重排，保持 (ts_code, trade_date)
            # 升序契约（下游 strategy_aware groupby + _ensure_ma 各自再排，全局序非必需，
            # 但保持与改造前一致更稳）。
            df = df.sort_values(["ts_code", "trade_date"]).reset_index(drop=True)
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
    数据来源 raw.trade_cal（exchange='SSE', is_open=1），与 query_trading_days /
    缺口检测同口径（trade_cal 每个日历日含多交易所行，**必须**按 exchange 过滤，
    否则 LIMIT n 实际只回 ~n/交易所数 个不同日期、尾部 padding 减半）。
    若 raw.trade_cal 在 end 之后不足 n_trade_days 个交易日（数据本身到期）→
    取能取到的最后一日并 logger.warning。
    """

    # cal_date / trade_date 均为 Tushare YYYYMMDD 定宽字符串，字典序即时序。
    # exchange='SSE'：A 股交易日历标准口径；漏此过滤会跨交易所重复计数（bug 教训）。
    sql = text(
        """
        SELECT cal_date FROM raw.trade_cal
        WHERE exchange = 'SSE' AND is_open = 1 AND cal_date > :end
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
    - 交易日历来源 raw.trade_cal（exchange='SSE', is_open=1），与 _compute_end_padded
      同源同口径（必须按 exchange 过滤，否则跨交易所重复计数、head_pad 减半）。
    """

    if head_pad <= 0:
        return g0
    # cal_date / trade_date 均为 Tushare YYYYMMDD 定宽字符串，字典序即时序。
    # 取 g0 之前 head_pad 个交易日（降序取第 head_pad 个）。
    # exchange='SSE'：A 股交易日历标准口径；漏此过滤会跨交易所重复计数（bug 教训）。
    sql = text(
        """
        SELECT cal_date FROM raw.trade_cal
        WHERE exchange = 'SSE' AND is_open = 1 AND cal_date < :g0
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


def _load_trade_calendar() -> list[str]:
    """加载全量 SSE 交易日历（exchange='SSE', is_open=1，升序）。

    用于 new_listing 过滤的**窗口无关**计数（约束 1，bug3 修复）："上市后第 N 交易日"
    必须按全局交易日历计，不能用加载窗口 [g0_load, end_padded] 的局部交易日——否则
    次新股 list_date 早于缺口 chunk 起点时 list_idx=NaN、漏剔，增量与整段重算分歧。
    全量加载（不设上界）覆盖任意 list_date（历史）与 buy_date（≤ end_padded ≤ 日历末），
    且日历连续 → 索引差 = 真实交易日数。exchange='SSE'：A 股交易日历标准口径（与
    _compute_end_padded / _compute_g0_load 同源，漏过滤会跨交易所重复计数）。
    """

    sql = text(
        """
        SELECT cal_date FROM raw.trade_cal
        WHERE exchange = 'SSE' AND is_open = 1
        ORDER BY cal_date
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.error("trade_cal_failed", extra={"err": str(exc)})
        raise
    if not rows:
        raise RuntimeError(
            "raw.trade_cal returned 0 SSE open days — cannot compute new_listing filter"
        )
    return [str(r[0]) for r in rows]


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
    band_lock_max_hold: int | None = None,
    label_winsorize: tuple[float, float] | None = None,
    force_recompute: bool = False,
    job_id: UUID | None = None,
    progress_callback: ProgressCallback | None = None,
) -> int:
    """计算并 upsert 标签；返回写入的行数。

    参数：
        scheme:                "strategy-aware" / "strategy-aware__{id}_{ver}" /
                               "fwd_5d_ret" / "fwd_ret_h{N}" /
                               "band_lock" / "band_lock__{variant}"
        date_range:            "YYYYMMDD:YYYYMMDD"
        new_listing_min_days:  新股门槛交易日阈值。None → 走默认 60；0 表示不过滤。
                               非法值由 _validate_min_days 抛 ValueError。
        fwd_horizon_days:      仅 fwd_5d_ret 生效（spec 02）。None → 走 fallback 默认
                               FWD_HORIZON_DAYS(5)；其它 scheme 忽略。
        exit_rules:            仅 strategy-aware 系生效（spec 03 §3.2）。出场规则配置
                               （list[dict]，见 strategy.exit_rules.build_exit_rules）。
                               None → 走 default_rules()（止损-8%/跌破MA5/最大持仓20日），
                               与 default_exit@v1 逐行等价；其它 scheme 忽略。
        band_lock_max_hold:    仅 band_lock 系生效（trailing-lock-exit spec 03 §二）。
                               透传给 simulate_band_lock 的 max_hold 硬上限（已走过
                               可交易持有日数）。None → 不设硬上限；其它 scheme 忽略。
        label_winsorize:       spec 02 §「只截一次」：标签截尾**统一在 features.builder
                               执行**（features 层 winsorize_label_value），本函数
                               不在标签阶段再截一次（避免双重 winsorize）。此入参仅
                               为与 train_e2e._step_labels 调用签名对齐而保留，labels
                               阶段不消费；实际值由 _step_features 透传给 builder。
        force_recompute:       spec 02 §force_recompute。True → 跳过"查已物化 / 算缺口"，
                               对整段 [start, end] 重算并覆盖写（= 改造前整段行为，等价
                               基线）。False（默认）→ 实时查 factors.labels 已物化的
                               trade_date，仅对缺口连续子区间增量重算（gap_subranges）。
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
    is_band_lock = _BAND_LOCK_RE.match(scheme) is not None
    # band_lock__mh{N} 把 max_hold 编进 scheme（决定性、scheme 自描述）。显式
    # band_lock_max_hold 入参优先；未给则从 scheme 串解析（同 scheme → 同 max_hold）。
    if is_band_lock and band_lock_max_hold is None:
        mh_match = _BAND_LOCK_MH_RE.match(scheme)
        if mh_match is not None:
            band_lock_max_hold = int(mh_match.group(1))
    if (
        not is_strategy_aware
        and not is_band_lock
        and scheme != SCHEME_FWD_5D_RET
        and fwd_ret_hn_match is None
    ):
        raise NotImplementedError(
            f"labels scheme={scheme!r} not implemented "
            f"(supported: 'strategy-aware', 'strategy-aware__{{id}}_{{ver}}', "
            f"{SCHEME_FWD_5D_RET!r}, fwd_ret_h{{N}}, "
            f"'band_lock', 'band_lock__{{variant}}')"
        )
    start, end = date_range.split(":")
    if len(start) != 8 or len(end) != 8:
        raise ValueError(f"date_range must be 'YYYYMMDD:YYYYMMDD', got {date_range!r}")

    # 头部 padding 解析（spec 02 §「padding 判定」）：
    #   strategy_aware（含 ma_break）需回看 ma_window−1 个交易日复现整段 MA NaN 边界；
    #   band_lock 也用 MA5（5 个非停牌交易日 close_adj 滚动均值）→ 同样需回看 MA_WINDOW−1
    #     个交易日预热，使 ma5 在缺口 chunk 起点处即可用、增量与整段重算一致；
    #   fwd_ret / 无 ma_break → ma_window=None → head_pad=0（g0_load=g0，不回看）。
    if is_band_lock:
        head_pad = MA_WINDOW - 1
    else:
        ma_window = _resolve_ma_window(
            is_strategy_aware=is_strategy_aware, exit_rules=exit_rules
        )
        head_pad = (ma_window - 1) if ma_window else 0

    # 算子区间（spec 02 §labels 增量缺口算法）：
    #   force_recompute=True → 整段重算覆盖（= 改造前整段行为，等价基线）；
    #   否则实时查 factors.labels 已物化 trade_date，对缺口连续子区间增量重算。
    if force_recompute:
        subranges: list[tuple[str, str]] = [(start, end)]
        trading_days: list[str] = []
        skipped_dates: list[str] = []
    else:
        with session_scope() as _s:
            materialized = query_materialized_dates(
                _s, "factors.labels", "scheme", scheme, start, end
            )
            trading_days = query_trading_days(_s, start, end)
        subranges = gap_subranges(materialized, trading_days)
        # 已物化、本次跳过的交易日（仅 log 用，禁止静默截断）。
        gap_set = {
            d for (g0, g1) in subranges for d in trading_days if g0 <= d <= g1
        }
        skipped_dates = [d for d in trading_days if d not in gap_set]

    logger.info(
        "labels_incremental_plan",
        extra={
            "date_range": date_range,
            "scheme": scheme,
            "force_recompute": force_recompute,
            "skipped_dates": len(skipped_dates),
            "computed_subranges": subranges,
        },
    )

    if not subranges:
        # 全区间已物化（缺口为空）→ 无需重算，按已物化处理（不 raise）。
        _progress(PROGRESS_DONE, "labels:done")
        return 0

    if job_id is not None and check_cancel_requested(job_id):
        raise JobCancelled
    _progress(PROGRESS_LOAD, "labels:load")

    # listing/delist 全区间共用，逐缺口循环外加载一次（与缺口子区间无关）。
    listing, delist = _load_listing_info()
    # 全局 SSE 交易日历（窗口无关 new_listing 计数，约束 1 / bug3）：与加载窗口起点
    # 无关，缺口循环外加载一次。strategy_aware / fwd 两路径都注入，使"上市后第N交易日"
    # 计数对增量 chunk 与整段重算一致（详见 _load_trade_calendar / filter_new_listing）。
    trade_calendar = _load_trade_calendar()

    total_written = 0
    for g0, g1 in subranges:
        # 头部 padding（仅 strategy_aware head_pad>0）：g0_load = max(start, g0−head_pad 交易日)；
        # 尾部 padding：end_padded = g1 之后第 30 交易日（_compute_end_padded）。
        g0_load = _compute_g0_load(g0, head_pad, start)
        end_padded = _compute_end_padded(g1)

        # head_rows_per_code=head_pad（=ma_window-1）：bug5 修复。每股补够 g0_load 前
        # ma_window-1 个在场行，使 simulate_exit 的 MA 窗口无关（停牌股缺行也对齐 FULL）。
        # fwd 路径 head_pad=0 → 不补 head 行，行为与改造前逐字节一致。
        quotes = _load_daily_quotes(
            g0_load, end_padded, head_rows_per_code=head_pad
        )
        # 窗口无关（约束 1，bug2）：stk_limit 须加载到 end_padded（与 quotes/suspend
        # 同口径），而非 g1——涨停过滤看 buy_date(entry_col="buy_date")，signal=g1 的
        # buy_date=next_day(g1)>g1，只到 g1 则查不到该日涨停、漏剔涨停入场，增量与整段
        # 重算分歧。buy_date 最大为 next_day(g1)≤end_padded，多加载的日期对过滤无害
        # （filter 只查 buy_date）。
        stk_limit = _load_stk_limit(g0_load, end_padded)
        suspend = _load_suspend(g0_load, end_padded)

        if quotes.empty:
            # 该缺口子区间内一行 daily_quote 都没有 → 确凿数据缺口（CLAUDE.md 硬约束）
            raise RuntimeError(
                f"labels: no daily_quote rows in window "
                f"date_range={date_range!r} scheme={scheme!r} "
                f"subrange={(g0, g1)!r} end_padded={end_padded!r}"
            )

        # 该缺口内的 entries（信号日 T；只取 [g0,g1]，头/尾 padding 区不产生信号）。
        # trade_date 为 YYYYMMDD 定宽字符串，字典序即时序，可直接做字符串比较。
        entries = quotes.loc[
            (quotes["trade_date"] >= g0) & (quotes["trade_date"] <= g1),
            ["ts_code", "trade_date"],
        ].copy()

        if is_strategy_aware:
            labels_df = compute_strategy_aware_labels(
                LabelInputs(
                    daily_quotes=quotes,
                    stk_limit=stk_limit if not stk_limit.empty else None,
                    suspend_d=suspend if not suspend.empty else None,
                    delist=delist if not delist.empty else None,
                    listing=listing if not listing.empty else None,
                    entries=entries,
                    end=g1,
                    new_listing_min_days=new_listing_min_days,
                    # spec 03 §3.2：仅 strategy-aware 系生效；None → default_rules()
                    # （与 default_exit@v1 逐行等价）。
                    exit_rules=exit_rules,
                    # 全局日历：窗口无关 new_listing 计数（约束 1 / bug3）。
                    trade_calendar=trade_calendar,
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
                    f"date_range={date_range!r} scheme={scheme!r} subrange={(g0, g1)!r}"
                )
            # entries 已限 [g0,g1]，输出 trade_date=signal_date ⊆ [g0,g1]；按 spec
            # 「_upsert_labels(rows ∩ [g0,g1])」再夹一次（头/尾 padding 区都不写）。
            labels_df = labels_df.loc[
                (labels_df["trade_date"] >= g0) & (labels_df["trade_date"] <= g1)
            ].reset_index(drop=True)
        elif is_band_lock:
            # band_lock 独立有状态 scheme（trailing-lock-exit spec 03 §二）：买在 T+1
            # hfq open_adj，调共享核 simulate_band_lock，绕开 strategy_aware first-match。
            labels_df = compute_band_lock_labels(
                LabelInputs(
                    daily_quotes=quotes,
                    stk_limit=stk_limit if not stk_limit.empty else None,
                    suspend_d=suspend if not suspend.empty else None,
                    delist=delist if not delist.empty else None,
                    listing=listing if not listing.empty else None,
                    entries=entries,
                    end=g1,
                    new_listing_min_days=new_listing_min_days,
                    # 全局日历：窗口无关 new_listing 计数（约束 1 / bug3）。
                    trade_calendar=trade_calendar,
                ),
                progress_callback=_progress if progress_callback is not None else None,
                # scheme 透传：写入 records.scheme（legacy 'band_lock' 或变体），
                # 与 factors.labels PK 对齐。
                scheme=scheme,
                max_hold=band_lock_max_hold,
            )
            if labels_df.empty:
                raise RuntimeError(
                    f"labels: compute_band_lock_labels produced 0 rows "
                    f"date_range={date_range!r} scheme={scheme!r} subrange={(g0, g1)!r}"
                )
            # 输出 trade_date=signal_date ⊆ [g0,g1]；再夹一次（头/尾 padding 区不写）。
            labels_df = labels_df.loc[
                (labels_df["trade_date"] >= g0) & (labels_df["trade_date"] <= g1)
            ].reset_index(drop=True)
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
                    suspended_set=derive_suspended_set(
                        suspend if not suspend.empty else None
                    ),
                    delist_map=derive_delist_map(delist if not delist.empty else None),
                    listing=listing if not listing.empty else None,
                    new_listing_min_days=new_listing_min_days,
                    # 全局日历：窗口无关 new_listing 计数（约束 1 / bug3）。
                    trade_calendar=trade_calendar,
                ),
                fwd_horizon_days=resolved_horizon,
            )
            # compute_* 原始输出（区间过滤前）为空 → 真异常
            if labels_df.empty:
                raise RuntimeError(
                    f"labels: compute_fwd_5d_ret produced 0 rows "
                    f"date_range={date_range!r} scheme={scheme!r} subrange={(g0, g1)!r}"
                )
            # 区间过滤到缺口 [g0,g1]（头部 padding 区不写；尾部 horizon 行被 shift 丢弃属正常）。
            # 过滤后合法地为空 → 仅 warning + 跳过本子区间，不 raise。
            labels_df = labels_df.loc[
                (labels_df["trade_date"] >= g0) & (labels_df["trade_date"] <= g1)
            ].reset_index(drop=True)

        if labels_df.empty:
            logger.warning(
                "labels_empty_after_range_filter",
                extra={"date_range": date_range, "scheme": scheme,
                       "subrange": (g0, g1)},
            )
            continue

        # 持久化 scheme 恒为调用方请求的 scheme（PK 组件）。strategy_aware 已在 compute
        # 内设为传入 scheme；fwd 路径(fallback.compute_fwd_5d_ret)内部用 base_scheme_codec
        # 重建规范名当 scheme 列，会把变体(如 fwd_ret_h1__recheck)误写进规范/生产 scheme。
        # 此处统一覆盖，确保对称、支持变体 scheme 重算/探查、杜绝误写生产。
        labels_df["scheme"] = scheme

        total_written += _upsert_labels(labels_df.to_dict("records"))

    _progress(PROGRESS_COMPUTE_DONE, "labels:compute")
    _progress(PROGRESS_DONE, "labels:done")
    logger.info(
        "labels_written",
        extra={"date_range": date_range, "scheme": scheme, "rows": total_written},
    )
    return total_written


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
    # force_recompute 可选（spec 02 §force_recompute）：默认 False 走增量缺口；
    # True 整段重算覆盖（= 改造前整段行为）。
    force_recompute = bool(params.get("force_recompute", False))
    # band_lock_max_hold 可选（仅 band_lock scheme 生效）：透传给 simulate_band_lock
    # 的 max_hold 硬上限；缺省 None=不设硬上限。非 band_lock scheme 下 compute_labels
    # 忽略该入参。校验 int（禁 bool / float / 字符串），越界由核 / 本处拦截。
    band_lock_max_hold_raw = params.get("band_lock_max_hold")
    band_lock_max_hold: int | None = None
    if band_lock_max_hold_raw is not None:
        if isinstance(band_lock_max_hold_raw, bool) or not isinstance(
            band_lock_max_hold_raw, int
        ):
            raise ValueError(
                f"band_lock_max_hold must be a positive int, "
                f"got {band_lock_max_hold_raw!r}"
            )
        if band_lock_max_hold_raw < 1:
            raise ValueError(
                f"band_lock_max_hold must be >= 1, got {band_lock_max_hold_raw!r}"
            )
        band_lock_max_hold = int(band_lock_max_hold_raw)
    job_id = getattr(job, "id", None)
    compute_labels(
        scheme=str(scheme),
        date_range=str(date_range),
        new_listing_min_days=new_listing_min_days,
        exit_rules=exit_rules,
        band_lock_max_hold=band_lock_max_hold,
        force_recompute=force_recompute,
        job_id=job_id,
    )


__all__ = ["compute_labels", "runner_entrypoint"]
