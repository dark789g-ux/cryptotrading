"""单元测试：kelly_sweep/exits.py 出场结构纯函数。

口径基准：docs/superpowers/specs/2026-06-09-signal-kelly-research-harness-design/03-exit-structures.md

测试策略：全部使用 synthetic ForwardPath（手工构造 bars），不依赖 DB。
"""

from __future__ import annotations

import pytest

from quant_pipeline.research.kelly_sweep.exits import (
    simulate_atr_stop,
    simulate_fixed_n,
    simulate_tp_sl,
    simulate_trailing,
)
from quant_pipeline.research.kelly_sweep.types import Bar, ForwardPath


# ─────────────────────────────────────────────────────────────────────────────
# 辅助构造器
# ─────────────────────────────────────────────────────────────────────────────


def make_bar(
    trade_date: str,
    open_: float = 10.0,
    high: float = 10.5,
    low: float = 9.5,
    close: float = 10.0,
) -> Bar:
    return Bar(
        trade_date=trade_date,
        qfq_open=open_,
        qfq_high=high,
        qfq_low=low,
        qfq_close=close,
    )


def make_path(
    bars: list[Bar],
    buy_price: float = 10.0,
    delist_date: str | None = None,
    atr14_at_signal: float | None = None,
    ts_code: str = "000001.SZ",
    signal_date: str = "20260101",
    buy_date: str = "20260102",
) -> ForwardPath:
    return ForwardPath(
        ts_code=ts_code,
        signal_date=signal_date,
        buy_date=buy_date,
        buy_price=buy_price,
        bars=bars,
        delist_date=delist_date,
        atr14_at_signal=atr14_at_signal,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1. simulate_fixed_n
# ─────────────────────────────────────────────────────────────────────────────


class TestSimulateFixedN:
    def test_basic_n1(self):
        """第 1 个 bar 出场（buy_date 之后第一个可交易日）。"""
        bars = [make_bar("20260102", close=10.5)]
        path = make_path(bars, buy_price=10.0)
        r = simulate_fixed_n(path, n=1)
        assert r.exit_date == "20260102"
        assert r.exit_price == pytest.approx(10.5)
        assert r.hold_days == 1
        assert r.exit_reason == "max_hold"
        assert r.ret == pytest.approx(0.05)

    def test_basic_n3(self):
        """第 3 个 bar 出场。"""
        bars = [
            make_bar("20260102", close=10.0),
            make_bar("20260103", close=11.0),
            make_bar("20260106", close=12.0),
            make_bar("20260107", close=13.0),
        ]
        path = make_path(bars, buy_price=10.0)
        r = simulate_fixed_n(path, n=3)
        assert r.exit_date == "20260106"
        assert r.exit_price == pytest.approx(12.0)
        assert r.hold_days == 3
        assert r.exit_reason == "max_hold"

    def test_window_insufficient_falls_back_to_last_bar(self):
        """bars 不足 n 个时，用最后一个 bar qfq_close 强平。"""
        bars = [
            make_bar("20260102", close=10.0),
            make_bar("20260103", close=10.8),
        ]
        path = make_path(bars, buy_price=10.0)
        r = simulate_fixed_n(path, n=5)
        assert r.exit_date == "20260103"
        assert r.exit_price == pytest.approx(10.8)
        assert r.hold_days == 2
        assert r.exit_reason == "max_hold"

    def test_delist_priority(self):
        """退市优先：bars[2].trade_date >= delist_date → 用 bars[1] qfq_close 强平。"""
        bars = [
            make_bar("20260102", close=10.0),
            make_bar("20260103", close=11.0),
            make_bar("20260106", close=12.0),  # 20260106 >= 20260106 → delist
        ]
        path = make_path(bars, buy_price=10.0, delist_date="20260106")
        r = simulate_fixed_n(path, n=10)
        assert r.exit_date == "20260103"
        assert r.exit_price == pytest.approx(11.0)
        assert r.exit_reason == "delist"
        assert r.hold_days == 2


# ─────────────────────────────────────────────────────────────────────────────
# 2. simulate_tp_sl
# ─────────────────────────────────────────────────────────────────────────────


class TestSimulateTpSl:
    def _path(self, bars, buy_price=10.0, **kw):
        return make_path(bars, buy_price=buy_price, **kw)

    def test_sl_triggered(self):
        """止损触发：low <= SL_level，exit_price = SL_level。"""
        # buy_price=10, sl=0.05 → SL_level=9.5
        bars = [
            make_bar("20260102", open_=10.0, high=10.2, low=9.4, close=9.6),
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_tp_sl(path, tp_pct=0.1, sl_pct=0.05, max_hold=10)
        assert r.exit_reason == "sl"
        assert r.exit_price == pytest.approx(9.5)
        assert r.hold_days == 1
        assert r.ret == pytest.approx(-0.05)

    def test_tp_triggered(self):
        """止盈触发：high >= TP_level，exit_price = TP_level。"""
        # buy_price=10, tp=0.1 → TP_level=11.0
        bars = [
            make_bar("20260102", open_=10.0, high=11.5, low=9.8, close=11.0),
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_tp_sl(path, tp_pct=0.1, sl_pct=0.05, max_hold=10)
        assert r.exit_reason == "tp"
        assert r.exit_price == pytest.approx(11.0)
        assert r.hold_days == 1
        assert r.ret == pytest.approx(0.1)

    def test_tp_no_trigger_until_max_hold(self):
        """多 bar 都未触发，到 max_hold 兜底。"""
        bars = [
            make_bar("20260102", open_=10.0, high=10.3, low=9.7, close=10.0),
            make_bar("20260103", open_=10.0, high=10.3, low=9.7, close=10.1),
            make_bar("20260106", open_=10.0, high=10.3, low=9.7, close=10.2),
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_tp_sl(path, tp_pct=0.1, sl_pct=0.05, max_hold=3)
        assert r.exit_reason == "max_hold"
        assert r.exit_price == pytest.approx(10.2)
        assert r.hold_days == 3
        assert r.exit_date == "20260106"

    # ── 跳空修正 ──────────────────────────────────────────────────────────────

    def test_gap_down_open_below_sl(self):
        """跳空低开：open <= SL_level → exit_price = open（比止损位更差）。"""
        # buy_price=10, sl=0.05 → SL_level=9.5; open=9.0 < 9.5
        bars = [
            make_bar("20260102", open_=9.0, high=9.3, low=8.8, close=9.1),
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_tp_sl(path, tp_pct=0.1, sl_pct=0.05, max_hold=10)
        assert r.exit_reason == "sl"
        assert r.exit_price == pytest.approx(9.0)
        assert r.ret == pytest.approx(-0.1)

    def test_gap_up_open_above_tp(self):
        """跳空高开：open >= TP_level → exit_price = open（比止盈位更好）。"""
        # buy_price=10, tp=0.1 → TP_level=11.0; open=11.5 > 11.0
        bars = [
            make_bar("20260102", open_=11.5, high=12.0, low=11.3, close=11.8),
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_tp_sl(path, tp_pct=0.1, sl_pct=0.05, max_hold=10)
        assert r.exit_reason == "tp"
        assert r.exit_price == pytest.approx(11.5)
        assert r.ret == pytest.approx(0.15)

    # ── 同日双触发 ────────────────────────────────────────────────────────────

    def test_same_day_double_trigger_sl_first(self):
        """同日 high>=TP 且 low<=SL，sl_first → reason=sl，exit_price=SL_level。"""
        # buy_price=10, tp=0.1 → TP=11.0, sl=0.05 → SL=9.5
        bars = [
            make_bar("20260102", open_=10.0, high=11.5, low=9.3, close=10.0),
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_tp_sl(path, tp_pct=0.1, sl_pct=0.05, max_hold=10, same_day_rule="sl_first")
        assert r.exit_reason == "sl"
        assert r.exit_price == pytest.approx(9.5)

    def test_same_day_double_trigger_tp_first(self):
        """同日 high>=TP 且 low<=SL，tp_first → reason=tp，exit_price=TP_level。"""
        bars = [
            make_bar("20260102", open_=10.0, high=11.5, low=9.3, close=10.0),
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_tp_sl(path, tp_pct=0.1, sl_pct=0.05, max_hold=10, same_day_rule="tp_first")
        assert r.exit_reason == "tp"
        assert r.exit_price == pytest.approx(11.0)

    def test_same_day_sl_first_gap_down(self):
        """同日双触发 + 跳空低开：sl_first，open <= SL_level → exit_price=open。"""
        # open=9.0 < SL_level=9.5，且 high>=TP=11.0
        bars = [
            make_bar("20260102", open_=9.0, high=11.5, low=8.8, close=10.0),
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_tp_sl(path, tp_pct=0.1, sl_pct=0.05, max_hold=10, same_day_rule="sl_first")
        assert r.exit_reason == "sl"
        assert r.exit_price == pytest.approx(9.0)

    def test_same_day_tp_first_gap_up(self):
        """同日双触发 + 跳空高开：tp_first，open >= TP_level → exit_price=open。"""
        # open=11.5 > TP_level=11.0，且 low<=SL=9.5
        bars = [
            make_bar("20260102", open_=11.5, high=12.0, low=9.3, close=10.0),
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_tp_sl(path, tp_pct=0.1, sl_pct=0.05, max_hold=10, same_day_rule="tp_first")
        assert r.exit_reason == "tp"
        assert r.exit_price == pytest.approx(11.5)

    # ── 退市优先 ──────────────────────────────────────────────────────────────

    def test_delist_priority(self):
        """退市优先：持有推进中遇 delist → 用上一 bar close 强平。"""
        bars = [
            make_bar("20260102", close=10.0),
            make_bar("20260103", close=10.5),
            make_bar("20260106", close=11.0),  # 20260106 >= delist_date=20260106
        ]
        path = self._path(bars, buy_price=10.0, delist_date="20260106")
        r = simulate_tp_sl(path, tp_pct=0.2, sl_pct=0.1, max_hold=10)
        assert r.exit_reason == "delist"
        assert r.exit_date == "20260103"
        assert r.exit_price == pytest.approx(10.5)
        assert r.hold_days == 2

    def test_delist_on_second_bar_uses_first_bar(self):
        """退市发生在第 2 个 bar → 用第 1 个 bar (buy_date) 的 close 强平。"""
        bars = [
            make_bar("20260102", close=10.2),  # buy_date
            make_bar("20260103", close=11.0),  # 20260103 >= 20260103 → delist
        ]
        path = self._path(bars, buy_price=10.0, delist_date="20260103")
        r = simulate_tp_sl(path, tp_pct=0.2, sl_pct=0.1, max_hold=10)
        assert r.exit_reason == "delist"
        assert r.exit_date == "20260102"
        assert r.exit_price == pytest.approx(10.2)
        assert r.hold_days == 1

    # ── 窗口不足 ──────────────────────────────────────────────────────────────

    def test_window_shorter_than_max_hold(self):
        """bars 比 max_hold 短，未触发任何止损 → 最后一个 bar close 强平。"""
        bars = [
            make_bar("20260102", close=10.0),
            make_bar("20260103", close=10.3),
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_tp_sl(path, tp_pct=0.2, sl_pct=0.1, max_hold=10)
        assert r.exit_reason == "max_hold"
        assert r.exit_price == pytest.approx(10.3)
        assert r.hold_days == 2

    # ── 第二日触发（不是第一日）────────────────────────────────────────────────

    def test_sl_triggers_on_second_bar(self):
        """第一日未触发，第二日止损。"""
        bars = [
            make_bar("20260102", open_=10.0, high=10.3, low=9.6, close=10.0),  # 未触发
            make_bar("20260103", open_=10.0, high=10.2, low=9.3, close=9.4),   # low=9.3 <= SL=9.5
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_tp_sl(path, tp_pct=0.1, sl_pct=0.05, max_hold=10)
        assert r.exit_reason == "sl"
        assert r.exit_date == "20260103"
        assert r.exit_price == pytest.approx(9.5)
        assert r.hold_days == 2


# ─────────────────────────────────────────────────────────────────────────────
# 3. simulate_trailing
# ─────────────────────────────────────────────────────────────────────────────


class TestSimulateTrailing:
    def _path(self, bars, buy_price=10.0, **kw):
        return make_path(bars, buy_price=buy_price, **kw)

    def test_trailing_triggers(self):
        """移动止损触发。

        buy_date 高点=11，peak=11。z=0.1 → trail=9.9。
        bar2 low=9.8 <= 9.9 → 触发，exit_price=9.9。
        """
        bars = [
            make_bar("20260102", open_=10.0, high=11.0, low=9.8, close=10.5),  # buy_date, peak=11
            make_bar("20260103", open_=10.5, high=10.8, low=9.8, close=10.0),  # low=9.8 <= 9.9 → 触发
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_trailing(path, z_pct=0.1, max_hold=10)
        assert r.exit_reason == "trailing"
        assert r.exit_date == "20260103"
        assert r.exit_price == pytest.approx(9.9)
        assert r.hold_days == 2

    def test_trailing_gap_down(self):
        """跳空低开：open <= trail_level → exit_price = open。"""
        bars = [
            make_bar("20260102", open_=10.0, high=11.0, low=9.8, close=10.5),  # peak=11
            make_bar("20260103", open_=9.5, high=9.8, low=9.4, close=9.5),  # open=9.5 < trail=9.9
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_trailing(path, z_pct=0.1, max_hold=10)
        assert r.exit_reason == "trailing"
        assert r.exit_price == pytest.approx(9.5)  # open，因 open < trail

    def test_trailing_peak_order_current_high_does_not_exempt_current_trigger(self):
        """关键：当日触发不被当日新高豁免。

        bar2 的 high=12 比 peak=11 高，但 low=9.8 <= trail(=11*0.9=9.9)。
        按「先判触发，再更新 peak」的口径，应触发 trailing，而不是用新高 12 更新 peak 再判。
        """
        bars = [
            make_bar("20260102", open_=10.0, high=11.0, low=10.0, close=10.5),  # peak=11
            make_bar("20260103", open_=10.0, high=12.0, low=9.8, close=11.0),   # high=12>11, low=9.8<=9.9
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_trailing(path, z_pct=0.1, max_hold=10)
        # 必须触发 trailing（用旧 peak=11，trail=9.9，low=9.8 <= 9.9）
        assert r.exit_reason == "trailing"
        assert r.exit_date == "20260103"
        assert r.exit_price == pytest.approx(9.9)

    def test_trailing_peak_rises_protects_new_trail(self):
        """peak 上移后，止损位随之上移，新 low 虽然低但不触发旧位。"""
        bars = [
            make_bar("20260102", open_=10.0, high=10.0, low=9.9, close=10.0),  # peak=10
            make_bar("20260103", open_=10.0, high=12.0, low=9.6, close=11.0),  # low=9.6 <= trail=9.0? 不，9.6>9.0 → 不触发；peak更新为12
            make_bar("20260106", open_=11.0, high=11.5, low=10.7, close=11.0), # trail=12*0.9=10.8，low=10.7<=10.8 → 触发
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_trailing(path, z_pct=0.1, max_hold=10)
        assert r.exit_reason == "trailing"
        assert r.exit_date == "20260106"
        assert r.exit_price == pytest.approx(10.8)
        assert r.hold_days == 3

    def test_trailing_max_hold_fallback(self):
        """未触发移动止损，到 max_hold 兜底。"""
        bars = [
            make_bar("20260102", open_=10.0, high=10.5, low=9.9, close=10.2),
            make_bar("20260103", open_=10.2, high=10.7, low=10.1, close=10.3),
            make_bar("20260106", open_=10.3, high=10.8, low=10.2, close=10.4),
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_trailing(path, z_pct=0.05, max_hold=3)
        assert r.exit_reason == "max_hold"
        assert r.exit_date == "20260106"
        assert r.hold_days == 3

    def test_trailing_window_insufficient(self):
        """窗口 1 个 bar，未触发，兜底。"""
        bars = [
            make_bar("20260102", close=10.3),
        ]
        path = self._path(bars, buy_price=10.0)
        r = simulate_trailing(path, z_pct=0.1, max_hold=10)
        assert r.exit_reason == "max_hold"
        assert r.hold_days == 1
        assert r.exit_price == pytest.approx(10.3)

    def test_trailing_delist_priority(self):
        """退市优先于移动止损触发。"""
        bars = [
            make_bar("20260102", high=11.0, close=10.5),   # peak=11, buy_date
            make_bar("20260103", low=9.8, close=10.0),     # 20260103 >= 20260103 → delist
        ]
        path = self._path(bars, buy_price=10.0, delist_date="20260103")
        r = simulate_trailing(path, z_pct=0.05, max_hold=10)
        assert r.exit_reason == "delist"
        assert r.exit_date == "20260102"


# ─────────────────────────────────────────────────────────────────────────────
# 4. simulate_atr_stop
# ─────────────────────────────────────────────────────────────────────────────


class TestSimulateAtrStop:
    def _path(self, bars, buy_price=10.0, atr=0.5, **kw):
        return make_path(bars, buy_price=buy_price, atr14_at_signal=atr, **kw)

    def test_atr_none_raises(self):
        """atr14_at_signal=None 时抛 ValueError。"""
        bars = [make_bar("20260102")]
        path = make_path(bars, buy_price=10.0, atr14_at_signal=None)
        with pytest.raises(ValueError, match="atr14_at_signal"):
            simulate_atr_stop(path, k=2.0, max_hold=10)

    def test_atr_sl_triggered(self):
        """ATR 止损触发：low <= SL_level = entry - k*atr。

        entry=10, k=2, atr=0.5 → SL_level=9.0。bar low=8.9 <= 9.0 → 触发。
        """
        bars = [
            make_bar("20260102", open_=10.0, high=10.3, low=8.9, close=9.0),
        ]
        path = self._path(bars, buy_price=10.0, atr=0.5)
        r = simulate_atr_stop(path, k=2.0, max_hold=10)
        assert r.exit_reason == "atr"
        assert r.exit_price == pytest.approx(9.0)
        assert r.hold_days == 1

    def test_atr_gap_down(self):
        """ATR 止损跳空低开：open <= SL_level → exit_price = open。"""
        bars = [
            make_bar("20260102", open_=8.5, high=8.8, low=8.4, close=8.6),
        ]
        path = self._path(bars, buy_price=10.0, atr=0.5)
        r = simulate_atr_stop(path, k=2.0, max_hold=10)
        assert r.exit_reason == "atr"
        assert r.exit_price == pytest.approx(8.5)

    def test_atr_max_hold_fallback(self):
        """未触发 ATR 止损，到 max_hold 兜底。"""
        bars = [
            make_bar("20260102", open_=10.0, high=10.3, low=9.5, close=10.1),
            make_bar("20260103", open_=10.1, high=10.4, low=9.6, close=10.2),
        ]
        path = self._path(bars, buy_price=10.0, atr=0.5)
        # SL_level = 10 - 2*0.5 = 9.0；low 从未 <= 9.0
        r = simulate_atr_stop(path, k=2.0, max_hold=2)
        assert r.exit_reason == "max_hold"
        assert r.hold_days == 2

    def test_atr_trailing_stop_rises(self):
        """atr_trailing=True：止损位随 peak - k*atr 上移。

        entry=10, atr=0.5, k=2 → 初始SL=9.0。
        bar1(buy_date) high=12 → peak=12。
        bar2 进入时，dynamic_sl=12-1=11.0 > 9.0 → sl_level=11.0。
        bar2 low=10.8 <= 11.0 → 触发。
        """
        bars = [
            make_bar("20260102", open_=10.0, high=12.0, low=9.9, close=11.0),  # buy_date, peak→12
            make_bar("20260103", open_=11.5, high=11.8, low=10.8, close=11.0),  # low=10.8<=11.0
        ]
        path = self._path(bars, buy_price=10.0, atr=0.5)
        r = simulate_atr_stop(path, k=2.0, max_hold=10, atr_trailing=True)
        assert r.exit_reason == "atr"
        assert r.exit_date == "20260103"
        assert r.exit_price == pytest.approx(11.0)
        assert r.hold_days == 2

    def test_atr_trailing_sl_only_rises(self):
        """atr_trailing=True：止损位只上不下（用 max）。

        peak 下行后，sl 不跟着降。
        """
        bars = [
            make_bar("20260102", open_=10.0, high=11.0, low=9.8, close=10.5),  # peak=11, dynamic_sl=11-1=10
            make_bar("20260103", open_=10.3, high=10.5, low=10.0, close=10.3),  # low=10.0=sl_level=10 → 触发
        ]
        path = self._path(bars, buy_price=10.0, atr=0.5)
        r = simulate_atr_stop(path, k=2.0, max_hold=10, atr_trailing=True)
        assert r.exit_reason == "atr"
        # peak=11, dynamic_sl=10.0, sl_level=max(9.0, 10.0)=10.0; low=10.0 <= 10.0 → 触发
        assert r.exit_price == pytest.approx(10.0)

    def test_atr_delist_priority(self):
        """退市优先于 ATR 止损。"""
        bars = [
            make_bar("20260102", close=10.5),   # buy_date
            make_bar("20260103", low=8.0, close=9.0),  # 退市 & low<=SL
        ]
        path = self._path(bars, buy_price=10.0, atr=0.5, delist_date="20260103")
        r = simulate_atr_stop(path, k=2.0, max_hold=10)
        assert r.exit_reason == "delist"
        assert r.exit_date == "20260102"

    def test_atr_window_insufficient(self):
        """窗口 1 个 bar，未触发，兜底。"""
        bars = [
            make_bar("20260102", close=10.3, low=9.5),  # low=9.5 > SL=9.0，不触发
        ]
        path = self._path(bars, buy_price=10.0, atr=0.5)
        r = simulate_atr_stop(path, k=2.0, max_hold=10)
        assert r.exit_reason == "max_hold"
        assert r.hold_days == 1
        assert r.exit_price == pytest.approx(10.3)


# ─────────────────────────────────────────────────────────────────────────────
# 5. 共通行为：hold_days / ret / ts_code / dates 字段
# ─────────────────────────────────────────────────────────────────────────────


class TestCommonFields:
    def test_ret_formula(self):
        """ret = exit_price / buy_price - 1。"""
        bars = [make_bar("20260102", close=12.0)]
        path = make_path(bars, buy_price=10.0)
        r = simulate_fixed_n(path, n=1)
        assert r.ret == pytest.approx(12.0 / 10.0 - 1.0)

    def test_ts_code_and_dates_propagated(self):
        """ts_code / signal_date / buy_date 从 path 原样传出。"""
        bars = [make_bar("20260102", close=10.0)]
        path = make_path(bars, ts_code="600000.SH", signal_date="20260101", buy_date="20260102")
        r = simulate_fixed_n(path, n=1)
        assert r.ts_code == "600000.SH"
        assert r.signal_date == "20260101"
        assert r.buy_date == "20260102"

    def test_buy_price_propagated(self):
        """buy_price 从 path 原样传出。"""
        bars = [make_bar("20260102", close=10.0)]
        path = make_path(bars, buy_price=8.88)
        r = simulate_fixed_n(path, n=1)
        assert r.buy_price == pytest.approx(8.88)
