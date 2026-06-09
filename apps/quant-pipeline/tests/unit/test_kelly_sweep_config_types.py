"""TDD：SweepConfig + kelly_sweep 类型契约冒烟测试。

不连库、不查 Tushare、不依赖任何运行时状态。
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from quant_pipeline.research.kelly_sweep import (
    Bar,
    BaseTrigger,
    ForwardPath,
    MetricResult,
    SweepConfig,
    TradeResult,
)


# ---------------------------------------------------------------------------
# BaseTrigger
# ---------------------------------------------------------------------------


class TestBaseTrigger:
    def test_default_is_kdj_j_lt_0(self) -> None:
        t = BaseTrigger.default()
        assert t.field == "kdj_j"
        assert t.op == "lt"
        assert t.value == 0.0

    def test_explicit_construction(self) -> None:
        t = BaseTrigger(field="rsi_14", op="lte", value=30.0)
        assert t.field == "rsi_14"
        assert t.op == "lte"
        assert t.value == 30.0

    def test_frozen_immutable(self) -> None:
        t = BaseTrigger.default()
        with pytest.raises((AttributeError, TypeError)):
            t.value = 5.0  # type: ignore[misc]


# ---------------------------------------------------------------------------
# SweepConfig — 默认值
# ---------------------------------------------------------------------------


class TestSweepConfigDefaults:
    def test_base_trigger_default(self) -> None:
        cfg = SweepConfig()
        assert cfg.base_trigger.field == "kdj_j"
        assert cfg.base_trigger.op == "lt"
        assert cfg.base_trigger.value == 0.0

    def test_universe_default(self) -> None:
        assert SweepConfig().universe == "all"

    def test_max_window_default(self) -> None:
        assert SweepConfig().max_window == 20

    def test_max_entry_filters_default(self) -> None:
        assert SweepConfig().max_entry_filters == 2

    def test_train_range_default(self) -> None:
        assert SweepConfig().train_range == ("20230101", "20241231")

    def test_valid_range_default(self) -> None:
        assert SweepConfig().valid_range == ("20250101", "20260608")

    def test_min_samples_default(self) -> None:
        assert SweepConfig().min_samples == 300

    def test_bootstrap_iters_default(self) -> None:
        assert SweepConfig().bootstrap_iters == 1000

    def test_same_day_rule_default(self) -> None:
        assert SweepConfig().same_day_rule == "sl_first"

    def test_rs_benchmark_default(self) -> None:
        assert SweepConfig().rs_benchmark == ["hs300"]

    def test_rs_lookback_default(self) -> None:
        assert SweepConfig().rs_lookback == 5

    def test_top_k_default(self) -> None:
        assert SweepConfig().top_k == 30


# ---------------------------------------------------------------------------
# SweepConfig — 校验生效
# ---------------------------------------------------------------------------


class TestSweepConfigValidation:
    def test_max_window_zero_rejected(self) -> None:
        with pytest.raises(ValidationError):
            SweepConfig(max_window=0)

    def test_max_window_negative_rejected(self) -> None:
        with pytest.raises(ValidationError):
            SweepConfig(max_window=-1)

    def test_min_samples_zero_rejected(self) -> None:
        with pytest.raises(ValidationError):
            SweepConfig(min_samples=0)

    def test_bootstrap_iters_zero_rejected(self) -> None:
        with pytest.raises(ValidationError):
            SweepConfig(bootstrap_iters=0)

    def test_rs_lookback_zero_rejected(self) -> None:
        with pytest.raises(ValidationError):
            SweepConfig(rs_lookback=0)

    def test_train_range_bad_format_rejected(self) -> None:
        with pytest.raises(ValidationError):
            SweepConfig(train_range=("2023-01-01", "20241231"))

    def test_valid_range_bad_format_rejected(self) -> None:
        with pytest.raises(ValidationError):
            SweepConfig(valid_range=("20250101", "2026/06/08"))

    def test_train_range_start_after_end_rejected(self) -> None:
        with pytest.raises(ValidationError):
            SweepConfig(train_range=("20241231", "20230101"))

    def test_valid_range_start_after_end_rejected(self) -> None:
        with pytest.raises(ValidationError):
            SweepConfig(valid_range=("20260608", "20250101"))

    def test_train_start_after_valid_start_rejected(self) -> None:
        # train 起点晚于 valid 起点
        with pytest.raises(ValidationError):
            SweepConfig(
                train_range=("20250601", "20251231"),
                valid_range=("20230101", "20241231"),
            )

    def test_universe_list_accepted(self) -> None:
        cfg = SweepConfig(universe=["000001.SZ", "600000.SH"])
        assert cfg.universe == ["000001.SZ", "600000.SH"]

    def test_same_day_rule_tp_first_accepted(self) -> None:
        cfg = SweepConfig(same_day_rule="tp_first")
        assert cfg.same_day_rule == "tp_first"

    def test_same_day_rule_invalid_rejected(self) -> None:
        with pytest.raises(ValidationError):
            SweepConfig(same_day_rule="both")  # type: ignore[arg-type]

    def test_rs_benchmark_multi_accepted(self) -> None:
        cfg = SweepConfig(rs_benchmark=["hs300", "zz500"])
        assert set(cfg.rs_benchmark) == {"hs300", "zz500"}

    def test_train_start_equal_valid_start_accepted(self) -> None:
        # 边界：train_start == valid_start 合法
        cfg = SweepConfig(
            train_range=("20230101", "20241231"),
            valid_range=("20230101", "20260608"),
        )
        assert cfg.train_range[0] == cfg.valid_range[0]


# ---------------------------------------------------------------------------
# Bar
# ---------------------------------------------------------------------------


class TestBar:
    def test_construction(self) -> None:
        bar = Bar(
            trade_date="20240101",
            qfq_open=10.0,
            qfq_high=11.0,
            qfq_low=9.5,
            qfq_close=10.5,
        )
        assert bar.trade_date == "20240101"
        assert bar.qfq_high == 11.0

    def test_frozen(self) -> None:
        bar = Bar(
            trade_date="20240101",
            qfq_open=10.0,
            qfq_high=11.0,
            qfq_low=9.5,
            qfq_close=10.5,
        )
        with pytest.raises((AttributeError, TypeError)):
            bar.qfq_close = 99.0  # type: ignore[misc]


# ---------------------------------------------------------------------------
# ForwardPath
# ---------------------------------------------------------------------------


class TestForwardPath:
    def _make_bar(self, date: str) -> Bar:
        return Bar(
            trade_date=date,
            qfq_open=10.0,
            qfq_high=11.0,
            qfq_low=9.5,
            qfq_close=10.5,
        )

    def test_construction_minimal(self) -> None:
        fp = ForwardPath(
            ts_code="000001.SZ",
            signal_date="20240103",
            buy_date="20240104",
            buy_price=10.0,
            bars=[self._make_bar("20240104"), self._make_bar("20240105")],
            delist_date=None,
            atr14_at_signal=None,
        )
        assert fp.ts_code == "000001.SZ"
        assert len(fp.bars) == 2
        assert fp.delist_date is None
        assert fp.atr14_at_signal is None

    def test_construction_with_optionals(self) -> None:
        fp = ForwardPath(
            ts_code="000001.SZ",
            signal_date="20240103",
            buy_date="20240104",
            buy_price=10.0,
            bars=[self._make_bar("20240104")],
            delist_date="20240201",
            atr14_at_signal=0.35,
        )
        assert fp.delist_date == "20240201"
        assert fp.atr14_at_signal == 0.35


# ---------------------------------------------------------------------------
# TradeResult
# ---------------------------------------------------------------------------


class TestTradeResult:
    def test_construction(self) -> None:
        tr = TradeResult(
            ts_code="000001.SZ",
            signal_date="20240103",
            buy_date="20240104",
            exit_date="20240115",
            buy_price=10.0,
            exit_price=11.0,
            ret=0.1,
            hold_days=11,
            exit_reason="tp",
        )
        assert tr.ret == 0.1
        assert tr.exit_reason == "tp"

    def test_all_exit_reasons_valid(self) -> None:
        for reason in ("max_hold", "delist", "tp", "sl", "trailing", "atr"):
            tr = TradeResult(
                ts_code="000001.SZ",
                signal_date="20240103",
                buy_date="20240104",
                exit_date="20240115",
                buy_price=10.0,
                exit_price=9.0,
                ret=-0.1,
                hold_days=11,
                exit_reason=reason,  # type: ignore[arg-type]
            )
            assert tr.exit_reason == reason


# ---------------------------------------------------------------------------
# MetricResult
# ---------------------------------------------------------------------------


class TestMetricResult:
    def test_construction_full(self) -> None:
        m = MetricResult(
            n=100,
            wins=60,
            win_rate=0.6,
            avg_win=0.05,
            avg_loss=-0.03,
            payoff_b=5 / 3,
            profit_factor=3.0,
            kelly=0.6 - 0.4 / (5 / 3),
        )
        assert m.n == 100
        assert m.wins == 60
        assert m.win_rate == pytest.approx(0.6)

    def test_construction_none_payoff(self) -> None:
        """无亏损样本时 payoff_b / kelly 允许为 None。"""
        m = MetricResult(
            n=10,
            wins=10,
            win_rate=1.0,
            avg_win=0.05,
            avg_loss=None,
            payoff_b=None,
            profit_factor=None,
            kelly=None,
        )
        assert m.payoff_b is None
        assert m.kelly is None

    def test_construction_empty(self) -> None:
        """n=0 时所有可选指标均为 None。"""
        m = MetricResult(
            n=0,
            wins=0,
            win_rate=None,
            avg_win=None,
            avg_loss=None,
            payoff_b=None,
            profit_factor=None,
            kelly=None,
        )
        assert m.n == 0
        assert m.win_rate is None
