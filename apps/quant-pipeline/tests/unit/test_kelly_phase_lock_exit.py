"""单元测试：kelly_sweep phase_lock 出场族。

覆盖：
  - exits.simulate_phase_lock_exit 适配层（有交易 / no_entry→None / buy_bar 缺失→None / 退市 / max_hold 兜底）
  - sweep.build_phase_lock_grid（默认 48 组 / 去重 / 量化 / 护栏阈值）
  - sweep._exit_id 的 phase_lock 分支格式
  - sweep._run_exit 的 phase_lock dispatch
  - runner._normalize_phase_lock_candidates（合法键透传 / 未知键 / 非 list 拒绝）
  - runner._build_exit_grid_from_params 接 phase_lock_grid（presence-driven）

口径基准：
  - 共享核语义：strategy/phase_lock_exit.py（test_phase_lock_exit.py 锁数值）
  - kelly 接入口径：docs/superpowers/specs/2026-06-13-phase-lock-exit-design/04-kelly-sweep.md §D4
  - 默认网格：docs/.../02-params-scheme-grid.md §kelly 默认网格（4×4×3=48）

测试策略：全部 synthetic ForwardPath（手工构造 buy_bar + bars），不依赖 DB。

关键 bars 口径（务必牢记，否则期望对不上，与 band_lock 同）：
  - kelly_sweep 的 ForwardPath.bars[0] = buy_date **之后**第一日（= T+2），buy_date(T+1) 存于 buy_bar。
  - simulate_phase_lock_exit 喂核序列 = [buy_bar(T+1)] + bars(T+2, T+3, ...)。
  - 核 exit_index 是 core_bars 下标（0=持仓首日 T+1 从不出场），映射回 kelly：
        core exit_index = k  →  path.bars[k-1]（= 第 k 个持有日）。
  - recent_lows 在 kelly 侧只有 buy_bar.qfq_low 一根（path 无 T+1 之前历史）；
        init_stop = floor2(buy_bar.qfq_low × init_factor)，T+2 起盘中生效。
"""

from __future__ import annotations

import pytest

from quant_pipeline.research.kelly_sweep.exits import simulate_phase_lock_exit
from quant_pipeline.research.kelly_sweep.sweep import (
    _exit_id,
    _run_exit,
    build_exit_grid,
    build_phase_lock_grid,
)
from quant_pipeline.research.kelly_sweep.types import Bar, ForwardPath
from quant_pipeline.strategy.phase_lock_exit import (
    DEFAULT_INIT_FACTOR,
    DEFAULT_LOCK_FACTOR,
    DEFAULT_LOOKBACK,
)
from quant_pipeline.worker.kelly_sweep_runner import (
    _build_exit_grid_from_params,
    _normalize_phase_lock_candidates,
)


# ─────────────────────────────────────────────────────────────────────────────
# 辅助构造器（与 band_lock 测试同款）
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
    """构造带 phase_lock 字段的 Bar。

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
    *,
    buy_price: float | None = None,
    delist_date: str | None = None,
    ts_code: str = "000001.SZ",
    signal_date: str = "20260101",
    buy_date: str = "20260102",
) -> ForwardPath:
    """构造 phase_lock 用 ForwardPath。

    phase_lock 不需要 signal_bar_high（与 band_lock 不同），但 ForwardPath 字段保留默认 None。
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
        signal_bar_high=None,  # phase_lock 不读
        buy_bar=buy_bar,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1. 阶段 A 初始止损（盘中止损）
# ─────────────────────────────────────────────────────────────────────────────


