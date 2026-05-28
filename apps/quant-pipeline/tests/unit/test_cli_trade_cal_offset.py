# -*- coding: utf-8 -*-
"""CLI `quant trade-cal offset` 单测（spec 2026-05-29 P1.1）。

供 daily 脚本计算 labels 阶段回填日期（T-30 交易日）；不连库，mock 出
raw.trade_cal 查询结果。
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
        self.captured_params: dict[str, Any] | None = None

    def execute(self, sql: Any, params: dict[str, Any] | None = None) -> "_FakeSession":
        self.captured_params = params
        return self

    def fetchall(self) -> list[tuple]:
        return list(self._rows)


def _patch_session(monkeypatch: pytest.MonkeyPatch, rows: list[tuple]) -> _FakeSession:
    session = _FakeSession(rows)

    @contextmanager
    def _cm() -> Any:
        yield session

    monkeypatch.setattr("quant_pipeline.db.engine.session_scope", _cm)
    return session


def test_offset_negative_returns_nth_before(monkeypatch: pytest.MonkeyPatch) -> None:
    """days=-3 → 返回 base 之前的第 3 个开市日。"""

    rows = [
        ("20260515",),  # 第 1 个 before（近）
        ("20260514",),
        ("20260513",),  # 第 3 个 before（目标）
    ]
    _patch_session(monkeypatch, rows)

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        ["trade-cal", "offset", "--base", "20260528", "--days", "-3"],
    )
    assert result.exit_code == 0, result.output
    assert result.output.strip() == "20260513"


def test_offset_positive_returns_nth_after(monkeypatch: pytest.MonkeyPatch) -> None:
    """days=+2 → 返回 base 之后的第 2 个开市日。"""

    rows = [
        ("20260529",),  # 第 1 个 after
        ("20260530",),  # 第 2 个 after（目标）
    ]
    _patch_session(monkeypatch, rows)

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        ["trade-cal", "offset", "--base", "20260528", "--days", "2"],
    )
    assert result.exit_code == 0, result.output
    assert result.output.strip() == "20260530"


def test_offset_zero_returns_base_directly(monkeypatch: pytest.MonkeyPatch) -> None:
    """days=0 → 不查 trade_cal，直接回显 base。"""

    captured: dict[str, bool] = {"queried": False}

    @contextmanager
    def _cm() -> Any:
        captured["queried"] = True
        yield _FakeSession([])

    monkeypatch.setattr("quant_pipeline.db.engine.session_scope", _cm)

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        ["trade-cal", "offset", "--base", "20260528", "--days", "0"],
    )
    assert result.exit_code == 0
    assert result.output.strip() == "20260528"
    assert captured["queried"] is False, "days=0 不应触发 trade_cal 查询"


def test_offset_insufficient_data_exits_3(monkeypatch: pytest.MonkeyPatch) -> None:
    """raw.trade_cal 数据不足 |days| 个开市日 → exit 3。"""

    rows = [("20260515",), ("20260514",)]  # 只有 2 个 before
    _patch_session(monkeypatch, rows)

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        ["trade-cal", "offset", "--base", "20260528", "--days", "-3"],
    )
    assert result.exit_code == 3, result.output


def test_offset_invalid_base_exits_2(monkeypatch: pytest.MonkeyPatch) -> None:
    """--base 不是 YYYYMMDD → exit 2，不查库。"""

    captured: dict[str, bool] = {"queried": False}

    @contextmanager
    def _cm() -> Any:
        captured["queried"] = True
        yield _FakeSession([])

    monkeypatch.setattr("quant_pipeline.db.engine.session_scope", _cm)

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        ["trade-cal", "offset", "--base", "2026-05-28", "--days", "-3"],
    )
    assert result.exit_code == 2, result.output
    assert captured["queried"] is False


def test_offset_passes_exchange_param(monkeypatch: pytest.MonkeyPatch) -> None:
    """--exchange 透传到 SQL。"""

    session = _patch_session(monkeypatch, [("20260515",)])

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        [
            "trade-cal", "offset",
            "--base", "20260528", "--days", "-1",
            "--exchange", "SZSE",
        ],
    )
    assert result.exit_code == 0
    assert session.captured_params is not None
    assert session.captured_params["ex"] == "SZSE"
