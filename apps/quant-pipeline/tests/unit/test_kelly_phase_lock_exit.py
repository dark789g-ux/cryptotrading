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
  - recent_lows（D7 起 lookback 真生效）：load_forward_paths 预收集「含 buy_date(T+1) 的最近
        max(lookback) 个非停牌复权 low（升序）」到 path.recent_lows_window；simulate_phase_lock_exit
        按本 cfg 的 lookback 切末尾片段 recent_lows_window[-lookback:]，init_stop =
        floor2(min(切片) × init_factor)，T+2 起盘中生效。recent_lows_window 为空（旧缓存/防御）
        → 回退历史单元素 [buy_bar.qfq_low]。多数本文件用例**不**填 recent_lows_window（用默认空），
        故走回退、init_stop = floor2(buy_bar.qfq_low × init_factor)（守旧期望，零回归）；专门验证
        lookback 生效的用例（TestLookbackEffective）显式填多元素 recent_lows_window。
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from quant_pipeline.research.kelly_sweep.enumerate import SignalRecord
from quant_pipeline.research.kelly_sweep.exits import simulate_phase_lock_exit
from quant_pipeline.research.kelly_sweep import paths as paths_mod
from quant_pipeline.research.kelly_sweep.paths import (
    _load_paths_from_parquet,
    _make_cache_key,
    _save_paths_to_parquet,
    load_forward_paths,
)
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
    _required_recent_lows_window,
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
    recent_lows_window: list[float] | None = None,
) -> ForwardPath:
    """构造 phase_lock 用 ForwardPath。

    phase_lock 不需要 signal_bar_high（与 band_lock 不同），但 ForwardPath 字段保留默认 None。
    buy_price 默认取 buy_bar.qfq_open（与 load_forward_paths 口径一致）。
    recent_lows_window 默认空列表（→ simulate_phase_lock_exit 回退 [buy_bar.qfq_low] 单元素，
    守旧期望、零回归）；专门验证 lookback 生效的用例显式传升序多元素列表。
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
        recent_lows_window=recent_lows_window if recent_lows_window is not None else [],
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1. 阶段 A 初始止损（盘中止损）
# ─────────────────────────────────────────────────────────────────────────────


class TestInitialStop:
    def test_initial_stop_intraday(self) -> None:
        """初始止损来自 recent_lows（此用例未填 recent_lows_window → 回退 buy_bar.qfq_low 单元素）：
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


# ─────────────────────────────────────────────────────────────────────────────
# 9. D7：lookback 在 kelly 真生效（recent_lows_window 切片）
# ─────────────────────────────────────────────────────────────────────────────


