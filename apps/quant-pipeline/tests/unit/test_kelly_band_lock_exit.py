"""单元测试：kelly_sweep band_lock 出场族（exits.simulate_band_lock_exit + sweep grid 注册）。

口径基准：
  - 共享核语义/对拍样例：docs/superpowers/specs/2026-06-09-trailing-lock-exit-design/01,02
  - 接入口径：docs/superpowers/specs/2026-06-09-trailing-lock-exit-design/03 §三

测试策略：全部 synthetic ForwardPath（手工构造 buy_bar + bars），不依赖 DB。

关键 bars 口径（务必牢记，否则期望对不上）：
  - kelly_sweep 的 ForwardPath.bars[0] = buy_date **之后**第一日（= T+2），buy_date(T+1) 存于 buy_bar。
  - simulate_band_lock_exit 喂核序列 = [buy_bar(T+1)] + bars(T+2, T+3, ...)。
  - 共享核 exit_index 是 core_bars 下标（0=持仓首日 T+1，从不出场），映射回 kelly_sweep：
        core exit_index = k  →  path.bars[k-1]（= 第 k 个持有日 T+1+k）。
  - exits 返回的 TradeResult.hold_days 直接取核的 hold_days（持仓首日记 0，从 1 起递增）。
"""

from __future__ import annotations

import pytest

from quant_pipeline.research.kelly_sweep.exits import simulate_band_lock_exit
from quant_pipeline.research.kelly_sweep.sweep import (
    DEFAULT_EXIT_GRID,
    _exit_id,
    _run_exit,
    build_exit_grid,
)
from quant_pipeline.research.kelly_sweep.types import Bar, ForwardPath


# ─────────────────────────────────────────────────────────────────────────────
# 辅助构造器
# ─────────────────────────────────────────────────────────────────────────────


def make_bar(
    trade_date: str,
    o: float = 10.0,
    h: float = 10.5,
    low: float = 9.5,
    c: float = 10.0,
    *,
    ma5: float | None = None,
    ro: float | None = None,
    rh: float | None = None,
    up: float | None = None,
    dn: float | None = None,
) -> Bar:
    """构造带 band_lock 字段的 Bar。

    未给 raw_open/raw_high 时默认 = qfq open/high（不触发限停板）；
    未给 up/down_limit 时默认 None（该端约束不生效）。
    """
    return Bar(
        trade_date=trade_date,
        qfq_open=o,
        qfq_high=h,
        qfq_low=low,
        qfq_close=c,
        ma5=ma5,
        raw_open=o if ro is None else ro,
        raw_high=h if rh is None else rh,
        up_limit=up,
        down_limit=dn,
    )


def make_path(
    buy_bar: Bar | None,
    bars: list[Bar],
    signal_bar_high: float | None,
    *,
    buy_price: float | None = None,
    delist_date: str | None = None,
    ts_code: str = "000001.SZ",
    signal_date: str = "20260101",
    buy_date: str = "20260102",
) -> ForwardPath:
    """构造 band_lock 用 ForwardPath。

    buy_price 默认取 buy_bar.qfq_open（与 load_forward_paths 口径一致）。
    """
    bp = buy_price if buy_price is not None else (buy_bar.qfq_open if buy_bar else 10.0)
    return ForwardPath(
        ts_code=ts_code,
        signal_date=signal_date,
        buy_date=buy_date,
        buy_price=bp,
        bars=bars,
        delist_date=delist_date,
        atr14_at_signal=None,
        signal_bar_high=signal_bar_high,
        buy_bar=buy_bar,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1. 方案一·跟踪止损出场（对照共享核 S1，验 bars 口径映射）
# ─────────────────────────────────────────────────────────────────────────────


class TestScheme1TrailingStop:
    def test_scheme1_stop(self) -> None:
        """对照核 S1：buy_bar=T+1(o10,l9.8,c10.2)→方案一，初始止损 9.99；
        bars[0]=T+2(l10.5,h10.6)→锁定 stop_next=floor2(10.4895)=10.48；
        bars[1]=T+3(o10.45,l10.40)≤10.48 → stop @min(10.48,10.45)=10.45。
        core exit_index=2 → path.bars[1]=T+3。hold_days=2。
        """
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.8, c=10.2)  # T+1
        bars = [
            make_bar("20260103", o=10.4, h=10.6, low=10.5, c=10.5),  # T+2
            make_bar("20260106", o=10.45, h=10.5, low=10.40, c=10.42),  # T+3
        ]
        path = make_path(buy_bar, bars, signal_bar_high=10.0)
        r = simulate_band_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "stop"
        assert r.exit_date == "20260106"
        assert r.exit_price == pytest.approx(10.45)
        assert r.hold_days == 2
        # ret = 10.45 / buy_price(=10.0) - 1
        assert r.ret == pytest.approx(10.45 / 10.0 - 1.0)
        assert r.ts_code == "000001.SZ"

    def test_first_held_day_not_self_stopped(self) -> None:
        """持仓首日(buy_bar)当天 low 远低于 open×0.999 也不出场（初始止损 T+2 才生效，核 S9）。

        buy_bar low=9.0 < open×0.999=9.99，但首日不自止损；
        bars[0]=T+2 未触发任何条件、窗口耗尽 → max_hold 兜底（无 delist）。
        """
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.0, c=10.2)  # 方案一
        bars = [make_bar("20260103", o=10.1, h=10.4, low=10.0, c=10.2)]
        path = make_path(buy_bar, bars, signal_bar_high=20.0)  # 高 signal_high → 不锁定
        r = simulate_band_lock_exit(path)
        assert r is not None
        # 未触发止损/MA5/锁定 → 窗口耗尽 max_hold @最后 bar close
        assert r.exit_reason == "max_hold"
        assert r.exit_date == "20260103"
        assert r.exit_price == pytest.approx(10.2)


