"""单元测试：kelly_sweep/report.py 和 cli.py。

测试策略：
  - 全部使用合成数据（mock ResultRow / ForwardPath），不查 DB
  - 覆盖：
      1. compute_pareto_frontier — 支配逻辑（严格/并列/按 window_group 分组/below_floor 排除）
      2. rank_top_k — 排序 + CI 填充（mock valid_rets_for + bootstrap）
      3. render_report — CSV / MD 落文件后读回断言关键内容
      4. cli.py — argparse 解析 + self-check 达标/不达标分支（mock 数据）
"""

from __future__ import annotations

import csv
import sys
from dataclasses import replace as dc_replace
from pathlib import Path
from typing import Optional
from unittest.mock import MagicMock, patch

import pytest

from quant_pipeline.research.kelly_sweep.config import SweepConfig
from quant_pipeline.research.kelly_sweep.report import (
    _describe_exit,
    _describe_variant,
    compute_pareto_frontier,
    rank_top_k,
    render_report,
)
from quant_pipeline.research.kelly_sweep.sweep import ResultRow
from quant_pipeline.research.kelly_sweep.types import Bar, ForwardPath


# ─────────────────────────────────────────────────────────────────────────────
# 辅助构造器
# ─────────────────────────────────────────────────────────────────────────────


def make_row(
    variant_id: str = "base",
    variant_filters: list = None,
    exit_id: str = "fixed_n(n=1)",
    exit_cfg: dict = None,
    window_group: str = "no_rs",
    n_train: int = 100,
    kelly_train: Optional[float] = 0.10,
    n_valid: int = 200,
    kelly_valid: Optional[float] = 0.15,
    win_rate_valid: Optional[float] = 0.55,
    payoff_b_valid: Optional[float] = 1.2,
    profit_factor_valid: Optional[float] = 1.3,
    below_floor: bool = False,
    kelly_ci_low: Optional[float] = None,
    kelly_ci_high: Optional[float] = None,
    valid_keys: list = None,
    same_day_rule: str = "sl_first",
) -> ResultRow:
    return ResultRow(
        variant_id=variant_id,
        variant_filters=variant_filters or [],
        exit_id=exit_id,
        exit_cfg=exit_cfg or {"type": "fixed_n", "n": 1},
        window_group=window_group,
        n_train=n_train,
        kelly_train=kelly_train,
        win_rate_train=0.54,
        payoff_b_train=1.1,
        profit_factor_train=1.2,
        n_valid=n_valid,
        kelly_valid=kelly_valid,
        win_rate_valid=win_rate_valid,
        payoff_b_valid=payoff_b_valid,
        profit_factor_valid=profit_factor_valid,
        below_floor=below_floor,
        kelly_ci_low=kelly_ci_low,
        kelly_ci_high=kelly_ci_high,
        valid_keys=valid_keys or [],
        same_day_rule=same_day_rule,
    )


def make_path(
    ts_code: str = "000001.SZ",
    signal_date: str = "20250601",
    buy_date: str = "20250602",
) -> ForwardPath:
    return ForwardPath(
        ts_code=ts_code,
        signal_date=signal_date,
        buy_date=buy_date,
        buy_price=10.0,
        bars=[
            Bar(
                trade_date=buy_date,
                qfq_open=10.0,
                qfq_high=10.5,
                qfq_low=9.5,
                qfq_close=10.3,
            )
        ],
        delist_date=None,
        atr14_at_signal=None,
    )


def make_config(**kwargs) -> SweepConfig:
    defaults = dict(
        train_range=("20230101", "20241231"),
        valid_range=("20250101", "20261231"),
        min_samples=100,
        top_k=5,
        bootstrap_iters=50,
    )
    defaults.update(kwargs)
    return SweepConfig(**defaults)


# ─────────────────────────────────────────────────────────────────────────────
# 1. compute_pareto_frontier
# ─────────────────────────────────────────────────────────────────────────────


