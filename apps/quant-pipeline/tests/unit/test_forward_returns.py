"""A1 · training/forward_returns.load_forward_returns 单测。

DB 用桩 session（_FakeSession），不连线上。覆盖：
  · 真实次日后复权收益正确 join（r = close_adj(t+1)/close_adj(t)−1）
  · 取不到 t+1 的样本（停牌 / 末日）不进 dict + 双路径 warn
  · DB 0 行 → 空 dict + warn（路径①）
  · 后复权基准为窗口内 max(adj_factor)，与 _common.apply_hfq 一致
"""

from __future__ import annotations

import logging

import pytest

from quant_pipeline.training import forward_returns
from quant_pipeline.training.forward_returns import load_forward_returns


class _FakeResult:
    def __init__(self, rows: list[tuple]) -> None:
        self._rows = rows

    def fetchall(self) -> list[tuple]:
        return self._rows


class _FakeSession:
    """桩 session：按 SQL 文本路由到 daily_quote / trade_cal 返回值。"""

    def __init__(self, *, quotes: list[tuple], cal_dates: list[str]) -> None:
        self._quotes = quotes
        self._cal_dates = cal_dates
        self.calls: list[dict] = []

    def execute(self, sql, params):  # noqa: ANN001
        text = str(sql)
        self.calls.append({"sql": text, "params": params})
        if "raw.trade_cal" in text:
            limit = params.get("limit", len(self._cal_dates))
            end = params["end"]
            after = [d for d in self._cal_dates if d > end][:limit]
            return _FakeResult([(d,) for d in after])
        # daily_quote 查询：行 = (ts_code, trade_date, close, adj_factor)
        codes = set(params["codes"])
        start, end = params["start"], params["end"]
        rows = [
            r
            for r in self._quotes
            if r[0] in codes and start <= r[1] <= end
        ]
        return _FakeResult(rows)


# adj_factor 恒定 → close_adj = close（窗口 max 基准约掉），r 直接由 close 比值算。
_QUOTES = [
    # (ts_code, trade_date, close, adj_factor)
    ("000001.SZ", "20260105", 10.0, 1.0),
    ("000001.SZ", "20260106", 11.0, 1.0),
    ("000001.SZ", "20260107", 12.0, 1.0),
    ("000002.SZ", "20260105", 20.0, 2.0),
    ("000002.SZ", "20260106", 22.0, 2.0),
]
_CAL = ["20260105", "20260106", "20260107", "20260108"]


def _session() -> _FakeSession:
    return _FakeSession(quotes=_QUOTES, cal_dates=_CAL)


def test_load_forward_returns_correct_join() -> None:
    pairs = [
        ("000001.SZ", "20260105"),
        ("000001.SZ", "20260106"),
        ("000002.SZ", "20260105"),
    ]
    out = load_forward_returns(pairs, session=_session())
    # r = close(t+1)/close(t) − 1（adj_factor 恒定 → close_adj 比值 == close 比值）
    assert out[("000001.SZ", "20260105")] == pytest.approx(11.0 / 10.0 - 1.0)
    assert out[("000001.SZ", "20260106")] == pytest.approx(12.0 / 11.0 - 1.0)
    assert out[("000002.SZ", "20260105")] == pytest.approx(22.0 / 20.0 - 1.0)


def test_last_day_sample_excluded(caplog: pytest.LogCaptureFixture) -> None:
    """每票末日（无 t+1）样本不进 dict + 路径②部分缺失 warn。"""

    pairs = [
        ("000001.SZ", "20260107"),  # 末日，无 t+1
        ("000002.SZ", "20260106"),  # 末日，无 t+1
        ("000001.SZ", "20260105"),  # 有 t+1
    ]
    with caplog.at_level(logging.WARNING, logger="quant_pipeline.training.forward_returns"):
        out = load_forward_returns(pairs, session=_session())
    assert ("000001.SZ", "20260107") not in out
    assert ("000002.SZ", "20260106") not in out
    assert ("000001.SZ", "20260105") in out
    assert any("forward_returns_partial_missing" in r.message for r in caplog.records)


def test_db_empty_returns_empty_and_warns(caplog: pytest.LogCaptureFixture) -> None:
    """DB 0 行 → 空 dict + 路径① warn（不静默吞）。"""

    empty_session = _FakeSession(quotes=[], cal_dates=_CAL)
    with caplog.at_level(logging.WARNING, logger="quant_pipeline.training.forward_returns"):
        out = load_forward_returns([("000001.SZ", "20260105")], session=empty_session)
    assert out == {}
    assert any("forward_returns_db_empty" in r.message for r in caplog.records)


def test_empty_pairs_short_circuit() -> None:
    assert load_forward_returns([], session=_session()) == {}


def test_hfq_basis_uses_window_max_adj_factor() -> None:
    """后复权用窗口 max(adj_factor)；r 对基准不敏感（基准在比值中约掉）。"""

    quotes = [
        ("600000.SH", "20260105", 10.0, 1.5),
        ("600000.SH", "20260106", 12.0, 3.0),  # adj_factor 翻倍
    ]
    sess = _FakeSession(quotes=quotes, cal_dates=_CAL)
    out = load_forward_returns([("600000.SH", "20260105")], session=sess)
    # close_adj(t)   = 10 * 1.5 / 3.0 = 5.0
    # close_adj(t+1) = 12 * 3.0 / 3.0 = 12.0
    # r = 12.0 / 5.0 − 1 = 1.4
    assert out[("600000.SH", "20260105")] == pytest.approx(12.0 / 5.0 - 1.0)


def test_missing_quote_for_t_excluded() -> None:
    """请求样本在 DB 无对应行 → 不进 dict（由调用方填 NaN）。"""

    out = load_forward_returns(
        [("999999.SZ", "20260105")], session=_session()
    )
    assert out == {}


def test_session_scope_used_when_session_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """session=None 时走 session_scope()（用 monkeypatch 桩，不连真实 DB）。"""

    import contextlib

    fake = _session()

    @contextlib.contextmanager
    def _fake_scope():
        yield fake

    monkeypatch.setattr(forward_returns, "session_scope", _fake_scope)
    out = load_forward_returns([("000001.SZ", "20260105")], session=None)
    assert out[("000001.SZ", "20260105")] == pytest.approx(11.0 / 10.0 - 1.0)
