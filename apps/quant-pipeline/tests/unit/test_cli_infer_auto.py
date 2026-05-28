# -*- coding: utf-8 -*-
"""CLI `quant infer` 自动选模型单测（spec 2026-05-29 P0.3）。

Mock：
  - session_scope 提供 fake row（max(created_at) 查询）
  - run_inference 不真跑，返回固定 n

覆盖：
  - 不传 --model-version / --run-id → 走自动选最新（source=auto）
  - 显式 --model-version → source=cli
  - --run-id → 反查 model_version；source=cli
  - DB 无模型 → exit 2 + 明确错误消息
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any

import pytest
from typer.testing import CliRunner

from quant_pipeline import cli as cli_mod


class _FakeSession:
    def __init__(self, rows: list[tuple]) -> None:
        self._rows = rows
        self.executed_sqls: list[str] = []

    def execute(self, sql: Any, params: dict[str, Any] | None = None) -> "_FakeSession":
        self.executed_sqls.append(str(sql))
        return self

    def first(self) -> tuple | None:
        if not self._rows:
            return None
        return self._rows[0]


def _fake_session_scope_factory(rows: list[tuple]):
    @contextmanager
    def _cm() -> Any:
        yield _FakeSession(rows)

    return _cm


def test_infer_auto_selects_latest_when_no_flags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """两个 flag 都空 → SQL 自动取 max(created_at) 的 status='prod' 模型。"""

    fake_cm = _fake_session_scope_factory([("lgb-lambdarank-v1-20260521-seed42",)])
    monkeypatch.setattr("quant_pipeline.db.engine.session_scope", fake_cm)
    monkeypatch.setattr(
        "quant_pipeline.inference.runner.run_inference",
        lambda *, model_version, trade_date, **kwargs: 4523,
    )

    runner = CliRunner()
    result = runner.invoke(cli_mod.app, ["infer", "--date", "20260528"])
    assert result.exit_code == 0, result.output
    assert "model_version=lgb-lambdarank-v1-20260521-seed42" in result.output
    assert "source=auto" in result.output
    assert "written=4523" in result.output


def test_infer_explicit_model_version_uses_cli_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """显式传 --model-version → source=cli，不走 auto 查询。"""

    # session_scope 即使提供也不应被自动选模型路径触发；保险给个空列表
    fake_cm = _fake_session_scope_factory([])
    monkeypatch.setattr("quant_pipeline.db.engine.session_scope", fake_cm)
    monkeypatch.setattr(
        "quant_pipeline.inference.runner.run_inference",
        lambda *, model_version, trade_date, **kwargs: 4500,
    )

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        ["infer", "--date", "20260528", "--model-version", "lgb-explicit-v9"],
    )
    assert result.exit_code == 0, result.output
    assert "model_version=lgb-explicit-v9" in result.output
    assert "source=cli" in result.output


def test_infer_run_id_lookups_model_version(monkeypatch: pytest.MonkeyPatch) -> None:
    """只传 --run-id → 反查 ml.model_runs.model_version；source=cli。"""

    fake_cm = _fake_session_scope_factory([("lgb-lambdarank-v1-from-runid",)])
    monkeypatch.setattr("quant_pipeline.db.engine.session_scope", fake_cm)
    monkeypatch.setattr(
        "quant_pipeline.inference.runner.run_inference",
        lambda *, model_version, trade_date, **kwargs: 4400,
    )

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        [
            "infer",
            "--date", "20260528",
            "--run-id", "deadbeef-dead-beef-dead-beefdeadbeef",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "model_version=lgb-lambdarank-v1-from-runid" in result.output
    assert "source=cli" in result.output


def test_infer_auto_exits_when_no_prod_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """两个 flag 都空且 DB 无 status='prod' 模型 → exit 2，错误消息明确。"""

    fake_cm = _fake_session_scope_factory([])
    monkeypatch.setattr("quant_pipeline.db.engine.session_scope", fake_cm)
    monkeypatch.setattr(
        "quant_pipeline.inference.runner.run_inference",
        lambda *, model_version, trade_date, **kwargs: pytest.fail("不应被调"),
    )

    runner = CliRunner()
    result = runner.invoke(cli_mod.app, ["infer", "--date", "20260528"])
    assert result.exit_code == 2, result.output
    err = result.output + (result.stderr or "")
    assert "status='prod'" in err
