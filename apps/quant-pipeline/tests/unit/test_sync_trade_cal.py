"""trade_cal sync 模块单测。

mock TushareClient 与 session_scope：
- 正常路径：DataFrame 入参 → upsert_rows 被调用
- 三种空数据：FetchResult.empty_path 非 None → 不调 upsert，SyncReport 含 empty_path
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pandas as pd
import pytest

from quant_pipeline.sync import trade_cal as mod
from quant_pipeline.sync.tushare_client import FetchResult


def _fake_result_ok() -> FetchResult:
    df = pd.DataFrame(
        [
            {"exchange": "SSE", "cal_date": "20240102", "is_open": 1, "pretrade_date": "20231229"},
            {"exchange": "SSE", "cal_date": "20240103", "is_open": 1, "pretrade_date": "20240102"},
        ]
    )
    return FetchResult(df=df, empty_path=None, api_name="trade_cal", params={})


@pytest.fixture
def fake_session(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    fake_sess = MagicMock()
    monkeypatch.setattr(
        mod,
        "session_scope",
        lambda: _ctx(fake_sess),
    )
    return fake_sess


class _ctx:
    def __init__(self, sess: MagicMock) -> None:
        self.sess = sess

    def __enter__(self) -> MagicMock:
        return self.sess

    def __exit__(self, *exc: object) -> None:
        return None


def test_sync_trade_cal_ok_calls_upsert(fake_session: MagicMock) -> None:
    client = MagicMock()
    client.fetch.return_value = _fake_result_ok()

    with patch("quant_pipeline.sync.trade_cal.upsert_rows", return_value=2) as upsert_mock:
        reports = mod.sync_trade_cal(
            start_date="20240101",
            end_date="20240105",
            exchanges=("SSE",),
            client=client,
        )

    assert len(reports) == 1
    assert reports[0].empty_path is None
    assert reports[0].rows_upserted == 2
    upsert_mock.assert_called_once()
    # 确认 PK 与 update_cols 正确
    kwargs = upsert_mock.call_args.kwargs
    assert kwargs["table"] == "raw.trade_cal"
    assert kwargs["pk_cols"] == ("exchange", "cal_date")
    assert kwargs["update_cols"] == ("is_open", "pretrade_date")
    assert len(kwargs["rows"]) == 2


def test_sync_trade_cal_data_null_skips_upsert() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(), empty_path="data_null", api_name="trade_cal", params={}
    )

    with patch("quant_pipeline.sync.trade_cal.upsert_rows") as upsert_mock:
        reports = mod.sync_trade_cal(
            start_date="20240101",
            end_date="20240105",
            exchanges=("SSE",),
            client=client,
        )

    upsert_mock.assert_not_called()
    assert len(reports) == 1
    assert reports[0].empty_path == "data_null"
    assert reports[0].rows_upserted == 0


def test_sync_trade_cal_items_empty_skips_upsert() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(), empty_path="items_empty", api_name="trade_cal", params={}
    )

    with patch("quant_pipeline.sync.trade_cal.upsert_rows") as upsert_mock:
        reports = mod.sync_trade_cal(
            start_date="20240101",
            end_date="20240105",
            exchanges=("SSE",),
            client=client,
        )

    upsert_mock.assert_not_called()
    assert reports[0].empty_path == "items_empty"


def test_sync_trade_cal_code_nonzero_skips_upsert() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(), empty_path="code_nonzero", api_name="trade_cal", params={}
    )

    with patch("quant_pipeline.sync.trade_cal.upsert_rows") as upsert_mock:
        reports = mod.sync_trade_cal(
            start_date="20240101",
            end_date="20240105",
            exchanges=("SSE",),
            client=client,
        )

    upsert_mock.assert_not_called()
    assert reports[0].empty_path == "code_nonzero"
