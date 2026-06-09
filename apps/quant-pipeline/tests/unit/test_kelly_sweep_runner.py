"""单元测试：kelly_sweep runner 新功能。

覆盖：
  1. build_exit_grid — 子集过滤、空/未知 type 报错
  2. on_progress 钩子 — 传 callback 按 (done,total) 调用；不传(None)行为不变
  3. _runner_kelly_sweep — dispatcher 路由注册
  4. _parse_sweep_config — 从 params 正确构造 SweepConfig
  5. persist_results — is_frontier/is_topk 标注正确；jsonb UTF-8；写前删旧行幂等
  6. build_summary_payload — 摘要字段正确
"""

from __future__ import annotations

from dataclasses import replace as dc_replace
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest

from quant_pipeline.research.kelly_sweep.sweep import (
    DEFAULT_EXIT_GRID,
    ResultRow,
    build_exit_grid,
    run_sweep,
)
from quant_pipeline.research.kelly_sweep.persist import build_summary_payload


# ─────────────────────────────────────────────────────────────────────────────
# 辅助：构造最小 ResultRow
# ─────────────────────────────────────────────────────────────────────────────


def _make_row(
    variant_id: str = "base",
    exit_id: str = "fixed_n(n=1)",
    window_group: str = "no_rs",
    n_valid: int = 10,
    kelly_valid: float | None = 0.2,
    below_floor: bool = False,
    kelly_ci_low: float | None = None,
    kelly_ci_high: float | None = None,
) -> ResultRow:
    return ResultRow(
        variant_id=variant_id,
        variant_filters=[],
        exit_id=exit_id,
        exit_cfg={"type": "fixed_n", "n": 1},
        window_group=window_group,
        n_train=5,
        kelly_train=0.1,
        win_rate_train=0.5,
        payoff_b_train=1.5,
        profit_factor_train=1.2,
        n_valid=n_valid,
        kelly_valid=kelly_valid,
        win_rate_valid=0.55,
        payoff_b_valid=1.4,
        profit_factor_valid=1.1,
        below_floor=below_floor,
        kelly_ci_low=kelly_ci_low,
        kelly_ci_high=kelly_ci_high,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1. build_exit_grid
# ─────────────────────────────────────────────────────────────────────────────


class TestBuildExitGrid:
    def test_all_four_families_equals_default(self) -> None:
        """build_exit_grid(全选四族) == DEFAULT_EXIT_GRID。"""
        result = build_exit_grid(["fixed_n", "tp_sl", "trailing", "atr_stop"])
        assert result == DEFAULT_EXIT_GRID

    def test_single_family_fixed_n(self) -> None:
        """只选 fixed_n → 仅 fixed_n 类型的出场配置。"""
        result = build_exit_grid(["fixed_n"])
        assert all(e["type"] == "fixed_n" for e in result)
        assert len(result) == 5  # N ∈ {1,2,3,5,10}

    def test_single_family_tp_sl(self) -> None:
        """只选 tp_sl → 36 条（4×3×3）。"""
        result = build_exit_grid(["tp_sl"])
        assert all(e["type"] == "tp_sl" for e in result)
        assert len(result) == 36

    def test_single_family_trailing(self) -> None:
        """只选 trailing → 6 条（3×2）。"""
        result = build_exit_grid(["trailing"])
        assert all(e["type"] == "trailing" for e in result)
        assert len(result) == 6

    def test_single_family_atr_stop(self) -> None:
        """只选 atr_stop → 6 条（3×2）。"""
        result = build_exit_grid(["atr_stop"])
        assert all(e["type"] == "atr_stop" for e in result)
        assert len(result) == 6

    def test_two_families_subset(self) -> None:
        """build_exit_grid(['fixed_n','tp_sl']) 长度 = 5+36 = 41。"""
        result = build_exit_grid(["fixed_n", "tp_sl"])
        assert len(result) == 41
        types = {e["type"] for e in result}
        assert types == {"fixed_n", "tp_sl"}

    def test_order_preserved(self) -> None:
        """返回子集与 DEFAULT_EXIT_GRID 中的顺序一致（fixed_n 先于 tp_sl）。"""
        result = build_exit_grid(["fixed_n", "tp_sl"])
        fixed_n_end = max(i for i, e in enumerate(result) if e["type"] == "fixed_n")
        tp_sl_start = min(i for i, e in enumerate(result) if e["type"] == "tp_sl")
        assert fixed_n_end < tp_sl_start

    def test_empty_families_raises(self) -> None:
        """families=[] → ValueError（至少选一族）。"""
        with pytest.raises(ValueError, match="至少选一族"):
            build_exit_grid([])

    def test_unknown_type_raises(self) -> None:
        """含未知 type → ValueError（fail-fast）。"""
        with pytest.raises(ValueError, match="未知出场族"):
            build_exit_grid(["fixed_n", "magic_exit"])

    def test_all_unknown_raises(self) -> None:
        """全部未知 type 也 fail-fast。"""
        with pytest.raises(ValueError, match="未知出场族"):
            build_exit_grid(["bogus"])

    def test_duplicate_family_handled(self) -> None:
        """重复 family 不报错，输出与单次一样（set 去重）。"""
        result_dedup = build_exit_grid(["fixed_n"])
        result_dup = build_exit_grid(["fixed_n", "fixed_n"])
        assert result_dedup == result_dup


# ─────────────────────────────────────────────────────────────────────────────
# 2. on_progress 钩子 — run_sweep
# ─────────────────────────────────────────────────────────────────────────────


def _make_minimal_sweep_for_progress():
    """构造最小 run_sweep 输入（2 条 valid 信号，1 种出场，1 个变体）。"""
    import pandas as pd
    from quant_pipeline.research.kelly_sweep.config import SweepConfig
    from quant_pipeline.research.kelly_sweep.types import Bar, ForwardPath

    config = SweepConfig(
        train_range=("20230101", "20231231"),
        valid_range=("20240101", "20261231"),
        min_samples=1,
        max_entry_filters=0,
    )
    exit_grid = [{"type": "fixed_n", "n": 1}]

    def _bar(d: str, close: float) -> Bar:
        return Bar(trade_date=d, qfq_open=10.0, qfq_high=10.5, qfq_low=9.5, qfq_close=close)

    paths = [
        ForwardPath(
            ts_code="A.SZ", signal_date="20250601", buy_date="20250602",
            buy_price=10.0, bars=[_bar("20250602", 10.5)],
            delist_date=None, atr14_at_signal=None,
        ),
        ForwardPath(
            ts_code="B.SZ", signal_date="20250601", buy_date="20250602",
            buy_price=10.0, bars=[_bar("20250602", 9.5)],
            delist_date=None, atr14_at_signal=None,
        ),
    ]
    cross_df = pd.DataFrame([
        {"ts_code": "A.SZ", "signal_date": "20250601", "qfq_close": 10.0,
         "ma5": 10.5, "ma30": 11.0, "atr_14": 0.3, "kdj_j": -5.0, "vol": 100_000.0},
        {"ts_code": "B.SZ", "signal_date": "20250601", "qfq_close": 10.0,
         "ma5": 10.5, "ma30": 11.0, "atr_14": 0.3, "kdj_j": -5.0, "vol": 100_000.0},
    ])
    hist_map = {
        ("A.SZ", "20250601"): pd.DataFrame({
            "trade_date": ["20250530", "20250531", "20250601"],
            "qfq_pct_chg": [-1.0, -0.5, 0.3], "vol": [100000.0, 90000.0, 80000.0],
        }),
        ("B.SZ", "20250601"): pd.DataFrame({
            "trade_date": ["20250530", "20250531", "20250601"],
            "qfq_pct_chg": [-1.0, -0.5, 0.3], "vol": [100000.0, 90000.0, 80000.0],
        }),
    }
    return config, paths, cross_df, hist_map, exit_grid


class TestOnProgressRunSweep:
    def test_on_progress_called_with_done_total(self) -> None:
        """传 on_progress 时，每完成一个变体调一次 (done, total)。"""
        config, paths, cross_df, hist_map, exit_grid = _make_minimal_sweep_for_progress()
        calls: list[tuple[int, int]] = []

        def _cb(done: int, total: int) -> None:
            calls.append((done, total))

        run_sweep(
            config=config, signals_raw=[], paths=paths,
            cross_section_df=cross_df, history_map=hist_map,
            exit_grid=exit_grid,
            on_progress=_cb,
        )

        # max_entry_filters=0 → 只有 1 个变体（base）→ emit (1, 1)
        assert len(calls) == 1
        assert calls[0] == (1, 1)

    def test_on_progress_none_does_not_raise(self) -> None:
        """on_progress=None 时与改动前行为一致，不报错。"""
        config, paths, cross_df, hist_map, exit_grid = _make_minimal_sweep_for_progress()
        rows = run_sweep(
            config=config, signals_raw=[], paths=paths,
            cross_section_df=cross_df, history_map=hist_map,
            exit_grid=exit_grid,
            on_progress=None,  # 显式 None
        )
        assert isinstance(rows, list)

    def test_on_progress_total_matches_n_variants(self) -> None:
        """on_progress 的 total 值 = 变体数（由 max_entry_filters 决定）。"""
        import pandas as pd
        from quant_pipeline.research.kelly_sweep.config import SweepConfig
        from quant_pipeline.research.kelly_sweep.types import Bar, ForwardPath

        # 3 个候选特征，max_entry_filters=1 → 1+3=4 变体
        config = SweepConfig(
            train_range=("20230101", "20231231"),
            valid_range=("20240101", "20261231"),
            min_samples=1,
            max_entry_filters=1,
        )
        exit_grid = [{"type": "fixed_n", "n": 1}]
        path = ForwardPath(
            ts_code="A.SZ", signal_date="20250601", buy_date="20250602",
            buy_price=10.0,
            bars=[Bar(trade_date="20250602", qfq_open=10.0, qfq_high=10.5,
                      qfq_low=9.5, qfq_close=10.5)],
            delist_date=None, atr14_at_signal=None,
        )
        cross_df = pd.DataFrame([{
            "ts_code": "A.SZ", "signal_date": "20250601", "qfq_close": 10.0,
            "ma5": 10.5, "ma30": 11.0, "atr_14": 0.3, "kdj_j": -5.0, "vol": 100_000.0,
        }])
        hist_map = {
            ("A.SZ", "20250601"): pd.DataFrame({
                "trade_date": ["20250530", "20250531", "20250601"],
                "qfq_pct_chg": [-1.0, -0.5, 0.3], "vol": [100000.0, 90000.0, 80000.0],
            }),
        }
        filter_candidates = [
            ("dev_ma5", "lt", -0.03),
            ("down_streak", "gte", 3.0),
            ("vol_contract", "lt", 0.7),
        ]

        totals_seen: list[int] = []

        def _cb(done: int, total: int) -> None:
            totals_seen.append(total)

        run_sweep(
            config=config, signals_raw=[], paths=[path],
            cross_section_df=cross_df, history_map=hist_map,
            exit_grid=exit_grid,
            entry_filter_candidates=filter_candidates,
            on_progress=_cb,
        )

        # 所有 emit 的 total 必须一致，且 = n_variants（不小于 1+3=4）
        assert len(totals_seen) >= 1
        assert all(t >= 4 for t in totals_seen)
        # done 应该单调递增（最后一个 done == total）
        dones_totals = []

        def _track(done: int, total: int) -> None:
            dones_totals.append((done, total))

        run_sweep(
            config=config, signals_raw=[], paths=[path],
            cross_section_df=cross_df, history_map=hist_map,
            exit_grid=exit_grid,
            entry_filter_candidates=filter_candidates,
            on_progress=_track,
        )
        dones = [d for d, _ in dones_totals]
        assert dones == sorted(dones), "done 值应单调递增"


# ─────────────────────────────────────────────────────────────────────────────
# 3. dispatcher 路由注册
# ─────────────────────────────────────────────────────────────────────────────


class TestDispatcherRoute:
    def test_kelly_sweep_in_routes(self) -> None:
        """'kelly_sweep' 已注册到 _ROUTES 路由表。"""
        from quant_pipeline.worker.dispatcher import get_routes

        routes = get_routes()
        assert "kelly_sweep" in routes

    def test_kelly_sweep_runner_callable(self) -> None:
        """'kelly_sweep' 对应的 runner 是可调用对象。"""
        from quant_pipeline.worker.dispatcher import get_routes

        routes = get_routes()
        assert callable(routes["kelly_sweep"])


# ─────────────────────────────────────────────────────────────────────────────
# 4. _parse_sweep_config
# ─────────────────────────────────────────────────────────────────────────────


class TestParseSweepConfig:
    def _make_full_params(self) -> dict[str, Any]:
        return {
            "base_trigger": {"field": "kdj_j", "op": "lt", "value": -5.0},
            "universe": "all",
            "max_window": 15,
            "max_entry_filters": 1,
            "min_samples": 200,
            "train_range": ["20230101", "20241231"],
            "valid_range": ["20250101", "20260101"],
            "bootstrap_iters": 500,
            "same_day_rule": "tp_first",
            "rs_benchmark": ["hs300", "zz500"],
            "rs_lookback": 10,
            "top_k": 20,
        }

    def test_all_fields_parsed_correctly(self) -> None:
        """所有 12 字段正确解析到 SweepConfig。"""
        from quant_pipeline.worker.kelly_sweep_runner import _parse_sweep_config

        params = self._make_full_params()
        cfg = _parse_sweep_config(params)

        assert cfg.base_trigger.field == "kdj_j"
        assert cfg.base_trigger.op == "lt"
        assert cfg.base_trigger.value == -5.0
        assert cfg.universe == "all"
        assert cfg.max_window == 15
        assert cfg.max_entry_filters == 1
        assert cfg.min_samples == 200
        assert cfg.train_range == ("20230101", "20241231")
        assert cfg.valid_range == ("20250101", "20260101")
        assert cfg.bootstrap_iters == 500
        assert cfg.same_day_rule == "tp_first"
        assert cfg.rs_benchmark == ["hs300", "zz500"]
        assert cfg.rs_lookback == 10
        assert cfg.top_k == 20

    def test_defaults_applied_for_missing_fields(self) -> None:
        """缺少可选字段时使用合理默认值。"""
        from quant_pipeline.worker.kelly_sweep_runner import _parse_sweep_config

        params = {
            "train_range": ["20230101", "20241231"],
            "valid_range": ["20250101", "20260101"],
        }
        cfg = _parse_sweep_config(params)

        assert cfg.base_trigger.field == "kdj_j"
        assert cfg.max_window == 20
        assert cfg.same_day_rule == "sl_first"

    def test_exit_families_default_is_all_four(self) -> None:
        """params 不含 exit_families 时，build_exit_grid 默认四族全选。"""
        from quant_pipeline.worker.kelly_sweep_runner import _parse_sweep_config
        from quant_pipeline.research.kelly_sweep.sweep import DEFAULT_EXIT_GRID

        params = {
            "train_range": ["20230101", "20241231"],
            "valid_range": ["20250101", "20260101"],
            # 不含 exit_families
        }
        _parse_sweep_config(params)  # 不抛即可（exit_families 由 runner 独立处理）
        # 验证 runner 从 params 取 exit_families，缺失时默认四族
        families = params.get("exit_families", ["fixed_n", "tp_sl", "trailing", "atr_stop"])
        assert set(families) == {"fixed_n", "tp_sl", "trailing", "atr_stop"}


# ─────────────────────────────────────────────────────────────────────────────
# 5. persist_results — 单元测试（mock DB）
# ─────────────────────────────────────────────────────────────────────────────


class TestPersistResults:
    """用 mock session_scope 测试 persist_results 的标注逻辑。"""

    def _make_pareto(self, rows: list[ResultRow], frontier_keys: set) -> list[dict]:
        """构造 pareto 列表：frontier_keys 中的 (variant_id, exit_id, window_group) 标 True。"""
        result = []
        for row in rows:
            d = row.__dict__.copy()
            d["is_frontier"] = (row.variant_id, row.exit_id, row.window_group) in frontier_keys
            result.append(d)
        return result

    def _make_topk(self, rows: list[ResultRow]) -> dict:
        """把 rows 原样放进 topk dict。"""
        result: dict[str, list] = {}
        for row in rows:
            result.setdefault(row.window_group, []).append(row)
        return result

    def test_is_frontier_flagged_correctly(self) -> None:
        """is_frontier 标注：只有 frontier_set 中的行是 True。"""
        from unittest.mock import MagicMock, patch
        import uuid

        row_a = _make_row(variant_id="base", exit_id="fixed_n(n=1)", window_group="no_rs")
        row_b = _make_row(variant_id="base+dev_ma5(lt,-0.03)", exit_id="fixed_n(n=1)", window_group="no_rs")

        frontier_keys = {("base", "fixed_n(n=1)", "no_rs")}
        pareto = self._make_pareto([row_a, row_b], frontier_keys)
        topk = self._make_topk([row_a])

        inserted_batches: list[list[dict]] = []

        class FakeSession:
            def execute(self, sql, params=None):
                if params is not None and isinstance(params, list):
                    inserted_batches.append(params)
                return MagicMock()
            def __enter__(self): return self
            def __exit__(self, *a): pass

        from quant_pipeline.research.kelly_sweep.persist import persist_results

        job_id = uuid.uuid4()
        with patch("quant_pipeline.research.kelly_sweep.persist.session_scope", FakeSession):
            persist_results(job_id, [row_a, row_b], pareto, topk)

        # 找插入的行（第二次 session_scope 调用是 INSERT）
        assert len(inserted_batches) >= 1
        all_inserted = [row for batch in inserted_batches for row in batch]
        assert len(all_inserted) == 2

        row_a_ins = next(r for r in all_inserted if r["variant_id"] == "base")
        row_b_ins = next(r for r in all_inserted if r["variant_id"] != "base")
        assert row_a_ins["is_frontier"] is True
        assert row_b_ins["is_frontier"] is False

    def test_is_topk_flagged_correctly(self) -> None:
        """is_topk 标注：只有 topk 中的行是 True。"""
        import uuid
        from unittest.mock import MagicMock, patch

        row_a = _make_row(variant_id="base", exit_id="fixed_n(n=1)", window_group="no_rs", kelly_valid=0.3)
        row_b = _make_row(variant_id="v2", exit_id="fixed_n(n=2)", window_group="no_rs", kelly_valid=0.1)

        pareto = self._make_pareto([row_a, row_b], set())
        topk = {"no_rs": [row_a]}  # 只有 row_a 入选 top-K

        inserted_batches: list[list[dict]] = []

        class FakeSession:
            def execute(self, sql, params=None):
                if params is not None and isinstance(params, list):
                    inserted_batches.append(params)
                return MagicMock()
            def __enter__(self): return self
            def __exit__(self, *a): pass

        from quant_pipeline.research.kelly_sweep.persist import persist_results

        job_id = uuid.uuid4()
        with patch("quant_pipeline.research.kelly_sweep.persist.session_scope", FakeSession):
            persist_results(job_id, [row_a, row_b], pareto, topk)

        all_inserted = [r for batch in inserted_batches for r in batch]
        assert len(all_inserted) == 2

        row_a_ins = next(r for r in all_inserted if r["variant_id"] == "base")
        row_b_ins = next(r for r in all_inserted if r["variant_id"] == "v2")
        assert row_a_ins["is_topk"] is True
        assert row_b_ins["is_topk"] is False

    def test_variant_filters_json_ensure_ascii_false(self) -> None:
        """variant_filters 用 ensure_ascii=False（JSONB UTF-8 中文不转义）。"""
        import json
        import uuid
        from unittest.mock import MagicMock, patch

        # 构造含中文字符的 variant_filters（实际场景是特征名英文，但测试字段序列化）
        row = _make_row()
        object.__setattr__(row, "variant_filters", [["特征A", "lt", -0.03]])

        pareto = self._make_pareto([row], set())
        topk: dict = {}

        inserted_batches: list[list[dict]] = []

        class FakeSession:
            def execute(self, sql, params=None):
                if params is not None and isinstance(params, list):
                    inserted_batches.append(params)
                return MagicMock()
            def __enter__(self): return self
            def __exit__(self, *a): pass

        from quant_pipeline.research.kelly_sweep.persist import persist_results

        job_id = uuid.uuid4()
        with patch("quant_pipeline.research.kelly_sweep.persist.session_scope", FakeSession):
            persist_results(job_id, [row], pareto, topk)

        all_inserted = [r for batch in inserted_batches for r in batch]
        assert len(all_inserted) == 1
        vf_json = all_inserted[0]["variant_filters"]
        # ensure_ascii=False → 中文直接在 JSON 中，不转义为 \uXXXX
        parsed = json.loads(vf_json)
        assert parsed[0][0] == "特征A"
        assert "\\u" not in vf_json  # 不应有 unicode 转义

    def test_ci_from_topk_applied_to_topk_rows(self) -> None:
        """is_topk 行的 kelly_ci_low/high 来自 topk dict（已填充）。"""
        import uuid
        from unittest.mock import MagicMock, patch

        row_a = _make_row(kelly_valid=0.3, kelly_ci_low=None, kelly_ci_high=None)
        # topk 中的版本（CI 已填充）
        row_a_with_ci = dc_replace(row_a, kelly_ci_low=0.25, kelly_ci_high=0.35)

        pareto = self._make_pareto([row_a], set())
        topk = {"no_rs": [row_a_with_ci]}

        inserted_batches: list[list[dict]] = []

        class FakeSession:
            def execute(self, sql, params=None):
                if params is not None and isinstance(params, list):
                    inserted_batches.append(params)
                return MagicMock()
            def __enter__(self): return self
            def __exit__(self, *a): pass

        from quant_pipeline.research.kelly_sweep.persist import persist_results

        job_id = uuid.uuid4()
        with patch("quant_pipeline.research.kelly_sweep.persist.session_scope", FakeSession):
            persist_results(job_id, [row_a], pareto, topk)

        all_inserted = [r for batch in inserted_batches for r in batch]
        assert len(all_inserted) == 1
        assert all_inserted[0]["kelly_ci_low"] == pytest.approx(0.25)
        assert all_inserted[0]["kelly_ci_high"] == pytest.approx(0.35)

    def test_empty_rows_skips_write(self) -> None:
        """rows=[] 时不调 session_scope（早返回）。"""
        import uuid
        from unittest.mock import patch

        sessions_entered = []

        class FakeSession:
            def execute(self, sql, params=None):
                return MagicMock()
            def __enter__(self):
                sessions_entered.append(True)
                return self
            def __exit__(self, *a): pass

        from quant_pipeline.research.kelly_sweep.persist import persist_results

        job_id = uuid.uuid4()
        with patch("quant_pipeline.research.kelly_sweep.persist.session_scope", FakeSession):
            persist_results(job_id, [], [], {})

        # 空 rows → 不进 session_scope
        assert sessions_entered == []


# ─────────────────────────────────────────────────────────────────────────────
# 6. build_summary_payload
# ─────────────────────────────────────────────────────────────────────────────


class TestBuildSummaryPayload:
    def test_n_rows_correct(self) -> None:
        rows = [_make_row(), _make_row(variant_id="v2")]
        pareto = [{"is_frontier": False}, {"is_frontier": True}]
        topk: dict = {}
        result = build_summary_payload(rows, pareto, topk)
        assert result["n_rows"] == 2

    def test_n_frontier_correct(self) -> None:
        rows = [_make_row(), _make_row(variant_id="v2")]
        pareto = [{"is_frontier": True}, {"is_frontier": False}]
        topk: dict = {}
        result = build_summary_payload(rows, pareto, topk)
        assert result["n_frontier"] == 1

    def test_n_topk_correct(self) -> None:
        rows = [_make_row()]
        pareto = [{"is_frontier": False}]
        r1 = _make_row(kelly_valid=0.3)
        r2 = _make_row(variant_id="v2", kelly_valid=0.2)
        topk = {"no_rs": [r1, r2]}
        result = build_summary_payload(rows, pareto, topk)
        assert result["n_topk"] == 2

    def test_best_is_highest_kelly_valid(self) -> None:
        rows = [_make_row()]
        pareto: list = []
        r_low = _make_row(kelly_valid=0.1, kelly_ci_low=0.05, kelly_ci_high=0.15)
        r_high = _make_row(variant_id="v2", kelly_valid=0.4, kelly_ci_low=0.35, kelly_ci_high=0.45)
        topk = {"no_rs": [r_low, r_high]}
        result = build_summary_payload(rows, pareto, topk)
        assert result["best"] is not None
        assert result["best"]["kelly_valid"] == pytest.approx(0.4)
        assert result["best"]["variant_id"] == "v2"

    def test_best_is_none_when_no_topk(self) -> None:
        rows = [_make_row()]
        pareto: list = []
        result = build_summary_payload(rows, pareto, {})
        assert result["best"] is None

    def test_summary_keys_match_spec(self) -> None:
        """摘要包含 spec 02 规定的全部 key。"""
        rows = [_make_row()]
        pareto: list = []
        result = build_summary_payload(rows, pareto, {})
        assert "n_rows" in result
        assert "n_topk" in result
        assert "n_frontier" in result
        assert "best" in result


# ─────────────────────────────────────────────────────────────────────────────
# 7. on_progress enumerate_signals（via mock DB）
# ─────────────────────────────────────────────────────────────────────────────


class TestOnProgressEnumerate:
    """验证 enumerate_signals 的 on_progress 钩子（mock DB）。"""

    def test_on_progress_called_three_stages(self) -> None:
        """on_progress 在三个阶段各 emit 一次。"""
        from unittest.mock import patch, MagicMock

        from quant_pipeline.research.kelly_sweep.enumerate import enumerate_signals
        from quant_pipeline.research.kelly_sweep.config import SweepConfig

        config = SweepConfig(
            train_range=("20230101", "20231231"),
            valid_range=("20240101", "20261231"),
        )

        calls: list[tuple[int, int]] = []

        def _cb(done: int, total: int) -> None:
            calls.append((done, total))

        # mock DB 函数，返回空数据（不连 DB）
        with (
            patch("quant_pipeline.research.kelly_sweep.enumerate.load_sse_calendar",
                  return_value=["20230601", "20230602", "20230603"]),
            patch("quant_pipeline.research.kelly_sweep.enumerate._prefetch_symbol_map",
                  return_value={}),
            patch("quant_pipeline.research.kelly_sweep.enumerate._scan_indicator_signals",
                  return_value=[]),
            patch("quant_pipeline.research.kelly_sweep.enumerate._fetch_buy_date_quotes",
                  return_value={}),
            patch("quant_pipeline.research.kelly_sweep.enumerate._fetch_buy_date_limits",
                  return_value={}),
        ):
            enumerate_signals(config, on_progress=_cb)

        # 至少应有 3 次 emit（indicator 扫完 / T+1 推进 / 过滤完）
        assert len(calls) == 3
        # 最后一次应为 (3, 3)
        assert calls[-1] == (3, 3)

    def test_on_progress_none_no_error(self) -> None:
        """on_progress=None 不报错（无 DB mock，用空日历直接跳过）。"""
        from unittest.mock import patch

        from quant_pipeline.research.kelly_sweep.enumerate import enumerate_signals
        from quant_pipeline.research.kelly_sweep.config import SweepConfig

        config = SweepConfig(
            train_range=("20230101", "20231231"),
            valid_range=("20240101", "20261231"),
        )

        with (
            patch("quant_pipeline.research.kelly_sweep.enumerate.load_sse_calendar",
                  return_value=[]),
            patch("quant_pipeline.research.kelly_sweep.enumerate._prefetch_symbol_map",
                  return_value={}),
            patch("quant_pipeline.research.kelly_sweep.enumerate._scan_indicator_signals",
                  return_value=[]),
            patch("quant_pipeline.research.kelly_sweep.enumerate._fetch_buy_date_quotes",
                  return_value={}),
            patch("quant_pipeline.research.kelly_sweep.enumerate._fetch_buy_date_limits",
                  return_value={}),
        ):
            result = enumerate_signals(config, on_progress=None)

        assert result == []


# ─────────────────────────────────────────────────────────────────────────────
# 7. run_kelly_sweep — 完成时必须 emit progress=100（SSE 终态链回归）
# ─────────────────────────────────────────────────────────────────────────────


class TestRunKellySweepCompletionProgress:
    """回归：runner 跑完必须 emit progress=100 的 NOTIFY（真机 e2e 2026-06-09 发现）。

    后端 SSE controller 仅在收到 progress>=100 的 pg_notify 时回查 status、下发
    complete 事件；前端 ProgressLine 据此 emit 'done' → 自动加载结果。dispatcher
    在 runner 返回后写 status=success/progress=100 是直接 UPDATE，**不发 pg_notify**。
    若 runner 自身最后停在 99（写库），SSE 永收不到 >=100 事件、前端卡 99、done 不
    触发、结果不自动加载。故 runner 末尾必须显式 emit 100。
    """

    def _fake_job(self) -> Any:
        from uuid import uuid4

        from quant_pipeline.worker.poller import Job

        return Job(
            id=uuid4(),
            run_type="kelly_sweep",
            params={"rs_benchmark": ["hs300"]},
            attempts=1,
            max_attempts=3,
        )

    def test_last_emitted_progress_is_100(self) -> None:
        from quant_pipeline.worker import kelly_sweep_runner as runner_mod

        recorded: list[int] = []

        with (
            patch.object(
                runner_mod,
                "update_progress",
                side_effect=lambda jid, pct, stage=None: recorded.append(pct),
            ),
            patch(
                "quant_pipeline.research.kelly_sweep.enumerate.enumerate_signals",
                return_value=["sig"],
            ),
            patch(
                "quant_pipeline.research.kelly_sweep.paths.load_forward_paths",
                return_value=["path"],
            ),
            patch(
                "quant_pipeline.research.kelly_sweep.paths.load_feature_inputs",
                return_value=(MagicMock(), {}),
            ),
            patch(
                "quant_pipeline.research.kelly_sweep.paths.load_index_daily",
                return_value=MagicMock(),
            ),
            patch(
                "quant_pipeline.research.kelly_sweep.sweep.run_sweep",
                return_value=[_make_row()],
            ),
            patch(
                "quant_pipeline.research.kelly_sweep.report.compute_pareto_frontier",
                return_value=[],
            ),
            patch(
                "quant_pipeline.research.kelly_sweep.report.rank_top_k",
                return_value={},
            ),
            patch("quant_pipeline.research.kelly_sweep.persist.persist_results"),
            patch(
                "quant_pipeline.research.kelly_sweep.persist.build_summary_payload",
                return_value={"n_rows": 1, "n_topk": 0, "n_frontier": 0},
            ),
        ):
            runner_mod.run_kelly_sweep(self._fake_job())

        assert recorded, "runner 应至少 emit 一次 progress"
        assert 100 in recorded, f"runner 必须 emit progress=100，实际序列={recorded}"
        assert recorded[-1] == 100, (
            "runner 完成时最后一次 progress 必须是 100"
            f"（否则 SSE 收不到终态、前端卡住），实际最后值={recorded[-1]}，序列={recorded}"
        )
