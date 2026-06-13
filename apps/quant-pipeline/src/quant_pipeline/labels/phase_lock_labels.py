"""阶段锁定 phase_lock 标签（独立有状态 scheme）。

phase_lock 是「阶段锁定出场」整套**有状态**出场方案，**不**走 strategy_aware 的
first-match `_RULE_BUILDERS` / `simulate_exit` 框架，而是直接调用共享纯函数核
strategy.phase_lock_exit.simulate_phase_lock（单一行为真值，S1~S15 单测 + 跨语言
TS 对拍护门）。**镜像 band_lock_labels.py**，仅出场核与参数集替换为 phase_lock。

与 strategy_aware 的口径差异（**仅本 scheme**，不动其它出场规则）：
  - 买入价 = T+1 **开盘 hfq open_adj**（strategy_aware 用 T+1 close_adj）。
  - **不**取 signal_high；初始止损用 recent_lows（含 T+1 的最近 lookback 个
    非停牌在场行 low_adj，升序）—— 由本数据层切好传给核（类比 band_lock 传
    signal_high）。
  - 限停板顺延在共享核内，用 raw_open/raw_high + up_limit/down_limit 判定。
  - MA5 = 5 个非停牌交易日的 hfq close 滚动均值（与 band_lock_labels._ensure_ma5
    同口径）。预热不足为 None。

写入 factors.labels（trade_date=信号日 T, ts_code, scheme, value, exit_reason,
hold_days），列与 strategy_aware / band_lock 完全一致：
  value       = exit_price / buy_price - 1（毛收益，未扣成本；成本由 portfolio
                评估层扣减）。
  exit_reason = 'phase_lock_stop' / 'phase_lock_ma5'（核给出）/ 'force_close'
                （核返回 no_exit 时由本模块按数据末尾兜底收口）。
  hold_days   = 核给出的已走过可交易持有日数（持仓首日=0）；force_close 兜底时
                取已统计到的可交易持有日数。

入场过滤（涨停 / 停牌 / 次新）复用 strategy_aware 的 3 个纯函数（口径一致）。
退市强平由本模块 force_close_date 兜底（核不处理退市）。

CLAUDE.md 硬约束：
  - 列名 / 表名落库前已亲查真 DB 核对（见 runner.py 取价 SQL + band_lock_labels）。
  - 文件 I/O 显式 encoding='utf-8'；本模块纯计算不直接做文件 I/O。
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from typing import Final

import numpy as np
import pandas as pd

from quant_pipeline.labels._common import (
    PROGRESS_SIMULATE_SPAN,
    PROGRESS_SIMULATE_START,
    dedup_labels,
    derive_delist_map,
    derive_limit_up_set,
    derive_list_date_map,
    derive_suspended_set,
    empty_labels_frame,
)
from quant_pipeline.labels.phase_lock_scheme import (
    DEFAULT_INIT_FACTOR,
    DEFAULT_LOCK_FACTOR,
    DEFAULT_LOOKBACK,
)
from quant_pipeline.labels.strategy_aware import (
    LIMIT_TOLERANCE,
    NEW_LISTING_MIN_DAYS,
    LabelInputs,
    _validate_min_days,
    filter_limit_up_on_entry,
    filter_new_listing,
    filter_suspended_on_entry,
)
from quant_pipeline.strategy.exit_rules import EXIT_FORCE_CLOSE, MA_WINDOW
from quant_pipeline.strategy.phase_lock_exit import (
    PhaseLockBar,
    PhaseLockOutcome,
    simulate_phase_lock,
)

logger = logging.getLogger(__name__)

# phase_lock scheme 字面量（base_scheme_codec 的 legacy 别名，守 PK 稳定）。
PHASE_LOCK_SCHEME: Final[str] = "phase_lock"

# 核出场 reason → factors.labels.exit_reason 直接落库（核已给规范字面量）。
# 'phase_lock_stop' / 'phase_lock_ma5' 原样写入；'force_close' 由本模块兜底产出。


def _finite_or_none(value: object) -> float | None:
    """转 float；None / NaN / 非数值 / 非有限 → None（喂核前的统一清洗）。"""

    fv = float(pd.to_numeric(value, errors="coerce"))
    return fv if np.isfinite(fv) else None


def _ensure_ma5(sub: pd.DataFrame, window: int = MA_WINDOW) -> pd.DataFrame:
    """按 trade_date 升序对 close_adj 滚动 window 日均值，写入 'ma5' 列。

    与 band_lock_labels._ensure_ma5 逐字同口径（shift 错位逐元素相加，窗口无关 /
    bit-stable）：MA5(t) = (Σ_{j=0}^{w-1} close_adj[t-j]) / w，只依赖窗口内 w 个
    在场日收盘价、与序列起点无关 → 增量与整段重算逐位一致。前 w-1 行为 NaN
    （预热不足 → None）。A 股停牌日缺行 → sub 天然只含在场日 → 即"5 个非停牌交易日"
    均值。
    """

    out = sub.sort_values("trade_date").reset_index(drop=True)
    if "close_adj" not in out.columns:
        out["ma5"] = np.nan
        return out
    close = pd.to_numeric(out["close_adj"], errors="coerce")
    acc = close.copy()
    for j in range(1, window):
        acc = acc + close.shift(j)
    out["ma5"] = acc / window
    return out


def _slice_recent_lows(
    sub: pd.DataFrame,
    *,
    buy_date: str,
    lookback: int,
    suspended_set: set[tuple[str, str]],
    ts_code: str,
) -> list[float]:
    """切 recent_lows：含 T+1（buy_date）的最近 lookback 个**非停牌在场行** low_adj（升序）。

    sub：单 ts_code、按 trade_date 升序、已注入 ma5 的价格切片（含 buy_date 之前的
        左扩 head 行）。
    口径（spec 02/03）：取 trade_date <= buy_date 的所有在场行，过滤停牌（A 股停牌
        缺行天然不在 sub；冗余防御额外剔 suspended_set 命中 / low_adj 缺失行），按
        trade_date 升序取**最后** lookback 个（= 最近 lookback 个，含 buy_date 自身），
        返回这些行的 low_adj（升序 = 按 trade_date 升序，core 只做 min 不依赖排序，
        但与 spec「升序」一致）。不足 lookback 根 → 用现有可用根数（至少含 T+1）。
        理论上 buy_date 已过入场过滤、必在场，故至少 1 根。
    """

    window = sub[sub["trade_date"] <= str(buy_date)]
    lows: list[float] = []
    for td_v, low_v in zip(window["trade_date"], window["low_adj"], strict=False):
        td = str(td_v)
        if (ts_code, td) in suspended_set:
            continue  # 冗余防御：suspend_d 标记的停牌日不计入
        low = _finite_or_none(low_v)
        if low is None:
            continue  # 复权 low 缺失（停牌缺行 / 复权因子缺）→ 不计入
        lows.append(low)
    # 取最近 lookback 个（按 trade_date 升序的最后 lookback 个，含 buy_date）。
    return lows[-lookback:] if lookback > 0 else []


def _build_bars_for_stock(
    sub: pd.DataFrame,
    *,
    buy_date: str,
    stk_limit_map: Mapping[tuple[str, str], tuple[float | None, float | None]],
    suspended_set: set[tuple[str, str]],
    ts_code: str,
    force_close_date: str | None = None,
) -> list[PhaseLockBar]:
    """把单只票 buy_date 起的持仓窗口逐日组装成 PhaseLockBar 列表（bars[0]=T+1）。

    与 band_lock_labels._build_bars_for_stock 同口径（仅 BandLockBar → PhaseLockBar）。
    sub：单 ts_code、按 trade_date 升序、已注入 ma5 列的价格切片；含列
        open_adj / high_adj / low_adj / close_adj（hfq）+ open / high（raw）+ ma5。
    停牌日 A 股 daily_quote 无行 → 不在 sub 内、自然不进 bars。冗余防御：若某行落在
        suspended_set 则把 adj_* 置 None 标停牌。
    限停板：up_limit/down_limit 从 stk_limit_map 取（缺则 None → 该端约束不生效）。
    force_close_date：退市公告日 / 外部强制平仓日（YYYYMMDD）；窗口截断到该日之前
        （trade_date < force_close_date），使核在退市前耗尽窗口返回 no_exit，再由
        调用方按 _force_close_outcome 收口。
    """

    window = sub[sub["trade_date"] >= str(buy_date)]
    if force_close_date is not None:
        window = window[window["trade_date"] < str(force_close_date)]
    window = window.reset_index(drop=True)

    bars: list[PhaseLockBar] = []
    for _, row in window.iterrows():
        td = str(row["trade_date"])
        up_limit, down_limit = stk_limit_map.get((ts_code, td), (None, None))
        is_susp = (ts_code, td) in suspended_set

        bars.append(
            PhaseLockBar(
                adj_open=None if is_susp else _finite_or_none(row.get("open_adj")),
                adj_high=None if is_susp else _finite_or_none(row.get("high_adj")),
                adj_low=None if is_susp else _finite_or_none(row.get("low_adj")),
                adj_close=None if is_susp else _finite_or_none(row.get("close_adj")),
                ma5=None if is_susp else _finite_or_none(row.get("ma5")),
                raw_open=_finite_or_none(row.get("open")),
                raw_high=_finite_or_none(row.get("high")),
                up_limit=up_limit,
                down_limit=down_limit,
                is_suspended=is_susp,
            )
        )
    return bars


def _force_close_outcome(
    bars: list[PhaseLockBar],
) -> tuple[float | None, int]:
    """核返回 no_exit 时的数据末尾兜底：按最后一个有效收盘 hfq close 强平。

    沿用 band_lock_labels._force_close_outcome 语义（向前回溯最近一个有限 adj_close）；
    hold_days = 窗口内已走过的可交易持有日数（持仓首日=0，停牌日不计），与核口径一致。
    找不到任何有效收盘 → (None, hold) 由调用方丢弃该候选。
    """

    tradable = [
        b for b in bars[1:]
        if not (b.is_suspended or b.adj_close is None)
    ]
    hold = len(tradable)
    for b in reversed(bars):
        if b.adj_close is not None and np.isfinite(b.adj_close):
            return float(b.adj_close), hold
    return None, hold


def compute_phase_lock_labels(
    inputs: LabelInputs,
    progress_callback: Callable[[int, str], None] | None = None,
    *,
    scheme: str = PHASE_LOCK_SCHEME,
    init_factor: float = DEFAULT_INIT_FACTOR,
    lock_factor: float = DEFAULT_LOCK_FACTOR,
    lookback: int = DEFAULT_LOOKBACK,
) -> pd.DataFrame:
    """计算 phase_lock 标签长表（factors.labels 直接 upsert 列）。

    返回 DataFrame 列：trade_date / ts_code / scheme / value / exit_reason / hold_days

    每条对应一次「signal_date=T → buy_date=T+1 开盘买入 → phase_lock 核推进出场」：
      - trade_date = 信号日 T；
      - buy_price  = T+1 日 hfq open_adj；
      - recent_lows = 含 T+1 的最近 lookback 个非停牌在场行 low_adj（升序，本层切好）；
      - exit_price = 核给出（hfq），no_exit → force_close 兜底；
      - value = exit_price / buy_price - 1（毛收益）。
    信号日为窗口最后一个交易日、取不到 T+1 → 跳过该候选（边界样本，正常）。

    参数：
      scheme:       写入 records 的 scheme（factors.labels.scheme）。
      init_factor:  初始止损系数（× min(recent_lows)），透传给核；默认 0.999（零漂移）。
      lock_factor:  锁定止损系数（× max(cost, 当日 low)），透传给核；默认 0.999。
                    init/lock 系数默认 = 共享核 simulate_phase_lock 现状硬编码 →
                    全默认调用与改造前逐位一致（feature_set_id 哈希不漂移）。
      lookback:     初始止损回看根数（含 T+1 的非停牌在场行）；默认 10。仅作用于
                    recent_lows 切片（本数据层），核不消费 lookback。
    """

    quotes = inputs.daily_quotes
    if quotes is None or quotes.empty:
        logger.warning("phase_lock_empty_quotes")
        return empty_labels_frame()

    # 必须含 hfq open/high/low/close + raw open/high（phase_lock 买在开盘、用 recent_lows）。
    required = {
        "ts_code", "trade_date",
        "open", "high",
        "open_adj", "high_adj", "low_adj", "close_adj",
    }
    if not required.issubset(quotes.columns):
        raise ValueError(
            f"phase_lock daily_quotes 必须含列 {required}, got {list(quotes.columns)}"
        )

    q = quotes.copy()
    q["ts_code"] = q["ts_code"].astype(str)
    q["trade_date"] = q["trade_date"].astype(str)

    # 窗口交易日历（升序去重）。trade_date 为 YYYYMMDD 定宽字符串，字典序即时序。
    trade_dates_sorted = sorted(q["trade_date"].unique().tolist())
    next_day = {
        d: trade_dates_sorted[i + 1]
        for i, d in enumerate(trade_dates_sorted[:-1])
    }

    # 候选 entries（trade_date=信号日 T）
    if inputs.entries is not None and not inputs.entries.empty:
        cand = inputs.entries[["ts_code", "trade_date"]].rename(
            columns={"trade_date": "signal_date"}
        ).copy()
    else:
        cand = q[["ts_code", "trade_date"]].rename(
            columns={"trade_date": "signal_date"}
        ).copy()
    cand["ts_code"] = cand["ts_code"].astype(str)
    cand["signal_date"] = cand["signal_date"].astype(str)

    # 派生 buy_date = 信号日下一交易日；取不到 → 丢弃（窗口末日边界样本）。
    cand["buy_date"] = cand["signal_date"].map(next_day)
    cand = cand[cand["buy_date"].notna()].reset_index(drop=True)
    if cand.empty:
        logger.warning("phase_lock_no_candidates_after_t1")
        return empty_labels_frame()

    # 派生 lookup（与 strategy_aware 同源同口径）。
    limit_up_set = derive_limit_up_set(q, inputs.stk_limit, tolerance=LIMIT_TOLERANCE)
    suspended_set = derive_suspended_set(inputs.suspend_d)
    delist_map = derive_delist_map(inputs.delist)
    list_date_map = derive_list_date_map(inputs.listing)

    # 入场过滤 ① ② ③ —— 全部以 buy_date（T+1）为准（复用 strategy_aware 纯函数）。
    cand = filter_limit_up_on_entry(
        cand, limit_up_set=limit_up_set, entry_col="buy_date"
    )
    cand = filter_suspended_on_entry(
        cand, suspended_set=suspended_set, entry_col="buy_date"
    )
    min_days = (
        inputs.new_listing_min_days
        if inputs.new_listing_min_days is not None
        else NEW_LISTING_MIN_DAYS
    )
    _validate_min_days(min_days)
    new_listing_calendar = (
        inputs.trade_calendar
        if inputs.trade_calendar is not None
        else trade_dates_sorted
    )
    cand = filter_new_listing(
        cand,
        list_date_map=list_date_map,
        trade_dates_sorted=new_listing_calendar,
        min_days=min_days,
        entry_col="buy_date",
    )
    if cand.empty:
        logger.warning("phase_lock_no_candidates_after_filters")
        return empty_labels_frame()

    # stk_limit 反查表：(ts_code, trade_date) → (up_limit, down_limit)。
    stk_limit_map: dict[tuple[str, str], tuple[float | None, float | None]] = {}
    if inputs.stk_limit is not None and not inputs.stk_limit.empty:
        sl = inputs.stk_limit
        for ts_code_v, td_v, up_v, dn_v in zip(
            sl["ts_code"].astype(str),
            sl["trade_date"].astype(str),
            pd.to_numeric(sl["up_limit"], errors="coerce"),
            pd.to_numeric(sl["down_limit"], errors="coerce"),
            strict=False,
        ):
            up = float(up_v) if np.isfinite(up_v) else None
            dn = float(dn_v) if np.isfinite(dn_v) else None
            stk_limit_map[(ts_code_v, td_v)] = (up, dn)

    # 按 ts_code 分组、注入 ma5（hfq close_adj 滚动 5 日；窗口无关）。
    grouped: dict[str, pd.DataFrame] = {
        str(c): _ensure_ma5(df.sort_values("trade_date").reset_index(drop=True))
        for c, df in q.groupby("ts_code", sort=False)
    }

    records: list[dict[str, object]] = []
    cand_dedup = cand.drop_duplicates(
        subset=["ts_code", "signal_date"], keep="first"
    ).reset_index(drop=True)
    total = len(cand_dedup)
    report_interval = max(1, total // 100)

    for i, (_, e) in enumerate(cand_dedup.iterrows()):
        if progress_callback is not None and i % report_interval == 0:
            pct = PROGRESS_SIMULATE_START + int(PROGRESS_SIMULATE_SPAN * i / total)
            progress_callback(pct, f"labels:simulate {i}/{total}")

        ts_code = str(e["ts_code"])
        signal_date = str(e["signal_date"])
        buy_date = str(e["buy_date"])
        sub = grouped.get(ts_code)
        if sub is None or sub.empty:
            continue

        # recent_lows：含 T+1 的最近 lookback 个非停牌在场行 low_adj（升序，本层切好）。
        recent_lows = _slice_recent_lows(
            sub,
            buy_date=buy_date,
            lookback=lookback,
            suspended_set=suspended_set,
            ts_code=ts_code,
        )

        bars = _build_bars_for_stock(
            sub,
            buy_date=buy_date,
            stk_limit_map=stk_limit_map,
            suspended_set=suspended_set,
            ts_code=ts_code,
            # 退市强平：截断窗口到退市日之前，核耗尽窗口返回 no_exit → force_close 收口。
            force_close_date=delist_map.get(ts_code),
        )
        if not bars:
            continue

        outcome: PhaseLockOutcome = simulate_phase_lock(
            bars,
            recent_lows,
            init_factor=init_factor,
            lock_factor=lock_factor,
        )

        # 买入价 = T+1 hfq open_adj（核已校验入场端；no_entry → 跳过）。
        if outcome.kind == "no_entry":
            continue

        buy_price = bars[0].adj_open
        if buy_price is None or not np.isfinite(buy_price) or buy_price <= 0:
            continue

        if outcome.kind == "exit":
            exit_price = outcome.exit_price
            exit_reason = str(outcome.reason)
            hold_days = int(outcome.hold_days) if outcome.hold_days is not None else 0
        else:
            # kind == 'no_exit'：核未出场（含顺延未解）→ 数据末尾 force_close 兜底。
            exit_price, hold_days = _force_close_outcome(bars)
            exit_reason = EXIT_FORCE_CLOSE
            if exit_price is None or not np.isfinite(exit_price):
                continue

        if exit_price is None or not np.isfinite(exit_price):
            continue
        gross = float(exit_price) / float(buy_price) - 1.0

        records.append(
            {
                "trade_date": signal_date,
                "ts_code": ts_code,
                "scheme": scheme,
                "value": gross,
                "exit_reason": exit_reason,
                "hold_days": int(hold_days),
            }
        )

    if not records:
        logger.warning("phase_lock_no_outcomes")
        return empty_labels_frame()

    out = pd.DataFrame(records)
    out = dedup_labels(out, log_key="phase_lock_compute_dedup")
    return out[["trade_date", "ts_code", "scheme", "value", "exit_reason", "hold_days"]]


__all__ = [
    "PHASE_LOCK_SCHEME",
    "compute_phase_lock_labels",
]
