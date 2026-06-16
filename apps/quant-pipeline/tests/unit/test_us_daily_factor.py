"""us_daily 因子改造单测：

- factor = adj_close / close（乘法、恒正）；qfq = raw × factor / 最新factor，
  末日 adj==close 锚定 → qfq 列等于 adj_close、末日 qfq==close；
- raw 行情列写**未复权原始值**（AMV 依赖）；
- guard：adj_close 含非正 → factor_empty=True、qfq 列全 None、不写 factor/indicator。

mock client + session_scope + upsert_rows + calc_us_indicators（不碰真 DB / 真网）。
"""

from __future__ import annotations

from contextlib import contextmanager
from unittest import mock

import pandas as pd
import pytest

from quant_pipeline.sync import us_daily
from quant_pipeline.sync.us_daily import sync_us_daily_for_ticker
from quant_pipeline.sync.yahoo_client import UsFetchResult


def _mk_client(df):
    c = mock.Mock()
    c.fetch_us_daily.return_value = UsFetchResult(df=df, empty_path=None)
    return c


@contextmanager
def _fake_session():
    yield mock.Mock()


def _run_capture(df):
    captured: dict[str, list] = {}

    def _upsert(session, *, table, rows, pk_cols, update_cols):
        captured[table] = rows
        return len(rows)

    with mock.patch.object(us_daily, "session_scope", _fake_session), \
         mock.patch.object(us_daily, "upsert_rows", _upsert), \
         mock.patch.object(
             us_daily, "calc_us_indicators",
             lambda **kw: [{"ma5": None} for _ in range(len(kw["closes"]))]):
        rep = sync_us_daily_for_ticker(
            ticker="AVGO", start_date="20240101", end_date="20240105",
            client=_mk_client(df),
        )
    return rep, captured


def test_factor_multiplicative_and_qfq_anchored():
    df = pd.DataFrame({
        "date": ["20240102", "20240103", "20240104"],
        "open": [100.0, 110.0, 120.0],
        "high": [101.0, 111.0, 121.0],
        "low": [99.0, 109.0, 119.0],
        "close": [100.0, 110.0, 120.0],
        "volume": [1000.0, 1100.0, 1200.0],
        "adj_close": [99.0, 109.0, 120.0],  # 末日 adj==close → 锚定 latest factor=1
    })
    rep, captured = _run_capture(df)
    assert rep.factor_empty is False

    quote = captured["raw.us_daily_quote"]
    # raw 行情列写未复权原始值
    assert [r["close"] for r in quote] == [100.0, 110.0, 120.0]
    assert [r["volume"] for r in quote] == [1000.0, 1100.0, 1200.0]
    # qfq = raw × (adj/raw) / 最新factor；末日 factor=1 → qfq 列 == adj_close
    qfq_c = [r["qfq_close"] for r in quote]
    assert qfq_c == pytest.approx([99.0, 109.0, 120.0])
    assert qfq_c[-1] == pytest.approx(quote[-1]["close"])  # 末日锚定 qfq==close
    # adj_factor 表写乘法因子
    factor = captured["raw.us_adj_factor"]
    assert [r["adj_factor"] for r in factor] == pytest.approx([0.99, 109 / 110, 1.0])


def test_guard_nonpositive_adjclose_degrades_to_factor_empty():
    df = pd.DataFrame({
        "date": ["20240102", "20240103"],
        "open": [100.0, 110.0], "high": [101.0, 111.0], "low": [99.0, 109.0],
        "close": [100.0, 110.0], "volume": [1000.0, 1100.0],
        "adj_close": [-1.0, 110.0],  # 负 adj_close → factor<0 → 一票否决
    })
    rep, captured = _run_capture(df)
    assert rep.factor_empty is True
    quote = captured["raw.us_daily_quote"]
    assert all(r["qfq_close"] is None for r in quote)
    # factor_empty 时提前 return：不写 factor / indicator 表
    assert "raw.us_adj_factor" not in captured
    assert "raw.us_daily_indicator" not in captured
    # 但 raw 行情列仍写（未复权）
    assert [r["close"] for r in quote] == [100.0, 110.0]
