"""date_range 过滤单测（P4）。

验证：
  1. _load_feature_matrix 带 date_range → SQL 含 BETWEEN + 参数绑定 start/end
  2. _parse_date_range 格式校验（格式非法、start > end → ValueError）
  3. runner.runner_entrypoint 缺 date_range → ValueError（fail-fast）
  4. tuning.runner_entrypoint 缺 date_range → ValueError（fail-fast）
  5. seed_averaging.runner_entrypoint 缺 date_range → ValueError（fail-fast）
  6. train_seed_average 把 date_range 透传给 train_fn
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, call, patch
from uuid import UUID, uuid4

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.training import runner as runner_mod
from quant_pipeline.training.runner import _parse_date_range


# ---------------------------------------------------------------------------
# 1. _parse_date_range 单元测试
# ---------------------------------------------------------------------------


def test_parse_date_range_valid() -> None:
    """合法格式：返回 (start, end) 元组。"""
    start, end = _parse_date_range("20250101:20251231")
    assert start == "20250101"
    assert end == "20251231"


def test_parse_date_range_same_day() -> None:
    """start == end 合法（单日）。"""
    start, end = _parse_date_range("20260101:20260101")
    assert start == end == "20260101"


def test_parse_date_range_missing_colon() -> None:
    with pytest.raises(ValueError, match="YYYYMMDD:YYYYMMDD"):
        _parse_date_range("20250101_20251231")


def test_parse_date_range_empty_part() -> None:
    with pytest.raises(ValueError, match="YYYYMMDD:YYYYMMDD"):
        _parse_date_range(":20251231")


def test_parse_date_range_non_digit() -> None:
    with pytest.raises(ValueError, match="8 位数字"):
        _parse_date_range("2025-01-01:2025-12-31")


def test_parse_date_range_start_after_end() -> None:
    with pytest.raises(ValueError, match="start.*> end|非法"):
        _parse_date_range("20251231:20250101")


# ---------------------------------------------------------------------------
# 2. _load_feature_matrix — 验证 SQL 含 BETWEEN + 参数绑定
# ---------------------------------------------------------------------------


def _make_mock_rows(trade_dates: list[str]) -> list[Any]:
    """构造与 session.execute(...).mappings().all() 同形态的假数据。"""

    rows = []
    for td in trade_dates:
        m = MagicMock()
        m.__getitem__ = lambda self, k, _td=td: {  # type: ignore[misc]
            "trade_date": _td,
            "ts_code": "000001.SZ",
            "features": {"f0": 1.0},
            "label": 0.5,
        }[k]
        rows.append(m)
    return rows


def test_load_feature_matrix_with_date_range_uses_between(monkeypatch: pytest.MonkeyPatch) -> None:
    """_load_feature_matrix(fs, date_range='20250101:20251231') →
    SQL 含 BETWEEN，params 包含 start='20250101' / end='20251231'。"""

    executed_sqls: list[str] = []
    executed_params: list[dict[str, Any]] = []

    mock_rows = _make_mock_rows(["20250315", "20250916"])

    class _MockSession:
        def execute(self, sql: Any, params: dict[str, Any]) -> Any:
            executed_sqls.append(str(sql))
            executed_params.append(dict(params))
            mock_result = MagicMock()
            mock_result.mappings.return_value.all.return_value = mock_rows
            return mock_result

        def __enter__(self) -> "_MockSession":
            return self

        def __exit__(self, *a: Any) -> None:
            pass

    monkeypatch.setattr(runner_mod, "session_scope", lambda: _MockSession())

    df = runner_mod._load_feature_matrix("fs_v1", date_range="20250101:20251231")

    assert len(executed_sqls) == 1
    sql_str = executed_sqls[0].upper()
    assert "BETWEEN" in sql_str, f"SQL 应含 BETWEEN，实际: {executed_sqls[0]}"
    assert executed_params[0].get("start") == "20250101"
    assert executed_params[0].get("end") == "20251231"
    assert executed_params[0].get("fs") == "fs_v1"
    # 结果 DataFrame 有正确行数
    assert len(df) == 2


def test_load_feature_matrix_without_date_range_no_between(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """_load_feature_matrix(fs, date_range=None) → SQL 不含 BETWEEN（全量查询）。"""

    executed_sqls: list[str] = []
    executed_params: list[dict[str, Any]] = []

    mock_rows = _make_mock_rows(["20240101"])

    class _MockSession:
        def execute(self, sql: Any, params: dict[str, Any]) -> Any:
            executed_sqls.append(str(sql))
            executed_params.append(dict(params))
            mock_result = MagicMock()
            mock_result.mappings.return_value.all.return_value = mock_rows
            return mock_result

        def __enter__(self) -> "_MockSession":
            return self

        def __exit__(self, *a: Any) -> None:
            pass

    monkeypatch.setattr(runner_mod, "session_scope", lambda: _MockSession())

    df = runner_mod._load_feature_matrix("fs_v1")

    assert "BETWEEN" not in executed_sqls[0].upper()
    assert "start" not in executed_params[0]
    assert "end" not in executed_params[0]
    assert len(df) == 1


def test_load_feature_matrix_date_range_invalid_format(monkeypatch: pytest.MonkeyPatch) -> None:
    """date_range 格式非法 → ValueError，不查库。"""

    called = []

    class _MockSession:
        def execute(self, *a: Any, **k: Any) -> Any:  # noqa: ARG002
            called.append(True)
            raise AssertionError("不应查库")

        def __enter__(self) -> "_MockSession":
            return self

        def __exit__(self, *a: Any) -> None:
            pass

    monkeypatch.setattr(runner_mod, "session_scope", lambda: _MockSession())

    with pytest.raises(ValueError, match="YYYYMMDD:YYYYMMDD"):
        runner_mod._load_feature_matrix("fs_v1", date_range="bad-format")

    assert called == [], "format 校验失败时不应查库"


# ---------------------------------------------------------------------------
# 3. runner.runner_entrypoint — date_range 缺失 → ValueError
# ---------------------------------------------------------------------------


def test_runner_entrypoint_missing_date_range_raises() -> None:
    """train runner_entrypoint 缺 date_range → ValueError。"""

    class _Job:
        id = None
        params = {"feature_set_id": "fs_v1", "model": "lgb-lambdarank"}

    with pytest.raises(ValueError, match="date_range"):
        runner_mod.runner_entrypoint(_Job())


def test_runner_entrypoint_empty_date_range_raises() -> None:
    """train runner_entrypoint date_range='' → ValueError。"""

    class _Job:
        id = None
        params = {"feature_set_id": "fs_v1", "date_range": ""}

    with pytest.raises(ValueError, match="date_range"):
        runner_mod.runner_entrypoint(_Job())


def test_runner_entrypoint_date_range_passed_to_train_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """train runner_entrypoint 有 date_range → 传入 train_model。"""

    calls: list[dict[str, Any]] = []

    def _fake_train_model(**kwargs: Any) -> Any:
        calls.append(kwargs)
        raise SystemExit(0)  # 中断，不实际训练

    monkeypatch.setattr(runner_mod, "train_model", _fake_train_model)

    class _Job:
        id = None
        params = {"feature_set_id": "fs_v1", "date_range": "20250101:20251231"}

    with pytest.raises(SystemExit):
        runner_mod.runner_entrypoint(_Job())

    assert calls, "train_model 应被调用"
    assert calls[0].get("date_range") == "20250101:20251231"
    assert calls[0].get("feature_set_id") == "fs_v1"


# ---------------------------------------------------------------------------
# 4. tuning.runner_entrypoint — date_range 缺失 → ValueError
# ---------------------------------------------------------------------------


def test_tuning_runner_entrypoint_missing_date_range_raises() -> None:
    """optuna runner_entrypoint 缺 date_range → ValueError。"""

    from quant_pipeline.training.tuning import runner_entrypoint

    class _Job:
        id = uuid4()
        params = {"feature_set_id": "fs_v1", "n_trials": 5}

    with pytest.raises(ValueError, match="date_range"):
        runner_entrypoint(_Job())


def test_tuning_runner_entrypoint_empty_date_range_raises() -> None:
    """optuna runner_entrypoint date_range='' → ValueError。"""

    from quant_pipeline.training.tuning import runner_entrypoint

    class _Job:
        id = uuid4()
        params = {"feature_set_id": "fs_v1", "date_range": "", "n_trials": 5}

    with pytest.raises(ValueError, match="date_range"):
        runner_entrypoint(_Job())


def test_tuning_runner_entrypoint_date_range_passed_to_tune(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """optuna runner_entrypoint 有 date_range → 传入 tune。"""

    import quant_pipeline.training.tuning as tuning_mod

    calls: list[dict[str, Any]] = []

    def _fake_tune(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        raise SystemExit(0)

    monkeypatch.setattr(tuning_mod, "tune", _fake_tune)

    from quant_pipeline.training.tuning import runner_entrypoint

    class _Job:
        id = uuid4()
        params = {
            "feature_set_id": "fs_v1",
            "date_range": "20250101:20251231",
            "n_trials": 5,
        }

    with pytest.raises(SystemExit):
        runner_entrypoint(_Job())

    assert calls, "tune 应被调用"
    assert calls[0].get("date_range") == "20250101:20251231"


# ---------------------------------------------------------------------------
# 5. seed_averaging.runner_entrypoint — date_range 缺失 → ValueError
# ---------------------------------------------------------------------------


def test_seed_avg_runner_entrypoint_missing_date_range_raises() -> None:
    """seed_avg runner_entrypoint 缺 date_range → ValueError。"""

    from quant_pipeline.training.seed_averaging import runner_entrypoint

    class _Job:
        id = uuid4()
        params = {"feature_set_id": "fs_v1"}

    with pytest.raises(ValueError, match="date_range"):
        runner_entrypoint(_Job())


def test_seed_avg_runner_entrypoint_empty_date_range_raises() -> None:
    """seed_avg runner_entrypoint date_range='' → ValueError。"""

    from quant_pipeline.training.seed_averaging import runner_entrypoint

    class _Job:
        id = uuid4()
        params = {"feature_set_id": "fs_v1", "date_range": ""}

    with pytest.raises(ValueError, match="date_range"):
        runner_entrypoint(_Job())


def test_seed_avg_runner_entrypoint_date_range_passed_to_train_seed_average(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """seed_avg runner_entrypoint 有 date_range → 传入 train_seed_average。"""

    import quant_pipeline.training.seed_averaging as seed_mod

    calls: list[dict[str, Any]] = []

    def _fake_train_seed_average(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        raise SystemExit(0)

    monkeypatch.setattr(seed_mod, "train_seed_average", _fake_train_seed_average)

    from quant_pipeline.training.seed_averaging import runner_entrypoint

    class _Job:
        id = uuid4()
        params = {"feature_set_id": "fs_v1", "date_range": "20250101:20251231"}

    with pytest.raises(SystemExit):
        runner_entrypoint(_Job())

    assert calls, "train_seed_average 应被调用"
    assert calls[0].get("date_range") == "20250101:20251231"


# ---------------------------------------------------------------------------
# 6. train_seed_average → date_range 透传给 train_fn
# ---------------------------------------------------------------------------


def test_train_seed_average_passes_date_range_to_train_fn() -> None:
    """train_seed_average 的 date_range 透传给每次 train_fn 调用。"""

    from quant_pipeline.training.seed_averaging import train_seed_average

    calls: list[dict[str, Any]] = []

    class _FakeResult:
        model_run_id = uuid4()
        model_version = "lgb-lambdarank-v1-20260101-seed42"
        artifact_uri = "./artifacts/fake/model.txt"
        oos_metrics: dict[str, Any] = {"ndcg@10": 0.5, "ic": 0.02, "rank_ic": 0.03, "portfolio_annual_after_cost": 0.1}
        report_uri = None

    def _fake_train_fn(**kwargs: Any) -> _FakeResult:
        calls.append(dict(kwargs))
        return _FakeResult()

    from unittest.mock import patch as _patch

    # 禁止 DB 写
    with (
        _patch("quant_pipeline.training.seed_averaging._create_child_train_job", return_value=None),
        _patch("quant_pipeline.training.seed_averaging._finalize_child_job"),
        _patch("quant_pipeline.training.seed_averaging.update_progress"),
        _patch(
            "quant_pipeline.training.seed_averaging._write_ensemble_model_run",
            return_value=(uuid4(), "./artifacts/fake/seed_avg_meta.json"),
        ),
    ):
        train_seed_average(
            feature_set_id="fs_v1",
            seeds=[42, 123],
            train_fn=_fake_train_fn,
            date_range="20250101:20251231",
        )

    assert len(calls) == 2, "应跑 2 个 seed"
    for c in calls:
        assert c.get("date_range") == "20250101:20251231", (
            f"date_range 未透传给 train_fn，实际: {c}"
        )
