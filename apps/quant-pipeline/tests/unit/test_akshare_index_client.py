"""AkShareClient.fetch_us_index 三条路径单测（不连真实 akshare）。

mock akshare.index_us_stock_sina，验证：
- df=None        → empty_path="data_null"
- df=[](空 DF)   → empty_path="items_empty"
- 持续抛异常     → 重试耗尽后 raise
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pandas as pd
import pytest

from quant_pipeline.sync.akshare_client import AkShareClient


def _make_client() -> AkShareClient:
    # min_interval=0 关闭限频；max_attempts=2 收敛重试耗尽用例
    return AkShareClient(min_interval_ms=0, max_attempts=2)


def test_fetch_us_index_data_null() -> None:
    client = _make_client()
    with patch("akshare.index_us_stock_sina", return_value=None) as mocked:
        res = client.fetch_us_index(".NDX")
    assert res.df is None
    assert res.empty_path == "data_null"
    # symbol 透传
    mocked.assert_called_with(symbol=".NDX")


def test_fetch_us_index_items_empty() -> None:
    client = _make_client()
    with patch("akshare.index_us_stock_sina", return_value=pd.DataFrame()):
        res = client.fetch_us_index(".NDX")
    assert res.df is None
    assert res.empty_path == "items_empty"


def test_fetch_us_index_normal_returns_df() -> None:
    client = _make_client()
    df = pd.DataFrame(
        {
            "date": ["2026-06-15"],
            "open": [30289.0],
            "high": [30587.0],
            "low": [30100.0],
            "close": [30543.0],
            "volume": [1311956880],
            "amount": [0],
        }
    )
    with patch("akshare.index_us_stock_sina", return_value=df):
        res = client.fetch_us_index(".NDX")
    assert res.empty_path is None
    assert res.df is not None
    assert list(res.df.columns) == [
        "date", "open", "high", "low", "close", "volume", "amount"
    ]


def test_fetch_us_index_retry_exhausted_raises() -> None:
    client = _make_client()  # max_attempts=2
    calls = {"n": 0}

    def _boom(**_params: Any) -> Any:
        calls["n"] += 1
        raise RuntimeError("simulated akshare network error")

    with patch("akshare.index_us_stock_sina", side_effect=_boom):
        with pytest.raises(RuntimeError, match="simulated akshare network error"):
            client.fetch_us_index(".NDX")
    # 重试耗尽：调用次数 == max_attempts
    assert calls["n"] == 2