# ─────────────────────────────────────────────────────────────────────────────
# 2. 方案二·初始止损 = low×0.999（对照核 S3）
# ─────────────────────────────────────────────────────────────────────────────


class TestScheme2InitialStop:
    def test_scheme2_initial_stop_from_low(self) -> None:
        """buy_bar=T+1(o10,l9.7,c9.9 → close≤open 方案二)；初始止损 floor2(9.7×0.999)=9.69；
        bars[0]=T+2 low=9.6≤9.69 → stop @min(9.69, open=9.65)=9.65。core exit_index=1 → bars[0]。
        """
        buy_bar = make_bar("20260102", o=10.0, h=10.1, low=9.7, c=9.9)  # 方案二
        bars = [make_bar("20260103", o=9.65, h=9.8, low=9.6, c=9.7)]
        path = make_path(buy_bar, bars, signal_bar_high=11.0)  # 不锁定
        r = simulate_band_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "stop"
        assert r.exit_date == "20260103"
        assert r.exit_price == pytest.approx(9.65)  # min(9.69, open 9.65)
        assert r.hold_days == 1


# ─────────────────────────────────────────────────────────────────────────────
# 3. 锁定后 MA5 离场（对照核 S2）
# ─────────────────────────────────────────────────────────────────────────────


class TestMa5Exit:
    def test_ma5_exit_after_lock(self) -> None:
        """buy_bar=T+1(o10,l9.8,c10.2,ma5=10.0)→方案一；prev_ma5=10.0。
        bars[0]=T+2(l10.5,h10.6,c10.5,ma5=10.3)→锁定 stop_next=10.48；close≥ma5 不离场；prev_ma5→10.3。
        bars[1]=T+3(l10.5>10.48 不止损, c10.1<ma5=10.2 且 10.2<prev_ma5 10.3)→ma5_exit @10.1。
        core exit_index=2 → path.bars[1]=T+3。
        """
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.8, c=10.2, ma5=10.0)
        bars = [
            make_bar("20260103", o=10.4, h=10.6, low=10.5, c=10.5, ma5=10.3),
            make_bar("20260106", o=10.3, h=10.5, low=10.5, c=10.1, ma5=10.2),
        ]
        path = make_path(buy_bar, bars, signal_bar_high=10.0)
        r = simulate_band_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "ma5_exit"
        assert r.exit_date == "20260106"
        assert r.exit_price == pytest.approx(10.1)  # adj_close
        assert r.hold_days == 2

    def test_ma5_preheat_none_no_ma5_exit(self) -> None:
        """ma5=None（预热不足，核 S10）→ 不触发 MA5 离场，仅止损逻辑。

        锁定后 ma5=None → (2b) 守卫跳过；后续无止损触发 → 窗口耗尽 max_hold。
        """
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.8, c=10.2, ma5=None)
        bars = [
            make_bar("20260103", o=10.4, h=10.6, low=10.5, c=10.5, ma5=None),  # 锁定
            make_bar("20260106", o=10.5, h=10.7, low=10.5, c=10.1, ma5=None),  # ma5=None 不离场
        ]
        path = make_path(buy_bar, bars, signal_bar_high=10.0)
        r = simulate_band_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "max_hold"  # 未止损未离场 → 窗口耗尽