class TestInitialStop:
    def test_initial_stop_intraday(self) -> None:
        """初始止损来自 recent_lows（kelly 侧仅 buy_bar.qfq_low）：
        buy_bar T+1 low=9.7 → init_stop=floor2(9.7×0.999)=floor2(9.6903)=9.69（T+2 起生效）。
        bars[0]=T+2 low=9.6≤9.69 → 盘中止损 @min(9.69, open=9.65)=9.65。
        core exit_index=1 → path.bars[0]=T+2。hold_days=1。
        """
        buy_bar = make_bar("20260102", o=10.0, h=10.1, low=9.7, c=9.9)
        bars = [make_bar("20260103", o=9.65, h=9.8, low=9.6, c=9.7)]
        path = make_path(buy_bar, bars)
        r = simulate_phase_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "stop"
        assert r.exit_date == "20260103"
        assert r.exit_price == pytest.approx(9.65)  # min(init_stop 9.69, open 9.65)
        assert r.hold_days == 1
        assert r.ret == pytest.approx(9.65 / 10.0 - 1.0)
        assert r.ts_code == "000001.SZ"

    def test_first_held_day_not_self_stopped(self) -> None:
        """持仓首日(buy_bar)不出场（init_stop T+2 才生效）。

        buy_bar low=9.0 → init_stop=floor2(9.0×0.999)=8.99；首日不自止损；
        bars[0]=T+2 未触发任何条件、窗口耗尽 → max_hold 兜底。
        """
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.0, c=10.2, ma5=10.0)
        # bars[0] low=10.0 > init_stop 8.99 → 不止损；ma5 平、不切换 → max_hold
        bars = [make_bar("20260103", o=10.1, h=10.4, low=10.0, c=10.2, ma5=10.0)]
        path = make_path(buy_bar, bars)
        r = simulate_phase_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "max_hold"
        assert r.exit_date == "20260103"
        assert r.exit_price == pytest.approx(10.2)

    def test_init_stop_fixed_not_trailing(self) -> None:
        """阶段 A 初始止损固定不上移（与 band_lock 逐日上移的关键差异）。

        buy_bar low=9.7 → init_stop=9.69。即便后续 bar 创新高，止损仍是 9.69（不随 high 上移）。
        bars: 先涨（不切换，因 ma5 缺 → 无切换），再跌破 9.69 → 仍按 9.69 止损。
        """
        buy_bar = make_bar("20260102", o=10.0, h=10.1, low=9.7, c=9.9)  # init_stop 9.69
        bars = [
            make_bar("20260103", o=10.2, h=10.5, low=10.1, c=10.4),  # 创新高、ma5=None 不切换
            make_bar("20260106", o=9.8, h=9.9, low=9.6, c=9.7),  # low 9.6≤9.69 → 止损
        ]
        path = make_path(buy_bar, bars)
        r = simulate_phase_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "stop"
        assert r.exit_date == "20260106"
        # 跳空判定：open 9.8 > stop 9.69 → 按 stop 9.69 成交（min(9.69, 9.8)=9.69）
        assert r.exit_price == pytest.approx(9.69)
        assert r.hold_days == 2


# ─────────────────────────────────────────────────────────────────────────────
# 2. 阶段切换 + 阶段 B（MA5 离场）
# ─────────────────────────────────────────────────────────────────────────────


class TestLockAndMa5Exit:
    def test_lock_then_ma5_exit(self) -> None:
        """阶段切换（close>MA5 且 MA5>prev_ma5）→ 锁定；后续 close<MA5 且 MA5<prev_ma5 → MA5 离场。

        buy_bar T+1: c=10.2, ma5=10.0 → prev_ma5=10.0；init_stop=floor2(9.8×0.999)=9.79。
        bars[0]=T+2: c=10.5>ma5=10.3 且 10.3>10.0 → 切换、锁定 stop_next=floor2(max(cost10.0,low10.5)×0.999)
            = floor2(10.5×0.999)=floor2(10.4895)=10.48（次日生效）；prev_ma5→10.3。
        bars[1]=T+3: low 10.5>10.48 不止损；c=10.1<ma5=10.2 且 10.2<10.3 → MA5 离场 @close 10.1。
        core exit_index=2 → path.bars[1]=T+3。hold_days=2。
        """
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.8, c=10.2, ma5=10.0)
        bars = [
            make_bar("20260103", o=10.4, h=10.6, low=10.5, c=10.5, ma5=10.3),
            make_bar("20260106", o=10.3, h=10.5, low=10.5, c=10.1, ma5=10.2),
        ]
        path = make_path(buy_bar, bars)
        r = simulate_phase_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "ma5_exit"
        assert r.exit_date == "20260106"
        assert r.exit_price == pytest.approx(10.1)  # adj_close
        assert r.hold_days == 2

    def test_locked_stop_uses_lock_factor(self) -> None:
        """锁定后止损按 lock_factor（max(cost, 当日 low)×lock_factor）冻结、次日盘中生效。

        buy_bar T+1: c=10.2, ma5=10.0；init_stop=floor2(9.8×0.999)=9.79。
        bars[0]=T+2: c=10.6>ma5=10.3>10.0 → 切换；lock stop=floor2(max(10.0,10.5)×0.999)=10.48；prev_ma5→10.3。
        bars[1]=T+3: low 10.4≤10.48 → 锁定止损 @min(10.48, open 10.45)=10.45。
        """
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.8, c=10.2, ma5=10.0)
        bars = [
            make_bar("20260103", o=10.4, h=10.7, low=10.5, c=10.6, ma5=10.3),
            make_bar("20260106", o=10.45, h=10.5, low=10.4, c=10.42, ma5=10.4),
        ]
        path = make_path(buy_bar, bars)
        r = simulate_phase_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "stop"
        assert r.exit_date == "20260106"
        assert r.exit_price == pytest.approx(10.45)  # min(lock_stop 10.48, open 10.45)
        assert r.hold_days == 2


