"""report.py — 帕累托前沿 + top-K 排行 + 文件渲染（CSV / Markdown）。

责任：
  1. compute_pareto_frontier(rows)  — 标注每行 is_frontier（按 window_group 分组）
  2. rank_top_k(rows, config, paths) — 取 top-K，填 CI
  3. render_report(rows, config, output_dir) — 写 CSV + Markdown

不查 DB，不做 CLI（cli.py 负责）。
"""

from __future__ import annotations

import csv
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from quant_pipeline.research.kelly_sweep.config import SweepConfig
from quant_pipeline.research.kelly_sweep.metrics import bootstrap_kelly_ci
from quant_pipeline.research.kelly_sweep.sweep import ResultRow, valid_rets_for
from quant_pipeline.research.kelly_sweep.types import ForwardPath

logger = logging.getLogger(__name__)

# 基线参考（spec 04§4 / 05§1）
_BASELINE_KELLY = 0.171
_BASELINE_LABEL = "J<-10 + fixed_n(1)"


# ─────────────────────────────────────────────────────────────────────────────
# 1. 帕累托前沿
# ─────────────────────────────────────────────────────────────────────────────


def compute_pareto_frontier(rows: list[ResultRow]) -> list[dict]:
    """标注每行是否在帕累托前沿（按 window_group 分组各算一份）。

    支配定义：A 支配 B ⟺
        n_valid_A ≤ n_valid_B 且 kelly_valid_A ≥ kelly_valid_B
        且至少一项严格成立。
    前沿 = 不被任何点支配的点集。

    参与条件：
        - below_floor=False
        - kelly_valid 不为 None

    below_floor=True 的行也返回，但 is_frontier=False（灰点展示用）。

    Returns:
        list[dict]，每项含原 ResultRow 的所有字段（来自 row.__dict__）加 is_frontier(bool)。
        顺序与 rows 入参一致。
    """
    # 按 window_group 分组，各自算前沿
    groups: dict[str, list[tuple[int, ResultRow]]] = {}
    for idx, row in enumerate(rows):
        groups.setdefault(row.window_group, []).append((idx, row))

    frontier_set: set[int] = set()

    for _wg, grp in groups.items():
        # 候选点：below_floor=False 且 kelly_valid 不为 None
        candidates = [
            (idx, row) for idx, row in grp
            if not row.below_floor and row.kelly_valid is not None
        ]

        # 逐对检查支配关系：O(n^2)，候选数量有限可接受
        dominated: set[int] = set()
        for i, (idx_a, row_a) in enumerate(candidates):
            for j, (idx_b, row_b) in enumerate(candidates):
                if i == j:
                    continue
                # A 支配 B？（目标：最小化 n，最大化 kelly_valid）
                n_a, k_a = row_a.n_valid, row_a.kelly_valid
                n_b, k_b = row_b.n_valid, row_b.kelly_valid
                if (n_a <= n_b and k_a >= k_b) and (n_a < n_b or k_a > k_b):
                    dominated.add(idx_b)

        for idx, _row in candidates:
            if idx not in dominated:
                frontier_set.add(idx)

    result: list[dict] = []
    for idx, row in enumerate(rows):
        d = row.__dict__.copy()
        d["is_frontier"] = idx in frontier_set
        result.append(d)

    return result


# ─────────────────────────────────────────────────────────────────────────────
# 2. top-K 排行（含 CI 填充）
# ─────────────────────────────────────────────────────────────────────────────


