"""features/runner.py 增量物化单测（P3）。

覆盖 spec：
  - force_recompute=True  → 整段重算（现行为），不查已物化日期
  - force_recompute=False → 增量路径
      · 全重叠（无缺口）→ 跳过，0 次 upsert
      · 全不重叠（无物化）→ 整段一个缺口，1 次 upsert
      · 中间缺口 → 只算缺口子区间，正确区间传给 _load_*
      · 缺口内 labels 未覆盖的天 → warn 'features_missing_labels' + 跳过（不 upsert）
      · 缺口内 labels 全未覆盖 → warn + 跳过（0 次 upsert）
      · 加载区间 == 缺口区间（零 padding 断言）
      · log skipped/computed（缺口日志）
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, call, patch

import pandas as pd
import pytest

import quant_pipeline.features.runner as runner_mod
from quant_pipeline.features.runner import build_feature_matrix


# ---------------------------------------------------------------------------
# Helpers / shared fixtures
# ---------------------------------------------------------------------------

TRADING_DAYS_5 = [
    "20260102",
    "20260105",
    "20260106",
    "20260107",
    "20260108",
]

# 模拟 build_feature_matrix_from_frames 返回的 bundle
class _FakeBundle:
    def __init__(self, factor_ids: list[str] | None = None) -> None:
        self.feature_set_id = "fs_base000001"
        self.factor_ids = factor_ids or ["f1", "f2"]
        # matrix 要有 trade_date/ts_code 列 + 因子列 + label 列
        self.matrix = pd.DataFrame(
            [{"trade_date": "20260102", "ts_code": "000001.SZ", "f1": 1.0, "f2": 2.0, "label": 0.05}]
        )


def _make_fake_session(
    *,
    fm_dates: list[str] | None = None,
    labels_dates: list[str] | None = None,
    trading_days: list[str] | None = None,
) -> Any:
    """生成同时支持 query_materialized_dates 和 query_trading_days 的 fake session。

    _FakeSession 根据 SQL 内容返回不同行：
      - 含 'factors.feature_matrix' → fm_dates
      - 含 'factors.labels' → labels_dates
      - 含 'trade_cal' → trading_days
    """

    if fm_dates is None:
        fm_dates = []
    if labels_dates is None:
        labels_dates = TRADING_DAYS_5
    if trading_days is None:
        trading_days = TRADING_DAYS_5

    class _FakeResult:
        def __init__(self, rows: list[tuple]) -> None:
            self._rows = rows

        def fetchall(self) -> list[tuple]:
            return list(self._rows)

    class _FakeSession:
        def execute(self, sql: Any, params: Any = None) -> _FakeResult:
            sql_text = str(sql)
            if "factors.feature_matrix" in sql_text:
                return _FakeResult([(d,) for d in fm_dates])
            elif "factors.labels" in sql_text:
                return _FakeResult([(d,) for d in labels_dates])
            elif "trade_cal" in sql_text:
                return _FakeResult([(d,) for d in trading_days])
            return _FakeResult([])

    return _FakeSession()


@contextmanager
def _fake_session_scope(session: Any):
    yield session


def _patch_runner_base(
    monkeypatch: pytest.MonkeyPatch,
    *,
    fm_dates: list[str] | None = None,
    labels_dates: list[str] | None = None,
    trading_days: list[str] | None = None,
    upsert_calls: list | None = None,
) -> dict[str, Any]:
    """打 monkeypatch，返回 captures dict。

    补丁列表：
      - session_scope → fake session（支持 fm/labels/trading_days 查询）
      - _load_factor_ids → ["f1", "f2"]
      - resolve_feature_set_id → ("fs_base000001", False)
      - apply_overlay_to_feature_set_id → passthrough
      - build_overlay → {}
      - _load_daily_factors → 非空 DataFrame
      - _load_labels → 非空 DataFrame
      - _load_industry_map → 非空 DataFrame
      - _load_mv_map → 非空 DataFrame
      - build_feature_matrix_from_frames → _FakeBundle()
      - _upsert_feature_set → noop
      - _upsert_feature_matrix → 记录调用
    """
    if upsert_calls is None:
        upsert_calls = []

    captures: dict[str, Any] = {
        "load_factors_calls": [],
        "load_labels_calls": [],
        "upsert_matrix_calls": upsert_calls,
        "warned_api_names": [],
    }

    fake_session = _make_fake_session(
        fm_dates=fm_dates,
        labels_dates=labels_dates,
        trading_days=trading_days,
    )

    @contextmanager
    def _scope():
        yield fake_session

    monkeypatch.setattr(runner_mod, "session_scope", _scope)

    monkeypatch.setattr(
        runner_mod, "_load_factor_ids", lambda sess, fv: ["f1", "f2"]
    )
    monkeypatch.setattr(
        runner_mod, "resolve_feature_set_id",
        lambda sess, **kw: ("fs_base000001", False),
    )
    monkeypatch.setattr(
        runner_mod, "apply_overlay_to_feature_set_id",
        lambda base, overlay: base,
    )
    monkeypatch.setattr(runner_mod, "build_overlay", lambda **kw: {})

    def _fake_load_factors(fv: str, start: str, end: str) -> pd.DataFrame:
        captures["load_factors_calls"].append((start, end))
        return pd.DataFrame(
            [{"trade_date": start, "ts_code": "000001.SZ", "factor_id": "f1", "value": 1.0}]
        )

    def _fake_load_labels(scheme: str, start: str, end: str) -> pd.DataFrame:
        captures["load_labels_calls"].append((start, end))
        return pd.DataFrame(
            [{"trade_date": start, "ts_code": "000001.SZ", "scheme": scheme,
              "value": 0.05, "exit_reason": "max_hold", "hold_days": 10}]
        )

    monkeypatch.setattr(runner_mod, "_load_daily_factors", _fake_load_factors)
    monkeypatch.setattr(runner_mod, "_load_labels", _fake_load_labels)
    monkeypatch.setattr(
        runner_mod, "_load_industry_map",
        lambda s, e: pd.DataFrame(
            [{"trade_date": s, "ts_code": "000001.SZ", "industry_l1": "银行"}]
        ),
    )
    monkeypatch.setattr(
        runner_mod, "_load_mv_map",
        lambda s, e: pd.DataFrame(
            [{"trade_date": s, "ts_code": "000001.SZ", "mv": 100000.0}]
        ),
    )
    monkeypatch.setattr(
        runner_mod, "build_feature_matrix_from_frames",
        lambda **kw: _FakeBundle(),
    )
    monkeypatch.setattr(runner_mod, "_upsert_feature_set", lambda **kw: None)

    def _fake_upsert_matrix(**kw: Any) -> int:
        captures["upsert_matrix_calls"].append(kw)
        return 1

    monkeypatch.setattr(runner_mod, "_upsert_feature_matrix", _fake_upsert_matrix)

    return captures


# ---------------------------------------------------------------------------
# 1. force_recompute=True → 整段重算，不查已物化日期
# ---------------------------------------------------------------------------


def test_force_recompute_true_skips_incremental_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """force=True 走整段重算，_load_daily_factors 区间 == 原始 date_range。"""

    captures = _patch_runner_base(monkeypatch)
    fsid = build_feature_matrix(
        factor_version="v1",
        label_scheme="strategy-aware",
        date_range="20260102:20260108",
        new_listing_min_days=60,
        force_recompute=True,
    )
    assert fsid == "fs_base000001"
    # 整段加载：start=20260102, end=20260108
    assert captures["load_factors_calls"] == [("20260102", "20260108")]
    assert captures["load_labels_calls"] == [("20260102", "20260108")]
    # upsert 调用了 1 次
    assert len(captures["upsert_matrix_calls"]) == 1


def test_force_recompute_default_is_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """默认 force_recompute=False → 走增量路径。"""

    # 无已物化日期 → 整段一个缺口 → 仍会 upsert
    captures = _patch_runner_base(monkeypatch, fm_dates=[])
    build_feature_matrix(
        factor_version="v1",
        label_scheme="strategy-aware",
        date_range="20260102:20260108",
        new_listing_min_days=60,
        # 不传 force_recompute，默认 False
    )
    # 增量路径也会 upsert（因为全是缺口）
    assert len(captures["upsert_matrix_calls"]) == 1


# ---------------------------------------------------------------------------
# 2. 增量路径：全重叠（无缺口）→ 跳过
# ---------------------------------------------------------------------------


def test_incremental_full_overlap_skips_upsert(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """全部交易日已物化 → 无缺口 → 0 次 upsert，log skipped。"""

    captures = _patch_runner_base(
        monkeypatch,
        fm_dates=TRADING_DAYS_5,  # 全部已物化
    )
    import logging

    with caplog.at_level(logging.INFO, logger="quant_pipeline.features.runner"):
        fsid = build_feature_matrix(
            factor_version="v1",
            label_scheme="strategy-aware",
            date_range="20260102:20260108",
            new_listing_min_days=60,
            force_recompute=False,
        )

    assert fsid == "fs_base000001"
    assert len(captures["upsert_matrix_calls"]) == 0
    # 不加载因子/标签（全跳过）
    assert captures["load_factors_calls"] == []
    # 日志里应有 skipped 相关信息
    assert any("skipped" in r.message or "skip" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# 3. 增量路径：全不重叠（无物化）→ 整段一个缺口
# ---------------------------------------------------------------------------


def test_incremental_no_overlap_full_range_one_gap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """无已物化 → 整段 1 个缺口，_load_daily_factors 区间 == (g0, g1)。"""

    captures = _patch_runner_base(
        monkeypatch,
        fm_dates=[],  # 无已物化
    )
    build_feature_matrix(
        factor_version="v1",
        label_scheme="strategy-aware",
        date_range="20260102:20260108",
        new_listing_min_days=60,
        force_recompute=False,
    )
    # 整段缺口 → 加载区间 == (20260102, 20260108)
    assert captures["load_factors_calls"] == [("20260102", "20260108")]
    assert captures["load_labels_calls"] == [("20260102", "20260108")]
    assert len(captures["upsert_matrix_calls"]) == 1


# ---------------------------------------------------------------------------
# 4. 增量路径：中间缺口 → 只算缺口子区间
# ---------------------------------------------------------------------------


def test_incremental_middle_gap_correct_ranges(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """两端已物化，中间缺口 20260106-20260107。

    _load_daily_factors 应仅以 ('20260106', '20260107') 调用。
    """

    # trading_days = [20260102, 20260105, 20260106, 20260107, 20260108]
    # 已物化：20260102, 20260105, 20260108 → 缺口 = [20260106, 20260107]
    captures = _patch_runner_base(
        monkeypatch,
        fm_dates=["20260102", "20260105", "20260108"],
        labels_dates=TRADING_DAYS_5,
    )
    build_feature_matrix(
        factor_version="v1",
        label_scheme="strategy-aware",
        date_range="20260102:20260108",
        new_listing_min_days=60,
        force_recompute=False,
    )
    assert captures["load_factors_calls"] == [("20260106", "20260107")]
    assert captures["load_labels_calls"] == [("20260106", "20260107")]
    assert len(captures["upsert_matrix_calls"]) == 1


# ---------------------------------------------------------------------------
# 5. 多缺口 → 多次加载+upsert
# ---------------------------------------------------------------------------


def test_incremental_multiple_disjoint_gaps(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """两个不相邻缺口 → 每个缺口各 1 次加载+upsert。

    trading_days = [D1, D2, D3, D4, D5]
    已物化 = {D2, D4} → 缺口 = [(D1, D1), (D3, D3), (D5, D5)]
    """
    # 已物化：20260105, 20260107 → 缺口：[20260102], [20260106], [20260108]
    captures = _patch_runner_base(
        monkeypatch,
        fm_dates=["20260105", "20260107"],
        labels_dates=TRADING_DAYS_5,
    )
    build_feature_matrix(
        factor_version="v1",
        label_scheme="strategy-aware",
        date_range="20260102:20260108",
        new_listing_min_days=60,
        force_recompute=False,
    )
    # 3 个缺口 → 3 次加载
    assert len(captures["load_factors_calls"]) == 3
    assert captures["load_factors_calls"] == [
        ("20260102", "20260102"),
        ("20260106", "20260106"),
        ("20260108", "20260108"),
    ]
    assert len(captures["upsert_matrix_calls"]) == 3


# ---------------------------------------------------------------------------
# 6. 缺口内 labels 未覆盖的天 → warn + 跳过（不 upsert）
# ---------------------------------------------------------------------------


def test_incremental_gap_labels_not_covered_warns_and_skips(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """缺口 [20260106, 20260107]，但 labels 只覆盖到 20260105。

    缺口内的 20260106-20260107 labels 未覆盖 → warn features_missing_labels，跳过。
    不应调用 _upsert_feature_matrix。
    """

    # trading_days = TRADING_DAYS_5
    # 已物化 feature_matrix：20260102, 20260105 → 缺口 [20260106, 20260107, 20260108]
    # labels 已覆盖：只到 20260105
    labels_covered = ["20260102", "20260105"]

    captures = _patch_runner_base(
        monkeypatch,
        fm_dates=["20260102", "20260105"],
        labels_dates=labels_covered,
    )

    import logging

    with caplog.at_level(logging.WARNING, logger="quant_pipeline.features.runner"):
        build_feature_matrix(
            factor_version="v1",
            label_scheme="strategy-aware",
            date_range="20260102:20260108",
            new_listing_min_days=60,
            force_recompute=False,
        )

    # warn 应出现
    warned = [r for r in caplog.records if "features_missing_labels" in r.message]
    assert len(warned) >= 1

    # 缺口完全不在 labels 覆盖范围 → 不 upsert
    assert len(captures["upsert_matrix_calls"]) == 0


def test_incremental_gap_labels_fully_uncovered_no_upsert(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """全段 labels 未覆盖（labels_dates=[]）→ warn + 跳过所有缺口（0 次 upsert）。"""

    captures = _patch_runner_base(
        monkeypatch,
        fm_dates=[],
        labels_dates=[],  # labels 完全没有数据
    )

    import logging

    with caplog.at_level(logging.WARNING, logger="quant_pipeline.features.runner"):
        build_feature_matrix(
            factor_version="v1",
            label_scheme="strategy-aware",
            date_range="20260102:20260108",
            new_listing_min_days=60,
            force_recompute=False,
        )

    warned = [r for r in caplog.records if "features_missing_labels" in r.message]
    assert len(warned) >= 1
    assert len(captures["upsert_matrix_calls"]) == 0


def test_incremental_gap_partial_labels_coverage(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """缺口 [D1, D2, D3, D4, D5]，labels 覆盖 D1, D2, D3 → D4/D5 warn+跳过，D1~D3 正常算。

    trading_days = TRADING_DAYS_5 = [20260102, 20260105, 20260106, 20260107, 20260108]
    fm_dates = []（全缺口）
    labels_dates = [20260102, 20260105, 20260106]（前 3 个有 labels）

    期望：
      - 缺口 = [(20260102, 20260108)] 一整段
      - labels 未覆盖的 = {20260107, 20260108}
      - warn features_missing_labels（含未覆盖的 dates）
      - 实际算的子区间 = (20260102, 20260106)（仅 labels 覆盖部分）
      - upsert_matrix_calls == 1
    """

    labels_covered = ["20260102", "20260105", "20260106"]

    captures = _patch_runner_base(
        monkeypatch,
        fm_dates=[],
        labels_dates=labels_covered,
    )

    import logging

    with caplog.at_level(logging.WARNING, logger="quant_pipeline.features.runner"):
        build_feature_matrix(
            factor_version="v1",
            label_scheme="strategy-aware",
            date_range="20260102:20260108",
            new_listing_min_days=60,
            force_recompute=False,
        )

    # warn 出现
    warned = [r for r in caplog.records if "features_missing_labels" in r.message]
    assert len(warned) >= 1

    # 应 upsert 1 次（labels 覆盖的 20260102-20260106 部分）
    assert len(captures["upsert_matrix_calls"]) == 1
    # 加载区间仅覆盖 labels 有数据的天
    assert captures["load_factors_calls"] == [("20260102", "20260106")]


# ---------------------------------------------------------------------------
# 7. 零 padding 断言：加载区间 == 缺口子区间（不多不少）
# ---------------------------------------------------------------------------


def test_incremental_load_range_equals_gap_no_padding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """增量路径加载区间严格等于缺口子区间，不做 padding。

    设置单日缺口 20260106 → _load_daily_factors 仅以 ('20260106', '20260106') 调用。
    """

    captures = _patch_runner_base(
        monkeypatch,
        fm_dates=["20260102", "20260105", "20260107", "20260108"],
        labels_dates=TRADING_DAYS_5,
    )
    build_feature_matrix(
        factor_version="v1",
        label_scheme="strategy-aware",
        date_range="20260102:20260108",
        new_listing_min_days=60,
        force_recompute=False,
    )
    assert captures["load_factors_calls"] == [("20260106", "20260106")]
    # 加载区间不含 20260105 或 20260107（无 padding）
    for start, end in captures["load_factors_calls"]:
        assert start == "20260106"
        assert end == "20260106"


# ---------------------------------------------------------------------------
# 8. log computed（增量路径成功 upsert 后有 log 记录）
# ---------------------------------------------------------------------------


def test_incremental_logs_computed_rows(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """增量算完一个缺口后，应有包含 computed/written 信息的 log。"""

    _patch_runner_base(monkeypatch, fm_dates=[])

    import logging

    with caplog.at_level(logging.INFO, logger="quant_pipeline.features.runner"):
        build_feature_matrix(
            factor_version="v1",
            label_scheme="strategy-aware",
            date_range="20260102:20260108",
            new_listing_min_days=60,
            force_recompute=False,
        )

    # 应有 feature_matrix_written 类的 log
    assert any(
        "feature_matrix" in r.message or "written" in r.message or "computed" in r.message
        for r in caplog.records
    )


# ---------------------------------------------------------------------------
# 9. force=True 时不调用增量查询（不走 session_scope 中的 fm query）
# ---------------------------------------------------------------------------


def test_force_recompute_true_does_not_query_materialized(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """force=True 不应查 factors.feature_matrix 的已物化日期。"""

    fm_query_calls: list[str] = []

    class _TrackingSession:
        def execute(self, sql: Any, params: Any = None) -> Any:
            sql_text = str(sql)
            if "factors.feature_matrix" in sql_text and "DISTINCT" in sql_text:
                fm_query_calls.append(sql_text)

            class _R:
                def fetchall(self_) -> list:
                    if "trade_cal" in sql_text:
                        return [(d,) for d in TRADING_DAYS_5]
                    return []

            return _R()

    @contextmanager
    def _scope():
        yield _TrackingSession()

    # 需要同时 patch resolve_feature_set_id、_load_factor_ids
    monkeypatch.setattr(runner_mod, "session_scope", _scope)
    monkeypatch.setattr(runner_mod, "_load_factor_ids", lambda s, fv: ["f1"])
    monkeypatch.setattr(
        runner_mod, "resolve_feature_set_id",
        lambda s, **kw: ("fs_base000001", False),
    )
    monkeypatch.setattr(
        runner_mod, "apply_overlay_to_feature_set_id", lambda b, o: b
    )
    monkeypatch.setattr(runner_mod, "build_overlay", lambda **kw: {})
    monkeypatch.setattr(
        runner_mod, "_load_daily_factors",
        lambda fv, s, e: pd.DataFrame(
            [{"trade_date": s, "ts_code": "000001.SZ", "factor_id": "f1", "value": 1.0}]
        ),
    )
    monkeypatch.setattr(
        runner_mod, "_load_labels",
        lambda scheme, s, e: pd.DataFrame(
            [{"trade_date": s, "ts_code": "000001.SZ", "scheme": scheme,
              "value": 0.05, "exit_reason": "max_hold", "hold_days": 10}]
        ),
    )
    monkeypatch.setattr(
        runner_mod, "_load_industry_map",
        lambda s, e: pd.DataFrame(
            [{"trade_date": s, "ts_code": "000001.SZ", "industry_l1": "银行"}]
        ),
    )
    monkeypatch.setattr(
        runner_mod, "_load_mv_map",
        lambda s, e: pd.DataFrame(
            [{"trade_date": s, "ts_code": "000001.SZ", "mv": 100000.0}]
        ),
    )
    monkeypatch.setattr(
        runner_mod, "build_feature_matrix_from_frames",
        lambda **kw: _FakeBundle(["f1"]),
    )
    monkeypatch.setattr(runner_mod, "_upsert_feature_set", lambda **kw: None)
    monkeypatch.setattr(runner_mod, "_upsert_feature_matrix", lambda **kw: 1)

    build_feature_matrix(
        factor_version="v1",
        label_scheme="strategy-aware",
        date_range="20260102:20260108",
        new_listing_min_days=60,
        force_recompute=True,
    )

    # force=True 不应查 feature_matrix 已物化日期
    assert fm_query_calls == []