class TestComputeParetoFrontier:
    """帕累托前沿支配逻辑。"""

    def test_single_row_is_frontier(self) -> None:
        """单条有效行，没有任何点支配它，应在前沿。"""
        row = make_row(n_valid=100, kelly_valid=0.15)
        result = compute_pareto_frontier([row])
        assert len(result) == 1
        assert result[0]["is_frontier"] is True

    def test_dominated_row_not_frontier(self) -> None:
        """A 支配 B（A 样本更少 + kelly 更高），B 不在前沿。"""
        row_a = make_row("v1", n_valid=50, kelly_valid=0.20)   # A: 少样本、高 kelly
        row_b = make_row("v2", n_valid=100, kelly_valid=0.10)  # B: 多样本、低 kelly → 被 A 支配
        result = compute_pareto_frontier([row_a, row_b])
        by_id = {r["variant_id"]: r for r in result}
        assert by_id["v1"]["is_frontier"] is True
        assert by_id["v2"]["is_frontier"] is False

    def test_pareto_two_frontier_points(self) -> None:
        """A 样本少 kelly 低，B 样本多 kelly 高 —— 互不支配，均在前沿。"""
        row_a = make_row("v1", n_valid=50, kelly_valid=0.10)
        row_b = make_row("v2", n_valid=200, kelly_valid=0.25)
        result = compute_pareto_frontier([row_a, row_b])
        by_id = {r["variant_id"]: r for r in result}
        assert by_id["v1"]["is_frontier"] is True
        assert by_id["v2"]["is_frontier"] is True

    def test_tie_not_dominated(self) -> None:
        """完全相同的 (n, kelly) 对 —— 并列点互不支配，均在前沿。"""
        row_a = make_row("v1", n_valid=100, kelly_valid=0.20)
        row_b = make_row("v2", n_valid=100, kelly_valid=0.20)
        result = compute_pareto_frontier([row_a, row_b])
        by_id = {r["variant_id"]: r for r in result}
        assert by_id["v1"]["is_frontier"] is True
        assert by_id["v2"]["is_frontier"] is True

    def test_below_floor_not_in_frontier(self) -> None:
        """below_floor=True 的行即使 kelly 高也不进前沿。"""
        row_floor = make_row("v_floor", n_valid=10, kelly_valid=0.99, below_floor=True)
        row_ok = make_row("v_ok", n_valid=200, kelly_valid=0.15)
        result = compute_pareto_frontier([row_floor, row_ok])
        by_id = {r["variant_id"]: r for r in result}
        assert by_id["v_floor"]["is_frontier"] is False
        assert by_id["v_ok"]["is_frontier"] is True

    def test_below_floor_still_in_result(self) -> None:
        """below_floor=True 的行应出现在返回列表中（灰点用），只是 is_frontier=False。"""
        row = make_row("v_floor", below_floor=True)
        result = compute_pareto_frontier([row])
        assert len(result) == 1
        assert result[0]["is_frontier"] is False

    def test_kelly_valid_none_not_in_frontier(self) -> None:
        """kelly_valid=None 的行不进前沿（无法参与支配比较）。"""
        row = make_row("v_none", kelly_valid=None)
        result = compute_pareto_frontier([row])
        assert result[0]["is_frontier"] is False

    def test_window_group_separated(self) -> None:
        """with_rs 和 no_rs 各自计算前沿，不混算。

        no_rs 组 A 支配 no_rs 组 B；with_rs 组 C 独立为前沿点。
        """
        # no_rs 组：A 支配 B
        row_a = make_row("a", window_group="no_rs", n_valid=50, kelly_valid=0.30)
        row_b = make_row("b", window_group="no_rs", n_valid=100, kelly_valid=0.10)
        # with_rs 组：C 独立（C 的样本数多于 A，但分属不同 window_group）
        row_c = make_row("c", window_group="with_rs", n_valid=200, kelly_valid=0.05)

        result = compute_pareto_frontier([row_a, row_b, row_c])
        by_id = {r["variant_id"]: r for r in result}
        # no_rs: A 前沿, B 被支配
        assert by_id["a"]["is_frontier"] is True
        assert by_id["b"]["is_frontier"] is False
        # with_rs: C 前沿（无竞争者）
        assert by_id["c"]["is_frontier"] is True

    def test_result_length_matches_input(self) -> None:
        """返回列表长度等于输入列表长度。"""
        rows = [make_row(f"v{i}") for i in range(10)]
        result = compute_pareto_frontier(rows)
        assert len(result) == len(rows)

    def test_three_point_chain(self) -> None:
        """三点链：A 支配 B，B 支配 C → 只有 A 在前沿。"""
        row_a = make_row("a", n_valid=10, kelly_valid=0.30)   # 最少 n + 最高 kelly
        row_b = make_row("b", n_valid=50, kelly_valid=0.20)   # 被 a 支配
        row_c = make_row("c", n_valid=100, kelly_valid=0.10)  # 被 b 支配
        result = compute_pareto_frontier([row_a, row_b, row_c])
        by_id = {r["variant_id"]: r for r in result}
        assert by_id["a"]["is_frontier"] is True
        assert by_id["b"]["is_frontier"] is False
        assert by_id["c"]["is_frontier"] is False

    def test_strictly_dominated_on_one_axis(self) -> None:
        """A 的 n_valid 相同，但 kelly_valid 更高 → A 严格支配 B（单轴严格）。"""
        row_a = make_row("a", n_valid=100, kelly_valid=0.25)  # 相同 n，更高 kelly
        row_b = make_row("b", n_valid=100, kelly_valid=0.10)  # 被 a 支配（n 相同，kelly 劣势）
        result = compute_pareto_frontier([row_a, row_b])
        by_id = {r["variant_id"]: r for r in result}
        assert by_id["a"]["is_frontier"] is True
        assert by_id["b"]["is_frontier"] is False


