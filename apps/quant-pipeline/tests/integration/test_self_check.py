"""T8 集成测：self-check 复现锚点验收闸。

spec 05§1 锚点：
  base=KDJ_J<-10, exit=fixed_n(1), 全市场, 信号枚举末端 20260515（锚点数据快照边界）。
  Kelly≈0.171 (容差 abs < 0.005), n≈80276 (容差 < 1%)。
  胜率≈0.5453, b≈1.214 (参考断言，容差 ±0.02)。
  注：信号枚举末端用 20260515 而非 20260531——更晚 date_end 会纳入锚点跑时尚不存在的
  尾部真实信号，使 n/Kelly 偏离（数据快照差异，非 bug）。路径 date_end 用 20260531。

Gate 策略：
  - 依赖 tests/integration/conftest.py 的 _require_pg autouse fixture（无 DB → skip）。
  - 额外受 RUN_KELLY_SELF_CHECK 环境变量控制：未设置则 skip（防止全量跑混入
    默认快速单测）。全量跑时显式 RUN_KELLY_SELF_CHECK=1 开启。
  - 测试本身无 @pytest.mark.integration（避免因 --strict-markers 未注册而报错）。
"""

from __future__ import annotations

import os
import time
import logging

import pytest

# ── 环境变量 skip 守卫（不设则跳过，不污染默认快速单测）────────────────────────
_RUN_VAR = "RUN_KELLY_SELF_CHECK"
if not os.environ.get(_RUN_VAR):
    pytest.skip(
        f"跳过 kelly self-check 集成测（耗时可达数分钟）。"
        f"需要显式设置 {_RUN_VAR}=1 后重跑。",
        allow_module_level=True,
    )

# ── 内部导入（skip 后不执行）──────────────────────────────────────────────────
from quant_pipeline.research.kelly_sweep.cli import (
    _ANCHOR_KELLY,
    _ANCHOR_N,
    _ANCHOR_WIN_RATE,
    _ANCHOR_PAYOFF_B,
    _ANCHOR_DATE_START,
    _ANCHOR_DATE_END,
    _ANCHOR_PATH_DATE_END,
    _TOL_N_PCT,
    _TOL_KELLY_ABS,
    _run_self_check,
)
from quant_pipeline.research.kelly_sweep.config import SweepConfig
from quant_pipeline.research.kelly_sweep.enumerate import enumerate_signals
from quant_pipeline.research.kelly_sweep.metrics import compute_metrics
from quant_pipeline.research.kelly_sweep.paths import load_feature_inputs, load_forward_paths
from quant_pipeline.research.kelly_sweep.sweep import run_sweep, valid_rets_for
from quant_pipeline.research.kelly_sweep.types import BaseTrigger

logger = logging.getLogger(__name__)

# 宽松参考容差（胜率 / b）
_TOL_REF = 0.02


