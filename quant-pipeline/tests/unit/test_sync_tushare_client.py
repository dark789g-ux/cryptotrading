"""TuShare client 三种空数据 warn 双写单测。

mock pro_api 工厂，确保不连真实 TuShare；
mock warn_with_quality_report 验证 rule + empty_path 落入 ml.quality_reports。
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pandas as pd

from quant_pipeline.sync.tushare_client import (
    EMPTY_PATH_CODE_NONZERO,
    EMPTY_PATH_DATA_NULL,
    EMPTY_PATH_ITEMS_EMPTY,
    TushareClient,
)


class _FakePro:
    """假 pro_api：按构造时指定的策略返回值。"""

    def __init__(self, behavior: str, df: pd.DataFrame | None = None) -> None:
        self.behavior = behavior
        self.df = df
        self.calls = 0

    # 当 method 名 == 接口名时，TushareClient 直接走 getattr
    def trade_cal(self, **params: Any) -> Any:
        self.calls += 1
        if self.behavior == "ok":
            return self.df
        if self.behavior == "data_null":
            return None
        if self.behavior == "items_empty":
            return pd.DataFrame()
        if self.behavior == "exception":
            raise RuntimeError("simulated tushare error")
        raise AssertionError(self.behavior)


def _make_client(fake: _FakePro) -> TushareClient:
    return TushareClient(
        token="dummy",
        min_interval_seconds=0.0,
        max_retries=2,
        pro_api_factory=lambda _t: fake,
    )


def test_fetch_normal_returns_df_no_warn() -> None:
    df = pd.DataFrame(
        [
            {"exchange": "SSE", "cal_date": "20240102", "is_open": 1, "pretrade_date": "20231229"},
        ]
    )
    fake = _FakePro("ok", df)
    client = _make_client(fake)

    with patch("quant_pipeline.sync.tushare_client.warn_with_quality_report") as warn_mock:
        result = client.fetch("trade_cal", exchange="SSE", start_date="20240101", end_date="20240105")

    assert result.empty_path is None
    assert len(result.df) == 1
    assert result.api_name == "trade_cal"
    warn_mock.assert_not_called()


def test_fetch_data_null_warns_with_data_null_path() -> None:
    """模拟 pro_api 返回 None（极少见但 tushare 偶发）。

    本路径与 code_nonzero 区分：未抛异常，直接返回 None。
    """

    # 用 monkeypatched fake：让 trade_cal 返回 None
    fake = _FakePro("data_null")
    client = _make_client(fake)

    with patch("quant_pipeline.sync.tushare_client.warn_with_quality_report") as warn_mock:
        result = client.fetch("trade_cal", exchange="SSE", trade_date="20240102")

    assert result.empty_path == EMPTY_PATH_DATA_NULL
    assert result.df.empty
    warn_mock.assert_called_once()
    kwargs = warn_mock.call_args.kwargs
    assert kwargs["rule"] == "trade_cal_empty"
    assert kwargs["detail"]["empty_path"] == EMPTY_PATH_DATA_NULL
    assert kwargs["detail"]["api_name"] == "trade_cal"
    assert kwargs["trade_date"] == "20240102"


def test_fetch_items_empty_warns_with_items_empty_path() -> None:
    fake = _FakePro("items_empty")
    client = _make_client(fake)

    with patch("quant_pipeline.sync.tushare_client.warn_with_quality_report") as warn_mock:
        result = client.fetch("trade_cal", exchange="SSE", trade_date="20240102")

    assert result.empty_path == EMPTY_PATH_ITEMS_EMPTY
    assert result.df.empty
    warn_mock.assert_called_once()
    kwargs = warn_mock.call_args.kwargs
    assert kwargs["rule"] == "trade_cal_empty"
    assert kwargs["detail"]["empty_path"] == EMPTY_PATH_ITEMS_EMPTY


def test_fetch_code_nonzero_after_retries_warns() -> None:
    fake = _FakePro("exception")
    client = _make_client(fake)

    with patch("quant_pipeline.sync.tushare_client.warn_with_quality_report") as warn_mock:
        result = client.fetch(
            "trade_cal",
            exchange="SSE",
            trade_date="20240102",
        )

    assert result.empty_path == EMPTY_PATH_CODE_NONZERO
    assert result.df.empty
    # 经过 max_retries=2 次重试
    assert fake.calls == 2
    warn_mock.assert_called_once()
    kwargs = warn_mock.call_args.kwargs
    assert kwargs["rule"] == "trade_cal_empty"
    assert kwargs["detail"]["empty_path"] == EMPTY_PATH_CODE_NONZERO
    assert "error" in kwargs["detail"]


def test_trade_date_inferred_for_quality_report() -> None:
    """trade_date_for_quality 缺省时，client 应该从常见日期参数推断。"""

    fake = _FakePro("items_empty")
    client = _make_client(fake)

    with patch("quant_pipeline.sync.tushare_client.warn_with_quality_report") as warn_mock:
        client.fetch("trade_cal", exchange="SSE", trade_date="20240315")
    assert warn_mock.call_args.kwargs["trade_date"] == "20240315"

    with patch("quant_pipeline.sync.tushare_client.warn_with_quality_report") as warn_mock:
        client.fetch("trade_cal", exchange="SSE", cal_date="20240315")
    assert warn_mock.call_args.kwargs["trade_date"] == "20240315"

    with patch("quant_pipeline.sync.tushare_client.warn_with_quality_report") as warn_mock:
        client.fetch("fina_indicator", ts_code="600000.SH", ann_date="20240315")
    assert warn_mock.call_args.kwargs["trade_date"] == "20240315"