# ─────────────────────────────────────────────────────────────────────────────
# 4. 跳空低开 / 封死跌停顺延 / 停牌
# ─────────────────────────────────────────────────────────────────────────────


class TestLimitAndGap:
    def test_gap_down_exit_at_open(self) -> None:
        """触发日跳空低开 open<stop_eff → exit_price=open（核 S5，min 取开盘）。

        方案二初始止损 9.69；bars[0] open=9.5<9.69 且 low≤9.69 → exit @9.5。
        """
        buy_bar = make_bar("20260102", o=10.0, h=10.1, low=9.7, c=9.9)  # 方案二, stop=9.69
        bars = [make_bar("20260103", o=9.5, h=9.6, low=9.4, c=9.45)]
        path = make_path(buy_bar, bars, signal_bar_high=11.0)
        r = simulate_band_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "stop"
        assert r.exit_price == pytest.approx(9.5)

    def test_dead_limit_down_deferral(self) -> None:
        """封死跌停顺延（核 S6）：止损触发日 raw_high≤down_limit → 顺延；次日非封死 @adj_open。

        方案二 stop=9.69。bars[0] low≤9.69 但封死跌停（rh=9.0≤dn=9.0）→ pending；
        bars[1] 非封死 → exit @adj_open=9.3，reason 保留 stop。core exit_index=2 → path.bars[1]。
        """
        buy_bar = make_bar("20260102", o=10.0, h=10.1, low=9.7, c=9.9)  # 方案二
        bars = [
            make_bar("20260103", o=9.2, h=9.0, low=8.9, c=9.0, rh=9.0, dn=9.0),  # 封死跌停
            make_bar("20260106", o=9.3, h=9.5, low=9.1, c=9.4, dn=8.0),  # 非封死
        ]
        path = make_path(buy_bar, bars, signal_bar_high=11.0)
        r = simulate_band_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "stop"
        assert r.exit_date == "20260106"
        assert r.exit_price == pytest.approx(9.3)  # 顺延日 adj_open
        assert r.hold_days == 2

    def test_max_hold_cap(self) -> None:
        """max_hold 兜底（核 S11）：高 signal_high 不锁定、全程无止损 → 第 max_hold 个持有日 @adj_close。

        max_hold=2 → core 第 2 个可交易持有日（=path.bars[1]）@close 出场，reason=max_hold，hold_days=2。
        """
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.99, c=10.2)  # 方案一
        bars = [
            make_bar("20260103", o=10.2, h=10.5, low=10.15, c=10.3),
            make_bar("20260106", o=10.3, h=10.6, low=10.25, c=10.4),
            make_bar("20260107", o=10.4, h=10.7, low=10.35, c=10.5),
        ]
        path = make_path(buy_bar, bars, signal_bar_high=99.0)  # 永不锁定
        r = simulate_band_lock_exit(path, max_hold=2)
        assert r is not None
        assert r.exit_reason == "max_hold"
        assert r.exit_date == "20260106"  # core exit_index=2 → path.bars[1]
        assert r.exit_price == pytest.approx(10.4)  # path.bars[1].qfq_close
        assert r.hold_days == 2


# ─────────────────────────────────────────────────────────────────────────────
# 5. 入场买不进 / 数据缺失 → 无交易（返回 None，不计入凯利样本）
# ─────────────────────────────────────────────────────────────────────────────


