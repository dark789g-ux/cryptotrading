"""cli.py — kelly_sweep 命令行入口。

用法：
    python -m quant_pipeline.research.kelly_sweep.cli [选项]
    python -m quant_pipeline.research.kelly_sweep.cli --self-check

主流程：
    1. 解析 argparse → 构造 SweepConfig
    2. enumerate_signals(config) → signals
    3. load_forward_paths(signals, max_window, date_end) → paths
    4. 构造 cross_section_df / history_map / index_daily_df（从 DB 加载）
    5. run_sweep(config, signals, paths, ...) → rows
    6. compute_pareto_frontier(rows) → pareto_rows
    7. rank_top_k(rows, config, paths) → topk_rows
    8. render_report(rows, config, paths, output_dir)

--self-check 模式（供 T8 集成测试用）：
    以固定复现配置跑一遍，与锚点对比，打印达标/不达标，不达标时退出码非零。
    复现配置：base=KDJ_J<-10，exit=fixed_n(1)，全市场，区间 20230101~20260531。
    锚点：Kelly≈0.171, n≈80276, 胜率≈0.5453, b≈1.214。
    容差：n 偏差 < 1%，Kelly 绝对偏差 < 0.005。
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from typing import Optional

# ── 模块级导入（便于单测 mock patch）─────────────────────────────────────────
from quant_pipeline.research.kelly_sweep.config import SweepConfig
from quant_pipeline.research.kelly_sweep.enumerate import enumerate_signals
from quant_pipeline.research.kelly_sweep.metrics import compute_metrics
from quant_pipeline.research.kelly_sweep.paths import (
    load_feature_inputs,
    load_forward_paths,
    load_index_daily,
)
from quant_pipeline.research.kelly_sweep.report import (
    compute_pareto_frontier,
    rank_top_k,
    render_report,
)
from quant_pipeline.research.kelly_sweep.sweep import run_sweep, valid_rets_for
from quant_pipeline.research.kelly_sweep.types import BaseTrigger

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# 锚点常量（spec 05§1）
# ─────────────────────────────────────────────────────────────────────────────
_ANCHOR_KELLY = 0.171
_ANCHOR_N = 80276
_ANCHOR_WIN_RATE = 0.5453
_ANCHOR_PAYOFF_B = 1.214
_ANCHOR_DATE_START = "20230101"
_ANCHOR_DATE_END = "20260531"

_TOL_N_PCT = 0.01      # n 偏差 < 1%
_TOL_KELLY_ABS = 0.005  # Kelly 绝对偏差 < 0.005


# ─────────────────────────────────────────────────────────────────────────────
# argparse 构造
# ─────────────────────────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="kelly_sweep",
        description="Kelly 上界网格扫描研究 harness",
    )

    # ── 自校验模式 ────────────────────────────────────────────────────────────
    p.add_argument(
        "--self-check",
        action="store_true",
        help=(
            "以复现配置（base=KDJ_J<-10, exit=fixed_n(1), 全市场, "
            "区间 20230101~20260531）跑一遍，与锚点对比。"
            "达标则退出码 0，不达标则退出码 1。"
        ),
    )

    # ── 基础触发配置 ──────────────────────────────────────────────────────────
    p.add_argument(
        "--base-field", default="kdj_j",
        help="base 触发条件的字段名（默认 kdj_j）",
    )
    p.add_argument(
        "--base-op", default="lt",
        choices=["lt", "lte", "gt", "gte", "eq", "neq"],
        help="base 触发条件的算子（默认 lt）",
    )
    p.add_argument(
        "--base-value", type=float, default=0.0,
        help="base 触发条件的阈值（默认 0.0）",
    )

    # ── 标的范围 ──────────────────────────────────────────────────────────────
    p.add_argument(
        "--universe", default="all",
        help="标的范围：'all' 或逗号分隔的 ts_code 列表（默认 all）",
    )

    # ── 日期区间 ──────────────────────────────────────────────────────────────
    p.add_argument("--train-start", default="20230101", help="训练区间起点 YYYYMMDD（默认 20230101）")
    p.add_argument("--train-end", default="20241231", help="训练区间终点 YYYYMMDD（默认 20241231）")
    p.add_argument("--valid-start", default="20250101", help="验证区间起点 YYYYMMDD（默认 20250101）")
    p.add_argument("--valid-end", default="20260608", help="验证区间终点 YYYYMMDD（默认 20260608）")

    # ── 其他参数 ──────────────────────────────────────────────────────────────
    p.add_argument("--max-window", type=int, default=20, help="前向最长可交易日数（默认 20）")
    p.add_argument("--min-samples", type=int, default=300, help="验证集最低样本数（默认 300）")
    p.add_argument("--top-k", type=int, default=30, help="排行榜输出前 K 条（默认 30）")
    p.add_argument(
        "--rs-benchmark", default="hs300",
        help="相对强度基准，逗号分隔（默认 hs300）",
    )
    p.add_argument(
        "--same-day-rule", default="sl_first",
        choices=["sl_first", "tp_first"],
        help="同日双触发规则（默认 sl_first）",
    )
    p.add_argument("--bootstrap-iters", type=int, default=1000, help="Bootstrap CI 重采样次数（默认 1000）")
    p.add_argument(
        "--output-dir", default="./kelly_sweep_output",
        help="报告输出目录（默认 ./kelly_sweep_output）",
    )
    p.add_argument(
        "--max-entry-filters", type=int, default=2,
        help="单变体最多附加特征数（默认 2）",
    )
    p.add_argument("-v", "--verbose", action="store_true", help="开启 DEBUG 日志")

    return p


def _parse_universe(raw: str):
    """解析 --universe 参数：'all' → 'all'；其它 → 逗号分隔的 list[str]。"""
    raw = raw.strip()
    if raw.lower() == "all":
        return "all"
    return [s.strip() for s in raw.split(",") if s.strip()]


def _parse_rs_benchmark(raw: str) -> list[str]:
    """解析 --rs-benchmark：逗号分隔 → list[str]。"""
    return [s.strip() for s in raw.split(",") if s.strip()]


# ─────────────────────────────────────────────────────────────────────────────
# 自校验逻辑
# ─────────────────────────────────────────────────────────────────────────────


def _run_self_check() -> int:
    """
    运行自校验：用复现配置跑一遍，与锚点对比。

    Returns:
        0 — 达标（n + Kelly 均在容差内）
        1 — 不达标
    """
    print("=== self-check: 复现配置 ===")
    print(f"base=KDJ_J<-10, exit=fixed_n(1), 全市场, 区间 {_ANCHOR_DATE_START}~{_ANCHOR_DATE_END}")
    print(f"锚点: Kelly≈{_ANCHOR_KELLY}, n≈{_ANCHOR_N}, 胜率≈{_ANCHOR_WIN_RATE}, b≈{_ANCHOR_PAYOFF_B}")
    print()

    # 全区间配置：valid_range 覆盖全区间，valid_rets_for 可取全量 rets
    config_full = SweepConfig(
        base_trigger=BaseTrigger(field="kdj_j", op="lt", value=-10.0),
        universe="all",
        max_window=20,
        max_entry_filters=0,  # 仅 base 变体，确保只 1 组合
        train_range=(_ANCHOR_DATE_START, _ANCHOR_DATE_END),
        valid_range=(_ANCHOR_DATE_START, _ANCHOR_DATE_END),
        min_samples=1,
        bootstrap_iters=100,  # 自校验不需要精确 CI，节省时间
        same_day_rule="sl_first",
        rs_benchmark=["hs300"],
        top_k=1,
    )

    print("1. 枚举信号...")
    signals = enumerate_signals(config_full)
    print(f"   信号数：{len(signals)}")

    print("2. 加载前向路径...")
    paths = load_forward_paths(signals, config_full.max_window, date_end=_ANCHOR_DATE_END)
    print(f"   路径数：{len(paths)}")

    print("3. 加载特征输入...")
    cross_section_df, history_map = load_feature_inputs(signals)

    print("4. 运行 run_sweep（仅 base 变体 + fixed_n(1) 出场）...")
    exit_grid_single = [{"type": "fixed_n", "n": 1}]
    rows_full = run_sweep(
        config=config_full,
        signals_raw=signals,
        paths=paths,
        cross_section_df=cross_section_df,
        history_map=history_map,
        exit_grid=exit_grid_single,
    )

    if not rows_full:
        print("ERROR: run_sweep 返回空结果")
        return 1

    base_full = next(
        (r for r in rows_full if r.variant_id == "base" and r.window_group == "no_rs"),
        None,
    )
    if base_full is None:
        print("ERROR: run_sweep 找不到 base / no_rs ResultRow")
        return 1

    all_rets = valid_rets_for(base_full, paths)
    m = compute_metrics(all_rets)

    print("=== 复现结果 ===")
    print(f"  n       = {m.n}  (锚点 {_ANCHOR_N})")
    print(f"  Kelly   = {m.kelly}  (锚点 {_ANCHOR_KELLY})")
    print(f"  胜率    = {m.win_rate}  (锚点 {_ANCHOR_WIN_RATE})")
    print(f"  payoff_b= {m.payoff_b}  (锚点 {_ANCHOR_PAYOFF_B})")
    print()

    # 容差检查
    ok = True

    if m.n == 0:
        print("FAIL: n=0，无有效信号")
        ok = False
    else:
        n_diff_pct = abs(m.n - _ANCHOR_N) / _ANCHOR_N
        if n_diff_pct >= _TOL_N_PCT:
            print(f"FAIL: n 偏差 {n_diff_pct:.2%} >= 容差 {_TOL_N_PCT:.0%}")
            ok = False
        else:
            print(f"OK:   n 偏差 {n_diff_pct:.2%} < {_TOL_N_PCT:.0%}")

    if m.kelly is None:
        print("FAIL: Kelly=None（无法计算）")
        ok = False
    else:
        kelly_diff = abs(m.kelly - _ANCHOR_KELLY)
        if kelly_diff >= _TOL_KELLY_ABS:
            print(f"FAIL: Kelly 绝对偏差 {kelly_diff:.4f} >= 容差 {_TOL_KELLY_ABS}")
            ok = False
        else:
            print(f"OK:   Kelly 绝对偏差 {kelly_diff:.4f} < {_TOL_KELLY_ABS}")

    print()
    if ok:
        print("=== 自校验通过 ===")
        return 0
    else:
        print("=== 自校验不达标：请按 systematic-debugging 逐项排查口径 ===")
        return 1


# ─────────────────────────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────────────────────────


def _run_sweep_pipeline(args: argparse.Namespace) -> int:
    """完整扫描 + 报告流程。返回退出码（0=成功）。"""
    universe = _parse_universe(args.universe)
    rs_benchmark = _parse_rs_benchmark(args.rs_benchmark)

    config = SweepConfig(
        base_trigger=BaseTrigger(
            field=args.base_field,
            op=args.base_op,
            value=args.base_value,
        ),
        universe=universe,
        max_window=args.max_window,
        max_entry_filters=args.max_entry_filters,
        train_range=(args.train_start, args.train_end),
        valid_range=(args.valid_start, args.valid_end),
        min_samples=args.min_samples,
        bootstrap_iters=args.bootstrap_iters,
        same_day_rule=args.same_day_rule,
        rs_benchmark=rs_benchmark,
        top_k=args.top_k,
    )

    output_dir = Path(args.output_dir)

    print(f"Kelly Sweep: {config.base_trigger}, universe={config.universe}")
    print(f"train={config.train_range}, valid={config.valid_range}")
    print(f"min_samples={config.min_samples}, top_k={config.top_k}")
    print()

    # 1. 枚举信号
    print("枚举信号...")
    signals = enumerate_signals(config)
    print(f"  信号数：{len(signals)}")

    if not signals:
        print("ERROR: 无信号，退出")
        return 1

    # 2. 加载前向路径
    print("加载前向路径...")
    paths = load_forward_paths(signals, config.max_window, date_end=config.valid_range[1])
    print(f"  路径数：{len(paths)}")

    # 3. 加载特征输入
    print("加载特征输入...")
    cross_section_df, history_map = load_feature_inputs(signals)

    # 4. 加载指数日线（RS 基准）
    index_daily_df = None
    _bench_code_map = {"hs300": "883300.TI", "zz500": "883304.TI"}
    bench_codes = [_bench_code_map[b] for b in rs_benchmark if b in _bench_code_map]
    if bench_codes:
        print(f"加载指数日线（{bench_codes}）...")
        index_daily_df = load_index_daily(
            bench_codes,
            (config.train_range[0], config.valid_range[1]),
        )

    # 5. 运行扫描
    print("运行 run_sweep...")
    rows = run_sweep(
        config=config,
        signals_raw=signals,
        paths=paths,
        cross_section_df=cross_section_df,
        history_map=history_map,
        index_daily_df=index_daily_df,
    )
    print(f"  ResultRow 数：{len(rows)}")

    if not rows:
        print("ERROR: run_sweep 无结果")
        return 1

    # 6. 计算帕累托前沿
    print("计算帕累托前沿...")
    pareto_rows = compute_pareto_frontier(rows)
    n_frontier = sum(1 for p in pareto_rows if p["is_frontier"])
    print(f"  前沿点数：{n_frontier}")

    # 7. top-K + CI
    print(f"计算 top-{config.top_k} + bootstrap CI...")
    topk_rows = rank_top_k(rows, config, paths)

    # 8. 渲染报告
    print(f"渲染报告至 {output_dir}...")
    render_report(
        rows=rows,
        config=config,
        paths=paths,
        output_dir=output_dir,
        pareto_rows=pareto_rows,
        topk_rows=topk_rows,
    )

    print()
    print(f"完成。报告已写入 {output_dir}/")
    for wg, wg_rows in topk_rows.items():
        if wg_rows:
            kv = wg_rows[0].kelly_valid
            kv_str = f"{kv:.4f}" if kv is not None else "N/A"
            print(f"  [{wg}] top-{len(wg_rows)} 最高 kelly_oos = {kv_str}")
    return 0


# ─────────────────────────────────────────────────────────────────────────────
# main
# ─────────────────────────────────────────────────────────────────────────────


def main(argv: Optional[list[str]] = None) -> int:
    """CLI 入口，返回退出码。"""
    parser = _build_parser()
    args = parser.parse_args(argv)

    # 日志配置
    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    if args.self_check:
        return _run_self_check()

    return _run_sweep_pipeline(args)


if __name__ == "__main__":
    sys.exit(main())
