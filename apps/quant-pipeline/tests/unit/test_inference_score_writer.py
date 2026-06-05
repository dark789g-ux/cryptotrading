"""inference.score_writer + inference.runner 单测（M2 Part G）。

score_writer 职责（不连库 / 不调 quality）：
  - 严格行数校验：spec M2 验收硬约束
  - rank_in_day = score desc 唯一排名
  - upsert 前去重（CLAUDE.md ON CONFLICT 单批多次冲突预防）

runner 职责（mock session）：
  - 推理前必检失败 → 抛 QualityGateBlocked + 不调 score_writer
  - 推理前必检通过 → 走 predict_one_day → write_scores
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.inference import runner as runner_mod
from quant_pipeline.inference.score_writer import (
    ScoreRowCountMismatch,
    compute_rank_in_day,
    write_scores,
)
from quant_pipeline.quality.runner import QualityGateBlocked

# ----------------------------------------------------------------------
# 共用 fixture：mock Session
# ----------------------------------------------------------------------


class _MockSession:
    """最小 mock Session：用 _set_daily_quote_count 配置 raw.daily_quote 行数。"""

    def __init__(self, daily_quote_count: int = 0) -> None:
        self._daily_quote_count = daily_quote_count
        self.upsert_rows: list[dict[str, Any]] = []

    def execute(self, statement: Any, params: Any = None) -> Any:
        sql = str(statement)
        if "COUNT" in sql.upper() or "count(" in sql.lower():
            class _Row:
                def __init__(self, n: int) -> None:
                    self._n = n

                def first(self) -> tuple[int]:
                    return (self._n,)

                def __getitem__(self, idx: int) -> int:
                    return self._n

            return _Row(self._daily_quote_count)
        # upsert: SQLAlchemy executemany 把 list[dict] 当 params
        if isinstance(params, list):
            self.upsert_rows.extend(params)
        return None


# ----------------------------------------------------------------------
# score_writer.compute_rank_in_day
# ----------------------------------------------------------------------


def test_compute_rank_in_day_descending() -> None:
    df = pd.DataFrame({"ts_code": ["A", "B", "C", "D"], "score": [1.0, 3.0, 2.0, 4.0]})
    out = compute_rank_in_day(df)
    by_code = dict(zip(out["ts_code"], out["rank_in_day"], strict=False))
    assert by_code["D"] == 1
    assert by_code["B"] == 2
    assert by_code["C"] == 3
    assert by_code["A"] == 4


def test_compute_rank_in_day_ties_unique() -> None:
    """同分时 method='first' 保证整数 1..N 唯一。"""

    df = pd.DataFrame({"ts_code": ["A", "B", "C"], "score": [1.0, 1.0, 1.0]})
    out = compute_rank_in_day(df)
    assert sorted(out["rank_in_day"].tolist()) == [1, 2, 3]


# ----------------------------------------------------------------------
# score_writer.write_scores —— 严格行数校验
# ----------------------------------------------------------------------


def test_write_scores_row_count_match() -> None:
    """行数严格 == raw.daily_quote 当日股票数 → 正常写库。"""

    n = 8
    session = _MockSession(daily_quote_count=n)
    df = pd.DataFrame(
        {"ts_code": [f"00000{i}.SZ" for i in range(n)], "score": np.linspace(0, 1, n)}
    )
    written = write_scores(
        df,
        model_version="lgb-lambdarank-v1-20260517-seed42",
        trade_date="20260517",
        session=session,  # type: ignore[arg-type]
    )
    assert written == n
    assert len(session.upsert_rows) == n
    # rank_in_day 1..N 唯一
    ranks = sorted(r["rank_in_day"] for r in session.upsert_rows)
    assert ranks == list(range(1, n + 1))


def test_write_scores_row_count_mismatch_raises() -> None:
    """df 8 行 vs raw.daily_quote 10 行 → ScoreRowCountMismatch。"""

    session = _MockSession(daily_quote_count=10)
    df = pd.DataFrame(
        {"ts_code": [f"00000{i}.SZ" for i in range(8)], "score": [0.0] * 8}
    )
    with pytest.raises(ScoreRowCountMismatch):
        write_scores(
            df,
            model_version="x",
            trade_date="20260517",
            session=session,  # type: ignore[arg-type]
        )


def test_write_scores_raw_empty_raises() -> None:
    """raw.daily_quote 当日空 → 直接 raise（不允许半量写入）。"""

    session = _MockSession(daily_quote_count=0)
    df = pd.DataFrame({"ts_code": ["A"], "score": [1.0]})
    with pytest.raises(ScoreRowCountMismatch):
        write_scores(df, model_version="x", trade_date="20260517", session=session)  # type: ignore[arg-type]


def test_write_scores_dedup_before_upsert() -> None:
    """同 ts_code 重复 → 自动 drop_duplicates，保留 last。"""

    session = _MockSession(daily_quote_count=2)
    df = pd.DataFrame(
        {"ts_code": ["A", "A", "B"], "score": [0.1, 0.9, 0.5]}
    )
    written = write_scores(
        df,
        model_version="x",
        trade_date="20260517",
        session=session,  # type: ignore[arg-type]
    )
    assert written == 2


def test_write_scores_rejects_bad_date() -> None:
    session = _MockSession(daily_quote_count=0)
    df = pd.DataFrame({"ts_code": ["A"], "score": [0.0]})
    with pytest.raises(ValueError, match="YYYYMMDD"):
        write_scores(df, model_version="x", trade_date="2026-05-17", session=session)  # type: ignore[arg-type]


def test_write_scores_rejects_missing_columns() -> None:
    session = _MockSession(daily_quote_count=1)
    df = pd.DataFrame({"ts_code": ["A"]})  # 缺 score
    with pytest.raises(ValueError, match="ts_code"):
        write_scores(df, model_version="x", trade_date="20260517", session=session)  # type: ignore[arg-type]


# ----------------------------------------------------------------------
# inference/runner —— quality gate
# ----------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _patch_runner_progress(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runner_mod, "update_progress", lambda *a, **k: None)


def test_run_inference_blocked_writes_no_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    """quality 失败 → 抛 QualityGateBlocked + 不调 write_scores。"""

    def _fake_gate(trade_date: str, *, mode: str, strict: bool, job_id: Any) -> None:
        raise QualityGateBlocked(rule="null_violation", detail={"col": "close"})

    monkeypatch.setattr(runner_mod, "gate_check", _fake_gate)

    called: list[Any] = []

    def _fake_write(df: pd.DataFrame, **kw: Any) -> int:
        called.append((df, kw))
        return len(df)

    monkeypatch.setattr(runner_mod, "write_scores", _fake_write)

    with pytest.raises(QualityGateBlocked) as exc_info:
        runner_mod.run_inference(
            model_version="lgb-lambdarank-v1-20260517-seed42",
            trade_date="20260517",
        )
    assert exc_info.value.rule == "null_violation"
    assert called == [], "quality 失败时绝不允许调 write_scores"


def test_run_inference_full_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """quality 通过 → predict_one_day → write_scores；返回行数。"""

    monkeypatch.setattr(
        runner_mod,
        "gate_check",
        lambda trade_date, *, mode, strict, job_id: None,
    )

    # 桩 predict_one_day 直接返回一个 score df（带 rank_in_day）
    def _fake_predict(model_version: str, trade_date: str, session: Any, **kw: Any) -> pd.DataFrame:
        n = 5
        return pd.DataFrame(
            {
                "ts_code": [f"0000{i}.SZ" for i in range(n)],
                "score": np.linspace(0, 1, n),
                "rank_in_day": list(range(1, n + 1)),
            }
        )

    monkeypatch.setattr(runner_mod, "predict_one_day", _fake_predict)

    captured: dict[str, Any] = {}

    def _fake_write(df: pd.DataFrame, **kw: Any) -> int:
        captured["df_len"] = len(df)
        captured["model_version"] = kw["model_version"]
        captured["enforce"] = kw.get("enforce_row_count")
        return len(df)

    monkeypatch.setattr(runner_mod, "write_scores", _fake_write)

    # 桩 session_scope 提供一个 _MockSession（实际本测试不查 db_count）
    class _Ctx:
        def __enter__(self) -> _MockSession:
            return _MockSession(daily_quote_count=999)

        def __exit__(self, *a: Any) -> None:
            return None

    monkeypatch.setattr(runner_mod, "session_scope", lambda: _Ctx())

    written = runner_mod.run_inference(
        model_version="lgb-lambdarank-v1-20260517-seed42",
        trade_date="20260517",
    )
    assert written == 5
    assert captured["df_len"] == 5
    assert captured["enforce"] is True
    assert captured["model_version"] == "lgb-lambdarank-v1-20260517-seed42"


def test_run_inference_rejects_bad_date() -> None:
    with pytest.raises(ValueError, match="YYYYMMDD"):
        runner_mod.run_inference(model_version="x", trade_date="2026-05-17")


def test_dispatcher_route_present() -> None:
    from quant_pipeline.worker.dispatcher import get_routes

    routes = get_routes()
    assert "infer" in routes
    assert routes["infer"].__name__ == "_runner_infer"


def test_inference_runner_entrypoint_validates_params() -> None:
    class _Job:
        id = None
        params = {"model_version": "x"}  # 缺 date

    with pytest.raises(ValueError, match="date"):
        runner_mod.runner_entrypoint(_Job())

    class _Job2:
        id = None
        params = {"date": "20260517"}  # 缺 model_version 与 model_run_id

    with pytest.raises(ValueError, match="model_version"):
        runner_mod.runner_entrypoint(_Job2())


# ----------------------------------------------------------------------
# inference/runner —— predict_one_day 路径解析
# ----------------------------------------------------------------------


def test_resolve_artifact_local_path_strips_dot_artifacts(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("ARTIFACT_DIR", str(tmp_path))
    p = runner_mod._resolve_artifact_local_path("./artifacts/abc-123/model.txt")
    expected = tmp_path / "abc-123" / "model.txt"
    assert p == expected.resolve() or p == expected


def test_predict_one_day_loads_meta_and_scores(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """predict_one_day 能正常 booster.predict 并附 rank_in_day。"""

    import lightgbm as lgb

    feature_cols = ["feat0", "feat1"]
    # 训练一个最小 booster
    n = 20
    X = np.random.default_rng(0).normal(size=(n, len(feature_cols)))
    y = np.random.default_rng(1).integers(0, 5, size=n)
    groups = np.array([5, 5, 5, 5], dtype=np.int64)
    ds = lgb.Dataset(X, label=y, group=groups, feature_name=feature_cols)
    booster = lgb.train(
        {"objective": "lambdarank", "metric": "ndcg", "verbose": -1,
         "num_leaves": 7, "min_data_in_leaf": 1},
        ds,
        num_boost_round=5,
    )
    artifact_dir = tmp_path / str(uuid4())
    artifact_dir.mkdir()
    booster.save_model(str(artifact_dir / "model.txt"))
    (artifact_dir / "meta.json").write_text(
        json.dumps({"feature_columns_order": feature_cols}), encoding="utf-8"
    )

    monkeypatch.setattr(
        runner_mod,
        "_load_model_run",
        lambda session, **kw: {
            "id": uuid4(),
            "model_version": "x",
            "feature_set_id": "fs",
            "artifact_uri": "./artifacts/whatever/model.txt",
        },
    )
    monkeypatch.setattr(
        runner_mod,
        "_resolve_artifact_local_path",
        lambda _uri: artifact_dir / "model.txt",
    )
    monkeypatch.setattr(
        runner_mod,
        "_load_daily_feature_section",
        lambda session, fs, td, cols: pd.DataFrame(
            {
                "ts_code": [f"S{i}" for i in range(5)],
                **{c: np.random.default_rng(2).normal(size=5).tolist() for c in cols},
            }
        ),
    )
    # b7f1f44 给 predict_one_day 增加了 _load_all_ts_codes（查 raw.daily_quote 全量 ts_code
    # 做特征缺失补齐 + 覆盖缺口告警，评审 05-#4），本测试 fd33de96 出生时尚无此调用、未同步
    # patch → session=None 时真 session.execute 直接炸。这里 patch 成与特征截面相同的 5 只票，
    # 使 missing 为空、不补 NaN 行，测试保持聚焦在 booster.predict + rank_in_day。
    monkeypatch.setattr(
        runner_mod,
        "_load_all_ts_codes",
        lambda session, td: [f"S{i}" for i in range(5)],
    )

    df = runner_mod.predict_one_day("x", "20260517", session=None)  # type: ignore[arg-type]
    assert list(df.columns) >= ["ts_code", "score", "rank_in_day"]
    assert len(df) == 5
    # rank_in_day 唯一 1..5
    assert sorted(df["rank_in_day"].tolist()) == [1, 2, 3, 4, 5]
