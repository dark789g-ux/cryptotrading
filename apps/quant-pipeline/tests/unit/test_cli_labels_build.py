# -*- coding: utf-8 -*-
"""CLI `quant labels build` 单测（策略参数 + fail-fast 守门）。

覆盖：
  (a) 给 --strategy-id + --strategy-version → codec 算 scheme、_load_strategy_definition
      取 exit_rules，两者都正确传给 compute_labels
  (b) 只给其一（--strategy-id 或 --strategy-version）→ exit 2，报错消息清晰
  (c) 自定义 strategy-aware scheme（strategy-aware__xxx）+ 无 strategy-id → fail-fast exit 2
  (d) default 别名 "strategy-aware" + 无 strategy-id → 正常，exit_rules=None 传给 compute_labels
  (e) --scheme 与 codec 算出的不一致 → fail-fast exit 2

Mock：
  - quant_pipeline.labels.runner._load_strategy_definition（不连库）
  - quant_pipeline.labels.runner.compute_labels（捕获入参断言）
"""

from __future__ import annotations

from typing import Any

import pytest
from typer.testing import CliRunner

from quant_pipeline import cli as cli_mod


# ---------------------------------------------------------------------------
# 辅助 fixture / helper
# ---------------------------------------------------------------------------

_FAKE_EXIT_RULES: list[dict] = [{"type": "stop_loss", "threshold": -0.05}]

_FAKE_COMPUTE_CALLS: list[dict[str, Any]] = []


def _make_fake_load_strategy(exit_rules: list[dict]):
    """生成 _load_strategy_definition 的假实现，返回固定 exit_rules。"""

    def _load(strategy_id: str, strategy_version: str) -> list[dict]:
        return exit_rules

    return _load


def _make_fake_compute_labels(calls_log: list[dict[str, Any]]):
    """生成 compute_labels 的假实现，把入参记录到 calls_log，返回固定行数 42。"""

    def _compute(**kwargs: Any) -> int:
        calls_log.append(kwargs)
        return 42

    return _compute


# ---------------------------------------------------------------------------
# 测试 (a)：给 --strategy-id + --strategy-version → 正确解析 exit_rules 与 scheme
# ---------------------------------------------------------------------------


def test_labels_build_with_strategy_id_version_passes_exit_rules(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """给 --strategy-id 和 --strategy-version → codec 算 scheme，
    _load_strategy_definition 取 exit_rules，二者都传给 compute_labels。
    """

    calls: list[dict[str, Any]] = []

    monkeypatch.setattr(
        "quant_pipeline.labels.runner._load_strategy_definition",
        _make_fake_load_strategy(_FAKE_EXIT_RULES),
    )
    monkeypatch.setattr(
        "quant_pipeline.labels.runner.compute_labels",
        _make_fake_compute_labels(calls),
    )

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        [
            "labels", "build",
            "--date-range", "20260601:20260607",
            "--strategy-id", "tight_exit",
            "--strategy-version", "v2",
        ],
    )
    assert result.exit_code == 0, result.output

    # scheme 由 codec 决定：strategy_aware + tight_exit@v2 → "strategy-aware__tight_exit_v2"
    assert len(calls) == 1
    kw = calls[0]
    assert kw["scheme"] == "strategy-aware__tight_exit_v2"
    assert kw["exit_rules"] == _FAKE_EXIT_RULES
    assert "rows_upserted=42" in result.output


def test_labels_build_with_default_exit_strategy_uses_legacy_scheme(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """strategy_id=default_exit + strategy_version=v1 → codec 回 legacy 串 "strategy-aware"。"""

    calls: list[dict[str, Any]] = []

    monkeypatch.setattr(
        "quant_pipeline.labels.runner._load_strategy_definition",
        _make_fake_load_strategy(_FAKE_EXIT_RULES),
    )
    monkeypatch.setattr(
        "quant_pipeline.labels.runner.compute_labels",
        _make_fake_compute_labels(calls),
    )

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        [
            "labels", "build",
            "--date-range", "20260601:20260607",
            "--strategy-id", "default_exit",
            "--strategy-version", "v1",
        ],
    )
    assert result.exit_code == 0, result.output

    assert len(calls) == 1
    kw = calls[0]
    # default_exit@v1 → legacy 别名 "strategy-aware"（codec 守哈希不漂移）
    assert kw["scheme"] == "strategy-aware"
    assert kw["exit_rules"] == _FAKE_EXIT_RULES


# ---------------------------------------------------------------------------
# 测试 (b)：只给其一 → exit 2
# ---------------------------------------------------------------------------


def test_labels_build_only_strategy_id_exits_2(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """只传 --strategy-id，不传 --strategy-version → exit 2，错误消息提及两者。"""

    compute_called: list[bool] = []
    monkeypatch.setattr(
        "quant_pipeline.labels.runner.compute_labels",
        lambda **kwargs: compute_called.append(True) or 0,
    )

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        [
            "labels", "build",
            "--date-range", "20260601:20260607",
            "--strategy-id", "tight_exit",
        ],
    )
    assert result.exit_code == 2, result.output
    assert not compute_called, "不应调用 compute_labels"
    # 错误消息应包含关键词
    combined = result.output + (result.stderr or "")
    assert "strategy-id" in combined or "strategy_id" in combined


def test_labels_build_only_strategy_version_exits_2(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """只传 --strategy-version，不传 --strategy-id → exit 2。"""

    compute_called: list[bool] = []
    monkeypatch.setattr(
        "quant_pipeline.labels.runner.compute_labels",
        lambda **kwargs: compute_called.append(True) or 0,
    )

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        [
            "labels", "build",
            "--date-range", "20260601:20260607",
            "--strategy-version", "v1",
        ],
    )
    assert result.exit_code == 2, result.output
    assert not compute_called


