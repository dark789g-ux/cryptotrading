"""YahooClient 单测：mock urllib（禁打真实网络）。

覆盖：列归一化小写 + adj_close 透出 + date=YYYYMMDD；.NDX→^NDX 映射 + 指数无
adj_close；空数据双路径(data_null/items_empty)；网络异常重试耗尽 raise；
period1/period2 由 start/end 正确拼装（含 end_date 当天）。
"""

from __future__ import annotations

import json
import urllib.error
from unittest import mock

import pytest

from quant_pipeline.sync.yahoo_client import UsFetchResult, YahooClient

# 已知 epoch：1704067200 = 2024-01-01T00:00:00Z，1735689600 = 2025-01-01T00:00:00Z
_TS_20240102 = 1704153600  # 2024-01-01 +1d
_TS_20240103 = 1704240000  # +2d


def _resp(body: dict):
    """构造支持 with-context 的伪响应对象（.read() 返回 JSON bytes）。"""

    class _R:
        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

        def read(self):
            return json.dumps(body).encode("utf-8")

    return _R()


def _daily_body():
    return {
        "chart": {
            "error": None,
            "result": [
                {
                    "timestamp": [_TS_20240102, _TS_20240103],
                    "indicators": {
                        "quote": [
                            {
                                "open": [1.0, 2.0],
                                "high": [1.5, 2.5],
                                "low": [0.9, 1.9],
                                "close": [1.2, 2.2],
                                "volume": [100, 200],
                            }
                        ],
                        "adjclose": [{"adjclose": [1.1, 2.1]}],
                    },
                }
            ],
        }
    }


def _client():
    # min_interval_ms=0 关限频；max_attempts 默认 3
    return YahooClient(min_interval_ms=0)


def test_fetch_us_daily_columns_and_values():
    with mock.patch(
        "quant_pipeline.sync.yahoo_client.urllib.request.urlopen",
        return_value=_resp(_daily_body()),
    ):
        res = _client().fetch_us_daily("AAPL", "20240102", "20240103")
    assert isinstance(res, UsFetchResult)
    assert res.empty_path is None
    df = res.df
    assert list(df.columns) == ["date", "open", "high", "low", "close", "volume", "adj_close"]
    assert df["date"].tolist() == ["20240102", "20240103"]
    assert df["close"].tolist() == [1.2, 2.2]
    assert df["adj_close"].tolist() == [1.1, 2.1]
    assert df["volume"].tolist() == [100.0, 200.0]


def test_fetch_us_daily_period_args_inclusive_end():
    captured = {}

    def _spy(req, *a, **k):
        captured["url"] = req.full_url
        return _resp(_daily_body())

    with mock.patch(
        "quant_pipeline.sync.yahoo_client.urllib.request.urlopen", side_effect=_spy
    ):
        _client().fetch_us_daily("AAPL", "20250102", "20250103")
    # period1 = 2025-01-02 00:00Z = 1735776000；period2 = end+1d = 2025-01-04 00:00Z = 1735948800
    assert "period1=1735776000" in captured["url"]
    assert "period2=1735948800" in captured["url"]
    assert "interval=1d" in captured["url"]


def test_fetch_us_index_symbol_mapping_and_no_adjclose():
    body = {
        "chart": {
            "error": None,
            "result": [
                {
                    "timestamp": [_TS_20240102],
                    "indicators": {
                        "quote": [
                            {
                                "open": [100.0],
                                "high": [101.0],
                                "low": [99.0],
                                "close": [100.5],
                                "volume": [0],
                            }
                        ]
                    },
                }
            ],
        }
    }
    captured = {}

    def _spy(req, *a, **k):
        captured["url"] = req.full_url
        return _resp(body)

    with mock.patch(
        "quant_pipeline.sync.yahoo_client.urllib.request.urlopen", side_effect=_spy
    ):
        res = _client().fetch_us_index(".NDX", "20240102", "20240102")
    # ^NDX 经 quote(safe='') → %5ENDX
    assert "%5ENDX" in captured["url"]
    assert res.empty_path is None
    assert "adj_close" not in res.df.columns
    assert list(res.df.columns) == ["date", "open", "high", "low", "close", "volume"]


def test_empty_data_null_on_error():
    body = {"chart": {"error": {"code": "Not Found", "description": "No data found"}, "result": None}}
    with mock.patch(
        "quant_pipeline.sync.yahoo_client.urllib.request.urlopen",
        return_value=_resp(body),
    ):
        res = _client().fetch_us_daily("BADSYM", "20240102", "20240103")
    assert res.df is None
    assert res.empty_path == "data_null"


def test_empty_items_empty_on_no_timestamp():
    body = {"chart": {"error": None, "result": [{"timestamp": [], "indicators": {}}]}}
    with mock.patch(
        "quant_pipeline.sync.yahoo_client.urllib.request.urlopen",
        return_value=_resp(body),
    ):
        res = _client().fetch_us_daily("AAPL", "20240102", "20240103")
    assert res.df is None
    assert res.empty_path == "items_empty"


def test_network_error_retries_exhausted_raises():
    with mock.patch(
        "quant_pipeline.sync.yahoo_client.urllib.request.urlopen",
        side_effect=urllib.error.URLError("boom"),
    ), mock.patch("quant_pipeline.sync.yahoo_client.time.sleep"):
        with pytest.raises(urllib.error.URLError):
            YahooClient(min_interval_ms=0, max_attempts=2).fetch_us_daily(
                "AAPL", "20240102", "20240103"
            )