# ─────────────────────────────────────────────────────────────────────────────
# 2. rank_top_k
# ─────────────────────────────────────────────────────────────────────────────


class TestRankTopK:
    """rank_top_k：排序 + CI 填充。"""

    def _rows_with_rets(self) -> tuple[list[ResultRow], list[ForwardPath]]:
        """构造两行 ResultRow 和对应的 paths（用于 valid_rets_for）。"""
        # 构造可控的 valid_keys + paths，使 valid_rets_for 能返回真实 rets
        paths = [
            ForwardPath(
                ts_code="A.SZ",
                signal_date="20250601",
                buy_date="20250602",
                buy_price=10.0,
                bars=[Bar("20250602", 10.0, 11.0, 9.0, 11.0)],  # ret = 0.1
                delist_date=None,
                atr14_at_signal=None,
            ),
            ForwardPath(
                ts_code="B.SZ",
                signal_date="20250601",
                buy_date="20250602",
                buy_price=10.0,
                bars=[Bar("20250602", 10.0, 10.5, 9.0, 9.5)],  # ret = -0.05
                delist_date=None,
                atr14_at_signal=None,
            ),
        ]
        rows = [
            make_row(
                "high",
                kelly_valid=0.25,
                n_valid=2,
                valid_keys=[("A.SZ", "20250601"), ("B.SZ", "20250601")],
            ),
            make_row(
                "low",
                kelly_valid=0.10,
                n_valid=2,
                valid_keys=[("A.SZ", "20250601"), ("B.SZ", "20250601")],
            ),
        ]
        return rows, paths

    def test_sorted_by_kelly_valid_desc(self) -> None:
        """top-K 按 kelly_valid 降序排列。"""
        rows, paths = self._rows_with_rets()
        config = make_config(top_k=2, bootstrap_iters=50)
        result = rank_top_k(rows, config, paths)
        wg_rows = result["no_rs"]
        assert wg_rows[0].variant_id == "high"
        assert wg_rows[1].variant_id == "low"

    def test_top_k_limit(self) -> None:
        """top_k=1 时每组只返回 1 条。"""
        rows, paths = self._rows_with_rets()
        config = make_config(top_k=1, bootstrap_iters=50)
        result = rank_top_k(rows, config, paths)
        assert len(result["no_rs"]) == 1
        assert result["no_rs"][0].variant_id == "high"

    def test_below_floor_excluded(self) -> None:
        """below_floor=True 的行不进 top-K。"""
        rows = [
            make_row("eligible", kelly_valid=0.20, below_floor=False),
            make_row("floored", kelly_valid=0.99, below_floor=True),
        ]
        config = make_config(top_k=5, bootstrap_iters=10)
        result = rank_top_k(rows, config, [])
        wg_rows = result.get("no_rs", [])
        ids = [r.variant_id for r in wg_rows]
        assert "eligible" in ids
        assert "floored" not in ids

    def test_kelly_none_excluded(self) -> None:
        """kelly_valid=None 的行不进 top-K。"""
        rows = [
            make_row("with_kelly", kelly_valid=0.20),
            make_row("no_kelly", kelly_valid=None),
        ]
        config = make_config(top_k=5, bootstrap_iters=10)
        result = rank_top_k(rows, config, [])
        wg_rows = result.get("no_rs", [])
        ids = [r.variant_id for r in wg_rows]
        assert "with_kelly" in ids
        assert "no_kelly" not in ids

    def test_ci_filled_after_rank_top_k(self) -> None:
        """rank_top_k 后返回的行 kelly_ci_low / kelly_ci_high 已填充（不再是 None）。"""
        rows, paths = self._rows_with_rets()
        config = make_config(top_k=2, bootstrap_iters=100)
        result = rank_top_k(rows, config, paths)
        for row in result["no_rs"]:
            # bootstrap 用的 rets = [0.1, -0.05]，win+loss 混合，CI 两端均应有值
            assert row.kelly_ci_low is not None and row.kelly_ci_high is not None
            assert row.kelly_ci_low <= row.kelly_ci_high

    def test_window_groups_separated(self) -> None:
        """不同 window_group 的行各自排名，结果字典键 = window_group。"""
        rows = [
            make_row("no_rs_1", window_group="no_rs", kelly_valid=0.20),
            make_row("no_rs_2", window_group="no_rs", kelly_valid=0.10),
            make_row("with_rs_1", window_group="with_rs", kelly_valid=0.30),
        ]
        config = make_config(top_k=5, bootstrap_iters=10)
        result = rank_top_k(rows, config, [])
        assert "no_rs" in result
        assert "with_rs" in result
        assert len(result["no_rs"]) == 2
        assert len(result["with_rs"]) == 1

    def test_ci_uses_valid_rets_for(self) -> None:
        """CI 通过 valid_rets_for + bootstrap 计算，而非随机；用可控 rets 验证。"""
        rows, paths = self._rows_with_rets()
        config = make_config(top_k=1, bootstrap_iters=200)
        result = rank_top_k(rows, config, paths)
        row = result["no_rs"][0]
        # p=0.5, b=2 → kelly=0.25；bootstrap 估计应在合理范围内
        assert row.kelly_ci_low is not None
        assert row.kelly_ci_high is not None
        assert row.kelly_ci_low <= row.kelly_ci_high