def rank_top_k(
    rows: list[ResultRow],
    config: SweepConfig,
    paths: list[ForwardPath],
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> dict[str, list[ResultRow]]:
    """按 window_group 取 top-K（kelly_valid 降序），对入选行计算 bootstrap CI。

    入选条件：below_floor=False，kelly_valid 不为 None。
    CI 用 valid_rets_for(row, paths) + bootstrap_kelly_ci(rets, config.bootstrap_iters)。
    same_day_rule 从 row.same_day_rule 取（与扫描时口径一致）。

    Args:
        rows:        run_sweep 产出的 ResultRow 列表。
        config:      SweepConfig（top_k + bootstrap_iters）。
        paths:       run_sweep 使用的同批 ForwardPath（valid_rets_for 重算用）。
        on_progress: 可选进度回调 `(done: int, total: int) -> None`；bootstrap CI
                     每算完一行 emit (done, total_topk_rows)。默认 None → 不回调。

    Returns:
        dict[window_group → list[ResultRow]]（CI 已填充，kelly_ci_low/high 为 float 或 None）。
        各组按 kelly_valid 降序排列，最多 top_k 条。
    """
    groups: dict[str, list[ResultRow]] = {}
    for row in rows:
        if row.below_floor or row.kelly_valid is None:
            continue
        groups.setdefault(row.window_group, []).append(row)

    # 预计算总 top-K 行数，供 on_progress 使用
    _all_top: list[tuple[str, list[ResultRow]]] = []
    for wg, grp in groups.items():
        sorted_grp = sorted(grp, key=lambda r: r.kelly_valid, reverse=True)
        _all_top.append((wg, sorted_grp[: config.top_k]))
    _total_topk = sum(len(t) for _, t in _all_top)
    _done_ci = 0

    result: dict[str, list[ResultRow]] = {}

    for wg, top in _all_top:
        enriched: list[ResultRow] = []
        for row in top:
            rets = valid_rets_for(row, paths)
            ci_low, ci_high = bootstrap_kelly_ci(rets, config.bootstrap_iters)
            # ResultRow 是 dataclass，需要替换字段值
            from dataclasses import replace as dc_replace
            enriched.append(dc_replace(row, kelly_ci_low=ci_low, kelly_ci_high=ci_high))
            _done_ci += 1
            if on_progress is not None:
                on_progress(_done_ci, _total_topk)

        result[wg] = enriched
        logger.info("rank_top_k [%s]: %d 行入选，top-%d CI 计算完毕", wg, len(top), len(enriched))

    return result


# ─────────────────────────────────────────────────────────────────────────────
# 3. 可读化辅助
# ─────────────────────────────────────────────────────────────────────────────


def _describe_variant(variant_filters: list[tuple[str, str, float]]) -> str:
    """把 variant_filters 列表转成可读字符串。空列表 → 'base'。"""
    if not variant_filters:
        return "base"
    parts = [f"{feat} {op} {val}" for feat, op, val in variant_filters]
    return " AND ".join(parts)


def _describe_exit(exit_cfg: dict) -> str:
    """把 exit_cfg 字典转成可读字符串。"""
    t = exit_cfg.get("type", "?")
    if t == "fixed_n":
        return f"fixed_n({exit_cfg.get('n')})"
    if t == "tp_sl":
        return f"tp_sl(tp={exit_cfg.get('tp_pct')}, sl={exit_cfg.get('sl_pct')}, mh={exit_cfg.get('max_hold')})"
    if t == "trailing":
        return f"trailing(z={exit_cfg.get('z_pct')}, mh={exit_cfg.get('max_hold')})"
    if t == "atr_stop":
        return f"atr_stop(k={exit_cfg.get('k')}, mh={exit_cfg.get('max_hold')})"
    return str(exit_cfg)


def _fmt(v: Optional[float], decimals: int = 4) -> str:
    """格式化浮点数或 None。"""
    if v is None:
        return ""
    return f"{v:.{decimals}f}"


# ─────────────────────────────────────────────────────────────────────────────
# 4. 渲染输出
# ─────────────────────────────────────────────────────────────────────────────


# 排行 CSV 列名
_RANKING_CSV_COLS = [
    "window_group",
    "variant_desc",
    "exit_desc",
    "n_train",
    "kelly_is",
    "n_valid",
    "win_rate_valid",
    "payoff_b_valid",
    "profit_factor_valid",
    "kelly_oos",
    "ci_low",
    "ci_high",
    "is_frontier",
]

# 前沿散点 CSV 列名
_FRONTIER_CSV_COLS = ["window_group", "n_valid", "kelly_valid", "is_frontier", "variant_desc", "exit_desc"]


def _build_ranking_row(row: ResultRow, is_frontier: bool) -> dict:
    """把 ResultRow 转成 ranking CSV 一行。"""
    return {
        "window_group": row.window_group,
        "variant_desc": _describe_variant(row.variant_filters),
        "exit_desc": _describe_exit(row.exit_cfg),
        "n_train": row.n_train,
        "kelly_is": _fmt(row.kelly_train),
        "n_valid": row.n_valid,
        "win_rate_valid": _fmt(row.win_rate_valid),
        "payoff_b_valid": _fmt(row.payoff_b_valid),
        "profit_factor_valid": _fmt(row.profit_factor_valid),
        "kelly_oos": _fmt(row.kelly_valid),
        "ci_low": _fmt(row.kelly_ci_low),
        "ci_high": _fmt(row.kelly_ci_high),
        "is_frontier": is_frontier,
    }


def render_report(
    rows: list[ResultRow],
    config: SweepConfig,
    paths: list[ForwardPath],
    output_dir: Path,
    *,
    pareto_rows: Optional[list[dict]] = None,
    topk_rows: Optional[dict[str, list[ResultRow]]] = None,
) -> None:
    """主渲染入口：写排行 CSV + 前沿散点 CSV + Markdown 报告。

    Args:
        rows:         run_sweep 产出的完整 ResultRow 列表。
        config:       SweepConfig（用于摘要信息）。
        paths:        ForwardPath 列表（传给 rank_top_k 用于 CI）。
        output_dir:   输出目录（不存在时自动创建）。
        pareto_rows:  预计算的前沿标注列表（None 则内部调用 compute_pareto_frontier）。
        topk_rows:    预计算的 top-K dict（None 则内部调用 rank_top_k）。
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if pareto_rows is None:
        pareto_rows = compute_pareto_frontier(rows)
    if topk_rows is None:
        topk_rows = rank_top_k(rows, config, paths)

    # 建立 ResultRow → is_frontier 映射（用 (variant_id, exit_id, window_group) 作键）
    frontier_key_set: set[tuple[str, str, str]] = set()
    for prow in pareto_rows:
        if prow.get("is_frontier"):
            frontier_key_set.add((prow["variant_id"], prow["exit_id"], prow["window_group"]))

    def _is_frontier(row: ResultRow) -> bool:
        return (row.variant_id, row.exit_id, row.window_group) in frontier_key_set

    # ── (a) 排行 CSV ─────────────────────────────────────────────────────────
    ranking_path = output_dir / "top_k_ranking.csv"
    all_topk: list[ResultRow] = []
    for wg_rows in topk_rows.values():
        all_topk.extend(wg_rows)

    with open(ranking_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=_RANKING_CSV_COLS)
        writer.writeheader()
        for row in all_topk:
            writer.writerow(_build_ranking_row(row, _is_frontier(row)))
    logger.info("排行 CSV 已写入 %s", ranking_path)

    # ── (b) 前沿散点 CSV ──────────────────────────────────────────────────────
    frontier_csv_path = output_dir / "pareto_frontier.csv"
    with open(frontier_csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=_FRONTIER_CSV_COLS)
        writer.writeheader()
        for prow in pareto_rows:
            row = prow  # dict，含所有 ResultRow 字段 + is_frontier
            if row.get("kelly_valid") is None:
                continue
            writer.writerow({
                "window_group": row["window_group"],
                "n_valid": row["n_valid"],
                "kelly_valid": _fmt(row["kelly_valid"]),
                "is_frontier": row["is_frontier"],
                "variant_desc": _describe_variant(row["variant_filters"]),
                "exit_desc": _describe_exit(row["exit_cfg"]),
            })
    logger.info("前沿散点 CSV 已写入 %s", frontier_csv_path)

    # ── (c) Markdown 报告 ─────────────────────────────────────────────────────
    md_path = output_dir / "kelly_sweep_report.md"
    _write_markdown(md_path, rows, config, topk_rows, pareto_rows, frontier_key_set)
    logger.info("Markdown 报告已写入 %s", md_path)


def _write_markdown(
    md_path: Path,
    rows: list[ResultRow],
    config: SweepConfig,
    topk_rows: dict[str, list[ResultRow]],
    pareto_rows: list[dict],
    frontier_key_set: set[tuple[str, str, str]],
) -> None:
    """写 Markdown 报告。"""

    def _is_frontier(row: ResultRow) -> bool:
        return (row.variant_id, row.exit_id, row.window_group) in frontier_key_set

    n_total = len(rows)
    n_below_floor = sum(1 for r in rows if r.below_floor)
    n_eligible = n_total - n_below_floor

    lines: list[str] = []
    lines.append("# Kelly Sweep Report")
    lines.append("")
    lines.append("## 摘要")
    lines.append("")
    lines.append(f"- 总组合数：{n_total}")
    lines.append(f"- 被 floor 过滤（验证集 n < {config.min_samples}）：{n_below_floor}")
    lines.append(f"- 有效组合数：{n_eligible}")
    lines.append(f"- 训练区间：{config.train_range[0]} ~ {config.train_range[1]}")
    lines.append(f"- 验证区间：{config.valid_range[0]} ~ {config.valid_range[1]}")
    lines.append(f"- 基线参考：{_BASELINE_LABEL} Kelly ≈ {_BASELINE_KELLY}")
    lines.append("")
    lines.append(
        "> **多重检验提示**：本次扫描了 "
        f"{n_total} 个组合，top-K 的 in-sample 排名含选择偏差，"
        "以验证集 + CI 为准。本 harness 不做统计校正（无 Bonferroni/FDR），"
        "样本外验证集 + bootstrap CI 是唯一定量偏差防线。"
    )
    lines.append("")

    # 按 window_group 分节
    wgs = sorted(topk_rows.keys())
    for wg in wgs:
        wg_topk = topk_rows[wg]
        lines.append(f"## 窗口组：{wg}")
        lines.append("")
        if wg == "with_rs":
            lines.append(
                "> 含 RS 变体：训练起点已 clamp 到 2024-01-02（THS 数据约束）。"
                "与 no_rs 组凯利不可跨组比较。"
            )
            lines.append("")

        # top-K 表
        lines.append(f"### Top-{config.top_k} 排行（按验证集 Kelly 降序）")
        lines.append("")
        lines.append("| 入场变体 | 出场 | n_train | kelly_is | n_valid | win_rate | payoff_b | PF | kelly_oos | ci_low | ci_high | 前沿 |")
        lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for row in wg_topk:
            is_front = _is_frontier(row)
            unstable = ""
            if row.kelly_ci_low is not None and row.kelly_ci_low <= 0:
                unstable = " ⚠不稳健"
            lines.append(
                f"| {_describe_variant(row.variant_filters)} "
                f"| {_describe_exit(row.exit_cfg)} "
                f"| {row.n_train} "
                f"| {_fmt(row.kelly_train)} "
                f"| {row.n_valid} "
                f"| {_fmt(row.win_rate_valid)} "
                f"| {_fmt(row.payoff_b_valid)} "
                f"| {_fmt(row.profit_factor_valid)} "
                f"| {_fmt(row.kelly_valid)}{unstable} "
                f"| {_fmt(row.kelly_ci_low)} "
                f"| {_fmt(row.kelly_ci_high)} "
                f"| {'YES' if is_front else ''} |"
            )
        lines.append("")

        # 前沿点清单（该 window_group 的前沿行）
        frontier_of_wg = [
            p for p in pareto_rows
            if p["window_group"] == wg and p.get("is_frontier") and p.get("kelly_valid") is not None
        ]
        if frontier_of_wg:
            lines.append(f"### 帕累托前沿点（{wg}）")
            lines.append("")
            lines.append("| n_valid | kelly_oos | 入场变体 | 出场 |")
            lines.append("|---|---|---|---|")
            # 按 kelly_valid 降序
            frontier_sorted = sorted(frontier_of_wg, key=lambda p: p["kelly_valid"], reverse=True)
            for p in frontier_sorted:
                lines.append(
                    f"| {p['n_valid']} "
                    f"| {_fmt(p['kelly_valid'])} "
                    f"| {_describe_variant(p['variant_filters'])} "
                    f"| {_describe_exit(p['exit_cfg'])} |"
                )
            lines.append("")

        lines.append(f"基线参考（{_BASELINE_LABEL}）Kelly ≈ {_BASELINE_KELLY}")
        lines.append("")

    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