class TestLookbackEffective:
    """D7 核心：填多元素 recent_lows_window 后，不同 lookback 产出不同 init_stop / ret。

    历史退化（恒 [buy_bar.qfq_low]）下 lookback 对 ret 无影响；本类锁定修复后的新行为。
    """

    def test_lookback_changes_init_stop(self) -> None:
        """不同 lookback 取不同回看根数 → 不同 min(recent_lows) → 不同 init_stop → 不同 ret。

        recent_lows_window=[8.0, 9.0, 10.0]（升序，末=T+1 low=10.0）。
          - lookback=1 → 切片 [10.0] → init_stop=floor2(10.0×0.999)=floor2(9.99)=9.99。
          - lookback=3 → 切片 [8.0,9.0,10.0] → min=8.0 → init_stop=floor2(8.0×0.999)=floor2(7.992)=7.99。
        bars[0]=T+2 low=8.5：
          - lookback=1：8.5 ≤ 9.99 → 止损 @min(9.99, open 8.7)=8.7。
          - lookback=3：8.5 > 7.99 → 不止损 → 窗口耗尽 max_hold @close 8.6。
        证 lookback 真生效（两条 ret 不同）。
        """
        buy_bar = make_bar("20260102", o=10.0, h=10.5, low=10.0, c=10.3)
        bars = [make_bar("20260103", o=8.7, h=8.8, low=8.5, c=8.6)]
        path = make_path(buy_bar, bars, recent_lows_window=[8.0, 9.0, 10.0])

        r1 = simulate_phase_lock_exit(path, lookback=1)
        r3 = simulate_phase_lock_exit(path, lookback=3)
        assert r1 is not None and r3 is not None

        # lookback=1：init_stop=9.99，T+2 low 8.5≤9.99 → 止损 @min(9.99, open 8.7)=8.7
        assert r1.exit_reason == "stop"
        assert r1.exit_price == pytest.approx(8.7)

        # lookback=3：init_stop=floor2(8.0×0.999)=7.99，T+2 low 8.5>7.99 → 不止损 → max_hold @close 8.6
        assert r3.exit_reason == "max_hold"
        assert r3.exit_price == pytest.approx(8.6)

        # 关键：ret 不同（修复前会相同）
        assert r1.ret != pytest.approx(r3.ret)

    def test_lookback_slice_takes_tail(self) -> None:
        """lookback 取末尾 lookback 个（最近的），不是头部。

        recent_lows_window=[5.0, 6.0, 7.0, 20.0]（升序）。lookback=2 → 切片 [7.0, 20.0]（末两个）→
        min=7.0 → init_stop=floor2(7.0×0.999)=6.99。若错取头部 [5.0,6.0] → min=5.0 → 4.99，期望不同。
        bars[0] low=6.5≤6.99 → 止损（证取的是末尾片段 min=7.0，非头部 5.0 的 4.99）。
        """
        buy_bar = make_bar("20260102", o=20.0, h=21.0, low=20.0, c=20.5)
        bars = [make_bar("20260103", o=6.6, h=6.7, low=6.5, c=6.6)]
        path = make_path(buy_bar, bars, recent_lows_window=[5.0, 6.0, 7.0, 20.0])
        r = simulate_phase_lock_exit(path, lookback=2)
        assert r is not None
        assert r.exit_reason == "stop"
        # init_stop=floor2(7.0×0.999)=6.99；open 6.6<6.99 → @min(6.99, 6.6)=6.6
        assert r.exit_price == pytest.approx(6.6)

    def test_lookback_exceeds_window_uses_all(self) -> None:
        """lookback 超过 recent_lows_window 长度 → 用全部（切片不越界，等价取全窗 min）。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.5, low=10.0, c=10.3)
        bars = [make_bar("20260103", o=8.0, h=8.1, low=7.9, c=8.0)]
        path = make_path(buy_bar, bars, recent_lows_window=[8.5, 9.0, 10.0])
        # lookback=250 → 切片仍是全 3 个 → min=8.5 → init_stop=floor2(8.5×0.999)=8.49
        r = simulate_phase_lock_exit(path, lookback=250)
        assert r is not None
        # T+2 low 7.9≤8.49 → 止损 @min(8.49, open 8.0)=8.0
        assert r.exit_reason == "stop"
        assert r.exit_price == pytest.approx(8.0)

    def test_empty_window_falls_back_to_buy_bar_low(self) -> None:
        """recent_lows_window 为空（旧缓存/防御）→ 回退 [buy_bar.qfq_low]，lookback 不影响（仅 1 根）。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.1, low=9.7, c=9.9)
        bars = [make_bar("20260103", o=9.65, h=9.8, low=9.6, c=9.7)]
        path = make_path(buy_bar, bars, recent_lows_window=[])  # 显式空 → 回退
        r1 = simulate_phase_lock_exit(path, lookback=1)
        r10 = simulate_phase_lock_exit(path, lookback=10)
        assert r1 is not None and r10 is not None
        # 回退后 recent_lows=[9.7]，init_stop=floor2(9.7×0.999)=9.69，与 lookback 无关
        assert r1.exit_price == pytest.approx(9.65)  # min(9.69, open 9.65)
        assert r1 == r10  # 回退单元素 → lookback 不改变结果


