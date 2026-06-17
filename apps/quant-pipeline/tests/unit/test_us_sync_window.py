"""W1 同步窗口正确性单测（spec 04）：

约束A（end-cap）：
- cap_to_last_closed_session：盘中 → 前一日；收盘后 → 含今日；DST 夏/冬各一例。
- 双保险：抓取序列含「美东当日在长 bar」且未收盘 → 被丢弃；历史日期不丢。

约束B（全量抓取、只写所选窗口 write_start）：
- sync_us_daily_for_ticker / sync_us_index_for_symbol：给短 write_start，
  断言三段 upsert 行 trade_date 均 >= write_start；且这些行指标/pre_close
  与「全量写（write_start=None）」对应日期逐位相等（证明 warmup 在全序列算、切片不改值）。
- 默认 write_start=None → 与改动前行为一致（回归保护）。

全部 mock client / session_scope / upsert_rows / us_session._now_et，不碰真 DB / 真网 / 真时钟。
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime
from unittest import mock
from zoneinfo import ZoneInfo

import pandas as pd
import pytest

from quant_pipeline.sync import us_daily, us_index, us_session
from quant_pipeline.sync.us_daily import sync_us_daily_for_ticker
from quant_pipeline.sync.us_index import sync_us_index_for_symbol
from quant_pipeline.sync.us_session import cap_to_last_closed_session
from quant_pipeline.sync.yahoo_client import UsFetchResult

_ET = ZoneInfo("America/New_York")


# ===========================================================================
# 约束A：cap_to_last_closed_session
# ===========================================================================
def _patch_now(dt: datetime):
    return mock.patch.object(us_session, "_now_et", lambda: dt)


def test_cap_intraday_returns_prev_day_summer_dst() -> None:
    """夏令时（7 月，UTC-4）盘中 14:00 ET（< 16:05）→ 封顶到前一日。"""
    now = datetime(2024, 7, 15, 14, 0, tzinfo=_ET)  # 周一盘中
    with _patch_now(now):
        assert cap_to_last_closed_session("20240715") == "20240714"
        # user_end 在未来同样封顶到今日前一日（盘中）
        assert cap_to_last_closed_session("20241231") == "20240714"


def test_cap_after_close_includes_today_summer_dst() -> None:
    """夏令时收盘后 16:30 ET（>= 16:05）→ 含今日（min(user_end, today)=today）。"""
    now = datetime(2024, 7, 15, 16, 30, tzinfo=_ET)
    with _patch_now(now):
        assert cap_to_last_closed_session("20240715") == "20240715"
        assert cap_to_last_closed_session("20241231") == "20240715"  # 未来 → 封到今日


def test_cap_intraday_winter_dst() -> None:
    """冬令时（1 月，UTC-5）盘中 10:00 ET → 前一日（验证 DST 另一侧）。"""
    now = datetime(2024, 1, 15, 10, 0, tzinfo=_ET)  # 周一盘中
    with _patch_now(now):
        assert cap_to_last_closed_session("20240115") == "20240114"


def test_cap_after_close_winter_dst() -> None:
    """冬令时收盘后 17:00 ET → 含今日。"""
    now = datetime(2024, 1, 15, 17, 0, tzinfo=_ET)
    with _patch_now(now):
        assert cap_to_last_closed_session("20240115") == "20240115"


def test_cap_historical_end_untouched() -> None:
    """user_end 早于今日 → 原样返回（历史窗口不受当前时钟影响）。"""
    now = datetime(2024, 7, 15, 14, 0, tzinfo=_ET)
    with _patch_now(now):
        assert cap_to_last_closed_session("20240601") == "20240601"
        assert cap_to_last_closed_session("20240714") == "20240714"  # 昨日仍原样


def test_cap_boundary_just_before_close() -> None:
    """16:04 ET（< 16:05 缓冲）仍算未收盘 → 前一日。"""
    now = datetime(2024, 7, 15, 16, 4, tzinfo=_ET)
    with _patch_now(now):
        assert cap_to_last_closed_session("20240715") == "20240714"


# ===========================================================================
# 约束A 双保险：抓取序列丢弃「美东当日在长 bar」
# ===========================================================================
def _mk_daily_client(df):
    c = mock.Mock()
    c.fetch_us_daily.return_value = UsFetchResult(df=df, empty_path=None)
    return c


@contextmanager
def _fake_session():
    yield mock.Mock()


def _run_daily_capture(df, *, start, end, write_start=None):
    captured: dict[str, list] = {}

    def _upsert(session, *, table, rows, pk_cols, update_cols):
        captured[table] = rows
        return len(rows)

    with mock.patch.object(us_daily, "session_scope", _fake_session), \
         mock.patch.object(us_daily, "upsert_rows", _upsert), \
         mock.patch.object(
             us_daily, "calc_us_indicators",
             lambda **kw: [{"ma5": float(c)} for c in kw["closes"]]):
        rep = sync_us_daily_for_ticker(
            ticker="AAPL", start_date=start, end_date=end,
            client=_mk_daily_client(df), write_start=write_start,
        )
    return rep, captured


def test_intraday_today_bar_dropped() -> None:
    """抓取序列含美东当日 bar 且今日未收盘 → 该行被丢弃；其余历史行保留。"""
    today = "20240715"
    df = pd.DataFrame({
        "date": ["20240711", "20240712", today],
        "open": [100.0, 110.0, 120.0],
        "high": [101.0, 111.0, 121.0],
        "low": [99.0, 109.0, 119.0],
        "close": [100.0, 110.0, 120.0],
        "volume": [1000.0, 1100.0, 1200.0],
        "adj_close": [100.0, 110.0, 120.0],
    })
    now = datetime(2024, 7, 15, 14, 0, tzinfo=_ET)  # 盘中
    with _patch_now(now):
        rep, captured = _run_daily_capture(df, start="20240101", end="20240731")
    quote = captured["raw.us_daily_quote"]
    assert [r["trade_date"] for r in quote] == ["20240711", "20240712"]
    assert rep.empty_path is None


def test_after_close_today_bar_kept() -> None:
    """今日已收盘 → 当日 bar 保留（双保险只在未收盘才丢）。"""
    today = "20240715"
    df = pd.DataFrame({
        "date": ["20240711", "20240712", today],
        "open": [100.0, 110.0, 120.0],
        "high": [101.0, 111.0, 121.0],
        "low": [99.0, 109.0, 119.0],
        "close": [100.0, 110.0, 120.0],
        "volume": [1000.0, 1100.0, 1200.0],
        "adj_close": [100.0, 110.0, 120.0],
    })
    now = datetime(2024, 7, 15, 16, 30, tzinfo=_ET)  # 收盘后
    with _patch_now(now):
        rep, captured = _run_daily_capture(df, start="20240101", end="20240731")
    quote = captured["raw.us_daily_quote"]
    assert [r["trade_date"] for r in quote] == ["20240711", "20240712", today]


def test_historical_bar_never_dropped_even_intraday() -> None:
    """全是历史日期（无当日 bar）+ 盘中 → 一行不丢（现有历史窗口同步不受双保险影响）。"""
    df = pd.DataFrame({
        "date": ["20240711", "20240712", "20240715"],
        "open": [100.0, 110.0, 120.0],
        "high": [101.0, 111.0, 121.0],
        "low": [99.0, 109.0, 119.0],
        "close": [100.0, 110.0, 120.0],
        "volume": [1000.0, 1100.0, 1200.0],
        "adj_close": [100.0, 110.0, 120.0],
    })
    # 美东今日是 20240718（与序列任何行都不同）→ 双保险无作用
    now = datetime(2024, 7, 18, 14, 0, tzinfo=_ET)
    with _patch_now(now):
        rep, captured = _run_daily_capture(df, start="20240101", end="20240731")
    quote = captured["raw.us_daily_quote"]
    assert [r["trade_date"] for r in quote] == ["20240711", "20240712", "20240715"]


# ===========================================================================
# 约束B：write_start（us_daily）
# ===========================================================================
def _daily_fixture_df():
    """8 行升序日线（足够 pre_close/pct_chg/ma5 有非首行值）。日期全历史，避开双保险。"""
    dates = [f"202403{d:02d}" for d in (1, 4, 5, 6, 7, 8, 11, 12)]
    closes = [100.0, 101.0, 102.5, 101.5, 103.0, 104.0, 103.5, 105.0]
    return pd.DataFrame({
        "date": dates,
        "open": [c - 0.5 for c in closes],
        "high": [c + 1.0 for c in closes],
        "low": [c - 1.0 for c in closes],
        "close": closes,
        "volume": [1_000_000 + i * 1000 for i in range(len(closes))],
        "adj_close": closes,  # adj==close → factor=1，qfq==raw
    })


def _now_far_future():
    """美东时钟设到很远的未来收盘后，使双保险/封顶对历史 fixture 无影响。"""
    return _patch_now(datetime(2030, 1, 2, 17, 0, tzinfo=_ET))


def test_daily_write_start_slices_all_three_tables() -> None:
    """write_start 把三段 upsert（quote/factor/indicator）都切到 >= write_start。"""
    df = _daily_fixture_df()
    write_start = "20240307"
    with _now_far_future():
        rep, captured = _run_daily_capture(
            df, start="20240301", end="20240312", write_start=write_start
        )
    for table in ("raw.us_daily_quote", "raw.us_adj_factor", "raw.us_daily_indicator"):
        rows = captured[table]
        assert rows, f"{table} 不应为空"
        assert all(r["trade_date"] >= write_start for r in rows), f"{table} 含 < write_start 行"
    # 写入窗口 [20240307, 20240312] 应有 4 行（07/08/11/12）
    assert [r["trade_date"] for r in captured["raw.us_daily_quote"]] == \
        ["20240307", "20240308", "20240311", "20240312"]


def test_daily_write_start_values_match_full_window() -> None:
    """切片窗口内各行的 pre_close / pct_chg / ma5 与全量写（write_start=None）逐位相等。

    证明指标/pre_close 在全序列算（warmup 用上了 write_start 之前的行），切片不改值。
    """
    df = _daily_fixture_df()
    write_start = "20240307"
    with _now_far_future():
        _, full = _run_daily_capture(df, start="20240301", end="20240312")
        _, sliced = _run_daily_capture(
            df, start="20240301", end="20240312", write_start=write_start
        )

    full_q = {r["trade_date"]: r for r in full["raw.us_daily_quote"]}
    for r in sliced["raw.us_daily_quote"]:
        td = r["trade_date"]
        assert r["pre_close"] == full_q[td]["pre_close"], f"{td} pre_close 漂移"
        assert r["pct_chg"] == full_q[td]["pct_chg"], f"{td} pct_chg 漂移"

    full_i = {r["trade_date"]: r for r in full["raw.us_daily_indicator"]}
    for r in sliced["raw.us_daily_indicator"]:
        td = r["trade_date"]
        assert r["ma5"] == full_i[td]["ma5"], f"{td} ma5 漂移"

    # 关键回归点：write_start 首行（20240307）的 pre_close 必须 = 前一行(20240306)收盘，
    # 非 None —— 若先切片再算会丢成 NaN/None。
    first = next(r for r in sliced["raw.us_daily_quote"] if r["trade_date"] == "20240307")
    assert first["pre_close"] == pytest.approx(101.5)  # 20240306 close


def test_daily_write_start_none_is_regression_safe() -> None:
    """write_start=None（默认）→ 与不传参完全一致（回归保护）。"""
    df = _daily_fixture_df()
    with _now_far_future():
        _, default_cap = _run_daily_capture(df, start="20240301", end="20240312")
        _, none_cap = _run_daily_capture(
            df, start="20240301", end="20240312", write_start=None
        )
    for table in default_cap:
        assert none_cap[table] == default_cap[table]
    # 默认写入全 8 行
    assert len(default_cap["raw.us_daily_quote"]) == 8


# ===========================================================================
# 约束B：write_start（us_index）
# ===========================================================================
def _mk_index_client(df):
    c = mock.Mock()
    c.fetch_us_index.return_value = UsFetchResult(df=df, empty_path=None)
    return c


def _run_index_capture(df, *, start, end, write_start=None):
    captured: dict[str, list] = {}

    def _upsert(session, *, table, rows, pk_cols, update_cols):
        captured[table] = rows
        return len(rows)

    with mock.patch.object(us_index, "session_scope", _fake_session), \
         mock.patch.object(us_index, "upsert_rows", _upsert), \
         mock.patch.object(
             us_index, "calc_us_indicators",
             lambda **kw: [{"ma5": float(c)} for c in kw["closes"]]):
        rep = sync_us_index_for_symbol(
            index_code=".NDX", start_date=start, end_date=end,
            client=_mk_index_client(df), write_start=write_start,
        )
    return rep, captured


def _index_fixture_df():
    dates = [f"202403{d:02d}" for d in (1, 4, 5, 6, 7, 8, 11, 12)]
    closes = [100.0, 101.0, 102.5, 101.5, 103.0, 104.0, 103.5, 105.0]
    return pd.DataFrame({
        "date": dates,
        "open": [c - 0.5 for c in closes],
        "high": [c + 1.0 for c in closes],
        "low": [c - 1.0 for c in closes],
        "close": closes,
        "volume": [1_000_000 + i * 1000 for i in range(len(closes))],
    })


def test_index_write_start_slices_both_tables() -> None:
    df = _index_fixture_df()
    write_start = "20240307"
    with _now_far_future():
        rep, captured = _run_index_capture(
            df, start="20240301", end="20240312", write_start=write_start
        )
    for table in ("raw.us_index_daily", "raw.us_index_indicator"):
        rows = captured[table]
        assert rows, f"{table} 不应为空"
        assert all(r["trade_date"] >= write_start for r in rows)
    assert [r["trade_date"] for r in captured["raw.us_index_daily"]] == \
        ["20240307", "20240308", "20240311", "20240312"]


def test_index_write_start_values_match_full_window() -> None:
    df = _index_fixture_df()
    write_start = "20240307"
    with _now_far_future():
        _, full = _run_index_capture(df, start="20240301", end="20240312")
        _, sliced = _run_index_capture(
            df, start="20240301", end="20240312", write_start=write_start
        )
    full_i = {r["trade_date"]: r for r in full["raw.us_index_indicator"]}
    for r in sliced["raw.us_index_indicator"]:
        td = r["trade_date"]
        assert r["ma5"] == full_i[td]["ma5"], f"{td} ma5 漂移"


def test_index_write_start_none_is_regression_safe() -> None:
    df = _index_fixture_df()
    with _now_far_future():
        _, default_cap = _run_index_capture(df, start="20240301", end="20240312")
        _, none_cap = _run_index_capture(
            df, start="20240301", end="20240312", write_start=None
        )
    for table in default_cap:
        assert none_cap[table] == default_cap[table]
    assert len(default_cap["raw.us_index_daily"]) == 8


# ===========================================================================
# orchestrator write_start 透传
# ===========================================================================
def test_run_us_sync_passes_write_start() -> None:
    from quant_pipeline.sync import us_orchestrator as orch
    from quant_pipeline.sync.us_daily import UsDailyReport

    with mock.patch.object(orch, "list_tracked_tickers", return_value=["AAPL", "MSFT"]), \
         mock.patch.object(
             orch, "sync_us_daily_for_ticker",
             return_value=UsDailyReport(ticker="X", quote_rows=1)) as fetch_mock:
        orch.run_us_sync(
            job_id=None, date_range="20240101:20240331",
            client=mock.Mock(), write_start="20240301",
        )
    for call in fetch_mock.call_args_list:
        assert call.kwargs["write_start"] == "20240301"
        assert call.kwargs["start_date"] == "20240101"  # 抓取仍全窗口
        assert call.kwargs["end_date"] == "20240331"


def test_run_us_sync_default_write_start_none() -> None:
    from quant_pipeline.sync import us_orchestrator as orch
    from quant_pipeline.sync.us_daily import UsDailyReport

    with mock.patch.object(orch, "list_tracked_tickers", return_value=["AAPL"]), \
         mock.patch.object(
             orch, "sync_us_daily_for_ticker",
             return_value=UsDailyReport(ticker="X", quote_rows=1)) as fetch_mock:
        orch.run_us_sync(job_id=None, date_range="20240101:20240331", client=mock.Mock())
    assert fetch_mock.call_args.kwargs["write_start"] is None


def test_run_us_index_sync_passes_write_start() -> None:
    from quant_pipeline.sync import us_index_orchestrator as orch
    from quant_pipeline.sync.us_index import UsIndexReport

    with mock.patch.object(
        orch, "sync_us_index_for_symbol",
        return_value=UsIndexReport(index_code=".NDX", rows=1),
    ) as fetch_mock:
        orch.run_us_index_sync(
            job_id=None, date_range="20240101:20240331",
            client=mock.Mock(), write_start="20240301",
        )
    assert fetch_mock.call_args.kwargs["write_start"] == "20240301"
    assert fetch_mock.call_args.kwargs["start_date"] == "20240101"


def test_run_us_index_amv_sync_write_start_drives_amv_window_not_fetch() -> None:
    """AMV orchestrator：write_start 驱动 AMV 写窗口(compute.start)+warmup 起点，
    但成分抓取仍全史（不传 write_start 给 sync_us_daily_for_ticker）。"""
    from quant_pipeline.sync import us_index_amv_orchestrator as orch
    from quant_pipeline.sync.us_daily import UsDailyReport

    amv_report = mock.Mock()
    amv_report.amv_rows = 5
    with mock.patch.object(orch, "load_constituents", return_value=["AAPL", "MSFT"]), \
         mock.patch.object(orch, "resolve_warmup_start", return_value="20231201") as warm_mock, \
         mock.patch.object(
             orch, "sync_us_daily_for_ticker",
             return_value=UsDailyReport(ticker="X", quote_rows=1, factor_empty=False)) as fetch_mock, \
         mock.patch.object(orch, "compute_and_write_amv", return_value=amv_report) as compute_mock:
        orch.run_us_index_amv_sync(
            job_id=None, date_range="20240101:20240331",
            client=mock.Mock(), write_start="20240301",
        )
    # warmup 从写窗口起点(20240301)往前推，不是 date_range start(20240101)
    assert warm_mock.call_args.args[1] == "20240301"
    # AMV 写窗口 start = write_start；fetch_start = warmup 结果
    assert compute_mock.call_args.kwargs["start"] == "20240301"
    assert compute_mock.call_args.kwargs["fetch_start"] == "20231201"
    # 成分抓取仍全史：start_date = fetch_start，且**不传** write_start（保持全史写库）
    for call in fetch_mock.call_args_list:
        assert call.kwargs["start_date"] == "20231201"
        assert call.kwargs["end_date"] == "20240331"
        assert "write_start" not in call.kwargs


def test_run_us_index_amv_sync_default_uses_date_range_start() -> None:
    """write_start=None → AMV 写窗口 = date_range start（现有 us_index_amv 行为不变）。"""
    from quant_pipeline.sync import us_index_amv_orchestrator as orch
    from quant_pipeline.sync.us_daily import UsDailyReport

    amv_report = mock.Mock()
    amv_report.amv_rows = 5
    with mock.patch.object(orch, "load_constituents", return_value=["AAPL"]), \
         mock.patch.object(orch, "resolve_warmup_start", return_value="20231201") as warm_mock, \
         mock.patch.object(
             orch, "sync_us_daily_for_ticker",
             return_value=UsDailyReport(ticker="X", quote_rows=1, factor_empty=False)), \
         mock.patch.object(orch, "compute_and_write_amv", return_value=amv_report) as compute_mock:
        orch.run_us_index_amv_sync(
            job_id=None, date_range="20240101:20240331", client=mock.Mock(),
        )
    assert warm_mock.call_args.args[1] == "20240101"
    assert compute_mock.call_args.kwargs["start"] == "20240101"
