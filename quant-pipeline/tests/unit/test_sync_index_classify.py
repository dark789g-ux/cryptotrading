"""index_classify sync 模块单测。"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pandas as pd

from quant_pipeline.sync import index_classify as mod
from quant_pipeline.sync.tushare_client import FetchResult


class _ctx:
    def __init__(self, sess: MagicMock) -> None:
        self.sess = sess

    def __enter__(self) -> MagicMock:
        return self.sess

    def __exit__(self, *exc: object) -> None:
        return None


def test_sync_index_classify_ok(monkeypatch) -> None:
    fake_sess = MagicMock()
    monkeypatch.setattr(mod, "session_scope", lambda: _ctx(fake_sess))

    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(
            [
                {
                    "index_code": "801010.SI",
                    "industry_name": "农林牧渔",
                    "parent_code": "0",
                    "level": "L1",
                    "industry_code": "110000",
                }
            ]
        ),
        empty_path=None,
        api_name="index_classify",
        params={"src": "SW2021", "level": "L1"},
    )

    with patch("quant_pipeline.sync.index_classify.upsert_rows", return_value=1) as upsert_mock:
        reports = mod.sync_index_classify(combos=(("SW2021", "L1"),), client=client)

    assert len(reports) == 1
    assert reports[0].empty_path is None
    kw = upsert_mock.call_args.kwargs
    assert kw["pk_cols"] == ("src", "index_code")
    # src 应该被补齐到行内
    assert kw["rows"][0]["src"] == "SW2021"


def test_sync_index_classify_data_null() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(),
        empty_path="data_null",
        api_name="index_classify",
        params={"src": "SW2021", "level": "L1"},
    )
    with patch("quant_pipeline.sync.index_classify.upsert_rows") as upsert_mock:
        reports = mod.sync_index_classify(combos=(("SW2021", "L1"),), client=client)
    upsert_mock.assert_not_called()
    assert reports[0].empty_path == "data_null"


def test_sync_index_classify_items_empty() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(),
        empty_path="items_empty",
        api_name="index_classify",
        params={"src": "SW2021", "level": "L1"},
    )
    with patch("quant_pipeline.sync.index_classify.upsert_rows") as upsert_mock:
        reports = mod.sync_index_classify(combos=(("SW2021", "L1"),), client=client)
    upsert_mock.assert_not_called()
    assert reports[0].empty_path == "items_empty"


def test_sync_index_classify_code_nonzero() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(),
        empty_path="code_nonzero",
        api_name="index_classify",
        params={"src": "SW2021", "level": "L1"},
    )
    with patch("quant_pipeline.sync.index_classify.upsert_rows") as upsert_mock:
        reports = mod.sync_index_classify(combos=(("SW2021", "L1"),), client=client)
    upsert_mock.assert_not_called()
    assert reports[0].empty_path == "code_nonzero"
