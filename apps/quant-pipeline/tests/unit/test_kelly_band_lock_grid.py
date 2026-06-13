"""单元测试：kelly_sweep band_lock 扫描维度（build_band_lock_grid + _exit_id 扩展 + _run_exit 透传）。

任务 C（第 2 层），权威 spec：
  docs/superpowers/specs/2026-06-13-band-lock-params-config-design/05-labels-and-kelly.md §二~四
  + 01-params-and-semantics.md / 02-scheme-codec.md（参数语义 + 量化）

关键零漂移硬门：
  - build_band_lock_grid()（全默认候选集）== 现状 DEFAULT_EXIT_GRID 中 band_lock 3 个 cfg；
    且 _exit_id 全默认逐字不变（band_lock(mh=None)/band_lock(mh=10)/band_lock(mh=20)）。
  - 坍缩去重：floor_enabled:[T,F] × floor_ratio:[0.998,0.999] → 3 个（非 4）。
  - 护栏（band_lock 族 >200 cfg）warn，不拒绝不截断。
"""

from __future__ import annotations

import logging

import pytest

from quant_pipeline.research.kelly_sweep.exits import simulate_band_lock_exit
from quant_pipeline.research.kelly_sweep.sweep import (
    DEFAULT_EXIT_GRID,
    _exit_id,
    _run_exit,
    build_band_lock_grid,
)
from quant_pipeline.research.kelly_sweep.types import Bar, ForwardPath


# ─────────────────────────────────────────────────────────────────────────────
# 辅助构造器（与 test_kelly_band_lock_exit.py 同口径）
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
# 1. 零漂移硬门：默认候选集 == 现状 3 个 cfg
# ─────────────────────────────────────────────────────────────────────────────


class TestDefaultGridZeroDrift:
    def test_default_grid_is_three_cfgs(self) -> None:
        """build_band_lock_grid()（全默认）→ 恰 3 个 cfg。"""
        grid = build_band_lock_grid()
        assert len(grid) == 3

    def test_default_grid_max_holds(self) -> None:
        """3 个 cfg 的 max_hold ∈ {None, 10, 20}（照现状 DEFAULT_EXIT_GRID）。"""
        grid = build_band_lock_grid()
        mhs = [cfg["max_hold"] for cfg in grid]
        assert mhs == [None, 10, 20]

    def test_default_grid_all_type_band_lock(self) -> None:
        grid = build_band_lock_grid()
        assert all(cfg["type"] == "band_lock" for cfg in grid)

    def test_default_grid_carries_all_five_keys(self) -> None:
        """每个 cfg 携带 5 个出场参数键（type + max_hold + 4 新参数）。"""
        grid = build_band_lock_grid()
        for cfg in grid:
            assert cfg["type"] == "band_lock"
            assert "max_hold" in cfg
            assert "stop_ratio" in cfg
            assert "floor_ratio" in cfg
            assert "floor_enabled" in cfg
            assert "ma5_require_down" in cfg

    def test_default_grid_values_are_core_defaults(self) -> None:
        """默认候选集各 cfg 的 4 新参数 = 共享核默认（0.999/0.999/True/True）。"""
        grid = build_band_lock_grid()
        for cfg in grid:
            assert cfg["stop_ratio"] == pytest.approx(0.999)
            assert cfg["floor_ratio"] == pytest.approx(0.999)
            assert cfg["floor_enabled"] is True
            assert cfg["ma5_require_down"] is True

    def test_default_grid_exit_ids_match_legacy(self) -> None:
        """硬门：默认候选集 _exit_id 与现状 DEFAULT_EXIT_GRID band_lock 段逐字一致。"""
        grid = build_band_lock_grid()
        ids = [_exit_id(cfg) for cfg in grid]
        assert ids == ["band_lock(mh=None)", "band_lock(mh=10)", "band_lock(mh=20)"]

    def test_default_grid_exit_ids_match_default_exit_grid(self) -> None:
        """默认候选集 _exit_id 与 DEFAULT_EXIT_GRID 中 band_lock 段的 _exit_id 完全一致。"""
        legacy_ids = [_exit_id(c) for c in DEFAULT_EXIT_GRID if c["type"] == "band_lock"]
        grid_ids = [_exit_id(c) for c in build_band_lock_grid()]
        assert grid_ids == legacy_ids


# ─────────────────────────────────────────────────────────────────────────────
# 2. 笛卡尔积展开
# ─────────────────────────────────────────────────────────────────────────────