# ─────────────────────────────────────────────────────────────────────────────
# 3. 自定义 init_factor / lock_factor / lookback
# ─────────────────────────────────────────────────────────────────────────────


class TestCustomParams:
    def test_custom_init_factor(self) -> None:
        """init_factor=0.97：init_stop=floor2(10.0×0.97)=9.7（更深缓冲）。

        buy_bar low=10.0；bars[0] low=9.65≤9.7 → 止损 @min(9.7, open 9.68)=9.68。
        """
        buy_bar = make_bar("20260102", o=10.5, h=10.6, low=10.0, c=10.3)
        bars = [make_bar("20260103", o=9.68, h=9.9, low=9.65, c=9.7)]
        path = make_path(buy_bar, bars)
        r = simulate_phase_lock_exit(path, init_factor=0.97)
        assert r is not None
        assert r.exit_reason == "stop"
        assert r.exit_price == pytest.approx(9.68)  # min(init_stop 9.7, open 9.68)

    def test_default_params_equal_explicit_defaults(self) -> None:
        """默认调用 == 显式传核默认（零漂移自证）。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.1, low=9.7, c=9.9)
        bars = [make_bar("20260103", o=9.65, h=9.8, low=9.6, c=9.7)]
        p1 = make_path(buy_bar, bars)
        p2 = make_path(buy_bar, bars)
        r_default = simulate_phase_lock_exit(p1)
        r_explicit = simulate_phase_lock_exit(
            p2,
            init_factor=DEFAULT_INIT_FACTOR,
            lock_factor=DEFAULT_LOCK_FACTOR,
            lookback=DEFAULT_LOOKBACK,
        )
        assert r_default == r_explicit


# ─────────────────────────────────────────────────────────────────────────────
# 4. 无交易 / 边界
# ─────────────────────────────────────────────────────────────────────────────


class TestNoTrade:
    def test_limit_up_no_entry_returns_none(self) -> None:
        """持仓首日一字涨停（buy_bar raw_open≥up_limit）→ no_entry → None。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.0, low=10.0, c=10.0, ro=10.0, up=10.0)
        bars = [make_bar("20260103", c=10.5)]
        path = make_path(buy_bar, bars)
        assert simulate_phase_lock_exit(path) is None

    def test_buy_bar_none_returns_none(self) -> None:
        """buy_bar 缺失（phase_lock 必需的持仓首日缺失）→ None。"""
        bars = [make_bar("20260103", c=10.5)]
        path = make_path(None, bars)
        assert simulate_phase_lock_exit(path) is None

    def test_signal_high_none_still_works(self) -> None:
        """phase_lock 不依赖 signal_bar_high（与 band_lock 不同）→ 即便为 None 也照常出场。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.1, low=9.7, c=9.9)
        bars = [make_bar("20260103", o=9.65, h=9.8, low=9.6, c=9.7)]
        path = make_path(buy_bar, bars)  # signal_bar_high 恒 None
        r = simulate_phase_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "stop"

    def test_empty_bars_raises(self) -> None:
        """bars 为空 → ValueError（与其它出场族一致）。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.8, c=10.2)
        path = make_path(buy_bar, [])
        with pytest.raises(ValueError, match="bars 为空"):
            simulate_phase_lock_exit(path)

    def test_window_exhaust_max_hold(self) -> None:
        """无止损 / 无切换 / 无 MA5 离场 → 窗口耗尽 max_hold @最后 bar close。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.99, c=10.2)  # init_stop=floor2(9.98001)=9.98
        bars = [
            make_bar("20260103", o=10.2, h=10.5, low=10.15, c=10.3),  # low>9.98、ma5=None 不切换
            make_bar("20260106", o=10.3, h=10.6, low=10.25, c=10.4),
        ]
        path = make_path(buy_bar, bars)
        r = simulate_phase_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "max_hold"
        assert r.exit_date == "20260106"
        assert r.exit_price == pytest.approx(10.4)
        assert r.hold_days == 2


# ─────────────────────────────────────────────────────────────────────────────
# 5. 退市优先（调用方收口）
# ─────────────────────────────────────────────────────────────────────────────


class TestDelistPriority:
    def test_delist_forces_close_before_core_exit(self) -> None:
        """退市优先：bars[2] >= delist_date → 用 bars[1].qfq_close 强平、reason=delist、hold_days=2。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.99, c=10.2)  # init_stop 9.98
        bars = [
            make_bar("20260103", o=10.2, h=10.5, low=10.15, c=10.3),
            make_bar("20260106", o=10.3, h=10.6, low=10.25, c=10.45),  # bars[1]
            make_bar("20260107", o=10.0, h=10.1, low=9.0, c=9.1),  # 本会止损；但 >= delist
        ]
        path = make_path(buy_bar, bars, delist_date="20260107")
        r = simulate_phase_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "delist"
        assert r.exit_date == "20260106"  # 上一有效 bar
        assert r.exit_price == pytest.approx(10.45)
        assert r.hold_days == 2

    def test_core_exit_before_delist_takes_priority(self) -> None:
        """核在 delist 前出场 → 按核 stop 出场，delist 不预占。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.1, low=9.7, c=9.9)  # init_stop 9.69
        bars = [
            make_bar("20260103", o=9.6, h=9.7, low=9.5, c=9.55),  # low≤9.69 → stop
            make_bar("20260106", c=9.5),
            make_bar("20260107", c=9.0),  # delist 日
        ]
        path = make_path(buy_bar, bars, delist_date="20260107")
        r = simulate_phase_lock_exit(path)
        assert r is not None
        assert r.exit_reason == "stop"
        assert r.exit_date == "20260103"


# ─────────────────────────────────────────────────────────────────────────────
# 6. build_phase_lock_grid（默认 48 组 / 去重 / 量化 / 护栏）
# ─────────────────────────────────────────────────────────────────────────────


class TestBuildPhaseLockGrid:
    def test_default_grid_48(self) -> None:
        """默认候选集 = 4×4×3 = 48 组（spec 02 §kelly 默认网格）。"""
        grid = build_phase_lock_grid()
        assert len(grid) == 48
        assert all(e["type"] == "phase_lock" for e in grid)
        lookbacks = {e["lookback"] for e in grid}
        init_factors = {e["init_factor"] for e in grid}
        lock_factors = {e["lock_factor"] for e in grid}
        assert lookbacks == {5, 10, 15, 20}
        assert init_factors == {0.97, 0.98, 0.99, 1.00}
        assert lock_factors == {0.99, 0.999, 1.005}

    def test_grid_quantizes_ratios(self) -> None:
        """ratio 经 quantize_phase_lock_params 量化（千分位 round-half-up）。

        0.9994 → NNNN=floor(999.4+0.5)=999 → 0.999；0.9995 → floor(999.5+0.5)=1000 → 1.0。
        """
        grid = build_phase_lock_grid(
            lookback_list=[10],
            init_factor_list=[0.9994, 0.9995],
            lock_factor_list=[0.999],
        )
        init_factors = {e["init_factor"] for e in grid}
        assert init_factors == {0.999, 1.0}

    def test_grid_dedup(self) -> None:
        """量化后重复候选去重（0.97 与 0.9701 量化后都 → 0.97）。"""
        grid = build_phase_lock_grid(
            lookback_list=[10, 10],  # 重复 lookback
            init_factor_list=[0.97, 0.9701],  # 量化后都 0.97
            lock_factor_list=[0.999],
        )
        assert len(grid) == 1
        assert grid[0] == {
            "type": "phase_lock",
            "lookback": 10,
            "init_factor": 0.97,
            "lock_factor": 0.999,
        }

    def test_grid_warn_threshold(self, caplog) -> None:
        """cfg 数 > 200 → logger.warning（不截断）。

        构造 21 lookback × 10 init × 1 lock = 210 > 200 → warn，仍返回全部 210。
        """
        import logging

        lookbacks = list(range(1, 22))  # 1..21 = 21 个
        init_factors = [0.9 + i * 0.01 for i in range(10)]  # 0.90..0.99 = 10 个不同值
        with caplog.at_level(logging.WARNING):
            grid = build_phase_lock_grid(
                lookback_list=lookbacks,
                init_factor_list=init_factors,
                lock_factor_list=[0.999],
            )
        assert len(grid) == 210  # 不截断
        assert any("phase_lock" in rec.message and "超过软阈值" in rec.message for rec in caplog.records)

    def test_grid_invalid_ratio_raises(self) -> None:
        """非法 ratio（量化到 0 越下界）→ ValueError（透传 quantize_phase_lock_params）。"""
        with pytest.raises(ValueError):
            build_phase_lock_grid(init_factor_list=[0.0])

    def test_grid_invalid_lookback_raises(self) -> None:
        """非法 lookback（0）→ ValueError。"""
        with pytest.raises(ValueError):
            build_phase_lock_grid(lookback_list=[0])


# ─────────────────────────────────────────────────────────────────────────────
# 7. _exit_id 格式 + _run_exit dispatch + build_exit_grid
# ─────────────────────────────────────────────────────────────────────────────


class TestExitIdAndDispatch:
    def test_exit_id_format(self) -> None:
        """_exit_id 格式：phase_lock(lb={N},if={ratio},lf={ratio})；lookback 始终写出，ratio 去尾零。"""
        cfg = {"type": "phase_lock", "lookback": 10, "init_factor": 0.99, "lock_factor": 0.999}
        assert _exit_id(cfg) == "phase_lock(lb=10,if=0.99,lf=0.999)"

    def test_exit_id_ratio_strip_trailing_zero(self) -> None:
        """ratio 去尾零：1.00→'1'、0.97→'0.97'、1.005→'1.005'。"""
        cfg = {"type": "phase_lock", "lookback": 5, "init_factor": 1.00, "lock_factor": 1.005}
        assert _exit_id(cfg) == "phase_lock(lb=5,if=1,lf=1.005)"

    def test_exit_id_unique_across_default_grid(self) -> None:
        """默认 48 组 _exit_id 全唯一（同量化值产出同 id、不同值产出不同 id）。"""
        grid = build_phase_lock_grid()
        ids = [_exit_id(e) for e in grid]
        assert len(ids) == len(set(ids)) == 48

    def test_exit_id_falls_back_to_core_defaults(self) -> None:
        """cfg 缺键 → _exit_id 用核默认回填（lb=10,if=0.999,lf=0.999）。"""
        assert _exit_id({"type": "phase_lock"}) == "phase_lock(lb=10,if=0.999,lf=0.999)"

    def test_run_exit_phase_lock_returns_ret(self) -> None:
        """_run_exit 走 phase_lock 分支返回 ret（与 simulate_phase_lock_exit 一致）。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.1, low=9.7, c=9.9)
        bars = [make_bar("20260103", o=9.65, h=9.8, low=9.6, c=9.7)]
        path = make_path(buy_bar, bars)
        ret = _run_exit(
            path,
            {"type": "phase_lock", "lookback": 10, "init_factor": 0.999, "lock_factor": 0.999},
            "sl_first",
        )
        assert ret is not None
        assert ret == pytest.approx(9.65 / 10.0 - 1.0)

    def test_run_exit_phase_lock_no_entry_returns_none(self) -> None:
        """_run_exit phase_lock：no_entry（一字涨停）→ None。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.0, low=10.0, c=10.0, ro=10.0, up=10.0)
        bars = [make_bar("20260103", c=10.5)]
        path = make_path(buy_bar, bars)
        assert _run_exit(path, {"type": "phase_lock"}, "sl_first") is None

    def test_run_exit_phase_lock_missing_keys_uses_core_defaults(self) -> None:
        """_run_exit phase_lock：cfg 缺参数键 → 用核默认（不报 KeyError）。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.99, c=10.2)
        bars = [make_bar("20260103", o=10.2, h=10.5, low=10.15, c=10.3)]
        path = make_path(buy_bar, bars)
        ret = _run_exit(path, {"type": "phase_lock"}, "sl_first")  # 无 lookback/init/lock 键
        assert ret is not None

    def test_build_exit_grid_phase_lock_empty(self) -> None:
        """phase_lock 不进 DEFAULT_EXIT_GRID → build_exit_grid(['phase_lock']) 返回空（presence-driven）。"""
        grid = build_exit_grid(["phase_lock"])
        assert grid == []

    def test_build_exit_grid_band_lock_still_works(self) -> None:
        """零回归：band_lock 仍在 DEFAULT_EXIT_GRID（3 个）。"""
        grid = build_exit_grid(["band_lock"])
        assert len(grid) == 3
        assert all(e["type"] == "band_lock" for e in grid)