class TestNoTrade:
    def test_limit_up_no_entry_returns_none(self) -> None:
        """持仓首日一字涨停（buy_bar raw_open≥up_limit，核 S8）→ no_entry → 返回 None。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.0, low=10.0, c=10.0, ro=10.0, up=10.0)
        bars = [make_bar("20260103", c=10.5)]
        path = make_path(buy_bar, bars, signal_bar_high=10.0)
        assert simulate_band_lock_exit(path) is None

    def test_buy_bar_none_returns_none(self) -> None:
        """buy_bar 缺失（band_lock 必需输入缺失）→ 返回 None。"""
        bars = [make_bar("20260103", c=10.5)]
        path = make_path(None, bars, signal_bar_high=10.0)
        assert simulate_band_lock_exit(path) is None

    def test_signal_high_none_returns_none(self) -> None:
        """signal_bar_high 缺失 → 返回 None。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.8, c=10.2)
        bars = [make_bar("20260103", c=10.5)]
        path = make_path(buy_bar, bars, signal_bar_high=None)
        assert simulate_band_lock_exit(path) is None

    def test_empty_bars_raises(self) -> None:
        """bars 为空 → ValueError（与其它出场族一致）。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.8, c=10.2)
        path = make_path(buy_bar, [], signal_bar_high=10.0)
        with pytest.raises(ValueError, match="bars 为空"):
            simulate_band_lock_exit(path)


# ─────────────────────────────────────────────────────────────────────────────
# 6. 退市优先（调用方收口，核不处理退市）
# ─────────────────────────────────────────────────────────────────────────────


class TestDelistPriority:
    def test_delist_forces_close_before_core_exit(self) -> None:
        """退市优先：bars[2] >= delist_date → 用 bars[1].qfq_close 强平、reason=delist、hold_days=2。

        构造一条本会在 bars[2] 触发止损的路径，但 delist 在 bars[2] 当日 → delist 先收口。
        """
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.99, c=10.2)  # 方案一
        bars = [
            make_bar("20260103", o=10.2, h=10.5, low=10.15, c=10.3),
            make_bar("20260106", o=10.3, h=10.6, low=10.25, c=10.45),  # bars[1]
            make_bar("20260107", o=10.0, h=10.1, low=9.0, c=9.1),  # bars[2] 本会止损；但 >= delist
        ]
        path = make_path(buy_bar, bars, signal_bar_high=99.0, delist_date="20260107")
        r = simulate_band_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "delist"
        assert r.exit_date == "20260106"  # 上一有效 bar
        assert r.exit_price == pytest.approx(10.45)
        assert r.hold_days == 2

    def test_core_exit_before_delist_takes_priority(self) -> None:
        """核在 delist 之前出场 → 按核的 stop/ma5_exit 出场，delist 不预占。

        方案二 stop=9.69；bars[0] 触发止损（在 delist 日 bars[2] 之前）→ stop 优先。
        """
        buy_bar = make_bar("20260102", o=10.0, h=10.1, low=9.7, c=9.9)  # 方案二
        bars = [
            make_bar("20260103", o=9.6, h=9.7, low=9.5, c=9.55),  # stop 触发 @9.6
            make_bar("20260106", c=9.5),
            make_bar("20260107", c=9.0),  # delist 日
        ]
        path = make_path(buy_bar, bars, signal_bar_high=11.0, delist_date="20260107")
        r = simulate_band_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "stop"
        assert r.exit_date == "20260103"


# ─────────────────────────────────────────────────────────────────────────────
# 7. sweep grid 注册（_exit_id 唯一 / _run_exit 跑通 / build_exit_grid）
# ─────────────────────────────────────────────────────────────────────────────


class TestSweepGridRegistration:
    def test_band_lock_in_default_grid(self) -> None:
        """DEFAULT_EXIT_GRID 含 band_lock 配置（max_hold ∈ {None,10,20}）。"""
        band_cfgs = [e for e in DEFAULT_EXIT_GRID if e["type"] == "band_lock"]
        assert len(band_cfgs) == 3
        mhs = {e["max_hold"] for e in band_cfgs}
        assert mhs == {None, 10, 20}

    def test_exit_id_unique_for_band_lock(self) -> None:
        """band_lock 各 max_hold 的 _exit_id 唯一，且不与现有族碰撞。"""
        ids = [_exit_id(e) for e in DEFAULT_EXIT_GRID]
        assert len(ids) == len(set(ids)), "所有出场配置 _exit_id 必须全局唯一"
        band_ids = [_exit_id(e) for e in DEFAULT_EXIT_GRID if e["type"] == "band_lock"]
        assert set(band_ids) == {
            "band_lock(mh=None)",
            "band_lock(mh=10)",
            "band_lock(mh=20)",
        }

    def test_build_exit_grid_band_lock_only(self) -> None:
        """build_exit_grid(['band_lock']) → 仅 band_lock 3 条。"""
        grid = build_exit_grid(["band_lock"])
        assert len(grid) == 3
        assert all(e["type"] == "band_lock" for e in grid)

    def test_run_exit_band_lock_returns_ret(self) -> None:
        """_run_exit 走 band_lock 分支返回 ret（与 simulate_band_lock_exit 一致）。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.8, c=10.2)
        bars = [
            make_bar("20260103", o=10.4, h=10.6, low=10.5, c=10.5),
            make_bar("20260106", o=10.45, h=10.5, low=10.40, c=10.42),
        ]
        path = make_path(buy_bar, bars, signal_bar_high=10.0)
        ret = _run_exit(path, {"type": "band_lock", "max_hold": None}, "sl_first")
        assert ret is not None
        assert ret == pytest.approx(10.45 / 10.0 - 1.0)

    def test_run_exit_band_lock_no_entry_returns_none(self) -> None:
        """_run_exit band_lock：no_entry（一字涨停）→ None（不计入凯利样本）。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.0, low=10.0, c=10.0, ro=10.0, up=10.0)
        bars = [make_bar("20260103", c=10.5)]
        path = make_path(buy_bar, bars, signal_bar_high=10.0)
        assert _run_exit(path, {"type": "band_lock", "max_hold": 10}, "sl_first") is None

    def test_run_exit_band_lock_missing_max_hold_key(self) -> None:
        """_run_exit band_lock：exit_cfg 缺 max_hold 键 → 当 None（不封顶），不报 KeyError。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.99, c=10.2)
        bars = [make_bar("20260103", o=10.2, h=10.5, low=10.15, c=10.3)]
        path = make_path(buy_bar, bars, signal_bar_high=99.0)
        ret = _run_exit(path, {"type": "band_lock"}, "sl_first")  # 无 max_hold 键
        assert ret is not None


