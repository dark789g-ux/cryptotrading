"""fina_indicator sync 模块单测（强制 ann_date PIT 入库）。"""

from __future__ import annotations

from unittest.mock import MagicMock

import pandas as pd

from quant_pipeline.sync import fina_indicator as mod
from quant_pipeline.sync.tushare_client import FetchResult


class _ctx:
    def __init__(self, sess: MagicMock) -> None:
        self.sess = sess

    def __enter__(self) -> MagicMock:
        return self.sess

    def __exit__(self, *exc: object) -> None:
        return None


def test_sync_fina_indicator_ok_uses_ann_date_in_pk(monkeypatch) -> None:
    fake_sess = MagicMock()
    monkeypatch.setattr(mod, "session_scope", lambda: _ctx(fake_sess))

    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(
            [
                {
                    "ts_code": "600000.SH",
                    "ann_date": "20180830",
                    "end_date": "20180630",
                    "eps": 0.95,
                    "roe": 6.5,
                    "update_flag": "1",
                },
                {
                    "ts_code": "600000.SH",
                    "ann_date": "20180428",
                    "end_date": "20180331",
                    "eps": 0.46,
                    "roe": 3.2,
                    "update_flag": "0",
                },
            ]
        ),
        empty_path=None,
        api_name="fina_indicator",
        params={"ts_code": "600000.SH"},
    )

    rep = mod.sync_fina_indicator_by_ts_code(ts_code="600000.SH", client=client)
    assert rep.empty_path is None
    assert rep.rows_upserted == 2

    # 验证 SQL 是用 ann_date 在 PK 内（不能只用 end_date）
    call_args = fake_sess.execute.call_args
    sql_text = str(call_args.args[0])
    assert "ann_date" in sql_text
    assert "ON CONFLICT (ts_code, end_date, ann_date)" in sql_text

    # indicators jsonb 必须含 eps / roe
    rows_param = call_args.args[1]
    assert len(rows_param) == 2
    import json

    indicators = json.loads(rows_param[0]["indicators"])
    assert "eps" in indicators
    assert "roe" in indicators
    # PK 三列不应进 indicators
    assert "ann_date" not in indicators
    assert "end_date" not in indicators
    assert "ts_code" not in indicators


def test_sync_fina_indicator_drops_rows_with_null_ann_date(monkeypatch) -> None:
    fake_sess = MagicMock()
    monkeypatch.setattr(mod, "session_scope", lambda: _ctx(fake_sess))

    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(
            [
                {
                    "ts_code": "600000.SH",
                    "ann_date": None,  # 必丢
                    "end_date": "20180630",
                    "eps": 0.95,
                },
                {
                    "ts_code": "600000.SH",
                    "ann_date": "20180428",
                    "end_date": "20180331",
                    "eps": 0.46,
                },
            ]
        ),
        empty_path=None,
        api_name="fina_indicator",
        params={"ts_code": "600000.SH"},
    )

    rep = mod.sync_fina_indicator_by_ts_code(ts_code="600000.SH", client=client)
    assert rep.empty_path is None
    assert rep.rows_upserted == 1


def test_sync_fina_indicator_items_empty() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(),
        empty_path="items_empty",
        api_name="fina_indicator",
        params={"ts_code": "600000.SH"},
    )
    rep = mod.sync_fina_indicator_by_ts_code(ts_code="600000.SH", client=client)
    assert rep.empty_path == "items_empty"
    assert rep.rows_upserted == 0


def test_sync_fina_indicator_data_null() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(),
        empty_path="data_null",
        api_name="fina_indicator",
        params={"ts_code": "600000.SH"},
    )
    rep = mod.sync_fina_indicator_by_ts_code(ts_code="600000.SH", client=client)
    assert rep.empty_path == "data_null"


def test_sync_fina_indicator_code_nonzero() -> None:
    client = MagicMock()
    client.fetch.return_value = FetchResult(
        df=pd.DataFrame(),
        empty_path="code_nonzero",
        api_name="fina_indicator",
        params={"ts_code": "600000.SH"},
    )
    rep = mod.sync_fina_indicator_by_ts_code(ts_code="600000.SH", client=client)
    assert rep.empty_path == "code_nonzero"
