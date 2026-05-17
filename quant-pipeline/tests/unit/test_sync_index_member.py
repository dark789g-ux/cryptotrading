"""index_member sync 模块单测（接口名为 index_member_all）。"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pandas as pd

from quant_pipeline.sync import index_member as mod
from quant_pipeline.sync.tushare_client import FetchResult


class _ctx:
    def __init__(self, sess: MagicMock) -> None:
        self.sess = sess

    def __enter__(self) -> MagicMock:
        return self.sess

    def __exit__(self, *exc: object) -> None:
        return None


def test_sync_index_member_ok(monkeypatch) -> None:
    fake_sess = MagicMock()
    monkeypatch.setattr(mod, "session_scope", lambda: _ctx(fake_sess))

    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(
            [
                {
                    "l1_code": "801050.SI",
                    "l1_name": "有色金属",
                    "l2_code": "801053.SI",
                    "l2_name": "贵金属",
                    "l3_code": "850531.SI",
                    "l3_name": "黄金",
                    "ts_code": "600547.SH",
                    "name": "山东黄金",
                    "in_date": "20030826",
                    "out_date": None,
                    "is_new": "Y",
                }
            ]
        ),
        empty_path=None,
        api_name="index_member_all",
        params={"l1_code": "801050.SI"},
    )

    with patch("quant_pipeline.sync.index_member.upsert_rows", return_value=1) as upsert_mock:
        reports = mod.sync_index_member(l1_codes=("801050.SI",), client=client)

    assert len(reports) == 1
    assert reports[0].empty_path is None
    kw = upsert_mock.call_args.kwargs
    assert kw["pk_cols"] == ("l3_code", "ts_code", "in_date")
    assert kw["table"] == "raw.index_member"
    # 接口名严格按文档：index_member_all
    assert reports[0].api_name == "index_member_all"


def test_sync_index_member_items_empty() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(),
        empty_path="items_empty",
        api_name="index_member_all",
        params={"l1_code": "801050.SI"},
    )
    with patch("quant_pipeline.sync.index_member.upsert_rows") as upsert_mock:
        reports = mod.sync_index_member(l1_codes=("801050.SI",), client=client)
    upsert_mock.assert_not_called()
    assert reports[0].empty_path == "items_empty"


def test_sync_index_member_data_null() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(),
        empty_path="data_null",
        api_name="index_member_all",
        params={"l1_code": "801050.SI"},
    )
    with patch("quant_pipeline.sync.index_member.upsert_rows") as upsert_mock:
        reports = mod.sync_index_member(l1_codes=("801050.SI",), client=client)
    upsert_mock.assert_not_called()
    assert reports[0].empty_path == "data_null"


def test_sync_index_member_code_nonzero() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(),
        empty_path="code_nonzero",
        api_name="index_member_all",
        params={"l1_code": "801050.SI"},
    )
    with patch("quant_pipeline.sync.index_member.upsert_rows") as upsert_mock:
        reports = mod.sync_index_member(l1_codes=("801050.SI",), client=client)
    upsert_mock.assert_not_called()
    assert reports[0].empty_path == "code_nonzero"
