"""出场结构纯函数库 — kelly_sweep harness Phase 1。

口径基准：docs/superpowers/specs/2026-06-09-signal-kelly-research-harness-design/03-exit-structures.md

每个函数均为无副作用纯函数：输入 (ForwardPath, 参数)，输出 TradeResult。
所有持仓日计数以 bars 中可交易 bar 的 1-based 序号为准（停牌日已在加载时剔除）。
"""

from __future__ import annotations

from typing import Literal, Optional

from quant_pipeline.research.kelly_sweep.types import Bar, ForwardPath, TradeResult
from quant_pipeline.strategy.band_lock_exit import BandLockBar, simulate_band_lock


# ─────────────────────────────────────────────────────────────────────────────
# 内部辅助
# ─────────────────────────────────────────────────────────────────────────────


def _make_result(
    path: ForwardPath,
    bar: Bar,
    hold_days: int,
    exit_price: float,
    exit_reason: Literal["max_hold", "delist", "tp", "sl", "trailing", "atr"],
) -> TradeResult:
    """构造 TradeResult，ret 口径 = exit_price / buy_price - 1。"""
    return TradeResult(
        ts_code=path.ts_code,
        signal_date=path.signal_date,
        buy_date=path.buy_date,
        exit_date=bar.trade_date,
        buy_price=path.buy_price,
        exit_price=exit_price,
        ret=exit_price / path.buy_price - 1.0,
        hold_days=hold_days,
        exit_reason=exit_reason,
    )


def _check_delist(
    path: ForwardPath,
    bars: list[Bar],
    i: int,
    prev_bar: Bar,
    prev_hold_days: int,
) -> Optional[TradeResult]:
    """检查 bars[i] 是否触发退市强平条件。

    口径（spec §8 + TS simulator:231/268）：
        若 delist_date 不为 None 且 bars[i].trade_date >= delist_date
        → 用上一个有效 bar（prev_bar）的 qfq_close 强平，hold_days = prev_hold_days。
    """
    if path.delist_date is not None and bars[i].trade_date >= path.delist_date:
        return _make_result(
            path=path,
            bar=prev_bar,
            hold_days=prev_hold_days,
            exit_price=prev_bar.qfq_close,
            exit_reason="delist",
        )
    return None


# ─────────────────────────────────────────────────────────────────────────────
# 1. simulate_fixed_n
# ─────────────────────────────────────────────────────────────────────────────


def simulate_fixed_n(path: ForwardPath, n: int) -> TradeResult:
    """第 n 个可交易 bar 出场，exit_price = 该 bar.qfq_close，reason = max_hold。

    - n 从 1 开始计数（第 1 个 bar = bars[0] = buy_date 之后第一个可交易日）。
    - 若 bars 不足 n 个（窗口末端），以最后一个 bar 的 qfq_close 强平，reason = max_hold。
    - 退市优先（spec §8）：迭代中先检查退市，再计入 hold_days。
    """
    bars = path.bars

    if not bars:
        raise ValueError("ForwardPath.bars 为空，无法模拟出场")

    for i, bar in enumerate(bars):
        hold_days = i + 1  # 1-based

        # 退市检查：i >= 1 时检测（首个 bar 无前一有效 bar，跳过）
        if i >= 1:
            result = _check_delist(path, bars, i, prev_bar=bars[i - 1], prev_hold_days=i)
            if result is not None:
                return result

        # 第 n 个 bar（0-based index = n-1）出场
        if hold_days == n:
            return _make_result(path, bar, hold_days=hold_days, exit_price=bar.qfq_close, exit_reason="max_hold")

    # 窗口不足 n 个 bar：用最后一个 bar 强平
    last_bar = bars[-1]
    return _make_result(path, last_bar, hold_days=len(bars), exit_price=last_bar.qfq_close, exit_reason="max_hold")