# ---------------------------------------------------------------------------
# 测试 (c)：自定义 strategy-aware scheme + 无 strategy-id → fail-fast exit 2
# ---------------------------------------------------------------------------


def test_labels_build_custom_strategy_aware_scheme_without_strategy_id_exits_2(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """scheme=strategy-aware__tight_exit_v1 + 无 --strategy-id/version → fail-fast exit 2。

    此路径若放行会静默回退到 default exit_rules 错标，违反 lint-no-silent-degradation。
    """

    compute_called: list[bool] = []
    monkeypatch.setattr(
        "quant_pipeline.labels.runner.compute_labels",
        lambda **kwargs: compute_called.append(True) or 0,
    )

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        [
            "labels", "build",
            "--date-range", "20260601:20260607",
            "--scheme", "strategy-aware__tight_exit_v1",
        ],
    )
    assert result.exit_code == 2, result.output
    assert not compute_called, "不应调用 compute_labels"
    combined = result.output + (result.stderr or "")
    # 错误消息应提示需要补充 strategy-id/version
    assert "strategy-id" in combined or "strategy_id" in combined or "strategy-aware__" in combined


# ---------------------------------------------------------------------------
# 测试 (d)：default 别名 "strategy-aware" + 无 strategy-id → 正常，exit_rules=None
# ---------------------------------------------------------------------------


def test_labels_build_default_strategy_aware_scheme_without_strategy_id_ok(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """--scheme=strategy-aware（默认 default 别名）+ 无 --strategy-id/version → 正常。

    exit_rules=None 传给 compute_labels（走 default_rules()，这是正确行为）。
    """

    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(
        "quant_pipeline.labels.runner.compute_labels",
        _make_fake_compute_labels(calls),
    )
    # _load_strategy_definition 不应被调用
    monkeypatch.setattr(
        "quant_pipeline.labels.runner._load_strategy_definition",
        lambda sid, sver: pytest.fail("不应加载 strategy_definitions"),
    )

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        [
            "labels", "build",
            "--date-range", "20260601:20260607",
            # --scheme 不传，走默认 "strategy-aware"
        ],
    )
    assert result.exit_code == 0, result.output

    assert len(calls) == 1
    kw = calls[0]
    assert kw["scheme"] == "strategy-aware"
    assert kw["exit_rules"] is None


def test_labels_build_explicit_default_strategy_aware_scheme_ok(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """显式 --scheme=strategy-aware（与默认值相同）+ 无 strategy-id → 同样正常。"""

    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(
        "quant_pipeline.labels.runner.compute_labels",
        _make_fake_compute_labels(calls),
    )
    monkeypatch.setattr(
        "quant_pipeline.labels.runner._load_strategy_definition",
        lambda sid, sver: pytest.fail("不应加载 strategy_definitions"),
    )

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        [
            "labels", "build",
            "--date-range", "20260601:20260607",
            "--scheme", "strategy-aware",
        ],
    )
    assert result.exit_code == 0, result.output
    assert calls[0]["exit_rules"] is None


# ---------------------------------------------------------------------------
# 测试 (e)：--scheme 与 codec 算出的不一致 → fail-fast exit 2
# ---------------------------------------------------------------------------


def test_labels_build_scheme_mismatch_with_codec_exits_2(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """显式 --scheme=strategy-aware__wrong_v9 + --strategy-id=tight_exit --strategy-version=v2
    → codec 算出 strategy-aware__tight_exit_v2，与 --scheme 不一致 → exit 2。
    """

    compute_called: list[bool] = []
    monkeypatch.setattr(
        "quant_pipeline.labels.runner.compute_labels",
        lambda **kwargs: compute_called.append(True) or 0,
    )
    # _load_strategy_definition 也不该被调用（fail-fast 在此之前）
    monkeypatch.setattr(
        "quant_pipeline.labels.runner._load_strategy_definition",
        lambda sid, sver: pytest.fail("不应加载 strategy_definitions"),
    )

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        [
            "labels", "build",
            "--date-range", "20260601:20260607",
            "--scheme", "strategy-aware__wrong_v9",
            "--strategy-id", "tight_exit",
            "--strategy-version", "v2",
        ],
    )
    assert result.exit_code == 2, result.output
    assert not compute_called
    combined = result.output + (result.stderr or "")
    assert "strategy-aware__tight_exit_v2" in combined  # 错误消息应包含 codec 算出的期望值


# ---------------------------------------------------------------------------
# 测试：非 strategy-aware scheme（如 fwd_5d_ret）无 strategy-id → 正常
# ---------------------------------------------------------------------------


def test_labels_build_non_strategy_aware_scheme_ok(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """--scheme=fwd_5d_ret + 无 strategy-id → 正常，不触发任何守门。"""

    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(
        "quant_pipeline.labels.runner.compute_labels",
        _make_fake_compute_labels(calls),
    )
    monkeypatch.setattr(
        "quant_pipeline.labels.runner._load_strategy_definition",
        lambda sid, sver: pytest.fail("不应加载 strategy_definitions"),
    )

    runner = CliRunner()
    result = runner.invoke(
        cli_mod.app,
        [
            "labels", "build",
            "--date-range", "20260601:20260607",
            "--scheme", "fwd_5d_ret",
        ],
    )
    assert result.exit_code == 0, result.output
    assert calls[0]["scheme"] == "fwd_5d_ret"
    assert calls[0]["exit_rules"] is None