def test_kelly_self_check_anchor() -> None:
    """运行 kelly sweep 自校验流水线，验证复现指标落在锚点容差内。

    这是 Phase1 的验收闸（spec 05§1）。依赖 _require_pg autouse fixture（无 DB → skip）。
    """
    t0 = time.monotonic()

    # ── 复现配置（与 cli._run_self_check 完全一致）──────────────────────────────
    config = SweepConfig(
        base_trigger=BaseTrigger(field="kdj_j", op="lt", value=-10.0),
        universe="all",
        max_window=20,
        max_entry_filters=0,
        train_range=(_ANCHOR_DATE_START, _ANCHOR_DATE_END),
        valid_range=(_ANCHOR_DATE_START, _ANCHOR_DATE_END),
        min_samples=1,
        bootstrap_iters=100,
        same_day_rule="sl_first",
        rs_benchmark=["hs300"],
        top_k=1,
    )

    # 1. 枚举信号
    logger.info("步骤 1/4：enumerate_signals ...")
    signals = enumerate_signals(config)
    logger.info("原始信号数：%d", len(signals))

    assert len(signals) > 0, "enumerate_signals 返回空，无法继续"

    # 2. 加载前向路径（路径 date_end 用 _ANCHOR_PATH_DATE_END，给边界信号留后向窗口）
    logger.info("步骤 2/4：load_forward_paths ...")
    paths = load_forward_paths(signals, config.max_window, date_end=_ANCHOR_PATH_DATE_END)
    logger.info("路径数：%d", len(paths))

    # 3. 加载特征输入（run_sweep 依赖）
    logger.info("步骤 3/4：load_feature_inputs ...")
    cross_section_df, history_map = load_feature_inputs(signals)

    # 4. 运行 run_sweep（仅 base 变体 + fixed_n(1)）
    logger.info("步骤 4/4：run_sweep ...")
    exit_grid_single = [{"type": "fixed_n", "n": 1}]
    rows = run_sweep(
        config=config,
        signals_raw=signals,
        paths=paths,
        cross_section_df=cross_section_df,
        history_map=history_map,
        exit_grid=exit_grid_single,
    )

    assert rows, "run_sweep 返回空结果"

    # 取 base / no_rs ResultRow
    base_row = next(
        (r for r in rows if r.variant_id == "base" and r.window_group == "no_rs"),
        None,
    )
    assert base_row is not None, (
        f"找不到 base/no_rs ResultRow；实际 variant_ids: {[r.variant_id for r in rows]}"
    )

    # 从 valid_keys 重算收益率（全区间 valid_range == train_range，取全量 rets）
    all_rets = valid_rets_for(base_row, paths)
    m = compute_metrics(all_rets)

    elapsed = time.monotonic() - t0

    # ── 打印实际数字供人工核查 ────────────────────────────────────────────────
    print()
    print("=== T8 自校验复现结果 ===")
    print(f"  耗时：{elapsed:.1f}s")
    print(f"  n       = {m.n}  (锚点 {_ANCHOR_N},  容差 <1%)")
    print(f"  Kelly   = {m.kelly}  (锚点 {_ANCHOR_KELLY},  容差 abs<0.005)")
    print(f"  胜率    = {m.win_rate}  (锚点 {_ANCHOR_WIN_RATE},  参考 ±{_TOL_REF})")
    print(f"  payoff_b= {m.payoff_b}  (锚点 {_ANCHOR_PAYOFF_B},  参考 ±{_TOL_REF})")
    print()

    # ── 硬断言：n ─────────────────────────────────────────────────────────────
    assert m.n > 0, "n=0，无有效信号"

    n_diff_pct = abs(m.n - _ANCHOR_N) / _ANCHOR_N
    assert n_diff_pct < _TOL_N_PCT, (
        f"n={m.n} 偏差 {n_diff_pct:.2%} 超出容差 {_TOL_N_PCT:.0%}（锚点 {_ANCHOR_N}）"
    )

    # ── 硬断言：Kelly ─────────────────────────────────────────────────────────
    assert m.kelly is not None, "Kelly=None，无法计算（检查 payoff_b / win_rate）"

    kelly_diff = abs(m.kelly - _ANCHOR_KELLY)
    assert kelly_diff < _TOL_KELLY_ABS, (
        f"Kelly={m.kelly:.4f} 绝对偏差 {kelly_diff:.4f} 超出容差 {_TOL_KELLY_ABS}（锚点 {_ANCHOR_KELLY}）"
    )

    # ── 参考断言：胜率 / b（容差宽松，排查口径分歧用）──────────────────────────
    assert m.win_rate is not None
    win_rate_diff = abs(m.win_rate - _ANCHOR_WIN_RATE)
    assert win_rate_diff < _TOL_REF, (
        f"胜率={m.win_rate:.4f} 偏差 {win_rate_diff:.4f} 超出参考容差 {_TOL_REF}"
        f"（锚点 {_ANCHOR_WIN_RATE}）"
    )

    assert m.payoff_b is not None
    b_diff = abs(m.payoff_b - _ANCHOR_PAYOFF_B)
    assert b_diff < _TOL_REF, (
        f"payoff_b={m.payoff_b:.4f} 偏差 {b_diff:.4f} 超出参考容差 {_TOL_REF}"
        f"（锚点 {_ANCHOR_PAYOFF_B}）"
    )

    print(f"=== 全部断言通过（耗时 {elapsed:.1f}s）===")