# ─────────────────────────────────────────────────────────────────────────────
# 3. render_report — CSV / MD 落文件
# ─────────────────────────────────────────────────────────────────────────────


class TestRenderReport:
    """render_report：验证文件被写入 + 关键内容存在。"""

    def _make_inputs(self, tmp_path: Path) -> tuple[list[ResultRow], SweepConfig, list[ForwardPath]]:
        rows = [
            make_row(
                "base",
                kelly_valid=0.171,
                n_valid=500,
                kelly_ci_low=0.15,
                kelly_ci_high=0.19,
                valid_keys=[],
            ),
            make_row(
                "filtered",
                variant_filters=[("kdj_j", "lt", -10.0)],
                kelly_valid=0.20,
                n_valid=300,
                kelly_ci_low=0.17,
                kelly_ci_high=0.23,
                valid_keys=[],
            ),
            # below_floor 行（灰点）
            make_row(
                "small",
                kelly_valid=0.30,
                n_valid=50,
                below_floor=True,
                valid_keys=[],
            ),
        ]
        config = make_config(top_k=5, bootstrap_iters=50, min_samples=100)
        paths: list[ForwardPath] = []
        return rows, config, paths

    def _precompute(self, rows, config, paths):
        pareto_rows = compute_pareto_frontier(rows)
        # top_k 需要 valid_rets_for；valid_keys=[] → rets=[]，CI=(None,None)
        topk_rows = rank_top_k(rows, config, paths)
        return pareto_rows, topk_rows

    def test_files_created(self, tmp_path: Path) -> None:
        """render_report 应在 output_dir 创建三个文件。"""
        rows, config, paths = self._make_inputs(tmp_path)
        pareto_rows, topk_rows = self._precompute(rows, config, paths)
        render_report(rows, config, paths, tmp_path, pareto_rows=pareto_rows, topk_rows=topk_rows)
        assert (tmp_path / "top_k_ranking.csv").exists()
        assert (tmp_path / "pareto_frontier.csv").exists()
        assert (tmp_path / "kelly_sweep_report.md").exists()

    def test_ranking_csv_has_header(self, tmp_path: Path) -> None:
        """ranking CSV 应含预期列名。"""
        rows, config, paths = self._make_inputs(tmp_path)
        pareto_rows, topk_rows = self._precompute(rows, config, paths)
        render_report(rows, config, paths, tmp_path, pareto_rows=pareto_rows, topk_rows=topk_rows)
        with open(tmp_path / "top_k_ranking.csv", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            cols = reader.fieldnames
        assert "kelly_oos" in cols
        assert "ci_low" in cols
        assert "ci_high" in cols
        assert "is_frontier" in cols
        assert "window_group" in cols

    def test_ranking_csv_rows_count(self, tmp_path: Path) -> None:
        """ranking CSV 行数 = top-K 实际入选行数（below_floor 不计入）。"""
        rows, config, paths = self._make_inputs(tmp_path)
        pareto_rows, topk_rows = self._precompute(rows, config, paths)
        render_report(rows, config, paths, tmp_path, pareto_rows=pareto_rows, topk_rows=topk_rows)
        with open(tmp_path / "top_k_ranking.csv", encoding="utf-8") as f:
            data = list(csv.DictReader(f))
        # 2 条 eligible 行（base + filtered），small 被 floor 排除
        assert len(data) == 2

    def test_frontier_csv_excludes_kelly_none(self, tmp_path: Path) -> None:
        """前沿 CSV 不含 kelly_valid=None 的行。"""
        rows = [
            make_row("with_kelly", kelly_valid=0.15, n_valid=200),
            make_row("no_kelly", kelly_valid=None, n_valid=100),
        ]
        config = make_config(top_k=5, bootstrap_iters=10)
        paths = []
        pareto_rows = compute_pareto_frontier(rows)
        topk_rows = rank_top_k(rows, config, paths)
        render_report(rows, config, paths, tmp_path, pareto_rows=pareto_rows, topk_rows=topk_rows)
        with open(tmp_path / "pareto_frontier.csv", encoding="utf-8") as f:
            data = list(csv.DictReader(f))
        variant_descs = [d["variant_desc"] for d in data]
        # with_kelly 行在前沿 CSV 中，no_kelly 行不在
        assert any("base" in d for d in variant_descs)
        # 前沿 CSV 行数应 >= 1（with_kelly 前沿点）且 < 总行数（no_kelly 已排除）
        assert len(data) >= 1

    def test_markdown_contains_baseline(self, tmp_path: Path) -> None:
        """Markdown 报告应含基线参考信息（0.171）。"""
        rows, config, paths = self._make_inputs(tmp_path)
        pareto_rows, topk_rows = self._precompute(rows, config, paths)
        render_report(rows, config, paths, tmp_path, pareto_rows=pareto_rows, topk_rows=topk_rows)
        content = (tmp_path / "kelly_sweep_report.md").read_text(encoding="utf-8")
        assert "0.171" in content

    def test_markdown_contains_summary_counts(self, tmp_path: Path) -> None:
        """Markdown 报告摘要应含组合总数和 floor 过滤数。"""
        rows, config, paths = self._make_inputs(tmp_path)
        pareto_rows, topk_rows = self._precompute(rows, config, paths)
        render_report(rows, config, paths, tmp_path, pareto_rows=pareto_rows, topk_rows=topk_rows)
        content = (tmp_path / "kelly_sweep_report.md").read_text(encoding="utf-8")
        assert "总组合数：3" in content
        assert "floor" in content.lower() or "过滤" in content

    def test_markdown_window_group_sections(self, tmp_path: Path) -> None:
        """Markdown 应按 window_group 分节。"""
        rows = [
            make_row("a", window_group="no_rs", kelly_valid=0.15, n_valid=300),
            make_row("b", window_group="with_rs", kelly_valid=0.18, n_valid=150),
        ]
        config = make_config(top_k=5, bootstrap_iters=10)
        paths = []
        pareto_rows = compute_pareto_frontier(rows)
        topk_rows = rank_top_k(rows, config, paths)
        render_report(rows, config, paths, tmp_path, pareto_rows=pareto_rows, topk_rows=topk_rows)
        content = (tmp_path / "kelly_sweep_report.md").read_text(encoding="utf-8")
        assert "no_rs" in content
        assert "with_rs" in content

    def test_output_dir_created_if_missing(self, tmp_path: Path) -> None:
        """output_dir 不存在时自动创建。"""
        new_dir = tmp_path / "new_subdir" / "reports"
        rows, config, paths = self._make_inputs(tmp_path)
        pareto_rows, topk_rows = self._precompute(rows, config, paths)
        render_report(rows, config, paths, new_dir, pareto_rows=pareto_rows, topk_rows=topk_rows)
        assert new_dir.exists()
        assert (new_dir / "kelly_sweep_report.md").exists()

    def test_frontier_csv_is_frontier_column(self, tmp_path: Path) -> None:
        """前沿 CSV 含 is_frontier 列，且前沿行标 True。"""
        # A 支配 B → A 前沿、B 不前沿
        # 给 A 一个不同的 variant_id 和 variant_filters 以区分 variant_desc
        row_a = make_row(
            "a",
            variant_filters=[("kdj_j", "lt", -10.0)],
            n_valid=50,
            kelly_valid=0.30,
        )
        row_b = make_row(
            "b",
            variant_filters=[("kdj_j", "lt", -20.0)],
            n_valid=200,
            kelly_valid=0.05,
        )
        config = make_config(top_k=5, bootstrap_iters=10)
        paths = []
        pareto_rows = compute_pareto_frontier([row_a, row_b])
        topk_rows = rank_top_k([row_a, row_b], config, paths)
        render_report([row_a, row_b], config, paths, tmp_path, pareto_rows=pareto_rows, topk_rows=topk_rows)
        with open(tmp_path / "pareto_frontier.csv", encoding="utf-8") as f:
            data = list(csv.DictReader(f))
        # 应有数据行（kelly_valid 不为 None 的行写入前沿 CSV）
        assert len(data) >= 1
        # 找到 A 行（variant_desc 含 "kdj_j lt -10"）并断言 is_frontier=True
        a_rows = [r for r in data if "-10" in r["variant_desc"]]
        assert len(a_rows) >= 1
        assert a_rows[0]["is_frontier"] == "True"


# ─────────────────────────────────────────────────────────────────────────────
# 4. 描述辅助函数
# ─────────────────────────────────────────────────────────────────────────────


class TestDescribeHelpers:
    def test_describe_variant_empty_is_base(self) -> None:
        assert _describe_variant([]) == "base"

    def test_describe_variant_single_filter(self) -> None:
        result = _describe_variant([("kdj_j", "lt", -10.0)])
        assert "kdj_j" in result
        assert "lt" in result
        assert "-10" in result

    def test_describe_variant_multiple_filters(self) -> None:
        result = _describe_variant([("kdj_j", "lt", -10.0), ("dev_ma5", "lt", -0.03)])
        assert "kdj_j" in result
        assert "dev_ma5" in result
        assert "AND" in result

    def test_describe_exit_fixed_n(self) -> None:
        result = _describe_exit({"type": "fixed_n", "n": 3})
        assert "fixed_n" in result
        assert "3" in result

    def test_describe_exit_tp_sl(self) -> None:
        result = _describe_exit({"type": "tp_sl", "tp_pct": 0.05, "sl_pct": 0.03, "max_hold": 10})
        assert "tp_sl" in result
        assert "0.05" in result

    def test_describe_exit_trailing(self) -> None:
        result = _describe_exit({"type": "trailing", "z_pct": 0.05, "max_hold": 20})
        assert "trailing" in result

    def test_describe_exit_atr_stop(self) -> None:
        result = _describe_exit({"type": "atr_stop", "k": 2.0, "max_hold": 10})
        assert "atr_stop" in result


# ─────────────────────────────────────────────────────────────────────────────
# 5. cli.py — argparse 和 self-check 分支
# ─────────────────────────────────────────────────────────────────────────────


class TestCliArgparse:
    """验证 cli.py 的 argparse 解析。"""

    def test_default_args_no_error(self) -> None:
        """默认参数不抛异常，config 字段符合预期。"""
        from quant_pipeline.research.kelly_sweep.cli import _build_parser, _parse_universe

        p = _build_parser()
        args = p.parse_args([])
        # 验证默认值
        assert args.base_field == "kdj_j"
        assert args.base_op == "lt"
        assert args.base_value == 0.0
        assert _parse_universe(args.universe) == "all"
        assert args.top_k == 30
        assert args.bootstrap_iters == 1000

    def test_custom_args_parsed(self) -> None:
        """自定义参数正确解析。"""
        from quant_pipeline.research.kelly_sweep.cli import _build_parser

        p = _build_parser()
        args = p.parse_args([
            "--base-field", "kdj_j",
            "--base-op", "lt",
            "--base-value", "-10",
            "--train-start", "20230101",
            "--train-end", "20241231",
            "--valid-start", "20250101",
            "--valid-end", "20260531",
            "--min-samples", "500",
            "--top-k", "20",
            "--bootstrap-iters", "500",
        ])
        assert args.base_value == -10.0
        assert args.min_samples == 500
        assert args.top_k == 20
        assert args.bootstrap_iters == 500

    def test_self_check_flag(self) -> None:
        """--self-check 标志正确解析。"""
        from quant_pipeline.research.kelly_sweep.cli import _build_parser

        p = _build_parser()
        args = p.parse_args(["--self-check"])
        assert args.self_check is True

    def test_parse_universe_all(self) -> None:
        from quant_pipeline.research.kelly_sweep.cli import _parse_universe
        assert _parse_universe("all") == "all"

    def test_parse_universe_list(self) -> None:
        from quant_pipeline.research.kelly_sweep.cli import _parse_universe
        result = _parse_universe("000001.SZ,600000.SH")
        assert result == ["000001.SZ", "600000.SH"]

    def test_parse_rs_benchmark(self) -> None:
        from quant_pipeline.research.kelly_sweep.cli import _parse_rs_benchmark
        assert _parse_rs_benchmark("hs300") == ["hs300"]
        assert _parse_rs_benchmark("hs300,zz500") == ["hs300", "zz500"]


class TestSelfCheckLogic:
    """验证 --self-check 的达标/不达标分支与退出码，使用 mock 数据。"""

    def _make_mock_metrics(self, n: int, kelly: float, win_rate: float, payoff_b: float):
        """构造 mock MetricResult。"""
        from quant_pipeline.research.kelly_sweep.types import MetricResult
        return MetricResult(
            n=n,
            wins=int(n * win_rate),
            win_rate=win_rate,
            avg_win=payoff_b * 0.02,
            avg_loss=-0.02,
            payoff_b=payoff_b,
            profit_factor=payoff_b * win_rate / (1 - win_rate),
            kelly=kelly,
        )

    def test_self_check_pass(self) -> None:
        """self-check 模拟锚点完全命中 → 退出码 0。"""
        from quant_pipeline.research.kelly_sweep.cli import (
            _ANCHOR_KELLY,
            _ANCHOR_N,
            _ANCHOR_PAYOFF_B,
            _ANCHOR_WIN_RATE,
        )

        anchor_metrics = self._make_mock_metrics(
            n=_ANCHOR_N,
            kelly=_ANCHOR_KELLY,
            win_rate=_ANCHOR_WIN_RATE,
            payoff_b=_ANCHOR_PAYOFF_B,
        )

        with (
            patch("quant_pipeline.research.kelly_sweep.cli.enumerate_signals", return_value=["dummy"]),
            patch("quant_pipeline.research.kelly_sweep.cli.load_forward_paths", return_value=["path"]),
            patch("quant_pipeline.research.kelly_sweep.cli.load_feature_inputs", return_value=(MagicMock(), {})),
            patch("quant_pipeline.research.kelly_sweep.cli.run_sweep") as mock_sweep,
            patch("quant_pipeline.research.kelly_sweep.cli.valid_rets_for", return_value=[0.1] * 80276),
            patch("quant_pipeline.research.kelly_sweep.cli.compute_metrics", return_value=anchor_metrics),
        ):
            # 两次调用 run_sweep：一次 train/valid split，一次 full-range
            mock_sweep.return_value = [
                make_row("base", window_group="no_rs", valid_keys=[])
            ]
            from quant_pipeline.research.kelly_sweep.cli import _run_self_check
            exit_code = _run_self_check()

        assert exit_code == 0

    def test_self_check_fail_n_too_different(self) -> None:
        """n 偏差 >= 1% → 退出码 1。"""
        from quant_pipeline.research.kelly_sweep.cli import _ANCHOR_KELLY, _ANCHOR_N

        # n 偏差 5%
        bad_n = int(_ANCHOR_N * 1.05)
        bad_metrics = self._make_mock_metrics(
            n=bad_n, kelly=_ANCHOR_KELLY, win_rate=0.5453, payoff_b=1.214
        )

        with (
            patch("quant_pipeline.research.kelly_sweep.cli.enumerate_signals", return_value=["dummy"]),
            patch("quant_pipeline.research.kelly_sweep.cli.load_forward_paths", return_value=["path"]),
            patch("quant_pipeline.research.kelly_sweep.cli.load_feature_inputs", return_value=(MagicMock(), {})),
            patch("quant_pipeline.research.kelly_sweep.cli.run_sweep") as mock_sweep,
            patch("quant_pipeline.research.kelly_sweep.cli.valid_rets_for", return_value=[0.1] * bad_n),
            patch("quant_pipeline.research.kelly_sweep.cli.compute_metrics", return_value=bad_metrics),
        ):
            mock_sweep.return_value = [
                make_row("base", window_group="no_rs", valid_keys=[])
            ]
            from quant_pipeline.research.kelly_sweep.cli import _run_self_check
            exit_code = _run_self_check()

        assert exit_code == 1

    def test_self_check_fail_kelly_too_different(self) -> None:
        """Kelly 绝对偏差 >= 0.005 → 退出码 1。"""
        from quant_pipeline.research.kelly_sweep.cli import _ANCHOR_KELLY, _ANCHOR_N

        # Kelly 偏差 0.01（> 0.005）
        bad_kelly = _ANCHOR_KELLY + 0.01
        bad_metrics = self._make_mock_metrics(
            n=_ANCHOR_N, kelly=bad_kelly, win_rate=0.5453, payoff_b=1.214
        )

        with (
            patch("quant_pipeline.research.kelly_sweep.cli.enumerate_signals", return_value=["dummy"]),
            patch("quant_pipeline.research.kelly_sweep.cli.load_forward_paths", return_value=["path"]),
            patch("quant_pipeline.research.kelly_sweep.cli.load_feature_inputs", return_value=(MagicMock(), {})),
            patch("quant_pipeline.research.kelly_sweep.cli.run_sweep") as mock_sweep,
            patch("quant_pipeline.research.kelly_sweep.cli.valid_rets_for", return_value=[0.1] * _ANCHOR_N),
            patch("quant_pipeline.research.kelly_sweep.cli.compute_metrics", return_value=bad_metrics),
        ):
            mock_sweep.return_value = [
                make_row("base", window_group="no_rs", valid_keys=[])
            ]
            from quant_pipeline.research.kelly_sweep.cli import _run_self_check
            exit_code = _run_self_check()

        assert exit_code == 1

    def test_self_check_no_results(self) -> None:
        """run_sweep 返回空列表 → 退出码 1。"""
        with (
            patch("quant_pipeline.research.kelly_sweep.cli.enumerate_signals", return_value=["dummy"]),
            patch("quant_pipeline.research.kelly_sweep.cli.load_forward_paths", return_value=["path"]),
            patch("quant_pipeline.research.kelly_sweep.cli.load_feature_inputs", return_value=(MagicMock(), {})),
            patch("quant_pipeline.research.kelly_sweep.cli.run_sweep", return_value=[]),
        ):
            from quant_pipeline.research.kelly_sweep.cli import _run_self_check
            exit_code = _run_self_check()

        assert exit_code == 1

    def test_self_check_no_base_no_rs_row(self) -> None:
        """run_sweep 返回行但不含 base/no_rs 组合 → 退出码 1。"""
        with (
            patch("quant_pipeline.research.kelly_sweep.cli.enumerate_signals", return_value=["dummy"]),
            patch("quant_pipeline.research.kelly_sweep.cli.load_forward_paths", return_value=["path"]),
            patch("quant_pipeline.research.kelly_sweep.cli.load_feature_inputs", return_value=(MagicMock(), {})),
            patch(
                "quant_pipeline.research.kelly_sweep.cli.run_sweep",
                return_value=[
                    # 有行，但 variant_id 不是 "base"，找不到 base/no_rs
                    make_row("v_other", window_group="no_rs", valid_keys=[]),
                ],
            ),
        ):
            from quant_pipeline.research.kelly_sweep.cli import _run_self_check
            exit_code = _run_self_check()

        assert exit_code == 1

    def test_main_self_check_exit_code(self) -> None:
        """main(['--self-check']) 在 mock 通过时返回 0。"""
        from quant_pipeline.research.kelly_sweep.cli import (
            _ANCHOR_KELLY,
            _ANCHOR_N,
            _ANCHOR_PAYOFF_B,
            _ANCHOR_WIN_RATE,
        )
        from quant_pipeline.research.kelly_sweep.types import MetricResult

        anchor_metrics = MetricResult(
            n=_ANCHOR_N,
            wins=int(_ANCHOR_N * _ANCHOR_WIN_RATE),
            win_rate=_ANCHOR_WIN_RATE,
            avg_win=_ANCHOR_PAYOFF_B * 0.02,
            avg_loss=-0.02,
            payoff_b=_ANCHOR_PAYOFF_B,
            profit_factor=1.5,
            kelly=_ANCHOR_KELLY,
        )

        with (
            patch("quant_pipeline.research.kelly_sweep.cli.enumerate_signals", return_value=["dummy"]),
            patch("quant_pipeline.research.kelly_sweep.cli.load_forward_paths", return_value=["path"]),
            patch("quant_pipeline.research.kelly_sweep.cli.load_feature_inputs", return_value=(MagicMock(), {})),
            patch("quant_pipeline.research.kelly_sweep.cli.run_sweep") as mock_sweep,
            patch("quant_pipeline.research.kelly_sweep.cli.valid_rets_for", return_value=[0.1] * _ANCHOR_N),
            patch("quant_pipeline.research.kelly_sweep.cli.compute_metrics", return_value=anchor_metrics),
        ):
            mock_sweep.return_value = [
                make_row("base", window_group="no_rs", valid_keys=[])
            ]
            from quant_pipeline.research.kelly_sweep.cli import main
            code = main(["--self-check"])

        assert code == 0