# ─────────────────────────────────────────────────────────────────────────────
# 10. D7：load_forward_paths 的 recent_lows_window 收集
# ─────────────────────────────────────────────────────────────────────────────


def _quote_row(low: float, *, o: float | None = None) -> dict:
    """构造 _fetch_quotes_for_ts 风格的行情 dict。o 缺省 = low+0.5（保证 qfq_open 非空可成交）。"""
    op = o if o is not None else low + 0.5
    return {
        "qfq_open": op,
        "qfq_high": low + 1.0,
        "qfq_low": low,
        "qfq_close": low + 0.3,
        "raw_open": op,
        "raw_high": low + 1.0,
        "ma5": None,
        "up_limit": None,
        "down_limit": None,
    }


class TestLoadForwardPathsRecentLows:
    """用 mock DB 辅助函数（不连真 DB）跑 load_forward_paths 的纯收集逻辑。

    构造一段连续 SSE 日历 + quote_map（含停牌洞），验证：升序、含 buy_date、停牌跳过、不足降级。
    """

    # 连续日历：signal=20260108, buy=20260109（次日）。向前回溯收 recent_lows_window。
    _CALENDAR = [
        "20260101", "20260102", "20260105", "20260106", "20260107",
        "20260108", "20260109", "20260112", "20260113",
    ]

    def _run(self, quote_map: dict, recent_lows_window: int) -> ForwardPath:
        """跑 load_forward_paths（mock 全部 DB 辅助），返回唯一一条 ForwardPath。"""
        sig = SignalRecord(ts_code="000001.SZ", signal_date="20260108", buy_date="20260109")
        with (
            patch.object(paths_mod, "load_sse_calendar", return_value=list(self._CALENDAR)),
            patch.object(
                paths_mod, "_prefetch_symbol_meta", return_value={"000001.SZ": {"delist_date": None}}
            ),
            patch.object(paths_mod, "_prefetch_atr14", return_value={}),
            patch.object(paths_mod, "_fetch_quotes_for_ts", return_value=quote_map),
        ):
            out = load_forward_paths(
                [sig],
                max_window=5,
                date_end="20260113",
                use_cache=False,
                recent_lows_window=recent_lows_window,
            )
        assert len(out) == 1
        return out[0]

    def test_collect_ascending_includes_buy_date(self) -> None:
        """收集升序、末元素 = buy_date(T+1) low、含回看根数。

        日历回看顺序（从 buy=20260109 向前）：09(low=9.0), 08(8.0), 07(7.0), 06(6.0), 05(5.0)...
        recent_lows_window=3 → 收 [09,08,07] 的 low → reversed 升序 = [7.0, 8.0, 9.0]，末=buy 9.0。
        """
        qm = {
            "20260105": _quote_row(5.0),
            "20260106": _quote_row(6.0),
            "20260107": _quote_row(7.0),
            "20260108": _quote_row(8.0),
            "20260109": _quote_row(9.0),  # buy_date
            "20260112": _quote_row(12.0),
            "20260113": _quote_row(13.0),
        }
        fp = self._run(qm, recent_lows_window=3)
        assert fp.recent_lows_window == [7.0, 8.0, 9.0]
        assert fp.recent_lows_window[-1] == 9.0  # 末元素 = buy_date low

    def test_collect_skips_suspended(self) -> None:
        """停牌日（quote 缺行 / qfq_low 为 None）跳过、不占额度，继续向前收满。

        20260108、20260106 停牌（缺行）：从 buy 09 向前收 W=3 → [09, 07, 05]（跳 08/06）。
        升序 = [5.0, 7.0, 9.0]。
        """
        qm = {
            "20260101": _quote_row(1.0),
            "20260102": _quote_row(2.0),
            "20260105": _quote_row(5.0),
            # 20260106 缺行（停牌）
            "20260107": _quote_row(7.0),
            # 20260108 缺行（停牌）
            "20260109": _quote_row(9.0),  # buy_date
            "20260112": _quote_row(12.0),
        }
        fp = self._run(qm, recent_lows_window=3)
        assert fp.recent_lows_window == [5.0, 7.0, 9.0]

    def test_collect_insufficient_degrades(self) -> None:
        """回看素材不足 recent_lows_window 根 → 用现有可用根数（降级、不报错）。

        buy=09，向前仅 08、09 有行（更早全停牌/无行），W=5 → 仅收 [08, 09] → 升序 [8.0, 9.0]。
        """
        qm = {
            "20260108": _quote_row(8.0),
            "20260109": _quote_row(9.0),  # buy_date
            "20260112": _quote_row(12.0),
        }
        fp = self._run(qm, recent_lows_window=5)
        assert fp.recent_lows_window == [8.0, 9.0]

    def test_default_window_1_is_buy_date_only(self) -> None:
        """默认 recent_lows_window=1 → 仅 buy_date low（= 现状行为，非 phase_lock 零改动）。"""
        qm = {
            "20260107": _quote_row(7.0),
            "20260108": _quote_row(8.0),
            "20260109": _quote_row(9.0),  # buy_date
            "20260112": _quote_row(12.0),
        }
        fp = self._run(qm, recent_lows_window=1)  # 显式 1 = 默认
        assert fp.recent_lows_window == [9.0]