# ─────────────────────────────────────────────────────────────────────────────
# 2. simulate_tp_sl
# ─────────────────────────────────────────────────────────────────────────────


def simulate_tp_sl(
    path: ForwardPath,
    tp_pct: float,
    sl_pct: float,
    max_hold: int,
    same_day_rule: Literal["sl_first", "tp_first"] = "sl_first",
) -> TradeResult:
    """固定比例止盈止损出场。

    - TP_level = entry * (1 + tp_pct)；SL_level = entry * (1 - sl_pct)。
    - 逐 bar 按时间序判断（bars 已剔停牌）。
    - 盘中触发：high >= TP_level 止盈；low <= SL_level 止损。
    - 跳空修正（spec §4）：open 已越过触发位时取 open。
    - 同日双触发（spec §5）：same_day_rule 控制先判止盈还是止损。
    - maxHold 兜底：第 max_hold 个 bar qfq_close 强平，reason = max_hold。
    - 退市优先（spec §8）。
    - 窗口不足：最后一个 bar qfq_close 强平，reason = max_hold。
    """
    bars = path.bars
    entry = path.buy_price
    tp_level = entry * (1.0 + tp_pct)
    sl_level = entry * (1.0 - sl_pct)

    if not bars:
        raise ValueError("ForwardPath.bars 为空，无法模拟出场")

    for i, bar in enumerate(bars):
        hold_days = i + 1  # 1-based

        # 退市检查：i >= 1 时检测（首个 bar 无前一有效 bar，跳过）
        if i >= 1:
            result = _check_delist(path, bars, i, prev_bar=bars[i - 1], prev_hold_days=i)
            if result is not None:
                return result

        # 触发判定
        hit_tp = bar.qfq_high >= tp_level
        hit_sl = bar.qfq_low <= sl_level

        if hit_tp and hit_sl:
            # 同日双触发：按 same_day_rule 决定
            if same_day_rule == "sl_first":
                exit_price = bar.qfq_open if bar.qfq_open <= sl_level else sl_level
                return _make_result(path, bar, hold_days, exit_price, "sl")
            else:  # tp_first
                exit_price = bar.qfq_open if bar.qfq_open >= tp_level else tp_level
                return _make_result(path, bar, hold_days, exit_price, "tp")
        elif hit_sl:
            exit_price = bar.qfq_open if bar.qfq_open <= sl_level else sl_level
            return _make_result(path, bar, hold_days, exit_price, "sl")
        elif hit_tp:
            exit_price = bar.qfq_open if bar.qfq_open >= tp_level else tp_level
            return _make_result(path, bar, hold_days, exit_price, "tp")

        # maxHold 兜底
        if hold_days >= max_hold:
            return _make_result(path, bar, hold_days, bar.qfq_close, "max_hold")

    # 窗口耗尽但未到 max_hold
    last_bar = bars[-1]
    return _make_result(path, last_bar, hold_days=len(bars), exit_price=last_bar.qfq_close, exit_reason="max_hold")


# ─────────────────────────────────────────────────────────────────────────────
# 3. simulate_trailing
# ─────────────────────────────────────────────────────────────────────────────


