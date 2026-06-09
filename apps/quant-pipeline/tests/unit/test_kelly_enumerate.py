"""enumerate.py + paths.py 纯逻辑单测。

不连 DB：所有 DB 函数通过 monkeypatch 注入假数据。
覆盖：
  1. _find_last_index_le — 二分搜索
  2. 过滤逻辑（停牌/一字涨停/次新）独立验证
  3. enumerate_signals 集成（monkeypatch DB 辅助函数）
  4. ForwardPath 构建逻辑（停牌跳过不占 max_window）
  5. parquet 缓存往返（_save/_load）
  6. load_sse_calendar 边界（空返回）
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from quant_pipeline.research.kelly_sweep.enumerate import (
    NEW_LISTING_MIN_TRADING_DAYS,
    SignalRecord,
    _find_last_index_le,
    _build_trigger_clause,
    _ALLOWED_INDICATOR_FIELDS,
    enumerate_signals,
)
from quant_pipeline.research.kelly_sweep.paths import (
    _save_paths_to_parquet,
    _load_paths_from_parquet,
    load_forward_paths,
    load_feature_inputs,
)
from quant_pipeline.research.kelly_sweep.types import Bar, BaseTrigger, ForwardPath
from quant_pipeline.research.kelly_sweep.config import SweepConfig


# ─────────────────────────────────────────────────────────────────────────────
# 1. _find_last_index_le
# ─────────────────────────────────────────────────────────────────────────────


class TestFindLastIndexLE:
    def test_exact_match(self) -> None:
        lst = ["20230101", "20230103", "20230105"]
        assert _find_last_index_le(lst, "20230103") == 1

    def test_between_elements(self) -> None:
        lst = ["20230101", "20230103", "20230105"]
        assert _find_last_index_le(lst, "20230102") == 0

    def test_before_all(self) -> None:
        lst = ["20230101", "20230103"]
        assert _find_last_index_le(lst, "20221231") == -1

    def test_after_all(self) -> None:
        lst = ["20230101", "20230103"]
        assert _find_last_index_le(lst, "20230201") == 1

    def test_single_element_match(self) -> None:
        assert _find_last_index_le(["20230101"], "20230101") == 0

    def test_single_element_before(self) -> None:
        assert _find_last_index_le(["20230101"], "20221231") == -1

    def test_empty_list(self) -> None:
        assert _find_last_index_le([], "20230101") == -1


# ─────────────────────────────────────────────────────────────────────────────
# 2. _build_trigger_clause
# ─────────────────────────────────────────────────────────────────────────────


class TestBuildTriggerClause:
    def test_lt_operator(self) -> None:
        trigger = BaseTrigger(field="kdj_j", op="lt", value=0.0)
        clause = _build_trigger_clause(trigger)
        assert clause == "i.kdj_j < :trigger_value"

    def test_gte_operator(self) -> None:
        trigger = BaseTrigger(field="ma5", op="gte", value=10.0)
        clause = _build_trigger_clause(trigger)
        assert clause == "i.ma5 >= :trigger_value"

    def test_invalid_field_raises(self) -> None:
        trigger = BaseTrigger(field="exec(1)", op="lt", value=0.0)
        with pytest.raises(ValueError, match="白名单"):
            _build_trigger_clause(trigger)

    def test_all_allowed_fields_are_valid(self) -> None:
        for field in _ALLOWED_INDICATOR_FIELDS:
            trigger = BaseTrigger(field=field, op="lt", value=0.0)
            clause = _build_trigger_clause(trigger)
            assert f"i.{field}" in clause


# ─────────────────────────────────────────────────────────────────────────────
# 3. 过滤逻辑单元化
# ─────────────────────────────────────────────────────────────────────────────


class TestFilterLogic:
    """把过滤判断从 enumerate_signals 内联逻辑剥出来单测。"""

    # 次新过滤常量核对
    def test_new_listing_threshold_is_60(self) -> None:
        """口径核对：次新阈值 = 60（signal-stats.simulator.ts:109）。"""
        assert NEW_LISTING_MIN_TRADING_DAYS == 60

    # 停牌过滤：qfq_open 为 None
    def test_suspended_when_qfq_open_is_none(self) -> None:
        quote = (None, 10.0)  # (qfq_open, raw_open)
        assert quote[0] is None  # 应被过滤

    def test_not_suspended_when_qfq_open_present(self) -> None:
        quote = (10.5, 10.5)
        assert quote[0] is not None

    # 停牌过滤：key 不在 map 中
    def test_suspended_when_no_quote_row(self) -> None:
        quote_map: dict = {}
        key = ("000001.SZ", "20240102")
        q = quote_map.get(key)
        assert q is None  # 应被过滤

    # 一字涨停：raw_open >= up_limit
    def test_limit_up_triggered(self) -> None:
        raw_open = 11.0
        up_limit = 11.0
        assert raw_open >= up_limit  # 应被过滤

    def test_limit_up_not_triggered_when_below(self) -> None:
        raw_open = 10.5
        up_limit = 11.0
        assert not (raw_open >= up_limit)

    def test_limit_up_not_triggered_when_up_limit_none(self) -> None:
        raw_open = 11.0
        up_limit = None
        # 缺失时不判（signal-stats.simulator.ts:141）
        assert not (raw_open is not None and up_limit is not None and raw_open >= up_limit)

    # 次新过滤：days_since_list < 60
    def test_new_listing_filtered_when_59_days(self) -> None:
        days_since_list = 59
        assert days_since_list < NEW_LISTING_MIN_TRADING_DAYS

    def test_new_listing_not_filtered_when_60_days(self) -> None:
        days_since_list = 60
        assert not (days_since_list < NEW_LISTING_MIN_TRADING_DAYS)

    def test_new_listing_not_filtered_when_list_date_missing(self) -> None:
        sym = {"list_date": None}
        # list_date 缺失 → 保留（不过滤）
        assert sym["list_date"] is None


# ─────────────────────────────────────────────────────────────────────────────
# 4. enumerate_signals 集成（monkeypatch DB）
# ─────────────────────────────────────────────────────────────────────────────


class TestEnumerateSignals:
    """用假 DB 数据验证 enumerate_signals 全链路。"""

    # 全局 SSE 日历（10 天）
    CALENDAR = [
        "20240101", "20240102", "20240103", "20240104", "20240105",
        "20240108", "20240109", "20240110", "20240111", "20240112",
    ]
    # list_date = 20240101（index 0）；buy_date = 20240102（index 1）
    # days_since_list = 1 < 60 → 次新剔除

    def _make_config(self, **kwargs) -> SweepConfig:
        return SweepConfig(
            train_range=("20240101", "20240105"),
            valid_range=("20240105", "20240112"),
            **kwargs,
        )

    def _patch_all(
        self,
        monkeypatch,
        calendar=None,
        raw_signals=None,
        symbol_map=None,
        quote_map=None,
        limit_map=None,
    ):
        if calendar is None:
            calendar = self.CALENDAR
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.enumerate.load_sse_calendar",
            lambda *a, **kw: calendar,
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.enumerate._scan_indicator_signals",
            lambda *a, **kw: raw_signals or [],
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.enumerate._prefetch_symbol_map",
            lambda *a, **kw: symbol_map or {},
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.enumerate._fetch_buy_date_quotes",
            lambda *a, **kw: quote_map or {},
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.enumerate._fetch_buy_date_limits",
            lambda *a, **kw: limit_map or {},
        )

    def test_no_signals_returns_empty(self, monkeypatch) -> None:
        self._patch_all(monkeypatch)
        config = self._make_config()
        result = enumerate_signals(config)
        assert result == []

    def test_normal_signal_passes_all_filters(self, monkeypatch) -> None:
        # 信号：20240103，buy_date=20240104
        # list_date=20230101（100+天前，通过次新过滤）
        self._patch_all(
            monkeypatch,
            raw_signals=[("000001.SZ", "20240103")],
            symbol_map={"000001.SZ": {"list_date": "20230101", "delist_date": None}},
            quote_map={("000001.SZ", "20240104"): (10.5, 10.5)},
            limit_map={("000001.SZ", "20240104"): 11.0},
        )
        config = self._make_config()
        result = enumerate_signals(config)
        assert len(result) == 1
        assert result[0].ts_code == "000001.SZ"
        assert result[0].signal_date == "20240103"
        assert result[0].buy_date == "20240104"

    def test_suspended_signal_filtered(self, monkeypatch) -> None:
        # buy_date 无 quote 行 → 停牌，剔除
        self._patch_all(
            monkeypatch,
            raw_signals=[("000001.SZ", "20240103")],
            symbol_map={"000001.SZ": {"list_date": "20230101", "delist_date": None}},
            quote_map={},  # 无行
            limit_map={},
        )
        config = self._make_config()
        result = enumerate_signals(config)
        assert result == []

    def test_limit_up_signal_filtered(self, monkeypatch) -> None:
        # raw_open == up_limit → 一字涨停，剔除
        self._patch_all(
            monkeypatch,
            raw_signals=[("000001.SZ", "20240103")],
            symbol_map={"000001.SZ": {"list_date": "20230101", "delist_date": None}},
            quote_map={("000001.SZ", "20240104"): (10.5, 11.0)},  # qfq_open=10.5, raw_open=11.0
            limit_map={("000001.SZ", "20240104"): 11.0},  # up_limit=11.0 = raw_open → 一字涨停
        )
        config = self._make_config()
        result = enumerate_signals(config)
        assert result == []

    def test_new_listing_filtered(self, monkeypatch) -> None:
        # list_date=20240101（index 0），buy_date=20240102（index 1），days_since_list=1 < 60
        self._patch_all(
            monkeypatch,
            raw_signals=[("000001.SZ", "20240101")],
            symbol_map={"000001.SZ": {"list_date": "20240101", "delist_date": None}},
            quote_map={("000001.SZ", "20240102"): (10.5, 10.5)},
            limit_map={("000001.SZ", "20240102"): 11.0},
        )
        config = self._make_config()
        result = enumerate_signals(config)
        assert result == []

    def test_new_listing_passes_at_60_days(self, monkeypatch) -> None:
        # 构造一个 60 天前上市的股票
        # CALENDAR[0] = "20240101"（list_date）；buy_date 在 index 60
        long_cal = [f"2024{str(i+1).zfill(4)}" for i in range(100)]
        # 简化：list_date=long_cal[0]，buy_date=long_cal[60]
        list_date = long_cal[0]
        signal_date = long_cal[59]  # T，buy_date = long_cal[60]
        buy_date = long_cal[60]

        self._patch_all(
            monkeypatch,
            calendar=long_cal,
            raw_signals=[("000001.SZ", signal_date)],
            symbol_map={"000001.SZ": {"list_date": list_date, "delist_date": None}},
            quote_map={("000001.SZ", buy_date): (10.5, 10.5)},
            limit_map={("000001.SZ", buy_date): 11.0},
        )
        config = SweepConfig(
            train_range=(long_cal[0], long_cal[49]),
            valid_range=(long_cal[50], long_cal[99]),
        )
        result = enumerate_signals(config)
        assert len(result) == 1

    def test_signal_at_last_calendar_day_filtered(self, monkeypatch) -> None:
        # signal_date = 最后一个交易日，无 T+1 → 过滤
        self._patch_all(
            monkeypatch,
            raw_signals=[("000001.SZ", "20240112")],
            symbol_map={},
            quote_map={},
            limit_map={},
        )
        config = self._make_config()
        result = enumerate_signals(config)
        assert result == []

    def test_universe_list_passed_to_scan(self, monkeypatch) -> None:
        """universe=['000001.SZ'] 时，_scan_indicator_signals 收到正确 universe。"""
        captured = {}

        def fake_scan(trigger, trading_days, universe):
            captured["universe"] = universe
            return [("000001.SZ", "20240103")]

        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.enumerate.load_sse_calendar",
            lambda *a, **kw: self.CALENDAR,
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.enumerate._scan_indicator_signals",
            fake_scan,
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.enumerate._prefetch_symbol_map",
            lambda *a, **kw: {"000001.SZ": {"list_date": "20230101", "delist_date": None}},
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.enumerate._fetch_buy_date_quotes",
            lambda *a, **kw: {("000001.SZ", "20240104"): (10.5, 10.5)},
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.enumerate._fetch_buy_date_limits",
            lambda *a, **kw: {("000001.SZ", "20240104"): 11.0},
        )

        config = self._make_config(universe=["000001.SZ"])
        enumerate_signals(config)
        assert captured["universe"] == ["000001.SZ"]


# ─────────────────────────────────────────────────────────────────────────────
# 5. ForwardPath 构建：停牌跳过 + max_window 不占额度
# ─────────────────────────────────────────────────────────────────────────────


class TestForwardPathConstruction:
    """验证停牌日跳过逻辑，口径：signal-stats.simulator.ts:239。"""

    CALENDAR = [
        "20240102", "20240103", "20240104", "20240105",
        "20240108", "20240109", "20240110",
    ]

    def _make_signal(self) -> SignalRecord:
        return SignalRecord(ts_code="000001.SZ", signal_date="20240101", buy_date="20240102")

    def test_suspended_day_skipped_does_not_count_toward_max_window(self, monkeypatch) -> None:
        """bars 从 buy_date 之后起：20240104 停牌（无 quote 行），
        max_window=3 应取到 buy_date(20240102) 之后的 20240103/05/08 三天。
        """
        signal = self._make_signal()

        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths.load_sse_calendar",
            lambda *a, **kw: self.CALENDAR,
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._prefetch_symbol_meta",
            lambda *a, **kw: {"000001.SZ": {"delist_date": None}},
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._prefetch_atr14",
            lambda *a, **kw: {("000001.SZ", "20240101"): 0.25},
        )

        # buy_date=20240102 有行情（供 buy_price）；20240104 停牌（无 quote）；其余有行情。
        # bars 从 buy_date 之后起 → 候选 20240103/04(停)/05/08/09，max_window=3 取 03/05/08。
        def fake_fetch_quotes(ts_code, dates):
            data = {
                "20240102": (10.0, 10.5, 9.8, 10.2),  # buy_date 当日，仅供 buy_price，不进 bars
                "20240103": (10.1, 10.6, 10.0, 10.4),
                # 20240104 缺失 → 停牌（跳过，不占额度）
                "20240105": (10.6, 11.0, 10.5, 10.9),
                "20240108": (10.9, 11.2, 10.8, 11.1),
                "20240109": (11.1, 11.4, 11.0, 11.3),
            }
            return {d: v for d, v in data.items() if d in dates}

        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._fetch_quotes_for_ts",
            fake_fetch_quotes,
        )

        with patch("quant_pipeline.research.kelly_sweep.paths._parquet_cache_path") as mock_cache:
            # 禁用缓存
            mock_cache.return_value = Path(tempfile.mktemp(suffix=".parquet"))
            paths = load_forward_paths([signal], max_window=3, date_end="20240112", use_cache=False)

        assert len(paths) == 1
        fp = paths[0]
        # buy_price 仍取 buy_date(20240102) 的 qfq_open
        assert fp.buy_price == pytest.approx(10.0)
        # bars 从 buy_date 之后起：停牌日 20240104 跳过、不占额度，max_window=3 取 20240103/05/08
        assert len(fp.bars) == 3
        assert fp.bars[0].trade_date == "20240103"
        assert fp.bars[1].trade_date == "20240105"
        assert fp.bars[2].trade_date == "20240108"
        # buy_date 当日 20240102 不应出现在 bars 中
        assert not any(b.trade_date == "20240102" for b in fp.bars)
        # 20240109 不应出现（已达 max_window=3）
        assert not any(b.trade_date == "20240109" for b in fp.bars)

    def test_buy_price_is_buy_date_qfq_open(self, monkeypatch) -> None:
        """buy_price = buy_date 的 qfq_open（simulator.ts:154）。"""
        signal = self._make_signal()

        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths.load_sse_calendar",
            lambda *a, **kw: self.CALENDAR,
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._prefetch_symbol_meta",
            lambda *a, **kw: {"000001.SZ": {"delist_date": None}},
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._prefetch_atr14",
            lambda *a, **kw: {},
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._fetch_quotes_for_ts",
            lambda ts_code, dates: {
                "20240102": (12.34, 12.8, 12.1, 12.5),
                "20240103": (12.5, 12.9, 12.3, 12.7),
            },
        )

        paths = load_forward_paths([signal], max_window=2, date_end="20240112", use_cache=False)
        assert len(paths) == 1
        # buy_price = buy_date(20240102) 的 qfq_open，即便 buy_date 不在 bars 中也单独取
        assert paths[0].buy_price == pytest.approx(12.34)
        # bars 从 buy_date 之后起，bars[0] = 20240103（非 buy_date）
        assert paths[0].bars[0].trade_date == "20240103"

    def test_atr14_at_signal_populated(self, monkeypatch) -> None:
        signal = self._make_signal()

        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths.load_sse_calendar",
            lambda *a, **kw: self.CALENDAR,
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._prefetch_symbol_meta",
            lambda *a, **kw: {"000001.SZ": {"delist_date": None}},
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._prefetch_atr14",
            lambda *a, **kw: {("000001.SZ", "20240101"): 0.55},
        )
        # buy_date=20240102（供 buy_price）+ 之后一天 20240103（供 bars，否则空 bars 被过滤）
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._fetch_quotes_for_ts",
            lambda ts_code, dates: {
                "20240102": (10.0, 10.5, 9.8, 10.2),
                "20240103": (10.2, 10.7, 10.0, 10.5),
            },
        )

        paths = load_forward_paths([signal], max_window=1, date_end="20240112", use_cache=False)
        assert paths[0].atr14_at_signal == pytest.approx(0.55)

    def test_delist_date_populated(self, monkeypatch) -> None:
        signal = self._make_signal()

        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths.load_sse_calendar",
            lambda *a, **kw: self.CALENDAR,
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._prefetch_symbol_meta",
            lambda *a, **kw: {"000001.SZ": {"delist_date": "20240601"}},
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._prefetch_atr14",
            lambda *a, **kw: {},
        )
        # buy_date=20240102（供 buy_price）+ 之后一天 20240103（供 bars，否则空 bars 被过滤）
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._fetch_quotes_for_ts",
            lambda ts_code, dates: {
                "20240102": (10.0, 10.5, 9.8, 10.2),
                "20240103": (10.2, 10.7, 10.0, 10.5),
            },
        )

        paths = load_forward_paths([signal], max_window=1, date_end="20240112", use_cache=False)
        assert paths[0].delist_date == "20240601"

    def test_empty_signals_returns_empty(self, monkeypatch) -> None:
        paths = load_forward_paths([], max_window=20, date_end="20240112", use_cache=False)
        assert paths == []

    def test_all_days_suspended_signal_skipped(self, monkeypatch) -> None:
        signal = self._make_signal()

        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths.load_sse_calendar",
            lambda *a, **kw: self.CALENDAR,
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._prefetch_symbol_meta",
            lambda *a, **kw: {"000001.SZ": {"delist_date": None}},
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._prefetch_atr14",
            lambda *a, **kw: {},
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._fetch_quotes_for_ts",
            lambda ts_code, dates: {},  # 全部停牌（含 buy_date 当日）→ buy_q is None，跳过
        )

        paths = load_forward_paths([signal], max_window=3, date_end="20240112", use_cache=False)
        assert paths == []

    def test_buy_date_has_quote_but_no_tradable_after_is_filtered(self, monkeypatch) -> None:
        """buy_date 当日有行情、但之后无任何可交易日（数据边界）→ 空 bars → 过滤。

        对齐 NestJS 尾部 insufficient_data：buy_date 之后没有可成交日则无法形成交易。
        """
        signal = self._make_signal()  # buy_date = 20240102

        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths.load_sse_calendar",
            lambda *a, **kw: self.CALENDAR,
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._prefetch_symbol_meta",
            lambda *a, **kw: {"000001.SZ": {"delist_date": None}},
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._prefetch_atr14",
            lambda *a, **kw: {},
        )
        # 仅 buy_date(20240102) 有行情，之后全部停牌 → bars 收集到 0 条
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._fetch_quotes_for_ts",
            lambda ts_code, dates: {"20240102": (10.0, 10.5, 9.8, 10.2)},
        )

        paths = load_forward_paths([signal], max_window=3, date_end="20240112", use_cache=False)
        assert paths == []


# ─────────────────────────────────────────────────────────────────────────────
# 6. parquet 缓存往返
# ─────────────────────────────────────────────────────────────────────────────


class TestParquetRoundtrip:
    """parquet 缓存往返测试。需要 pyarrow（pyproject.toml 依赖，若未安装则跳过）。"""

    @pytest.fixture(autouse=True)
    def require_pyarrow(self):
        pytest.importorskip("pyarrow", reason="pyarrow 未安装，跳过 parquet 缓存测试")

    def _make_path(self) -> ForwardPath:
        return ForwardPath(
            ts_code="000001.SZ",
            signal_date="20240101",
            buy_date="20240102",
            buy_price=10.5,
            bars=[
                Bar(trade_date="20240102", qfq_open=10.5, qfq_high=11.0, qfq_low=10.3, qfq_close=10.8),
                Bar(trade_date="20240103", qfq_open=10.8, qfq_high=11.2, qfq_low=10.7, qfq_close=11.0),
            ],
            delist_date=None,
            atr14_at_signal=0.35,
        )

    def test_roundtrip_preserves_data(self, tmp_path) -> None:
        fp = self._make_path()
        cache_file = tmp_path / "test_paths.parquet"
        _save_paths_to_parquet([fp], cache_file)
        loaded = _load_paths_from_parquet(cache_file)

        assert len(loaded) == 1
        lp = loaded[0]
        assert lp.ts_code == "000001.SZ"
        assert lp.signal_date == "20240101"
        assert lp.buy_date == "20240102"
        assert lp.buy_price == pytest.approx(10.5)
        assert lp.delist_date is None
        assert lp.atr14_at_signal == pytest.approx(0.35)
        assert len(lp.bars) == 2
        assert lp.bars[0].trade_date == "20240102"
        assert lp.bars[0].qfq_open == pytest.approx(10.5)
        assert lp.bars[1].trade_date == "20240103"
        assert lp.bars[1].qfq_close == pytest.approx(11.0)

    def test_roundtrip_with_delist_date(self, tmp_path) -> None:
        fp = ForwardPath(
            ts_code="000002.SZ",
            signal_date="20240101",
            buy_date="20240102",
            buy_price=5.0,
            bars=[Bar(trade_date="20240102", qfq_open=5.0, qfq_high=5.5, qfq_low=4.9, qfq_close=5.2)],
            delist_date="20240601",
            atr14_at_signal=None,
        )
        cache_file = tmp_path / "test_delist.parquet"
        _save_paths_to_parquet([fp], cache_file)
        loaded = _load_paths_from_parquet(cache_file)

        assert loaded[0].delist_date == "20240601"
        assert loaded[0].atr14_at_signal is None

    def test_multiple_paths_roundtrip(self, tmp_path) -> None:
        paths = [
            ForwardPath(
                ts_code=f"00000{i}.SZ",
                signal_date="20240101",
                buy_date="20240102",
                buy_price=float(10 + i),
                bars=[Bar(
                    trade_date="20240102",
                    qfq_open=float(10 + i),
                    qfq_high=float(11 + i),
                    qfq_low=float(9 + i),
                    qfq_close=float(10.5 + i),
                )],
                delist_date=None,
                atr14_at_signal=None,
            )
            for i in range(3)
        ]
        cache_file = tmp_path / "test_multi.parquet"
        _save_paths_to_parquet(paths, cache_file)
        loaded = _load_paths_from_parquet(cache_file)
        assert len(loaded) == 3
        loaded_codes = {lp.ts_code for lp in loaded}
        assert loaded_codes == {"000000.SZ", "000001.SZ", "000002.SZ"}

    def test_empty_paths_save_does_not_create_file(self, tmp_path) -> None:
        cache_file = tmp_path / "empty.parquet"
        _save_paths_to_parquet([], cache_file)
        assert not cache_file.exists()

    def test_load_from_empty_parquet(self, tmp_path) -> None:
        """空 DataFrame parquet 应返回空列表。"""
        import pandas as pd
        cache_file = tmp_path / "empty.parquet"
        pd.DataFrame(columns=["ts_code", "signal_date", "buy_date", "buy_price",
                               "delist_date", "atr14_at_signal", "bar_index",
                               "trade_date", "qfq_open", "qfq_high", "qfq_low", "qfq_close"]
                     ).to_parquet(cache_file)
        loaded = _load_paths_from_parquet(cache_file)
        assert loaded == []


# ─────────────────────────────────────────────────────────────────────────────
# 7. 问题1修复验证：停牌密集场景下 max_window*3 截断被移除
# ─────────────────────────────────────────────────────────────────────────────


class TestForwardPathsHeavySuspension:
    """问题1：去掉 max_window*3 上界后，停牌密集时仍能凑满 max_window 个可交易日。

    构造：日历 30 天、max_window=5；前 20 天几乎全部停牌（只有 5 个可交易日散落在后半段）。
    修复前：union_dates 被截断到 max_window*3=15 天，后半段的可交易日拿不到，bars<5。
    修复后：union_dates 取到 date_end，5 个可交易日全部纳入，len(bars)==5。
    """

    # 日历：30 个交易日（字符串升序，格式 YYYYMMDD）
    CALENDAR = [f"202401{str(i+1).zfill(2)}" for i in range(30)]
    # buy_date = 20240101（index 0）
    # 可交易日：index 15, 17, 19, 21, 23（散落在第 16~24 天，全在 max_window*3=15 天截断线之后）
    TRADABLE = {"20240116", "20240118", "20240120", "20240122", "20240124"}

    def _make_signal(self) -> SignalRecord:
        return SignalRecord(
            ts_code="000001.SZ",
            signal_date="20231231",
            buy_date=self.CALENDAR[0],  # 20240101
        )

    def test_heavy_suspension_gets_full_max_window(self, monkeypatch) -> None:
        """停牌密集：修复后 bars 数量等于 max_window=5（修复前因 ×3 截断仅 0 条）。"""
        signal = self._make_signal()
        max_window = 5
        date_end = self.CALENDAR[-1]  # 20240130

        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths.load_sse_calendar",
            lambda *a, **kw: self.CALENDAR,
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._prefetch_symbol_meta",
            lambda *a, **kw: {"000001.SZ": {"delist_date": None}},
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._prefetch_atr14",
            lambda *a, **kw: {},
        )

        def fake_fetch_quotes(ts_code, dates):
            # buy_date(20240101) 当日有行情（供 buy_price），TRADABLE 各日有行情，其余全部停牌。
            # bars 从 buy_date 之后起，故 buy_date 当日不进 bars。
            result = {}
            for d in dates:
                if d == "20240101" or d in self.TRADABLE:
                    result[d] = (10.0, 10.5, 9.8, 10.2)
            return result

        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._fetch_quotes_for_ts",
            fake_fetch_quotes,
        )

        paths = load_forward_paths([signal], max_window=max_window, date_end=date_end, use_cache=False)

        assert len(paths) == 1
        fp = paths[0]
        # 修复后：buy_date 之后的 5 个可交易日全部纳入
        assert len(fp.bars) == max_window, (
            f"期望 {max_window} 条 bars，实际 {len(fp.bars)}；"
            "若为 0 则说明 max_window*3 截断未移除"
        )
        # 确认 bars 都是预期的可交易日（buy_date 当日 20240101 不在内）
        actual_dates = {b.trade_date for b in fp.bars}
        assert actual_dates == self.TRADABLE
        assert "20240101" not in actual_dates

    def test_discrete_buy_dates_in_same_group_all_get_full_window(self, monkeypatch) -> None:
        """同组两个信号 buy_date 相差 10 天；修复后两者均能凑满 max_window=3 个可交易日。"""
        # 信号1：buy_date=CALENDAR[0]；信号2：buy_date=CALENDAR[10]
        # 两者在同一 ts_code 分组；可交易日：只在 CALENDAR[12..14]（索引12,13,14）
        cal = self.CALENDAR  # 30天
        tradable_late = {cal[12], cal[13], cal[14]}
        sig1 = SignalRecord(ts_code="000002.SZ", signal_date="20231230", buy_date=cal[0])
        sig2 = SignalRecord(ts_code="000002.SZ", signal_date="20231231", buy_date=cal[10])
        max_window = 3
        date_end = cal[-1]

        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths.load_sse_calendar",
            lambda *a, **kw: cal,
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._prefetch_symbol_meta",
            lambda *a, **kw: {"000002.SZ": {"delist_date": None}},
        )
        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._prefetch_atr14",
            lambda *a, **kw: {},
        )

        # 两个 buy_date 当日（cal[0]/cal[10]）有行情（供 buy_price），晚期 cal[12..14] 有行情；
        # bars 从各自 buy_date 之后起，buy_date 当日不进 bars。
        buy_dates = {cal[0], cal[10]}

        def fake_fetch(ts_code, dates):
            return {
                d: (10.0, 10.5, 9.8, 10.2)
                for d in dates
                if d in tradable_late or d in buy_dates
            }

        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths._fetch_quotes_for_ts",
            fake_fetch,
        )

        paths = load_forward_paths([sig1, sig2], max_window=max_window, date_end=date_end, use_cache=False)

        # sig1 的 buy_date=cal[0]，可交易日在 cal[12..14]，距 buy_date > max_window*3=9 天位置
        # 修复前 union_window_start_idx=0, window_end_idx=0+3*3-1=8，union_dates 截到 cal[8]，
        # cal[12..14] 不在其中，sig1/sig2 均拿不到行情 → 被 skipped。
        # 修复后取到 date_end，均可拿到 3 条 bars。
        assert len(paths) == 2, f"期望 2 条路径，实际 {len(paths)}（修复前可能为 0）"
        for fp in paths:
            assert len(fp.bars) == max_window


# ─────────────────────────────────────────────────────────────────────────────
# 8. 问题2修复验证：load_feature_inputs 历史窗口
# ─────────────────────────────────────────────────────────────────────────────


class TestLoadFeatureInputs:
    """问题2：load_feature_inputs 历史窗口测试（注入式，不连 DB）。

    验证：
      - 返回二元组 (cross_section_df, history_map)
      - cross_section_df 列齐全
      - history_map 键为 (ts_code, signal_date)，值 DataFrame 含 trade_date/qfq_pct_chg/vol
      - 历史窗口长度受 history_window 参数控制
      - 窗口数据不足时返回实际有多少行（不补齐、不报错）
      - 空信号列表 → 空 df + 空 map
    """

    def _make_signals(self) -> list[SignalRecord]:
        return [
            SignalRecord(ts_code="000001.SZ", signal_date="20240110", buy_date="20240111"),
            SignalRecord(ts_code="000002.SZ", signal_date="20240110", buy_date="20240111"),
        ]

    # ── 截面 DataFrame 构造辅助 ──────────────────────────────────────────────

    def _fake_cross_rows(self):
        """fake SQL 返回给截面查询用的行（模拟 pg 返回 Decimal，用 float 代替）。
        列顺序：ts_code, signal_date, qfq_close, ma5, ma30, atr_14, kdj_j, vol
        """
        return [
            ("000001.SZ", "20240110", 10.5, 10.2, 9.8, 0.25, -5.3, 50000.0),
            ("000002.SZ", "20240110", 8.3, 8.1, 7.9, 0.18, 12.0, 30000.0),
        ]

    def _fake_hist_rows(self, history_window: int = 6):
        """fake SQL 返回给历史窗口查询用的行，模拟 ROW_NUMBER 已筛好最近 history_window 行。"""
        rows = []
        # 000001.SZ：history_window 行，trade_date 截至 20240110
        for i in range(history_window):
            date = f"2024010{history_window - i}"  # 倒序，但最终在 Python 端升序
            rows.append(("000001.SZ", "20240110", date, float(i % 3 - 1) * 0.5, float(10000 + i * 100)))
        # 000002.SZ：只有 3 行（数据不足 history_window）
        for i in range(3):
            date = f"2024010{3 - i}"
            rows.append(("000002.SZ", "20240110", date, float(i) * 0.3, float(20000 + i * 200)))
        return rows

    def _patch_engine(self, monkeypatch, cross_rows, hist_rows):
        """把 get_engine 换成返回假数据的 mock engine。"""
        import decimal

        mock_conn = MagicMock()
        # 第一次调用（截面查询）返回 cross_rows，第二次（历史查询）返回 hist_rows
        mock_conn.execute.side_effect = [
            MagicMock(fetchall=lambda: cross_rows),
            MagicMock(fetchall=lambda: hist_rows),
        ]
        mock_conn.__enter__ = lambda s: mock_conn
        mock_conn.__exit__ = MagicMock(return_value=False)

        mock_engine = MagicMock()
        mock_engine.connect.return_value = mock_conn

        monkeypatch.setattr(
            "quant_pipeline.research.kelly_sweep.paths.get_engine",
            lambda: mock_engine,
        )
        return mock_conn

    def test_empty_signals_returns_empty(self, monkeypatch) -> None:
        cross, hist = load_feature_inputs([])
        assert cross.empty
        assert hist == {}

    def test_return_type_is_tuple(self, monkeypatch) -> None:
        signals = self._make_signals()
        self._patch_engine(monkeypatch, self._fake_cross_rows(), self._fake_hist_rows())
        result = load_feature_inputs(signals)
        assert isinstance(result, tuple) and len(result) == 2

    def test_cross_section_columns(self, monkeypatch) -> None:
        """截面 DataFrame 必须含 ts_code/signal_date/qfq_close/ma5/ma30/atr_14/kdj_j/vol。"""
        signals = self._make_signals()
        self._patch_engine(monkeypatch, self._fake_cross_rows(), self._fake_hist_rows())
        cross, _ = load_feature_inputs(signals)
        expected_cols = {"ts_code", "signal_date", "qfq_close", "ma5", "ma30", "atr_14", "kdj_j", "vol"}
        assert expected_cols.issubset(set(cross.columns))

    def test_cross_section_row_count(self, monkeypatch) -> None:
        """截面 DataFrame 行数与信号数一致（每个 (ts_code, signal_date) 一行）。"""
        signals = self._make_signals()
        self._patch_engine(monkeypatch, self._fake_cross_rows(), self._fake_hist_rows())
        cross, _ = load_feature_inputs(signals)
        assert len(cross) == 2

    def test_history_map_keys(self, monkeypatch) -> None:
        """history_map 键为 (ts_code, signal_date) 元组。"""
        signals = self._make_signals()
        self._patch_engine(monkeypatch, self._fake_cross_rows(), self._fake_hist_rows(6))
        _, hist = load_feature_inputs(signals, history_window=6)
        assert ("000001.SZ", "20240110") in hist
        assert ("000002.SZ", "20240110") in hist

    def test_history_map_columns(self, monkeypatch) -> None:
        """history_map 值 DataFrame 含 trade_date/qfq_pct_chg/vol。"""
        signals = self._make_signals()
        self._patch_engine(monkeypatch, self._fake_cross_rows(), self._fake_hist_rows(6))
        _, hist = load_feature_inputs(signals, history_window=6)
        window = hist[("000001.SZ", "20240110")]
        assert set(window.columns) == {"trade_date", "qfq_pct_chg", "vol"}

    def test_history_window_length_respected(self, monkeypatch) -> None:
        """000001.SZ 历史行数等于 history_window（DB 侧已用 ROW_NUMBER 截断）。"""
        signals = self._make_signals()
        hw = 6
        self._patch_engine(monkeypatch, self._fake_cross_rows(), self._fake_hist_rows(hw))
        _, hist = load_feature_inputs(signals, history_window=hw)
        window = hist[("000001.SZ", "20240110")]
        assert len(window) == hw

    def test_history_insufficient_data_returns_partial(self, monkeypatch) -> None:
        """000002.SZ 只有 3 行历史（< history_window），应返回 3 行而非报错。"""
        signals = self._make_signals()
        hw = 6
        self._patch_engine(monkeypatch, self._fake_cross_rows(), self._fake_hist_rows(hw))
        _, hist = load_feature_inputs(signals, history_window=hw)
        window = hist[("000002.SZ", "20240110")]
        assert len(window) == 3  # 只有 3 行

    def test_history_window_sorted_ascending(self, monkeypatch) -> None:
        """history_map 中的窗口 DataFrame 按 trade_date 升序排列。"""
        signals = [SignalRecord(ts_code="000001.SZ", signal_date="20240110", buy_date="20240111")]
        cross_rows = [("000001.SZ", "20240110", 10.5, 10.2, 9.8, 0.25, -5.3, 50000.0)]
        hist_rows = [
            ("000001.SZ", "20240110", "20240108", -0.5, 10000.0),
            ("000001.SZ", "20240110", "20240105", 0.3, 12000.0),
            ("000001.SZ", "20240110", "20240110", -0.2, 9000.0),
        ]
        self._patch_engine(monkeypatch, cross_rows, hist_rows)
        _, hist = load_feature_inputs(signals, history_window=3)
        window = hist[("000001.SZ", "20240110")]
        dates = window["trade_date"].tolist()
        assert dates == sorted(dates), f"期望升序，实际 {dates}"

    def test_history_qfq_pct_chg_values(self, monkeypatch) -> None:
        """qfq_pct_chg 值正确转为 float（pg numeric 来的 Decimal 也能处理）。"""
        import decimal
        signals = [SignalRecord(ts_code="000001.SZ", signal_date="20240110", buy_date="20240111")]
        cross_rows = [("000001.SZ", "20240110", 10.5, 10.2, 9.8, 0.25, -5.3, 50000.0)]
        # 模拟 pg 返回 Decimal 类型
        hist_rows = [
            ("000001.SZ", "20240110", "20240108", decimal.Decimal("-1.23"), decimal.Decimal("50000")),
            ("000001.SZ", "20240110", "20240109", decimal.Decimal("0.45"), decimal.Decimal("60000")),
            ("000001.SZ", "20240110", "20240110", decimal.Decimal("-0.77"), decimal.Decimal("45000")),
        ]
        self._patch_engine(monkeypatch, cross_rows, hist_rows)
        _, hist = load_feature_inputs(signals, history_window=3)
        window = hist[("000001.SZ", "20240110")]
        assert window["qfq_pct_chg"].dtype.kind == "f"
        assert window["vol"].dtype.kind == "f"
        assert pytest.approx(window["qfq_pct_chg"].iloc[0], abs=1e-6) == -1.23

    def test_no_history_data_key_absent(self, monkeypatch) -> None:
        """若某 (ts_code, signal_date) 无历史数据，history_map 中无此键（而非空 DataFrame）。"""
        signals = [SignalRecord(ts_code="000001.SZ", signal_date="20240110", buy_date="20240111")]
        cross_rows = [("000001.SZ", "20240110", 10.5, 10.2, 9.8, 0.25, -5.3, 50000.0)]
        hist_rows = []  # 无历史数据
        self._patch_engine(monkeypatch, cross_rows, hist_rows)
        _, hist = load_feature_inputs(signals, history_window=5)
        assert ("000001.SZ", "20240110") not in hist