# ─────────────────────────────────────────────────────────────────────────────
# 11. D7：parquet cache round-trip（JSON 列）+ cache_key 随 W 变化
# ─────────────────────────────────────────────────────────────────────────────


class TestCacheRoundTrip:
    def _sample_path(self, rlw: list[float]) -> ForwardPath:
        buy_bar = make_bar("20260109", o=9.5, h=10.0, low=9.0, c=9.8)
        bars = [make_bar("20260112", o=9.8, h=10.2, low=9.6, c=10.0)]
        return ForwardPath(
            ts_code="000001.SZ",
            signal_date="20260108",
            buy_date="20260109",
            buy_price=9.5,
            bars=bars,
            delist_date=None,
            atr14_at_signal=None,
            signal_bar_high=None,
            buy_bar=buy_bar,
            recent_lows_window=rlw,
        )

    def test_round_trip_preserves_recent_lows_window(self, tmp_path) -> None:
        """写 parquet（JSON 列）→ 读回，recent_lows_window 逐元素保真。"""
        fp = self._sample_path([7.0, 8.0, 9.0])
        cache_file = tmp_path / "paths_test.parquet"
        _save_paths_to_parquet([fp], cache_file)
        loaded = _load_paths_from_parquet(cache_file)
        assert len(loaded) == 1
        assert loaded[0].recent_lows_window == [7.0, 8.0, 9.0]

    def test_round_trip_empty_window(self, tmp_path) -> None:
        """空 recent_lows_window 写读 round-trip 仍为空列表（json.dumps([]) → json.loads → []）。"""
        fp = self._sample_path([])
        cache_file = tmp_path / "paths_empty.parquet"
        _save_paths_to_parquet([fp], cache_file)
        loaded = _load_paths_from_parquet(cache_file)
        assert loaded[0].recent_lows_window == []

    def test_missing_column_falls_back_to_empty(self, tmp_path) -> None:
        """旧缓存无 recent_lows_window 列（防御）→ 还原为空列表（不 KeyError）。"""
        import pandas as pd

        # 手工写一份**不含** recent_lows_window 列的 parquet（模拟旧 v3 schema 残留）。
        df = pd.DataFrame(
            [
                {
                    "ts_code": "000001.SZ",
                    "signal_date": "20260108",
                    "buy_date": "20260109",
                    "buy_price": 9.5,
                    "delist_date": None,
                    "atr14_at_signal": None,
                    "signal_bar_high": None,
                    "buy_bar_trade_date": None,
                    "bar_index": 0,
                    "trade_date": "20260112",
                    "qfq_open": 9.8,
                    "qfq_high": 10.2,
                    "qfq_low": 9.6,
                    "qfq_close": 10.0,
                    "ma5": None,
                    "raw_open": 9.8,
                    "raw_high": 10.2,
                    "up_limit": None,
                    "down_limit": None,
                }
            ]
        )
        cache_file = tmp_path / "paths_old.parquet"
        df.to_parquet(cache_file, index=False)
        loaded = _load_paths_from_parquet(cache_file)
        assert len(loaded) == 1
        assert loaded[0].recent_lows_window == []

    def test_cache_key_varies_with_window(self) -> None:
        """_make_cache_key 纳入 recent_lows_window：不同 W → 不同 key（缓存不互串）。"""
        sigs = [SignalRecord(ts_code="000001.SZ", signal_date="20260108", buy_date="20260109")]
        k1 = _make_cache_key(sigs, max_window=5, date_end="20260113", recent_lows_window=1)
        k20 = _make_cache_key(sigs, max_window=5, date_end="20260113", recent_lows_window=20)
        assert k1 != k20

    def test_cache_key_stable_same_window(self) -> None:
        """同输入（含同 W）→ 同 key（确定性）。"""
        sigs = [SignalRecord(ts_code="000001.SZ", signal_date="20260108", buy_date="20260109")]
        k_a = _make_cache_key(sigs, max_window=5, date_end="20260113", recent_lows_window=10)
        k_b = _make_cache_key(sigs, max_window=5, date_end="20260113", recent_lows_window=10)
        assert k_a == k_b


