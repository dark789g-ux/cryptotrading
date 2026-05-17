"""stk_limit sync 模块单测。"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pandas as pd
import pytest

from quant_pipeline.sync import stk_limit as mod
from quant_pipeline.sync.tushare_client import FetchResult


class _ctx:
    def __init__(self, sess: MagicMock) -> None:
        self.sess = sess

    def __enter__(self) -> MagicMock:
        return self.sess

    def __exit__(self, *exc: object) -> None:
        return None


@pytest.fixture
def fake_session(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    fake_sess = MagicMock()
    monkeypatch.setattr(mod, "session_scope", lambda: _ctx(fake_sess))
    return fake_sess


def test_sync_stk_limit_ok(fake_session: MagicMock) -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(
            [
                {
                    "ts_code": "000001.SZ",
                    "trade_date": "20240315",
                    "pre_close": 12.34,
                    "up_limit": 13.57,
                    "down_limit": 11.11,
                }
            ]
        ),
        empty_path=None,
        api_name="stk_limit",
        params={"trade_date": "20240315"},
    )

    with patch("quant_pipeline.sync.stk_limit.upsert_rows", return_value=1) as upsert_mock:
        rep = mod.sync_stk_limit_by_date(trade_date="20240315", client=client)

    assert rep.empty_path is None
    assert rep.rows_upserted == 1
    upsert_mock.assert_called_once()
    kw = upsert_mock.call_args.kwargs
    assert kw["table"] == "raw.stk_limit"
    assert kw["pk_cols"] == ("ts_code", "trade_date")


def test_sync_stk_limit_items_empty() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(),
        empty_path="items_empty",
        api_name="stk_limit",
        params={"trade_date": "20240315"},
    )
    with patch("quant_pipeline.sync.stk_limit.upsert_rows") as upsert_mock:
        rep = mod.sync_stk_limit_by_date(trade_date="20240315", client=client)
    upsert_mock.assert_not_called()
    assert rep.empty_path == "items_empty"
    assert rep.rows_upserted == 0


def test_sync_stk_limit_data_null() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(),
        empty_path="data_null",
        api_name="stk_limit",
        params={"trade_date": "20240315"},
    )
    with patch("quant_pipeline.sync.stk_limit.upsert_rows") as upsert_mock:
        rep = mod.sync_stk_limit_by_date(trade_date="20240315", client=client)
    upsert_mock.assert_not_called()
    assert rep.empty_path == "data_null"


def test_sync_stk_limit_code_nonzero() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(),
        empty_path="code_nonzero",
        api_name="stk_limit",
        params={"trade_date": "20240315"},
    )
    with patch("quant_pipeline.sync.stk_limit.upsert_rows") as upsert_mock:
        rep = mod.sync_stk_limit_by_date(trade_date="20240315", client=client)
    upsert_mock.assert_not_called()
    assert rep.empty_path == "code_nonzero"
