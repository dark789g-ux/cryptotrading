"""suspend_d sync 模块单测。"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pandas as pd

from quant_pipeline.sync import suspend as mod
from quant_pipeline.sync.tushare_client import FetchResult


class _ctx:
    def __init__(self, sess: MagicMock) -> None:
        self.sess = sess

    def __enter__(self) -> MagicMock:
        return self.sess

    def __exit__(self, *exc: object) -> None:
        return None


def test_sync_suspend_ok(monkeypatch) -> None:
    fake_sess = MagicMock()
    monkeypatch.setattr(mod, "session_scope", lambda: _ctx(fake_sess))

    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(
            [
                {
                    "ts_code": "000029.SZ",
                    "trade_date": "20240315",
                    "suspend_timing": None,
                    "suspend_type": "S",
                },
                {
                    "ts_code": "000029.SZ",
                    "trade_date": "20240315",
                    "suspend_timing": None,
                    "suspend_type": "R",
                },
            ]
        ),
        empty_path=None,
        api_name="suspend_d",
        params={"trade_date": "20240315"},
    )

    with patch("quant_pipeline.sync.suspend.upsert_rows", return_value=2) as upsert_mock:
        rep = mod.sync_suspend_by_date(trade_date="20240315", client=client)

    assert rep.empty_path is None
    assert rep.rows_upserted == 2
    kw = upsert_mock.call_args.kwargs
    assert kw["pk_cols"] == ("ts_code", "trade_date", "suspend_type")


def test_sync_suspend_data_null() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(),
        empty_path="data_null",
        api_name="suspend_d",
        params={"trade_date": "20240315"},
    )
    rep = mod.sync_suspend_by_date(trade_date="20240315", client=client)
    assert rep.empty_path == "data_null"
    assert rep.rows_upserted == 0


def test_sync_suspend_items_empty() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(),
        empty_path="items_empty",
        api_name="suspend_d",
        params={"trade_date": "20240315"},
    )
    rep = mod.sync_suspend_by_date(trade_date="20240315", client=client)
    assert rep.empty_path == "items_empty"


def test_sync_suspend_code_nonzero() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(),
        empty_path="code_nonzero",
        api_name="suspend_d",
        params={"trade_date": "20240315"},
    )
    rep = mod.sync_suspend_by_date(trade_date="20240315", client=client)
    assert rep.empty_path == "code_nonzero"