# ─────────────────────────────────────────────────────────────────────────────
# 12. D7：runner._required_recent_lows_window（max lookback 计算）
# ─────────────────────────────────────────────────────────────────────────────


class TestRequiredRecentLowsWindow:
    def test_no_phase_lock_grid_returns_1(self) -> None:
        """无 phase_lock_grid → 1（现状，非 phase_lock 调用零改动）。"""
        assert _required_recent_lows_window({"exit_families": ["fixed_n"]}) == 1

    def test_band_lock_only_returns_1(self) -> None:
        """仅 band_lock_grid（无 phase_lock_grid）→ 1（band_lock 不读 recent_lows_window）。"""
        params = {"exit_families": ["fixed_n"], "band_lock_grid": {"max_hold_list": [10, 20]}}
        assert _required_recent_lows_window(params) == 1

    def test_phase_lock_default_grid_returns_20(self) -> None:
        """phase_lock_grid={} → 默认 48 组 lookback{5,10,15,20} → max=20。"""
        params = {"exit_families": ["fixed_n"], "phase_lock_grid": {}}
        assert _required_recent_lows_window(params) == 20

    def test_phase_lock_custom_lookbacks_returns_max(self) -> None:
        """自定义 lookback_list → 取 max。"""
        params = {
            "exit_families": ["fixed_n"],
            "phase_lock_grid": {"lookback_list": [3, 7, 50], "init_factor_list": [0.99], "lock_factor_list": [0.999]},
        }
        assert _required_recent_lows_window(params) == 50

    def test_phase_lock_and_band_lock_coexist_uses_phase_max(self) -> None:
        """band_lock + phase_lock 共存 → 取 phase_lock 的 max lookback（band_lock 需求为 1）。"""
        params = {
            "exit_families": ["fixed_n"],
            "band_lock_grid": {"max_hold_list": [10]},
            "phase_lock_grid": {"lookback_list": [15], "init_factor_list": [0.99], "lock_factor_list": [0.999]},
        }
        assert _required_recent_lows_window(params) == 15

    def test_phase_lock_non_dict_raises(self) -> None:
        """phase_lock_grid 非 dict → ValueError（与 _build_exit_grid_from_params 同口径）。"""
        with pytest.raises(ValueError, match="phase_lock_grid 必须是各维度候选集 dict"):
            _required_recent_lows_window({"phase_lock_grid": [1, 2, 3]})
