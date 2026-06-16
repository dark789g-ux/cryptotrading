"""sync.us_index.sync_us_index_for_symbol 单测（mock client + 不触 DB）。

覆盖：
- empty_path 透出（data_null）
- window_empty（裁窗后 0 行）
- 正常路径：mock upsert_rows 验证幂等调 2 表（daily + indicator）、
  conflict 键正确、固定 OHLC fixture 下 calc_us_indicators 关键值非空。
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pandas as pd

from quant_pipeline.sync import us_index as mod
from quant_pipeline.sync.akshare_client import UsFetchResult


class _ctx:
    """假 session_scope 上下文管理器（不连真实 DB）。"""

    def __init__(self, sess: MagicMock) -> None:
        self.sess = sess

    def __enter__(self) -> MagicMock:
        return self.sess

    def __exit__(self, *exc: object) -> None:
        return None


def _ohlc_df() -> pd.DataFrame:
    """造一段 8 行升序 OHLC（足够 KDJ/MACD/MA5 出非空值）。

    date 用 datetime.date 风格的 'YYYY-MM-DD' 字符串（akshare 实测 date 列为
    datetime.date，pd.to_datetime 兼容两者；此处用字符串便于断言）。
    """
    dates = [
        "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05",
        "2026-06-06", "2026-06-09", "2026-06-10", "2026-06-11",
    ]
    closes = [100.0, 101.0, 102.5, 101.5, 103.0, 104.0, 103.5, 105.0]
    opens = [c - 0.5 for c in closes]
    highs = [c + 1.0 for c in closes]
    lows = [c - 1.0 for c in closes]
    vols = [1_000_000 + i * 1000 for i in range(len(closes))]
    return pd.DataFrame(
        {
            "date": dates,
            "open": opens,
            "high": highs,
            "low": lows,
            "close": closes,
            "volume": vols,
            "amount": [0] * len(closes),
        }
    )


def test_data_null_path_passthrough() -> None:
    client = MagicMock()
    client.fetch_us_index.return_value = UsFetchResult(df=None, empty_path="data_null")

    rep = mod.sync_us_index_for_symbol(
        index_code=".NDX", start_date="20100101", end_date="20261231", client=client
    )

    assert rep.empty_path == "data_null"
    assert rep.rows == 0
    assert rep.indicator_rows == 0
    client.fetch_us_index.assert_called_once_with(".NDX")


def test_window_empty_path() -> None:
    client = MagicMock()
    client.fetch_us_index.return_value = UsFetchResult(df=_ohlc_df(), empty_path=None)

    # 窗口完全错开数据（数据是 2026-06，窗口选 2020 年）→ 裁切后 0 行
    rep = mod.sync_us_index_for_symbol(
        index_code=".NDX", start_date="20200101", end_date="20201231", client=client
    )

    assert rep.empty_path == "window_empty"
    assert rep.rows == 0
    assert rep.indicator_rows == 0


def test_normal_path_upserts_two_tables_idempotent(monkeypatch) -> None:
    fake_sess = MagicMock()
    monkeypatch.setattr(mod, "session_scope", lambda: _ctx(fake_sess))

    client = MagicMock()
    client.fetch_us_index.return_value = UsFetchResult(df=_ohlc_df(), empty_path=None)

    with patch("quant_pipeline.sync.us_index.upsert_rows", return_value=8) as upsert_mock:
        rep = mod.sync_us_index_for_symbol(
            index_code=".NDX", start_date="20100101", end_date="20261231", client=client
        )

    assert rep.empty_path is None
    assert rep.rows == 8
    assert rep.indicator_rows == 8

    # 幂等：恰好两次 upsert（daily + indicator）
    assert upsert_mock.call_count == 2
    daily_call, indicator_call = upsert_mock.call_args_list

    # daily 表：conflict (index_code, trade_date)，列只含 OHLCV（无复权/无 amount）
    assert daily_call.kwargs["table"] == "raw.us_index_daily"
    assert daily_call.kwargs["pk_cols"] == ("index_code", "trade_date")
    assert daily_call.kwargs["update_cols"] == ("open", "high", "low", "close", "volume")
    daily_rows = daily_call.kwargs["rows"]
    assert len(daily_rows) == 8
    assert set(daily_rows[0].keys()) == {
        "index_code", "trade_date", "open", "high", "low", "close", "volume"
    }
    # trade_date 已规整为 YYYYMMDD
    assert daily_rows[0]["trade_date"] == "20260602"
    assert daily_rows[-1]["trade_date"] == "20260611"

    # indicator 表：conflict (index_code, trade_date)，含 17 指标键
    assert indicator_call.kwargs["table"] == "raw.us_index_indicator"
    assert indicator_call.kwargs["pk_cols"] == ("index_code", "trade_date")
    indic_rows = indicator_call.kwargs["rows"]
    assert len(indic_rows) == 8


def test_normal_path_indicator_values_non_null(monkeypatch) -> None:
    """固定 OHLC fixture 下，末行 ma5/kdj_j/macd 关键值非空。"""
    fake_sess = MagicMock()
    monkeypatch.setattr(mod, "session_scope", lambda: _ctx(fake_sess))

    client = MagicMock()
    client.fetch_us_index.return_value = UsFetchResult(df=_ohlc_df(), empty_path=None)

    captured: dict[str, list] = {}

    def _capture(_session, *, table, rows, **_kw):
        captured[table] = list(rows)
        return len(captured[table])

    with patch("quant_pipeline.sync.us_index.upsert_rows", side_effect=_capture):
        mod.sync_us_index_for_symbol(
            index_code=".NDX", start_date="20100101", end_date="20261231", client=client
        )

    indic_rows = captured["raw.us_index_indicator"]
    last = indic_rows[-1]
    # 8 行 ≥ 5 → ma5 非空；KDJ/MACD 自首行起即有值
    assert last["ma5"] is not None
    assert last["kdj_j"] is not None
    assert last["macd"] is not None
    # 该行包含全部 17 个指标键
    from quant_pipeline.sync.us_indicators import INDICATOR_KEYS
    assert set(INDICATOR_KEYS).issubset(set(last.keys()))