# ─────────────────────────────────────────────────────────────────────────────
# 8. runner._normalize_phase_lock_candidates + _build_exit_grid_from_params
# ─────────────────────────────────────────────────────────────────────────────


class TestRunnerPhaseLockCandidates:
    def test_normalize_valid_keys(self) -> None:
        """3 个合法候选集键透传。"""
        raw = {
            "lookback_list": [5, 10],
            "init_factor_list": [0.97, 0.99],
            "lock_factor_list": [0.999],
        }
        out = _normalize_phase_lock_candidates(raw)
        assert out == raw

    def test_normalize_partial_keys(self) -> None:
        """仅提供部分键 → 其余交给 build_phase_lock_grid 默认。"""
        raw = {"lookback_list": [10]}
        out = _normalize_phase_lock_candidates(raw)
        assert out == {"lookback_list": [10]}

    def test_normalize_unknown_key_raises(self) -> None:
        """未知键 → ValueError（fail-fast）。"""
        with pytest.raises(ValueError, match="未知候选集键"):
            _normalize_phase_lock_candidates({"max_hold_list": [10]})  # band_lock 键非法

    def test_normalize_non_list_value_raises(self) -> None:
        """候选集值非 list（前端误传标量）→ ValueError。"""
        with pytest.raises(ValueError, match="必须是候选集数组"):
            _normalize_phase_lock_candidates({"lookback_list": 10})

    def test_build_exit_grid_from_params_phase_lock_presence_driven(self) -> None:
        """phase_lock_grid 提供时 → 附加 phase_lock 段；其它族走 DEFAULT。"""
        params = {
            "exit_families": ["fixed_n"],
            "phase_lock_grid": {
                "lookback_list": [10],
                "init_factor_list": [0.99],
                "lock_factor_list": [0.999],
            },
        }
        grid = _build_exit_grid_from_params(params)
        fixed = [e for e in grid if e["type"] == "fixed_n"]
        phase = [e for e in grid if e["type"] == "phase_lock"]
        assert len(fixed) == 5  # fixed_n DEFAULT 子集
        assert len(phase) == 1
        assert phase[0] == {
            "type": "phase_lock",
            "lookback": 10,
            "init_factor": 0.99,
            "lock_factor": 0.999,
        }

    def test_build_exit_grid_from_params_phase_lock_default_48(self) -> None:
        """phase_lock_grid 为空 dict（无候选键）→ build_phase_lock_grid 默认 48 组。"""
        params = {"exit_families": ["fixed_n"], "phase_lock_grid": {}}
        grid = _build_exit_grid_from_params(params)
        phase = [e for e in grid if e["type"] == "phase_lock"]
        assert len(phase) == 48

    def test_build_exit_grid_from_params_no_phase_lock_key(self) -> None:
        """无 phase_lock_grid key → 不含 phase_lock 段（零回归）。"""
        params = {"exit_families": ["fixed_n", "tp_sl"]}
        grid = _build_exit_grid_from_params(params)
        assert not any(e["type"] == "phase_lock" for e in grid)

    def test_build_exit_grid_from_params_phase_lock_non_dict_raises(self) -> None:
        """phase_lock_grid 非 dict → ValueError。"""
        params = {"exit_families": ["fixed_n"], "phase_lock_grid": [1, 2, 3]}
        with pytest.raises(ValueError, match="phase_lock_grid 必须是各维度候选集 dict"):
            _build_exit_grid_from_params(params)

    def test_build_exit_grid_from_params_band_and_phase_coexist(self) -> None:
        """band_lock_grid 与 phase_lock_grid 可同时提供，各自附段、互不影响。"""
        params = {
            "exit_families": ["fixed_n"],
            "band_lock_grid": {"max_hold_list": [10]},
            "phase_lock_grid": {
                "lookback_list": [5],
                "init_factor_list": [0.98],
                "lock_factor_list": [0.999],
            },
        }
        grid = _build_exit_grid_from_params(params)
        assert len([e for e in grid if e["type"] == "fixed_n"]) == 5
        assert len([e for e in grid if e["type"] == "band_lock"]) == 1
        assert len([e for e in grid if e["type"] == "phase_lock"]) == 1