class TestCartesianProduct:
    def test_stop_ratio_sweep(self) -> None:
        """扫 stop_ratio:[0.997,0.998,0.999] × max_hold:[None,10,20] → 3×3 = 9。"""
        grid = build_band_lock_grid(
            max_hold_list=[None, 10, 20],
            stop_ratio_list=[0.997, 0.998, 0.999],
        )
        assert len(grid) == 9

    def test_single_value_lists_degenerate(self) -> None:
        """各维度单值 + max_hold 单值 → 1 个 cfg。"""
        grid = build_band_lock_grid(max_hold_list=[10])
        assert len(grid) == 1
        assert grid[0]["max_hold"] == 10

    def test_two_dims_product(self) -> None:
        """stop_ratio:[0.997,0.998] × ma5_require_down:[True,False] × max_hold:[None] → 4。"""
        grid = build_band_lock_grid(
            max_hold_list=[None],
            stop_ratio_list=[0.997, 0.998],
            ma5_require_down_list=[True, False],
        )
        assert len(grid) == 4

    def test_ratios_are_quantized(self) -> None:
        """候选 ratio 进笛卡尔积前经 quantize_band_lock_params 量化（0.9994→0.999）。"""
        # 0.9994 量化 NNNN = floor(999.4+0.5)=999 → 0.999
        grid = build_band_lock_grid(max_hold_list=[None], stop_ratio_list=[0.9994])
        assert len(grid) == 1
        assert grid[0]["stop_ratio"] == pytest.approx(0.999)


# ─────────────────────────────────────────────────────────────────────────────
# 3. 坍缩去重（floor_enabled=false 时 floor_ratio 从指纹剔除）
# ─────────────────────────────────────────────────────────────────────────────


class TestCollapseDedup:
    def test_floor_disabled_collapses_floor_ratio(self) -> None:
        """floor_enabled:[T,F] × floor_ratio:[0.998,0.999] × max_hold:[None] → 3（非 4）。"""
        grid = build_band_lock_grid(
            max_hold_list=[None],
            floor_ratio_list=[0.998, 0.999],
            floor_enabled_list=[True, False],
        )
        assert len(grid) == 3

    def test_floor_disabled_branch_floor_ratio_is_placeholder(self) -> None:
        """floor_enabled=false 分支 floor_ratio 取占位默认 0.999（坍缩成单条）。"""
        grid = build_band_lock_grid(
            max_hold_list=[None],
            floor_ratio_list=[0.998, 0.999],
            floor_enabled_list=[True, False],
        )
        false_cfgs = [c for c in grid if c["floor_enabled"] is False]
        assert len(false_cfgs) == 1
        assert false_cfgs[0]["floor_ratio"] == pytest.approx(0.999)  # 占位默认

    def test_floor_enabled_true_expands_floor_ratio(self) -> None:
        """floor_enabled=true 分支正常展开 floor_ratio 候选。"""
        grid = build_band_lock_grid(
            max_hold_list=[None],
            floor_ratio_list=[0.998, 0.999],
            floor_enabled_list=[True, False],
        )
        true_cfgs = [c for c in grid if c["floor_enabled"] is True]
        true_frs = sorted(c["floor_ratio"] for c in true_cfgs)
        assert true_frs == pytest.approx([0.998, 0.999])

    def test_only_floor_disabled_single_cfg_per_other_dims(self) -> None:
        """floor_enabled:[False] × floor_ratio:[0.997,0.998,0.999] → 仅 1 个（floor_ratio 不展开）。"""
        grid = build_band_lock_grid(
            max_hold_list=[None],
            floor_ratio_list=[0.997, 0.998, 0.999],
            floor_enabled_list=[False],
        )
        assert len(grid) == 1
        assert grid[0]["floor_enabled"] is False

    def test_collapse_dedup_with_extra_dims(self) -> None:
        """坍缩与其它维度正交：max_hold:[10,20] × (floor 坍缩 3) = 6。"""
        grid = build_band_lock_grid(
            max_hold_list=[10, 20],
            floor_ratio_list=[0.998, 0.999],
            floor_enabled_list=[True, False],
        )
        assert len(grid) == 6


# ─────────────────────────────────────────────────────────────────────────────
# 4. _exit_id 扩展（守现存 + 非默认按 sr→fr→fl→md 追加 + fr 省略规则）
# ─────────────────────────────────────────────────────────────────────────────