def simulate_trailing(
    path: ForwardPath,
    z_pct: float,
    max_hold: int,
) -> TradeResult:
    """移动止损出场。

    - peak = 持有期内截至上一 bar 的 qfq_high 最高值。
    - 触发：bar.qfq_low <= peak * (1 - z_pct) → reason = trailing。
    - exit_price = peak * (1 - z_pct)；若 open <= 回撤位则取 open（跳空修正）。
    - peak 更新次序（spec §6）：先用昨日 peak 判触发，再用今日 high 更新 peak。
    - maxHold 兜底；退市优先；窗口不足兜底。
    """
    bars = path.bars

    if not bars:
        raise ValueError("ForwardPath.bars 为空，无法模拟出场")

    # peak 初始化为首个持有 bar 的 qfq_high（bars[0] = buy_date 之后第一日）
    peak = bars[0].qfq_high

    for i, bar in enumerate(bars):
        hold_days = i + 1

        # 退市检查：i >= 1
        if i >= 1:
            result = _check_delist(path, bars, i, prev_bar=bars[i - 1], prev_hold_days=i)
            if result is not None:
                return result

            # 触发检查（用昨日 peak，即进入本 bar 前的 peak）
            trail_level = peak * (1.0 - z_pct)
            if bar.qfq_low <= trail_level:
                exit_price = bar.qfq_open if bar.qfq_open <= trail_level else trail_level
                # 更新 peak 不影响已触发的出场
                return _make_result(path, bar, hold_days, exit_price, "trailing")

            # 用今日 high 更新 peak
            if bar.qfq_high > peak:
                peak = bar.qfq_high
        # i=0 (首个持有 bar): peak 已初始化，不做触发判定（无昨日 peak）
        # maxHold 兜底
        if hold_days >= max_hold:
            return _make_result(path, bar, hold_days, bar.qfq_close, "max_hold")

    # 窗口耗尽
    last_bar = bars[-1]
    return _make_result(path, last_bar, hold_days=len(bars), exit_price=last_bar.qfq_close, exit_reason="max_hold")


# ─────────────────────────────────────────────────────────────────────────────
# 4. simulate_atr_stop
# ─────────────────────────────────────────────────────────────────────────────


def simulate_atr_stop(
    path: ForwardPath,
    k: float,
    max_hold: int,
    atr_trailing: bool = False,
) -> TradeResult:
    """ATR 倍数止损出场。

    - 初始止损 SL_level = entry - k * atr14_at_signal（spec §7）。
    - atr14_at_signal 为 None 时无法模拟 → 抛 ValueError。
    - 触发：bar.qfq_low <= SL_level；跳空修正同 §4。
    - atr_trailing=True：止损位随 peak - k*atr 上移（atr 用信号日固定值）。
    - reason = 'atr'；maxHold 兜底；退市优先；窗口不足兜底。
    """
    if path.atr14_at_signal is None:
        raise ValueError(
            f"atr14_at_signal 为 None（ts_code={path.ts_code}, signal_date={path.signal_date}），"
            "无法运行 simulate_atr_stop。"
        )

    bars = path.bars
    entry = path.buy_price
    atr = path.atr14_at_signal
    sl_level = entry - k * atr

    if not bars:
        raise ValueError("ForwardPath.bars 为空，无法模拟出场")

    # atr_trailing 需要跟踪 peak
    peak = bars[0].qfq_high if atr_trailing else 0.0

    for i, bar in enumerate(bars):
        hold_days = i + 1

        # 退市检查：i >= 1（首个 bar 无前一有效 bar，跳过）
        if i >= 1:
            result = _check_delist(path, bars, i, prev_bar=bars[i - 1], prev_hold_days=i)
            if result is not None:
                return result

            # atr_trailing：止损位随 (peak - k*atr) 上移，只上不下
            # 在触发判定前先更新 sl_level（使用进入本 bar 前的 peak）
            if atr_trailing:
                dynamic_sl = peak - k * atr
                sl_level = max(sl_level, dynamic_sl)

        # 触发判定（首个持有 bar 亦可触发，如跳空低开低于 SL）
        if bar.qfq_low <= sl_level:
            exit_price = bar.qfq_open if bar.qfq_open <= sl_level else sl_level
            return _make_result(path, bar, hold_days, exit_price, "atr")

        # 更新 peak（atr_trailing 模式）
        if atr_trailing and bar.qfq_high > peak:
            peak = bar.qfq_high

        if hold_days >= max_hold:
            return _make_result(path, bar, hold_days, bar.qfq_close, "max_hold")

    # 窗口耗尽
    last_bar = bars[-1]
    return _make_result(path, last_bar, hold_days=len(bars), exit_price=last_bar.qfq_close, exit_reason="max_hold")


