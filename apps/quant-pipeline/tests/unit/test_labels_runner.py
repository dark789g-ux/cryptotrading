"""labels/runner.py 单测。

覆盖 spec 04 §item-10 空数据硬约束：
  - quotes 为空 → compute_labels 抛 RuntimeError
  - labels_df 为空 → compute_labels 抛 RuntimeError
外加 spec 2026-06-06 量化策略管理：
  - _load_strategy_definition 命中返回 exit_rules / 缺行 raise RuntimeError
  - compute_labels scheme 放宽到 'strategy-aware__*' 走 strategy_aware 分支
  - runner_entrypoint 含 strategy_id/version → 加载 exit_rules + codec 算 scheme
通过 monkeypatch 替换 _load_* DB IO 函数，不接触真实 DB。
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any

import pandas as pd
import pytest

from quant_pipeline.labels import runner as labels_runner
from quant_pipeline.strategy.exit_rules import MA_WINDOW


def _empty_quotes() -> pd.DataFrame:
    return pd.DataFrame(
        columns=["ts_code", "trade_date", "close", "low", "high",
                 "adj_factor", "close_adj", "low_adj", "high_adj"]
    )


def _patch_loaders(
    monkeypatch: pytest.MonkeyPatch,
    *,
    quotes: pd.DataFrame,
) -> None:
    """把全部 DB IO（_load_* / 缺口查询 / trade_cal）替成内存 fake。

    增量缺口循环（spec 02）默认会 query_materialized_dates / query_trading_days /
    _compute_g0_load（trade_cal）。为让现有"整段"测试逐行复现改造前行为，这里把
    已物化集合置空、trading_days 置 [start, end] 两端点 → gap_subranges 必回单一
    子区间 (start, end)，等价整段重算；_compute_g0_load 退化为返回 g0（不回看）。
    """

    monkeypatch.setattr(labels_runner, "_compute_end_padded", lambda end: end)
    monkeypatch.setattr(labels_runner, "_compute_g0_load", lambda g0, hp, start: g0)
    # bug5：_load_daily_quotes 新增 head_rows_per_code（keyword-only，默认 0）。
    monkeypatch.setattr(
        labels_runner, "_load_daily_quotes",
        lambda s, e, head_rows_per_code=0: quotes,
    )
    monkeypatch.setattr(
        labels_runner, "_load_stk_limit",
        lambda s, e: pd.DataFrame(columns=["ts_code", "trade_date", "up_limit", "down_limit"]),
    )
    monkeypatch.setattr(
        labels_runner, "_load_suspend",
        lambda s, e: pd.DataFrame(columns=["ts_code", "trade_date"]),
    )
    monkeypatch.setattr(
        labels_runner, "_load_listing_info",
        lambda: (
            pd.DataFrame(columns=["ts_code", "list_date"]),
            pd.DataFrame(columns=["ts_code", "delist_date"]),
        ),
    )
    # 全局交易日历（窗口无关 new_listing 计数）：listing 为空时 filter_new_listing
    # 短路、日历值不影响结果，返回 quotes 自身日期作占位。
    monkeypatch.setattr(
        labels_runner, "_load_trade_calendar",
        lambda: sorted(quotes["trade_date"].astype(str).unique().tolist()),
    )
    # 增量缺口查询：已物化置空 + trading_days=[start,end] → 单一子区间 (start,end)。
    monkeypatch.setattr(labels_runner, "session_scope", _noop_session_scope)
    monkeypatch.setattr(
        labels_runner, "query_materialized_dates",
        lambda s, table, col, val, start, end: set(),
    )
    monkeypatch.setattr(
        labels_runner, "query_trading_days",
        lambda s, start, end: [start, end],
    )


@contextmanager
def _noop_session_scope() -> Any:
    """labels_runner.session_scope 的内存替身（不接触真实 DB）。"""

    yield None


def test_compute_labels_raises_on_empty_quotes(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_loaders(monkeypatch, quotes=_empty_quotes())
    with pytest.raises(RuntimeError, match="no daily_quote rows"):
        labels_runner.compute_labels(
            scheme="strategy-aware", date_range="20240102:20240131"
        )


def test_compute_labels_raises_on_empty_labels(monkeypatch: pytest.MonkeyPatch) -> None:
    """quotes 非空但全部候选被过滤光 → compute_* 输出空 → RuntimeError。"""

    # 单只票，但未传 listing/delist；entries 全部触发新股过滤前需有候选 —— 这里
    # 构造 quotes 只有 1 天，simulate_exit 无法形成有效交易 → 输出空。
    quotes = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "trade_date": "20240102",
             "close": 10.0, "low": 9.8, "adj_factor": 1.0,
             "close_adj": 10.0, "low_adj": 9.8},
        ]
    )
    _patch_loaders(monkeypatch, quotes=quotes)
    with pytest.raises(RuntimeError, match="produced 0 rows"):
        labels_runner.compute_labels(
            scheme="strategy-aware", date_range="20240102:20240102"
        )


# ----------------------------------------------------------------------
# _load_strategy_definition：命中 / 缺行
# ----------------------------------------------------------------------

def _patch_session_scope_with_row(
    monkeypatch: pytest.MonkeyPatch, *, row: Any
) -> None:
    """把 labels_runner.session_scope 替换成返回固定 fetchone() 结果的 fake。"""

    class _FakeSession:
        def execute(self, _sql: Any, _params: Any) -> _FakeSession:
            return self

        def fetchone(self) -> Any:
            return row

    @contextmanager
    def _fake_scope() -> Any:
        yield _FakeSession()

    monkeypatch.setattr(labels_runner, "session_scope", _fake_scope)


def test_load_strategy_definition_hit(monkeypatch: pytest.MonkeyPatch) -> None:
    """命中 → 返回 exit_rules（jsonb → list[dict]）。"""

    exit_rules = [
        {"type": "stop_loss", "params": {"pct": 0.08}},
        {"type": "max_hold", "params": {"days": 20}},
    ]
    _patch_session_scope_with_row(monkeypatch, row=(exit_rules,))
    out = labels_runner._load_strategy_definition("default_exit", "v1")
    assert out == exit_rules


def test_load_strategy_definition_missing_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """缺行（fetchone()=None）→ RuntimeError（fail-fast，禁静默吞错）。"""

    _patch_session_scope_with_row(monkeypatch, row=None)
    with pytest.raises(RuntimeError, match="not found"):
        labels_runner._load_strategy_definition("ghost", "v9")


def test_load_strategy_definition_non_list_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """exit_rules 列非 list（被改坏）→ RuntimeError。"""

    _patch_session_scope_with_row(monkeypatch, row=({"not": "a list"},))
    with pytest.raises(RuntimeError, match="not a list"):
        labels_runner._load_strategy_definition("default_exit", "v1")


# ----------------------------------------------------------------------
# compute_labels：scheme 放宽 'strategy-aware__*' 走 strategy_aware 分支
# ----------------------------------------------------------------------

def _rising_quotes_for_runner() -> pd.DataFrame:
    """单只票连涨 40 日（含 high/high_adj），让 strategy_aware 产出 max_hold 标签。"""

    dates = pd.bdate_range("2024-01-02", periods=40).strftime("%Y%m%d").tolist()
    rows = []
    for i, d in enumerate(dates):
        close = 10.0 + i * 0.5
        rows.append(
            {
                "ts_code": "X", "trade_date": d,
                "close": close, "low": close, "high": close,
                "adj_factor": 1.0,
                "close_adj": close, "low_adj": close, "high_adj": close,
            }
        )
    return pd.DataFrame(rows)


def test_compute_labels_named_strategy_scheme_routes_strategy_aware(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """scheme='strategy-aware__tight_exit_v1' 走 strategy_aware 分支并写该 scheme。"""

    quotes = _rising_quotes_for_runner()
    _patch_loaders(monkeypatch, quotes=quotes)

    captured: dict[str, Any] = {}

    def _fake_upsert(rows: list[dict[str, Any]]) -> int:
        captured["rows"] = rows
        return len(rows)

    monkeypatch.setattr(labels_runner, "_upsert_labels", _fake_upsert)

    n = labels_runner.compute_labels(
        scheme="strategy-aware__tight_exit_v1",
        date_range=f"{quotes.iloc[0]['trade_date']}:{quotes.iloc[3]['trade_date']}",
        exit_rules=[
            {"type": "stop_loss", "params": {"pct": 0.05}},
            {"type": "ma_break", "params": {"period": 5}},
            {"type": "max_hold", "params": {"days": 10}},
        ],
    )
    assert n > 0
    assert all(
        r["scheme"] == "strategy-aware__tight_exit_v1" for r in captured["rows"]
    )


def test_compute_labels_unknown_scheme_raises() -> None:
    """非 strategy-aware 系 / 非 fwd 系 scheme → NotImplementedError。"""

    with pytest.raises(NotImplementedError):
        labels_runner.compute_labels(
            scheme="dir3_tercile", date_range="20240102:20240131"
        )


# ----------------------------------------------------------------------
# helper：_resolve_ma_window（头部 padding 所需 ma_window 解析）
# ----------------------------------------------------------------------

def test_resolve_ma_window_non_strategy_aware_none() -> None:
    """非 strategy_aware（fwd_ret 系）→ None（无 MA，head_pad=0）。"""

    assert labels_runner._resolve_ma_window(
        is_strategy_aware=False, exit_rules=None
    ) is None
    assert labels_runner._resolve_ma_window(
        is_strategy_aware=False,
        exit_rules=[{"type": "ma_break", "params": {"period": 10}}],
    ) is None


def test_resolve_ma_window_strategy_aware_default() -> None:
    """strategy_aware 且 exit_rules=None → 默认 MA_WINDOW(5)。"""

    assert labels_runner._resolve_ma_window(
        is_strategy_aware=True, exit_rules=None
    ) == MA_WINDOW


def test_resolve_ma_window_strategy_aware_ma_break_period() -> None:
    """strategy_aware 且含 ma_break → 取该规则 period。"""

    rules = [
        {"type": "stop_loss", "params": {"pct": 0.05}},
        {"type": "ma_break", "params": {"period": 12}},
        {"type": "max_hold", "params": {"days": 10}},
    ]
    assert labels_runner._resolve_ma_window(
        is_strategy_aware=True, exit_rules=rules
    ) == 12


def test_resolve_ma_window_strategy_aware_no_ma_break_none() -> None:
    """strategy_aware 但 exit_rules 无 ma_break → None（MA 全 NaN，head_pad=0）。"""

    rules = [
        {"type": "stop_loss", "params": {"pct": 0.05}},
        {"type": "max_hold", "params": {"days": 10}},
    ]
    assert labels_runner._resolve_ma_window(
        is_strategy_aware=True, exit_rules=rules
    ) is None


# ----------------------------------------------------------------------
# helper：_compute_g0_load（缺口子区间头部 padding）
# ----------------------------------------------------------------------

def _patch_trade_cal_desc(
    monkeypatch: pytest.MonkeyPatch, *, dates_desc: list[str]
) -> None:
    """把 session_scope().execute().fetchall() 替成返回固定降序 cal_date 行。

    _compute_g0_load 用 `cal_date < g0 ORDER BY cal_date DESC LIMIT head_pad`，
    取 rows[-1] 作"g0 之前第 head_pad 个交易日"。dates_desc 模拟这批降序行。
    """

    class _FakeSession:
        def execute(self, _sql: Any, _params: Any) -> _FakeSession:
            return self

        def fetchall(self) -> list[tuple[str]]:
            return [(d,) for d in dates_desc]

    @contextmanager
    def _fake_scope() -> Any:
        yield _FakeSession()

    monkeypatch.setattr(labels_runner, "session_scope", _fake_scope)


def test_compute_g0_load_head_pad_zero_returns_g0() -> None:
    """head_pad<=0（fwd_ret / 无 ma_break）→ 直接返回 g0，不查 trade_cal。"""

    assert labels_runner._compute_g0_load("20240110", 0, "20240101") == "20240110"


def test_compute_g0_load_clamps_to_start(monkeypatch: pytest.MonkeyPatch) -> None:
    """回看落到 start 之前 → clamp 到 start。"""

    # g0 之前第 4 个交易日（rows[-1]）是 20231228（< start=20240101）→ clamp 到 start。
    _patch_trade_cal_desc(
        monkeypatch,
        dates_desc=["20240102", "20240101", "20231229", "20231228"],
    )
    out = labels_runner._compute_g0_load("20240108", 4, "20240101")
    assert out == "20240101"


def test_compute_g0_load_returns_padded_date(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """回看落在 start 之后 → 返回 g0 之前第 head_pad 个交易日（rows[-1]）。"""

    _patch_trade_cal_desc(
        monkeypatch,
        dates_desc=["20240109", "20240108", "20240105", "20240104"],
    )
    out = labels_runner._compute_g0_load("20240110", 4, "20240101")
    assert out == "20240104"


# ----------------------------------------------------------------------
# _load_daily_quotes：head_rows_per_code（bug5 —— 停牌股 MA 窗口依赖修复）
# ----------------------------------------------------------------------

def _patch_session_main_head(
    monkeypatch: pytest.MonkeyPatch,
    *,
    main_rows: list[tuple],
    head_rows: list[tuple],
    seen: dict[str, Any],
) -> None:
    """假 session：按 params 区分 _load_daily_quotes 的主窗口/head 两条查询。

    主窗口 params 仅含 {start,end}；head 查询 params 含 'head_rows' 键。fetchall()
    据最近一次 execute 的查询类型返回对应行。seen 记录是否查过 head（断言用）。
    """

    seen.setdefault("head_queried", False)
    seen.setdefault("head_rows_param", None)

    class _FakeSession:
        def __init__(self) -> None:
            self._is_head = False

        def execute(self, _sql: Any, params: Any) -> "_FakeSession":
            self._is_head = "head_rows" in params
            if self._is_head:
                seen["head_queried"] = True
                seen["head_rows_param"] = params["head_rows"]
            return self

        def fetchall(self) -> list[tuple]:
            return list(head_rows) if self._is_head else list(main_rows)

    @contextmanager
    def _fake_scope() -> Any:
        yield _FakeSession()

    monkeypatch.setattr(labels_runner, "session_scope", _fake_scope)


def test_load_daily_quotes_head_rows_included(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """head_rows_per_code>0 → 查 head 查询并把 start 前在场行并入结果（含 close_adj）。

    模拟停牌股 002499.SZ：主窗口 [20230223,20230331] 内首行才 20230327（停牌缺行），
    head 查询补回 start 前最近 4 个在场行（20230202/0201/0131/0130）。
    """

    # 列序与 _load_daily_quotes SQL 一致：(ts_code, trade_date, open, close, low, high, adj_factor)
    # （band_lock scheme 需 raw open → SQL 增取 q.open；本 fixture 同步加 open 列）。
    main_rows = [
        ("002499.SZ", "20230327", 1.69, 1.70, 1.68, 1.72, 2.575),
        ("002499.SZ", "20230328", 1.71, 1.72, 1.70, 1.74, 2.575),
    ]
    head_rows = [
        ("002499.SZ", "20230202", 1.67, 1.68, 1.66, 1.70, 2.575),
        ("002499.SZ", "20230201", 1.75, 1.76, 1.74, 1.78, 2.575),
        ("002499.SZ", "20230131", 1.67, 1.68, 1.66, 1.70, 2.575),
        ("002499.SZ", "20230130", 1.59, 1.60, 1.58, 1.62, 2.575),
    ]
    seen: dict[str, Any] = {}
    _patch_session_main_head(
        monkeypatch, main_rows=main_rows, head_rows=head_rows, seen=seen
    )

    df = labels_runner._load_daily_quotes(
        "20230223", "20230331", head_rows_per_code=4
    )

    assert seen["head_queried"] is True
    assert seen["head_rows_param"] == 4
    dates = set(df["trade_date"].astype(str))
    # 主窗口 2 行 + head 4 行全在
    assert {"20230327", "20230328", "20230202", "20230201", "20230131", "20230130"} <= dates
    assert len(df) == 6
    # close_adj 逐行注入（close × adj_factor）
    row = df.loc[df["trade_date"] == "20230202"].iloc[0]
    assert abs(float(row["close_adj"]) - 1.68 * 2.575) < 1e-9
    # 全局升序（拼接后重排契约）
    assert list(df["trade_date"].astype(str)) == sorted(df["trade_date"].astype(str))


def test_load_daily_quotes_no_head_query_when_zero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """head_rows_per_code=0（fwd 路径）→ 不发 head 查询，结果仅主窗口（行为不变）。"""

    # 列序：(ts_code, trade_date, open, close, low, high, adj_factor)（SQL 增取 q.open）。
    main_rows = [
        ("X", "20240102", 9.9, 10.0, 9.8, 10.2, 1.0),
        ("X", "20240103", 10.4, 10.5, 10.3, 10.7, 1.0),
    ]
    seen: dict[str, Any] = {}
    _patch_session_main_head(
        monkeypatch, main_rows=main_rows, head_rows=[("Y", "20231229", 1, 1, 1, 1, 1)],
        seen=seen,
    )

    df = labels_runner._load_daily_quotes("20240102", "20240103")

    assert seen["head_queried"] is False
    assert set(df["trade_date"].astype(str)) == {"20240102", "20240103"}
    assert "Y" not in set(df["ts_code"].astype(str))


# ----------------------------------------------------------------------
# compute_labels：增量缺口循环（force / gap / padding / 只写缺口 / log）
# ----------------------------------------------------------------------

def _shift_back(day: str, n: int) -> str:
    """把 YYYYMMDD 往前挪 n 个自然日（仅供测试模拟头部 padding 落点，非交易日历）。"""

    ts = pd.Timestamp(day) - pd.Timedelta(days=n)
    return ts.strftime("%Y%m%d")


def _fwd_quotes_over(dates: list[str]) -> pd.DataFrame:
    """单票，覆盖给定交易日；供 fwd_5d_ret 增量测试用。"""

    rows = []
    for i, d in enumerate(dates):
        close = 10.0 + i
        rows.append(
            {"ts_code": "X", "trade_date": d, "close": close, "low": close,
             "high": close, "adj_factor": 1.0,
             "close_adj": close, "low_adj": close, "high_adj": close}
        )
    return pd.DataFrame(rows)


def _patch_incremental_loaders(
    monkeypatch: pytest.MonkeyPatch,
    *,
    quotes: pd.DataFrame,
    materialized: set[str],
    trading_days: list[str],
    calls: dict[str, Any],
) -> None:
    """增量场景 fake：可控 materialized / trading_days，记录关键入参。

    calls 会被填入：
      - 'daily_quotes_starts'：每次 _load_daily_quotes 收到的 start 参数
      - 'upserted'：每次 _upsert_labels 收到的 rows（list[dict]）
      - 'compute_g0_load_calls'：_compute_g0_load 收到的 (g0, head_pad, start)
    """

    calls.setdefault("daily_quotes_starts", [])
    calls.setdefault("daily_quotes_head_rows", [])
    calls.setdefault("upserted", [])
    calls.setdefault("compute_g0_load_calls", [])
    calls.setdefault("stk_limit_ends", [])

    monkeypatch.setattr(labels_runner, "session_scope", _noop_session_scope)
    monkeypatch.setattr(
        labels_runner, "query_materialized_dates",
        lambda s, table, col, val, start, end: set(materialized),
    )
    monkeypatch.setattr(
        labels_runner, "query_trading_days",
        lambda s, start, end: list(trading_days),
    )
    # end_padded 取子区间末日（不实际查 trade_cal）。
    monkeypatch.setattr(labels_runner, "_compute_end_padded", lambda end: end)

    def _fake_g0_load(g0: str, head_pad: int, start: str) -> str:
        calls["compute_g0_load_calls"].append((g0, head_pad, start))
        if head_pad <= 0:
            return g0
        # 模拟头部 padding：回看 head_pad 个自然日并 clamp 到 start（保证 <= g0）。
        return max(start, _shift_back(g0, head_pad))

    monkeypatch.setattr(labels_runner, "_compute_g0_load", _fake_g0_load)

    def _fake_load_quotes(
        start: str, end: str, head_rows_per_code: int = 0
    ) -> pd.DataFrame:
        calls["daily_quotes_starts"].append(start)
        # bug5：记录 compute_labels 透传的 head_rows_per_code（strategy_aware=ma_window-1,
        # fwd=0），供 wiring 断言。
        calls["daily_quotes_head_rows"].append(head_rows_per_code)
        return quotes

    monkeypatch.setattr(labels_runner, "_load_daily_quotes", _fake_load_quotes)

    def _fake_load_stk_limit(start: str, end: str) -> pd.DataFrame:
        # 记录 end 入参：bug2 要求 stk_limit 加载到 end_padded（与 quotes 同口径），非 g1。
        calls["stk_limit_ends"].append(end)
        return pd.DataFrame(columns=["ts_code", "trade_date", "up_limit", "down_limit"])

    monkeypatch.setattr(labels_runner, "_load_stk_limit", _fake_load_stk_limit)
    monkeypatch.setattr(
        labels_runner, "_load_suspend",
        lambda s, e: pd.DataFrame(columns=["ts_code", "trade_date"]),
    )
    monkeypatch.setattr(
        labels_runner, "_load_listing_info",
        lambda: (
            pd.DataFrame(columns=["ts_code", "list_date"]),
            pd.DataFrame(columns=["ts_code", "delist_date"]),
        ),
    )
    # 全局交易日历（窗口无关 new_listing 计数）：listing 为空时 filter_new_listing
    # 短路、日历值不影响结果，返回 trading_days 作占位。
    monkeypatch.setattr(
        labels_runner, "_load_trade_calendar", lambda: list(trading_days)
    )

    def _fake_upsert(rows: list[dict[str, Any]]) -> int:
        calls["upserted"].append(rows)
        return len(rows)

    monkeypatch.setattr(labels_runner, "_upsert_labels", _fake_upsert)


def test_compute_labels_force_recompute_skips_materialized_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """force_recompute=True → 不查 materialized，直接整段 [start,end] 单子区间。"""

    dates = pd.bdate_range("2024-01-02", periods=20).strftime("%Y%m%d").tolist()
    quotes = _fwd_quotes_over(dates)
    calls: dict[str, Any] = {}
    _patch_incremental_loaders(
        monkeypatch, quotes=quotes, materialized=set(),
        trading_days=dates, calls=calls,
    )

    def _boom(*_a: Any, **_k: Any) -> set[str]:
        raise AssertionError("query_materialized_dates 不应在 force 路径被调用")

    monkeypatch.setattr(labels_runner, "query_materialized_dates", _boom)

    n = labels_runner.compute_labels(
        scheme="fwd_5d_ret",
        date_range=f"{dates[0]}:{dates[-1]}",
        force_recompute=True,
        fwd_horizon_days=1,
    )
    assert n > 0
    # 整段单子区间：_load_daily_quotes 只调一次，起点 == start（fwd head_pad=0）。
    assert calls["daily_quotes_starts"] == [dates[0]]


def test_compute_labels_force_recompute_strategy_aware_loads_from_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """force=True strategy_aware：单子区间 (start,end)，g0_load clamp 到 start（回归基线）。

    改造前整段算 _load_daily_quotes(start, end_padded)；force 路径 g0=start、head_pad>0，
    _compute_g0_load(start, head_pad, start) clamp 到 start → 加载起点逐字节等价。
    """

    quotes = _rising_quotes_for_runner()
    dates = quotes["trade_date"].tolist()
    calls: dict[str, Any] = {}

    def _boom(*_a: Any, **_k: Any) -> set[str]:
        raise AssertionError("force 路径不应查 materialized")

    _patch_incremental_loaders(
        monkeypatch, quotes=quotes, materialized=set(),
        trading_days=dates, calls=calls,
    )
    monkeypatch.setattr(labels_runner, "query_materialized_dates", _boom)

    n = labels_runner.compute_labels(
        scheme="strategy-aware",
        date_range=f"{dates[0]}:{dates[-1]}",
        force_recompute=True,
    )
    assert n > 0
    # 单子区间 → 只加载一次，起点 clamp 到 start。
    assert calls["daily_quotes_starts"] == [dates[0]]
    # head_pad = MA_WINDOW-1，g0==start → _compute_g0_load 仍被调（head_pad>0），clamp 到 start。
    assert calls["compute_g0_load_calls"][0] == (dates[0], MA_WINDOW - 1, dates[0])


def test_compute_labels_gap_in_middle_only_computes_gap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """中间缺口：已物化两端、缺中段 → 只算中段子区间，upsert 行 ∈ 缺口。"""

    dates = pd.bdate_range("2024-01-02", periods=10).strftime("%Y%m%d").tolist()
    quotes = _fwd_quotes_over(dates)
    # 已物化前 3 + 后 3；中间 dates[3:7] 是缺口。
    materialized = set(dates[:3]) | set(dates[7:])
    gap = dates[3:7]
    calls: dict[str, Any] = {}
    _patch_incremental_loaders(
        monkeypatch, quotes=quotes, materialized=materialized,
        trading_days=dates, calls=calls,
    )

    labels_runner.compute_labels(
        scheme="fwd_5d_ret",
        date_range=f"{dates[0]}:{dates[-1]}",
        fwd_horizon_days=1,
    )
    # 单缺口子区间 → _load_daily_quotes 调一次，起点 == 缺口首日（fwd head_pad=0）。
    assert calls["daily_quotes_starts"] == [gap[0]]
    # upsert 的所有行 trade_date ∈ [gap[0], gap[-1]]。
    upserted_rows = [r for batch in calls["upserted"] for r in batch]
    assert upserted_rows
    assert all(gap[0] <= str(r["trade_date"]) <= gap[-1] for r in upserted_rows)


def test_compute_labels_full_overlap_no_compute(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """全部已物化（无缺口）→ 不算、不 upsert，返回 0。"""

    dates = pd.bdate_range("2024-01-02", periods=6).strftime("%Y%m%d").tolist()
    quotes = _fwd_quotes_over(dates)
    calls: dict[str, Any] = {}
    _patch_incremental_loaders(
        monkeypatch, quotes=quotes, materialized=set(dates),
        trading_days=dates, calls=calls,
    )
    n = labels_runner.compute_labels(
        scheme="fwd_5d_ret",
        date_range=f"{dates[0]}:{dates[-1]}",
        fwd_horizon_days=1,
    )
    assert n == 0
    assert calls["daily_quotes_starts"] == []  # 一次都没加载
    assert calls["upserted"] == []


def test_compute_labels_full_disjoint_computes_whole(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """全不重叠（已物化集与区间无交集）→ 整段都是缺口，单子区间。"""

    dates = pd.bdate_range("2024-01-02", periods=8).strftime("%Y%m%d").tolist()
    quotes = _fwd_quotes_over(dates)
    calls: dict[str, Any] = {}
    # 已物化的是区间外的日子 → 区间内全是缺口。
    _patch_incremental_loaders(
        monkeypatch, quotes=quotes, materialized={"20230101", "20230102"},
        trading_days=dates, calls=calls,
    )
    n = labels_runner.compute_labels(
        scheme="fwd_5d_ret",
        date_range=f"{dates[0]}:{dates[-1]}",
        fwd_horizon_days=1,
    )
    assert n > 0
    assert calls["daily_quotes_starts"] == [dates[0]]


def test_compute_labels_head_padding_strategy_aware_midgap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """strategy_aware 缺口中段 → _load_daily_quotes 收到的起点 g0_load < g0。"""

    quotes = _rising_quotes_for_runner()
    dates = quotes["trade_date"].tolist()
    # 已物化前 5 天 → 缺口从 dates[5] 起。
    materialized = set(dates[:5])
    calls: dict[str, Any] = {}
    _patch_incremental_loaders(
        monkeypatch, quotes=quotes, materialized=materialized,
        trading_days=dates, calls=calls,
    )
    labels_runner.compute_labels(
        scheme="strategy-aware",
        date_range=f"{dates[0]}:{dates[-1]}",
    )
    g0 = dates[5]
    # head_pad = MA_WINDOW-1 = 4 > 0 → _compute_g0_load 被调，起点严格早于 g0。
    assert calls["compute_g0_load_calls"]
    assert calls["compute_g0_load_calls"][0][0] == g0
    assert calls["compute_g0_load_calls"][0][1] == MA_WINDOW - 1
    loaded_start = calls["daily_quotes_starts"][0]
    assert loaded_start < g0


def test_compute_labels_head_padding_g0_equals_start_clamped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """strategy_aware g0==start（区间全缺口）→ g0_load clamp 到 start。"""

    quotes = _rising_quotes_for_runner()
    dates = quotes["trade_date"].tolist()
    calls: dict[str, Any] = {}
    _patch_incremental_loaders(
        monkeypatch, quotes=quotes, materialized=set(),
        trading_days=dates, calls=calls,
    )
    labels_runner.compute_labels(
        scheme="strategy-aware",
        date_range=f"{dates[0]}:{dates[-1]}",
    )
    # g0 == start == dates[0] → _fake_g0_load 的 max(start, ...) → clamp 到 start。
    assert calls["daily_quotes_starts"][0] == dates[0]


def test_compute_labels_fwd_no_head_padding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """fwd_ret 缺口中段 → head_pad=0，g0_load == g0（不回看）。"""

    dates = pd.bdate_range("2024-01-02", periods=10).strftime("%Y%m%d").tolist()
    quotes = _fwd_quotes_over(dates)
    materialized = set(dates[:4])  # 缺口从 dates[4] 起
    calls: dict[str, Any] = {}
    _patch_incremental_loaders(
        monkeypatch, quotes=quotes, materialized=materialized,
        trading_days=dates, calls=calls,
    )
    labels_runner.compute_labels(
        scheme="fwd_5d_ret",
        date_range=f"{dates[0]}:{dates[-1]}",
        fwd_horizon_days=1,
    )
    g0 = dates[4]
    # fwd → head_pad=0 → _compute_g0_load(head_pad=0) 返回 g0；起点 == g0。
    assert calls["compute_g0_load_calls"][0] == (g0, 0, dates[0])
    assert calls["daily_quotes_starts"][0] == g0


def test_compute_labels_strategy_aware_passes_head_rows_per_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """bug5 wiring：strategy_aware → _load_daily_quotes 收到 head_rows_per_code=MA_WINDOW-1。"""

    quotes = _rising_quotes_for_runner()
    dates = quotes["trade_date"].tolist()
    materialized = set(dates[:5])  # 缺口从 dates[5] 起，触发头部 padding
    calls: dict[str, Any] = {}
    _patch_incremental_loaders(
        monkeypatch, quotes=quotes, materialized=materialized,
        trading_days=dates, calls=calls,
    )
    labels_runner.compute_labels(
        scheme="strategy-aware",
        date_range=f"{dates[0]}:{dates[-1]}",
    )
    assert calls["daily_quotes_head_rows"] == [MA_WINDOW - 1]


def test_compute_labels_fwd_passes_zero_head_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """bug5 wiring：fwd → head_pad=0 → _load_daily_quotes 收到 head_rows_per_code=0（不补 head 行）。"""

    dates = pd.bdate_range("2024-01-02", periods=10).strftime("%Y%m%d").tolist()
    quotes = _fwd_quotes_over(dates)
    materialized = set(dates[:4])
    calls: dict[str, Any] = {}
    _patch_incremental_loaders(
        monkeypatch, quotes=quotes, materialized=materialized,
        trading_days=dates, calls=calls,
    )
    labels_runner.compute_labels(
        scheme="fwd_5d_ret",
        date_range=f"{dates[0]}:{dates[-1]}",
        fwd_horizon_days=1,
    )
    assert calls["daily_quotes_head_rows"] == [0]


def test_compute_labels_logs_skipped_and_computed(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """缺口循环 log skipped_dates(数量) + computed_subranges(列表)，禁止静默截断。"""

    import logging

    dates = pd.bdate_range("2024-01-02", periods=10).strftime("%Y%m%d").tolist()
    quotes = _fwd_quotes_over(dates)
    materialized = set(dates[:3]) | set(dates[7:])  # 跳过 3+3=6 天，缺口 4 天
    calls: dict[str, Any] = {}
    _patch_incremental_loaders(
        monkeypatch, quotes=quotes, materialized=materialized,
        trading_days=dates, calls=calls,
    )
    with caplog.at_level(logging.INFO, logger=labels_runner.logger.name):
        labels_runner.compute_labels(
            scheme="fwd_5d_ret",
            date_range=f"{dates[0]}:{dates[-1]}",
            fwd_horizon_days=1,
        )
    plan = [r for r in caplog.records if r.msg == "labels_incremental_plan"]
    assert plan, "应记录 labels_incremental_plan"
    rec = plan[0]
    assert rec.skipped_dates == 6
    assert rec.computed_subranges == [(dates[3], dates[6])]


def test_compute_labels_loads_stk_limit_to_end_padded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """约束 1 / bug2：stk_limit 必须加载到 end_padded（与 quotes/suspend 同口径），
    而非缺口末日 g1。

    signal=g1 的 buy_date=next_day(g1)>g1，涨停过滤看 buy_date；只加载到 g1 则查不到
    该日涨停、漏剔涨停入场 → 增量与整段重算分歧。这里让 end_padded≠g1 以区分二者。
    """

    dates = pd.bdate_range("2024-01-02", periods=10).strftime("%Y%m%d").tolist()
    quotes = _fwd_quotes_over(dates)
    calls: dict[str, Any] = {}
    _patch_incremental_loaders(
        monkeypatch, quotes=quotes, materialized=set(),
        trading_days=dates, calls=calls,
    )
    # 让 end_padded 明显晚于 g1(dates[-1])，以区分"加载到 end_padded" vs "加载到 g1"。
    padded = "20240131"
    monkeypatch.setattr(labels_runner, "_compute_end_padded", lambda end: padded)

    labels_runner.compute_labels(
        scheme="strategy-aware",
        date_range=f"{dates[0]}:{dates[-1]}",
    )
    # 单子区间 → stk_limit 加载一次，end 必须是 end_padded(padded)，不是 g1(dates[-1])。
    assert calls["stk_limit_ends"] == [padded]


# ----------------------------------------------------------------------
# runner_entrypoint：strategy_id/version → codec scheme + 加载 exit_rules
# ----------------------------------------------------------------------

class _FakeJob:
    def __init__(self, params: dict[str, Any]) -> None:
        self.params = params
        self.id = None


def test_runner_entrypoint_loads_strategy_and_computes_scheme(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """含 strategy_id/version → 用 codec 算 scheme + 加载 exit_rules，透传 compute_labels。"""

    loaded_exit_rules = [
        {"type": "stop_loss", "params": {"pct": 0.05}},
        {"type": "max_hold", "params": {"days": 10}},
    ]
    monkeypatch.setattr(
        labels_runner, "_load_strategy_definition",
        lambda sid, sver: loaded_exit_rules,
    )

    captured: dict[str, Any] = {}

    def _fake_compute(**kwargs: Any) -> int:
        captured.update(kwargs)
        return 1

    monkeypatch.setattr(labels_runner, "compute_labels", _fake_compute)

    job = _FakeJob(
        {
            "date_range": "20240102:20240131",
            "strategy_id": "tight_exit",
            "strategy_version": "v1",
        }
    )
    labels_runner.runner_entrypoint(job)

    assert captured["scheme"] == "strategy-aware__tight_exit_v1"
    assert captured["exit_rules"] == loaded_exit_rules


def test_runner_entrypoint_default_exit_legacy_scheme(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """strategy_id=default_exit@v1 → codec 回 legacy 'strategy-aware'。"""

    monkeypatch.setattr(
        labels_runner, "_load_strategy_definition",
        lambda sid, sver: [{"type": "max_hold", "params": {"days": 20}}],
    )
    captured: dict[str, Any] = {}
    monkeypatch.setattr(
        labels_runner, "compute_labels",
        lambda **kw: captured.update(kw) or 1,
    )

    job = _FakeJob(
        {
            "date_range": "20240102:20240131",
            "strategy_id": "default_exit",
            "strategy_version": "v1",
        }
    )
    labels_runner.runner_entrypoint(job)
    assert captured["scheme"] == "strategy-aware"


def test_runner_entrypoint_bare_scheme_no_exit_rules(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """裸 scheme（无 strategy_id）→ exit_rules=None（走 default_exit）。"""

    captured: dict[str, Any] = {}
    monkeypatch.setattr(
        labels_runner, "compute_labels",
        lambda **kw: captured.update(kw) or 1,
    )
    job = _FakeJob({"scheme": "strategy-aware", "date_range": "20240102:20240131"})
    labels_runner.runner_entrypoint(job)
    assert captured["scheme"] == "strategy-aware"
    assert captured["exit_rules"] is None


# ----------------------------------------------------------------------
# runner_entrypoint：base_type/base_params 路径（expandForTraining 注入）
# ----------------------------------------------------------------------

def test_runner_entrypoint_base_type_fwd_ret_horizon5(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """base_type='fwd_ret', base_params={'horizon':5} → scheme='fwd_5d_ret', exit_rules=None。"""

    captured: dict[str, Any] = {}
    monkeypatch.setattr(
        labels_runner, "compute_labels",
        lambda **kw: captured.update(kw) or 1,
    )
    job = _FakeJob(
        {
            "date_range": "20240102:20240131",
            "base_type": "fwd_ret",
            "base_params": {"horizon": 5},
        }
    )
    labels_runner.runner_entrypoint(job)
    assert captured["scheme"] == "fwd_5d_ret"
    assert captured["exit_rules"] is None


def test_runner_entrypoint_base_type_fwd_ret_horizon1(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """base_type='fwd_ret', base_params={'horizon':1} → scheme='fwd_ret_h1', exit_rules=None。"""

    captured: dict[str, Any] = {}
    monkeypatch.setattr(
        labels_runner, "compute_labels",
        lambda **kw: captured.update(kw) or 1,
    )
    job = _FakeJob(
        {
            "date_range": "20240102:20240131",
            "base_type": "fwd_ret",
            "base_params": {"horizon": 1},
        }
    )
    labels_runner.runner_entrypoint(job)
    assert captured["scheme"] == "fwd_ret_h1"
    assert captured["exit_rules"] is None


def test_runner_entrypoint_base_type_strategy_aware(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """base_type='strategy_aware', base_params 含 strategy_id/version →
    scheme='strategy-aware'（legacy 别名），_load_strategy_definition 被调用，exit_rules 透传。
    """

    loaded_exit_rules = [{"type": "stop_loss", "params": {"pct": 0.08}}]
    load_calls: list[tuple[str, str]] = []

    def _fake_load(sid: str, sver: str) -> list[dict]:
        load_calls.append((sid, sver))
        return loaded_exit_rules

    monkeypatch.setattr(labels_runner, "_load_strategy_definition", _fake_load)

    captured: dict[str, Any] = {}
    monkeypatch.setattr(
        labels_runner, "compute_labels",
        lambda **kw: captured.update(kw) or 1,
    )

    job = _FakeJob(
        {
            "date_range": "20240102:20240131",
            "base_type": "strategy_aware",
            "base_params": {
                "strategy_id": "default_exit",
                "strategy_version": "v1",
            },
        }
    )
    labels_runner.runner_entrypoint(job)

    assert captured["scheme"] == "strategy-aware"
    assert captured["exit_rules"] == loaded_exit_rules
    assert load_calls == [("default_exit", "v1")]


def test_runner_entrypoint_explicit_scheme_takes_priority_over_base_type(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """显式 params.scheme 存在时，base_type 不参与解析（codec 不被调用）。"""

    captured: dict[str, Any] = {}
    monkeypatch.setattr(
        labels_runner, "compute_labels",
        lambda **kw: captured.update(kw) or 1,
    )
    job = _FakeJob(
        {
            "scheme": "strategy-aware",
            "date_range": "20240102:20240131",
            "base_type": "fwd_ret",          # 有显式 scheme → base_type 应被忽略
            "base_params": {"horizon": 5},
        }
    )
    labels_runner.runner_entrypoint(job)
    # 应使用显式 scheme，不被 base_type 覆盖
    assert captured["scheme"] == "strategy-aware"
    assert captured["exit_rules"] is None


def test_runner_entrypoint_no_scheme_no_strategy_no_base_type_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """三者全缺（无 scheme/strategy/base_type）→ ValueError fail-fast。"""

    monkeypatch.setattr(
        labels_runner, "compute_labels",
        lambda **kw: 1,
    )
    job = _FakeJob({"date_range": "20240102:20240131"})
    with pytest.raises(ValueError, match="missing required params"):
        labels_runner.runner_entrypoint(job)
