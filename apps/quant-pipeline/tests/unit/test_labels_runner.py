"""labels/runner.py 单测。

覆盖 spec 04 §item-10 空数据硬约束：
  - quotes 为空 → compute_labels 抛 RuntimeError
  - labels_df 为空 → compute_labels 抛 RuntimeError
外加 spec 2026-06-06 量化策略管理：
  - _load_strategy_definition 命中返回 exit_rules / 缺行 raise RuntimeError
  - compute_labels scheme 放宽到 'strategy-aware__*' 走 strategy_aware 分支
  - runner_entrypoint 含 strategy_id/version → 加载 exit_rules + codec 算 scheme
通过 monkeypatch 替换 _load_* DB IO 函数，不接触真实 DB。
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any

import pandas as pd
import pytest

from quant_pipeline.labels import runner as labels_runner


def _empty_quotes() -> pd.DataFrame:
    return pd.DataFrame(
        columns=["ts_code", "trade_date", "close", "low", "high",
                 "adj_factor", "close_adj", "low_adj", "high_adj"]
    )


def _patch_loaders(
    monkeypatch: pytest.MonkeyPatch,
    *,
    quotes: pd.DataFrame,
) -> None:
    monkeypatch.setattr(labels_runner, "_compute_end_padded", lambda end: end)
    monkeypatch.setattr(labels_runner, "_load_daily_quotes", lambda s, e: quotes)
    monkeypatch.setattr(
        labels_runner, "_load_stk_limit",
        lambda s, e: pd.DataFrame(columns=["ts_code", "trade_date", "up_limit", "down_limit"]),
    )
    monkeypatch.setattr(
        labels_runner, "_load_suspend",
        lambda s, e: pd.DataFrame(columns=["ts_code", "trade_date"]),
    )
    monkeypatch.setattr(
        labels_runner, "_load_listing_info",
        lambda: (
            pd.DataFrame(columns=["ts_code", "list_date"]),
            pd.DataFrame(columns=["ts_code", "delist_date"]),
        ),
    )


def test_compute_labels_raises_on_empty_quotes(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_loaders(monkeypatch, quotes=_empty_quotes())
    with pytest.raises(RuntimeError, match="no daily_quote rows"):
        labels_runner.compute_labels(
            scheme="strategy-aware", date_range="20240102:20240131"
        )


def test_compute_labels_raises_on_empty_labels(monkeypatch: pytest.MonkeyPatch) -> None:
    """quotes 非空但全部候选被过滤光 → compute_* 输出空 → RuntimeError。"""

    # 单只票，但未传 listing/delist；entries 全部触发新股过滤前需有候选 —— 这里
    # 构造 quotes 只有 1 天，simulate_exit 无法形成有效交易 → 输出空。
    quotes = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "trade_date": "20240102",
             "close": 10.0, "low": 9.8, "adj_factor": 1.0,
             "close_adj": 10.0, "low_adj": 9.8},
        ]
    )
    _patch_loaders(monkeypatch, quotes=quotes)
    with pytest.raises(RuntimeError, match="produced 0 rows"):
        labels_runner.compute_labels(
            scheme="strategy-aware", date_range="20240102:20240102"
        )


# ----------------------------------------------------------------------
# _load_strategy_definition：命中 / 缺行
# ----------------------------------------------------------------------

def _patch_session_scope_with_row(
    monkeypatch: pytest.MonkeyPatch, *, row: Any
) -> None:
    """把 labels_runner.session_scope 替换成返回固定 fetchone() 结果的 fake。"""

    class _FakeSession:
        def execute(self, _sql: Any, _params: Any) -> _FakeSession:
            return self

        def fetchone(self) -> Any:
            return row

    @contextmanager
    def _fake_scope() -> Any:
        yield _FakeSession()

    monkeypatch.setattr(labels_runner, "session_scope", _fake_scope)


def test_load_strategy_definition_hit(monkeypatch: pytest.MonkeyPatch) -> None:
    """命中 → 返回 exit_rules（jsonb → list[dict]）。"""

    exit_rules = [
        {"type": "stop_loss", "params": {"pct": 0.08}},
        {"type": "max_hold", "params": {"days": 20}},
    ]
    _patch_session_scope_with_row(monkeypatch, row=(exit_rules,))
    out = labels_runner._load_strategy_definition("default_exit", "v1")
    assert out == exit_rules


def test_load_strategy_definition_missing_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """缺行（fetchone()=None）→ RuntimeError（fail-fast，禁静默吞错）。"""

    _patch_session_scope_with_row(monkeypatch, row=None)
    with pytest.raises(RuntimeError, match="not found"):
        labels_runner._load_strategy_definition("ghost", "v9")


def test_load_strategy_definition_non_list_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """exit_rules 列非 list（被改坏）→ RuntimeError。"""

    _patch_session_scope_with_row(monkeypatch, row=({"not": "a list"},))
    with pytest.raises(RuntimeError, match="not a list"):
        labels_runner._load_strategy_definition("default_exit", "v1")


# ----------------------------------------------------------------------
# compute_labels：scheme 放宽 'strategy-aware__*' 走 strategy_aware 分支
# ----------------------------------------------------------------------

def _rising_quotes_for_runner() -> pd.DataFrame:
    """单只票连涨 40 日（含 high/high_adj），让 strategy_aware 产出 max_hold 标签。"""

    dates = pd.bdate_range("2024-01-02", periods=40).strftime("%Y%m%d").tolist()
    rows = []
    for i, d in enumerate(dates):
        close = 10.0 + i * 0.5
        rows.append(
            {
                "ts_code": "X", "trade_date": d,
                "close": close, "low": close, "high": close,
                "adj_factor": 1.0,
                "close_adj": close, "low_adj": close, "high_adj": close,
            }
        )
    return pd.DataFrame(rows)


def test_compute_labels_named_strategy_scheme_routes_strategy_aware(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """scheme='strategy-aware__tight_exit_v1' 走 strategy_aware 分支并写该 scheme。"""

    quotes = _rising_quotes_for_runner()
    _patch_loaders(monkeypatch, quotes=quotes)

    captured: dict[str, Any] = {}

    def _fake_upsert(rows: list[dict[str, Any]]) -> int:
        captured["rows"] = rows
        return len(rows)

    monkeypatch.setattr(labels_runner, "_upsert_labels", _fake_upsert)

    n = labels_runner.compute_labels(
        scheme="strategy-aware__tight_exit_v1",
        date_range=f"{quotes.iloc[0]['trade_date']}:{quotes.iloc[3]['trade_date']}",
        exit_rules=[
            {"type": "stop_loss", "params": {"pct": 0.05}},
            {"type": "ma_break", "params": {"period": 5}},
            {"type": "max_hold", "params": {"days": 10}},
        ],
    )
    assert n > 0
    assert all(
        r["scheme"] == "strategy-aware__tight_exit_v1" for r in captured["rows"]
    )


def test_compute_labels_unknown_scheme_raises() -> None:
    """非 strategy-aware 系 / 非 fwd 系 scheme → NotImplementedError。"""

    with pytest.raises(NotImplementedError):
        labels_runner.compute_labels(
            scheme="dir3_tercile", date_range="20240102:20240131"
        )


# ----------------------------------------------------------------------
# runner_entrypoint：strategy_id/version → codec scheme + 加载 exit_rules
# ----------------------------------------------------------------------

class _FakeJob:
    def __init__(self, params: dict[str, Any]) -> None:
        self.params = params
        self.id = None


def test_runner_entrypoint_loads_strategy_and_computes_scheme(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """含 strategy_id/version → 用 codec 算 scheme + 加载 exit_rules，透传 compute_labels。"""

    loaded_exit_rules = [
        {"type": "stop_loss", "params": {"pct": 0.05}},
        {"type": "max_hold", "params": {"days": 10}},
    ]
    monkeypatch.setattr(
        labels_runner, "_load_strategy_definition",
        lambda sid, sver: loaded_exit_rules,
    )

    captured: dict[str, Any] = {}

    def _fake_compute(**kwargs: Any) -> int:
        captured.update(kwargs)
        return 1

    monkeypatch.setattr(labels_runner, "compute_labels", _fake_compute)

    job = _FakeJob(
        {
            "date_range": "20240102:20240131",
            "strategy_id": "tight_exit",
            "strategy_version": "v1",
        }
    )
    labels_runner.runner_entrypoint(job)

    assert captured["scheme"] == "strategy-aware__tight_exit_v1"
    assert captured["exit_rules"] == loaded_exit_rules


def test_runner_entrypoint_default_exit_legacy_scheme(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """strategy_id=default_exit@v1 → codec 回 legacy 'strategy-aware'。"""

    monkeypatch.setattr(
        labels_runner, "_load_strategy_definition",
        lambda sid, sver: [{"type": "max_hold", "params": {"days": 20}}],
    )
    captured: dict[str, Any] = {}
    monkeypatch.setattr(
        labels_runner, "compute_labels",
        lambda **kw: captured.update(kw) or 1,
    )

    job = _FakeJob(
        {
            "date_range": "20240102:20240131",
            "strategy_id": "default_exit",
            "strategy_version": "v1",
        }
    )
    labels_runner.runner_entrypoint(job)
    assert captured["scheme"] == "strategy-aware"


def test_runner_entrypoint_bare_scheme_no_exit_rules(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """裸 scheme（无 strategy_id）→ exit_rules=None（走 default_exit）。"""

    captured: dict[str, Any] = {}
    monkeypatch.setattr(
        labels_runner, "compute_labels",
        lambda **kw: captured.update(kw) or 1,
    )
    job = _FakeJob({"scheme": "strategy-aware", "date_range": "20240102:20240131"})
    labels_runner.runner_entrypoint(job)
    assert captured["scheme"] == "strategy-aware"
    assert captured["exit_rules"] is None


# ----------------------------------------------------------------------
# runner_entrypoint：base_type/base_params 路径（expandForTraining 注入）
# ----------------------------------------------------------------------

def test_runner_entrypoint_base_type_fwd_ret_horizon5(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """base_type='fwd_ret', base_params={'horizon':5} → scheme='fwd_5d_ret', exit_rules=None。"""

    captured: dict[str, Any] = {}
    monkeypatch.setattr(
        labels_runner, "compute_labels",
        lambda **kw: captured.update(kw) or 1,
    )
    job = _FakeJob(
        {
            "date_range": "20240102:20240131",
            "base_type": "fwd_ret",
            "base_params": {"horizon": 5},
        }
    )
    labels_runner.runner_entrypoint(job)
    assert captured["scheme"] == "fwd_5d_ret"
    assert captured["exit_rules"] is None


def test_runner_entrypoint_base_type_fwd_ret_horizon1(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """base_type='fwd_ret', base_params={'horizon':1} → scheme='fwd_ret_h1', exit_rules=None。"""

    captured: dict[str, Any] = {}
    monkeypatch.setattr(
        labels_runner, "compute_labels",
        lambda **kw: captured.update(kw) or 1,
    )
    job = _FakeJob(
        {
            "date_range": "20240102:20240131",
            "base_type": "fwd_ret",
            "base_params": {"horizon": 1},
        }
    )
    labels_runner.runner_entrypoint(job)
    assert captured["scheme"] == "fwd_ret_h1"
    assert captured["exit_rules"] is None


def test_runner_entrypoint_base_type_strategy_aware(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """base_type='strategy_aware', base_params 含 strategy_id/version →
    scheme='strategy-aware'（legacy 别名），_load_strategy_definition 被调用，exit_rules 透传。
    """

    loaded_exit_rules = [{"type": "stop_loss", "params": {"pct": 0.08}}]
    load_calls: list[tuple[str, str]] = []

    def _fake_load(sid: str, sver: str) -> list[dict]:
        load_calls.append((sid, sver))
        return loaded_exit_rules

    monkeypatch.setattr(labels_runner, "_load_strategy_definition", _fake_load)

    captured: dict[str, Any] = {}
    monkeypatch.setattr(
        labels_runner, "compute_labels",
        lambda **kw: captured.update(kw) or 1,
    )

    job = _FakeJob(
        {
            "date_range": "20240102:20240131",
            "base_type": "strategy_aware",
            "base_params": {
                "strategy_id": "default_exit",
                "strategy_version": "v1",
            },
        }
    )
    labels_runner.runner_entrypoint(job)

    assert captured["scheme"] == "strategy-aware"
    assert captured["exit_rules"] == loaded_exit_rules
    assert load_calls == [("default_exit", "v1")]


def test_runner_entrypoint_explicit_scheme_takes_priority_over_base_type(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """显式 params.scheme 存在时，base_type 不参与解析（codec 不被调用）。"""

    captured: dict[str, Any] = {}
    monkeypatch.setattr(
        labels_runner, "compute_labels",
        lambda **kw: captured.update(kw) or 1,
    )
    job = _FakeJob(
        {
            "scheme": "strategy-aware",
            "date_range": "20240102:20240131",
            "base_type": "fwd_ret",          # 有显式 scheme → base_type 应被忽略
            "base_params": {"horizon": 5},
        }
    )
    labels_runner.runner_entrypoint(job)
    # 应使用显式 scheme，不被 base_type 覆盖
    assert captured["scheme"] == "strategy-aware"
    assert captured["exit_rules"] is None


def test_runner_entrypoint_no_scheme_no_strategy_no_base_type_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """三者全缺（无 scheme/strategy/base_type）→ ValueError fail-fast。"""

    monkeypatch.setattr(
        labels_runner, "compute_labels",
        lambda **kw: 1,
    )
    job = _FakeJob({"date_range": "20240102:20240131"})
    with pytest.raises(ValueError, match="missing required params"):
        labels_runner.runner_entrypoint(job)