# ─────────────────────────────────────────────────────────────────────────────
# 5. simulate_band_lock_exit（波段跟踪止损，复用 strategy/band_lock_exit.py 共享核）
# ─────────────────────────────────────────────────────────────────────────────


def _to_band_lock_bar(bar: Bar) -> BandLockBar:
    """把 kelly_sweep 的 Bar 适配成共享核 BandLockBar（adj_*=qfq_*）。

    kelly_sweep 全程前复权（qfq）→ 共享核的复权基准 adj_* 直接喂 qfq_*。
    Bar.bars 已剔停牌（停牌日不在序列内），故 is_suspended 恒 False；ma5/raw/limit
    缺失时为 None，共享核各自按"该端约束不生效 / 不触发 MA5 离场"降级（不误杀）。
    """
    return BandLockBar(
        adj_open=bar.qfq_open,
        adj_high=bar.qfq_high,
        adj_low=bar.qfq_low,
        adj_close=bar.qfq_close,
        ma5=bar.ma5,
        raw_open=bar.raw_open,
        raw_high=bar.raw_high,
        up_limit=bar.up_limit,
        down_limit=bar.down_limit,
        is_suspended=False,
    )


def simulate_band_lock_exit(
    path: ForwardPath,
    *,
    max_hold: Optional[int] = None,
    stop_ratio: float = 0.999,
    floor_ratio: float = 0.999,
    floor_enabled: bool = True,
    ma5_require_down: bool = True,
) -> Optional[TradeResult]:
    """波段跟踪止损出场：把 path 适配后调 strategy/band_lock_exit.py 共享核。

    口径对接（spec 03 §三 + 共享核 docstring）：
      - 共享核约定 bars[0] = 持仓首日 T+1、cost=adj_open(T+1)、方案由 adj_close(T+1) 判定；
        而 kelly_sweep 的 path.bars[0] 是 buy_date **之后**第一日（不含 buy_date），buy_date(T+1)
        本身存于 path.buy_bar。故喂核序列 = [buy_bar] + path.bars（把持仓首日拼回开头）。
      - signal_high = path.signal_bar_high（信号日 T 的 qfq_high）。
      - 出场价直接用核给的复权价（exit_price，已是 qfq），ret = exit_price/buy_price - 1
        （buy_price = buy_bar 的 qfq_open，即 path.buy_price）。

    无交易（返回 None，不计入凯利样本，与 atr_stop 无 ATR 同形态）：
      - 入场买不进：核返回 kind='no_entry'（buy_bar 一字涨停 raw_open≥up_limit / 停牌）。
        注：kelly_sweep 上游 enumerate_signals 已按 buy_date 一字涨停剔信号，此分支通常不触发，
        但保留以与其它两模块及 spec 口径一致、并防御 buy_bar 缺失。
      - 数据不全：path.buy_bar 为 None 或 path.signal_bar_high 为 None（band_lock 必需输入缺失）。

    退市 / 窗口耗尽兜底（核不处理，调用方收口，spec 01 §六）：
      - 退市优先：若 path.bars 中存在 trade_date>=delist_date 的 bar（下标 j>=1），则核只在
        delist 之前的 bar 上推进；核未在 delist 前出场 → 用 bars[j-1].qfq_close 强平、reason=delist
        （与 _check_delist 现有口径一致：用上一有效 bar close、hold_days=j）。
      - 窗口耗尽（核 no_exit 且无退市）：用最后一个 bar.qfq_close 强平、reason=max_hold
        （与其它出场族窗口不足兜底一致）。

    Args:
        path:             ForwardPath（须含 buy_bar + signal_bar_high，由 load_forward_paths 填充）。
        max_hold:         band_lock 硬上限（已走过可交易持有日数）；None=不封顶。
        stop_ratio:       止损缓冲系数（覆盖核 4 处止损基准 × 系数），默认 0.999=现状。
        floor_ratio:      成本地板系数（floor_price=floor2(cost×floor_ratio)），默认 0.999=现状；
                          >1 时从「保本」变「锁盈」。仅 floor_enabled=True 时生效。
        floor_enabled:    是否启用方案二成本地板，默认 True=现状；False 时核三处地板逻辑全短路。
        ma5_require_down: 锁定后 MA5 离场是否要求均线下行，默认 True=现状；False 时收盘跌破 MA5 即离场。

    四参数默认值钉死共享核 strategy/band_lock_exit.py 现存硬编码 → 全默认时与现状逐字一致（零漂移）。

    Returns:
        TradeResult；无交易时 None。
    """
    bars = path.bars
    if not bars:
        raise ValueError("ForwardPath.bars 为空，无法模拟出场")

    # band_lock 必需输入缺失 → 无法模拟，按"无交易"处理（不计入样本）
    if path.buy_bar is None or path.signal_bar_high is None:
        return None

    # ── 退市优先：截断 delist_date 当日及之后的 bar（核只在 delist 前推进）──────
    # 与 _check_delist 口径一致：仅 j>=1 的 bar 触发退市（首个持有日 bars[0] 不被退市预占）。
    delist_cut = len(bars)  # 默认不截断
    if path.delist_date is not None:
        for j in range(1, len(bars)):
            if bars[j].trade_date >= path.delist_date:
                delist_cut = j
                break
    held_bars = bars[:delist_cut]

    # ── 喂核：[持仓首日 buy_bar] + delist 前的持有 bar ──────────────────────────
    core_bars = [_to_band_lock_bar(path.buy_bar)] + [
        _to_band_lock_bar(b) for b in held_bars
    ]
    outcome = simulate_band_lock(
        core_bars,
        path.signal_bar_high,
        max_hold=max_hold,
        stop_ratio=stop_ratio,
        floor_ratio=floor_ratio,
        floor_enabled=floor_enabled,
        ma5_require_down=ma5_require_down,
    )

    if outcome.kind == "no_entry":
        return None

    if outcome.kind == "exit":
        # exit_index 是 core_bars 下标：0=buy_bar(持仓首日，核内不出场)、k>=1 → held_bars[k-1]。
        # 共享核保证持仓首日不出场，故 exit_index>=1。
        ei = outcome.exit_index
        assert ei is not None and ei >= 1, (
            f"band_lock 出场 exit_index 应 >=1（持仓首日不出场），实得 {ei!r}"
        )
        exit_bar = held_bars[ei - 1]
        assert outcome.exit_price is not None
        assert outcome.hold_days is not None
        # band_lock 的 reason ∈ {stop, ma5_exit, max_hold}，均在 TradeResult.exit_reason 联合内。
        reason: Literal["stop", "ma5_exit", "max_hold"] = outcome.reason  # type: ignore[assignment]
        return _make_result(
            path,
            exit_bar,
            hold_days=outcome.hold_days,
            exit_price=outcome.exit_price,
            exit_reason=reason,
        )

    # outcome.kind == 'no_exit'：核未出场（含顺延未解 / 窗口耗尽）→ 调用方收口
    if delist_cut < len(bars):
        # 退市优先：核在 delist 前未出场 → 用 delist 前一个有效 bar 的 qfq_close 强平
        prev_bar = bars[delist_cut - 1]
        return _make_result(
            path,
            prev_bar,
            hold_days=delist_cut,
            exit_price=prev_bar.qfq_close,
            exit_reason="delist",
        )

    # 无退市、窗口耗尽 → 最后一个 bar qfq_close 强平
    last_bar = bars[-1]
    return _make_result(
        path,
        last_bar,
        hold_days=len(bars),
        exit_price=last_bar.qfq_close,
        exit_reason="max_hold",
    )