class TestExitIdExtension:
    def test_all_default_unchanged(self) -> None:
        """全默认 → band_lock(mh=X) 不变（守现存）。"""
        assert _exit_id({"type": "band_lock", "max_hold": None}) == "band_lock(mh=None)"
        assert _exit_id({"type": "band_lock", "max_hold": 10}) == "band_lock(mh=10)"
        # 显式带 4 默认参数也应与 legacy 一致（零漂移）
        cfg = {
            "type": "band_lock", "max_hold": 10,
            "stop_ratio": 0.999, "floor_ratio": 0.999,
            "floor_enabled": True, "ma5_require_down": True,
        }
        assert _exit_id(cfg) == "band_lock(mh=10)"

    def test_stop_ratio_non_default(self) -> None:
        cfg = {"type": "band_lock", "max_hold": 10, "stop_ratio": 0.997}
        assert _exit_id(cfg) == "band_lock(mh=10,sr=0.997)"

    def test_floor_ratio_non_default_with_floor_enabled(self) -> None:
        """fl=1（默认）且 fr 非默认 → 含 fr。"""
        cfg = {"type": "band_lock", "max_hold": 10, "floor_ratio": 1.020}
        assert _exit_id(cfg) == "band_lock(mh=10,fr=1.02)"

    def test_floor_disabled_omits_fr(self) -> None:
        """fl=0 → 省 fr（与坍缩指纹同口径）。"""
        cfg = {
            "type": "band_lock", "max_hold": 10,
            "floor_ratio": 1.020,  # 非默认但 fl=0 → 省略
            "floor_enabled": False,
        }
        assert _exit_id(cfg) == "band_lock(mh=10,fl=0)"

    def test_ma5_require_down_non_default(self) -> None:
        cfg = {"type": "band_lock", "max_hold": 10, "ma5_require_down": False}
        assert _exit_id(cfg) == "band_lock(mh=10,md=0)"

    def test_full_non_default_order(self) -> None:
        """非默认按固定顺序 sr→fr→fl→md 追加；fl=0 时省 fr。"""
        cfg = {
            "type": "band_lock", "max_hold": 10,
            "stop_ratio": 0.997, "floor_ratio": 1.020,
            "floor_enabled": False, "ma5_require_down": False,
        }
        # fl=0 → 省 fr
        assert _exit_id(cfg) == "band_lock(mh=10,sr=0.997,fl=0,md=0)"

    def test_full_non_default_floor_enabled_keeps_fr(self) -> None:
        """fl=1 + 全非默认 → 含 fr，顺序 sr→fr→md。"""
        cfg = {
            "type": "band_lock", "max_hold": None,
            "stop_ratio": 0.997, "floor_ratio": 1.020,
            "floor_enabled": True, "ma5_require_down": False,
        }
        assert _exit_id(cfg) == "band_lock(mh=None,sr=0.997,fr=1.02,md=0)"

    def test_grid_exit_ids_unique(self) -> None:
        """任意候选集生成的 grid，_exit_id 全唯一（无碰撞）。"""
        grid = build_band_lock_grid(
            max_hold_list=[None, 10, 20],
            stop_ratio_list=[0.997, 0.998, 0.999],
            floor_ratio_list=[0.998, 0.999],
            floor_enabled_list=[True, False],
            ma5_require_down_list=[True, False],
        )
        ids = [_exit_id(c) for c in grid]
        assert len(ids) == len(set(ids)), "band_lock grid 各 cfg 的 _exit_id 必须唯一"

    def test_grid_no_duplicate_cfgs(self) -> None:
        """坍缩后 grid 内无重复 cfg（指纹去重保证）。"""
        grid = build_band_lock_grid(
            max_hold_list=[None],
            floor_ratio_list=[0.998, 0.999],
            floor_enabled_list=[True, False, False],  # 重复 False
        )
        # floor_enabled 候选去重 + 坍缩：T+0.998 / T+0.999 / F = 3
        assert len(grid) == 3


# ─────────────────────────────────────────────────────────────────────────────
# 5. 网格爆炸护栏（>200 warn，不拒绝不截断）
# ─────────────────────────────────────────────────────────────────────────────