# ─────────────────────────────────────────────────────────────────────────────
# 8. parquet 缓存往返保留 band_lock 字段（signal_bar_high / buy_bar / 每 bar 字段）
# ─────────────────────────────────────────────────────────────────────────────


class TestParquetRoundtripBandLockFields:
    @pytest.fixture(autouse=True)
    def require_pyarrow(self):
        pytest.importorskip("pyarrow", reason="pyarrow 未安装，跳过 parquet 缓存测试")

    def test_roundtrip_preserves_band_lock_fields(self, tmp_path) -> None:
        from quant_pipeline.research.kelly_sweep.paths import (
            _load_paths_from_parquet,
            _save_paths_to_parquet,
        )

        buy_bar = make_bar(
            "20260102", o=10.0, h=10.3, low=9.8, c=10.2,
            ma5=10.1, ro=10.0, rh=10.3, up=11.0, dn=9.0,
        )
        bars = [
            make_bar("20260103", o=10.4, h=10.6, low=10.5, c=10.5, ma5=10.3, up=11.5, dn=9.3),
            make_bar("20260106", o=10.45, h=10.5, low=10.40, c=10.42, ma5=10.4),
        ]
        fp = make_path(buy_bar, bars, signal_bar_high=10.0)

        cache_file = tmp_path / "band_lock_paths.parquet"
        _save_paths_to_parquet([fp], cache_file)
        loaded = _load_paths_from_parquet(cache_file)

        assert len(loaded) == 1
        lp = loaded[0]
        # path 级字段
        assert lp.signal_bar_high == pytest.approx(10.0)
        assert lp.buy_bar is not None
        assert lp.buy_bar.trade_date == "20260102"
        assert lp.buy_bar.ma5 == pytest.approx(10.1)
        assert lp.buy_bar.up_limit == pytest.approx(11.0)
        assert lp.buy_bar.down_limit == pytest.approx(9.0)
        # 每 bar 字段
        assert lp.bars[0].ma5 == pytest.approx(10.3)
        assert lp.bars[0].up_limit == pytest.approx(11.5)
        assert lp.bars[1].ma5 == pytest.approx(10.4)
        assert lp.bars[1].up_limit is None  # 该 bar 未给 → None
        # 还原后跑 simulate_band_lock_exit 与原 path 结果一致（缓存口径无漂移）
        assert simulate_band_lock_exit(lp) == simulate_band_lock_exit(fp)
