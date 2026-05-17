"""CLI `quant evaluate --run-id ... --ab-baseline ...` 单测（M3 Part A）。

Mock：
  - ml.model_runs 反查（session_scope 给一个最小可链调的 fake）
  - run_ab_compare：避免连库 + 不真训模型；捕获入参验证 CLI 参数翻译

覆盖：
  - 正常路径：'gbdt' → 'gbdt-pointwise' 名称翻译；输出含 report path
  - --run-id 在 ml.model_runs 中找不到 → exit 1
  - --ab-baseline 不支持的值 → exit 2
  - run_ab_compare 抛 ValueError → exit 1
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from quant_pipeline import cli as cli_mod


class _FakeSession:
    def __init__(self, row: tuple[str, str] | None) -> None:
        self._row = row

    def execute(self, _sql: Any, _params: dict[str, Any] | None = None) -> "_FakeSession":
        return self

    def first(self) -> tuple[str, str] | None:
        return self._row


def _fake_session_scope_factory(row: tuple[str, str] | None):
    """生成一个仿 `session_scope` 的 contextmanager 函数。"""

    @contextmanager
    def _cm() -> Any:
        yield _FakeSession(row)

    return _cm


def test_evaluate_happy_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """正常评估路径：'gbdt' 翻译为 'gbdt-pointwise'，CLI 输出含 report 路径。"""

    # mock session_scope 反查 ml.model_runs
    fake_cm = _fake_session_scope_factory(("fs_v1", "lgb-lambdarank-v1-test"))
    monkeypatch.setattr(
        "quant_pipeline.db.engine.session_scope",
        fake_cm,
    )

    # mock run_ab_compare：捕获 baselines 参数并返回最小 summary
    captured: dict[str, Any] = {}

    def _fake_run_ab(**kwargs: Any) -> dict[str, Any]:
        captured.update(kwargs)
        return {
            "summary": {
                "linear": {
                    "ndcg_at_10_mean": 0.5,
                    "ic_mean": 0.02,
                    "rank_ic_mean": 0.03,
                    "portfolio_annual_after_cost": 0.1,
                    "n_folds": 6,
                },
                "gbdt-pointwise": {
                    "ndcg_at_10_mean": 0.52,
                    "ic_mean": 0.025,
                    "rank_ic_mean": 0.035,
                    "portfolio_annual_after_cost": 0.12,
                    "n_folds": 6,
                },
                "ensemble": {
                    "ndcg_at_10_mean": 0.53,
                    "ic_mean": 0.027,
                    "rank_ic_mean": 0.04,
                    "portfolio_annual_after_cost": 0.13,
                    "n_folds": 6,
                },
            },
            "report_path": tmp_path / "report.md",
            "report_content": "# mock",
        }

    monkeypatch.setattr(
        "quant_pipeline.evaluation.ab_compare.run_ab_compare", _fake_run_ab
    )
    monkeypatch.setenv("ARTIFACT_DIR", str(tmp_path))

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        [
            "evaluate",
            "--run-id", "11111111-1111-1111-1111-111111111111",
            "--ab-baseline", "linear,gbdt",
            "--n-folds", "6",
            "--embargo-days", "21",
            "--min-train-days", "252",
            "--top-k", "5",
            "--lgb-num-boost-round", "20",
        ],
    )
    assert result.exit_code == 0, result.output
    # CLI 应把 'gbdt' 翻译成 'gbdt-pointwise'
    assert captured["baselines"] == ["linear", "gbdt-pointwise"]
    assert captured["feature_set_id"] == "fs_v1"
    assert captured["model_version"] == "lgb-lambdarank-v1-test"
    assert captured["n_folds"] == 6
    assert captured["embargo_days"] == 21
    # stdout 应含 evaluate ok
    assert "evaluate ok" in result.output
    assert "report ->" in result.output


def test_evaluate_run_id_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_cm = _fake_session_scope_factory(None)
    monkeypatch.setattr("quant_pipeline.db.engine.session_scope", fake_cm)

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        [
            "evaluate",
            "--run-id", "deadbeef-dead-beef-dead-beefdeadbeef",
            "--ab-baseline", "linear",
        ],
    )
    assert result.exit_code == 1
    assert "找不到" in result.output


def test_evaluate_invalid_baseline(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_cm = _fake_session_scope_factory(("fs_v1", "mv-x"))
    monkeypatch.setattr("quant_pipeline.db.engine.session_scope", fake_cm)

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        [
            "evaluate",
            "--run-id", "11111111-1111-1111-1111-111111111111",
            "--ab-baseline", "xgboost",  # 不支持
        ],
    )
    assert result.exit_code == 2
    assert "不支持" in result.output


def test_evaluate_run_ab_compare_raises(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake_cm = _fake_session_scope_factory(("fs_v1", "mv-x"))
    monkeypatch.setattr("quant_pipeline.db.engine.session_scope", fake_cm)

    def _boom(**_kwargs: Any) -> dict[str, Any]:
        raise ValueError("交易日数不足以做 6 折 Purged Walk-Forward")

    monkeypatch.setattr(
        "quant_pipeline.evaluation.ab_compare.run_ab_compare", _boom
    )
    monkeypatch.setenv("ARTIFACT_DIR", str(tmp_path))

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        [
            "evaluate",
            "--run-id", "11111111-1111-1111-1111-111111111111",
            "--ab-baseline", "linear",
        ],
    )
    assert result.exit_code == 1
    assert "EVALUATE FAILED" in result.output