class TestGuardrail:
    def test_over_200_warns_not_truncated(self, caplog) -> None:
        """band_lock 族 cfg > 200 → logger.warning，但不截断（全数返回）。"""
        # 构造 > 200：max_hold 阔列表凑数。坍缩不影响（floor_enabled 单值 True）。
        # max_hold 11 个 × stop 3 × floor 2 × ma5 2 × floor_enabled[True] = 11*3*2*2 = 132 不够；
        # 用 stop 5 × floor 3 × max_hold 5 × ma5 2 = 150；再加 floor_enabled[True,False] 坍缩…
        # 直接 max_hold 51 × stop 5 = 255 > 200。
        max_holds = list(range(1, 52))  # 51 个
        stops = [0.995, 0.996, 0.997, 0.998, 0.999]  # 5 个
        with caplog.at_level(logging.WARNING):
            grid = build_band_lock_grid(max_hold_list=max_holds, stop_ratio_list=stops)
        assert len(grid) == 255  # 不截断
        assert any("200" in rec.message or "band_lock" in rec.message.lower()
                   for rec in caplog.records if rec.levelno == logging.WARNING)

    def test_under_200_no_warn(self, caplog) -> None:
        """band_lock 族 cfg <= 200 → 不 warn。"""
        with caplog.at_level(logging.WARNING):
            grid = build_band_lock_grid(
                max_hold_list=[None, 10, 20],
                stop_ratio_list=[0.997, 0.998, 0.999],
            )
        assert len(grid) == 9
        warn_records = [r for r in caplog.records if r.levelno == logging.WARNING]
        # 不应有 band_lock 护栏 warn（其它无关 warn 不计）
        assert not any("200" in r.message for r in warn_records)


# ─────────────────────────────────────────────────────────────────────────────
# 6. _run_exit 透传 4 参数（透传改变 ret）
# ─────────────────────────────────────────────────────────────────────────────


class TestRunExitPassthrough:
    def test_default_cfg_matches_legacy(self) -> None:
        """全默认 cfg 的 _run_exit 与 simulate_band_lock_exit(默认) 结果一致（零漂移）。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.8, c=10.2)
        bars = [
            make_bar("20260103", o=10.4, h=10.6, low=10.5, c=10.5),
            make_bar("20260106", o=10.45, h=10.5, low=10.40, c=10.42),
        ]
        path = make_path(buy_bar, bars, signal_bar_high=10.0)
        ret_via_run = _run_exit(path, {"type": "band_lock", "max_hold": None}, "sl_first")
        ret_direct = simulate_band_lock_exit(path).ret  # type: ignore[union-attr]
        assert ret_via_run == pytest.approx(ret_direct)

    def test_ma5_require_down_false_changes_ret(self) -> None:
        """ma5_require_down=False（只要收盘跌破 MA5 即离场，更早出）→ ret 与默认不同。

        构造：锁定后 close<ma5 但 ma5 未下行（ma5>=prev_ma5）。
          - 默认（require_down=True）：不离场（需均线下行）→ 后续窗口耗尽 max_hold。
          - require_down=False：close<ma5 即离场，更早出。
        两路径 ret/出场日不同。
        """
        # buy_bar 方案一(close>open)，ma5=10.0
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.8, c=10.2, ma5=10.0)
        bars = [
            # T+2：锁定（low>signal_high=10.0）；close>=ma5 不离场；ma5 上行 10.0→10.3
            make_bar("20260103", o=10.4, h=10.6, low=10.5, c=10.5, ma5=10.3),
            # T+3：close=10.2 < ma5=10.4，但 ma5 上行（10.4>prev 10.3）→ require_down 不离场
            make_bar("20260106", o=10.4, h=10.6, low=10.49, c=10.2, ma5=10.4),
            # T+4：温和，窗口耗尽兜底
            make_bar("20260107", o=10.3, h=10.5, low=10.49, c=10.45, ma5=10.45),
        ]
        path = make_path(buy_bar, bars, signal_bar_high=10.0)

        ret_default = _run_exit(path, {"type": "band_lock", "max_hold": None}, "sl_first")
        ret_md_false = _run_exit(
            path,
            {"type": "band_lock", "max_hold": None, "ma5_require_down": False},
            "sl_first",
        )
        assert ret_default is not None and ret_md_false is not None
        # require_down=False 在 T+3 close<ma5 即离场（exit @10.2）；默认不离场走到后续 → ret 不同
        assert ret_md_false != pytest.approx(ret_default)

    def test_run_exit_grid_cfg_no_keyerror(self) -> None:
        """build_band_lock_grid 产出的 cfg 直接喂 _run_exit 不报 KeyError。"""
        buy_bar = make_bar("20260102", o=10.0, h=10.3, low=9.99, c=10.2)
        bars = [make_bar("20260103", o=10.2, h=10.5, low=10.15, c=10.3)]
        path = make_path(buy_bar, bars, signal_bar_high=99.0)
        grid = build_band_lock_grid(
            max_hold_list=[None, 10],
            stop_ratio_list=[0.997, 0.999],
            floor_enabled_list=[True, False],
            ma5_require_down_list=[True, False],
        )
        for cfg in grid:
            ret = _run_exit(path, cfg, "sl_first")
            assert ret is not None
