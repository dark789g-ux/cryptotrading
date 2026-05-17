# -*- coding: utf-8 -*-
"""strategy/exit_rules.py 单测。

覆盖 4 种出场路径：
  1. MA5 出场（ma5_break）
  2. -8% 止损（stop_loss）
  3. 最大持有期到期（max_hold）
  4. 强制平仓（force_close）—— 三种触发：
     a) 退市公告（force_close_date 触发）
     b) 持仓期内 is_delisted 标记
     c) 走完所有日子未触发任何规则（数据末尾兜底）

外加 combine_rules first-match 顺序验证 + 涨跌停顺延。
"""

from __future__ import annotations

import pandas as pd

from quant_pipeline.strategy.exit_rules import (
    EXIT_BELOW_MA5,
    EXIT_FORCE_CLOSE,
    EXIT_MAX_HOLD,
    EXIT_STOP_LOSS,
    MA5BreakRule,
    MaxHoldRule,
    StopLossRule,
    combine_rules,
    default_rules,
    simulate_exit,
)


def _build_quotes(rows: list[dict]) -> pd.DataFrame:
    """简化测试构造：rows = [{trade_date, close, low?, ...}, ...]，
    返回标准 DataFrame（不预填 ma5，simulate_exit 会内部补齐）。"""

    df = pd.DataFrame(rows)
    df["trade_date"] = df["trade_date"].astype(str)
    return df


def test_ma5_break_triggers_exit() -> None:
    """T+5 后 close 跌破 MA5 → ma5_break 路径。"""

    rows = [
        {"trade_date": "20240102", "close": 10.0, "low": 9.8},
        {"trade_date": "20240103", "close": 10.2, "low": 10.0},
        {"trade_date": "20240104", "close": 10.4, "low": 10.2},
        {"trade_date": "20240105", "close": 10.6, "low": 10.4},
        {"trade_date": "20240108", "close": 10.8, "low": 10.6},
        # 第 6 日 MA5=(10.2+10.4+10.6+10.8+11.0)/5=10.6；close=11.0 > MA5
        {"trade_date": "20240109", "close": 11.0, "low": 10.8},
        # 第 7 日 MA5=(10.4+10.6+10.8+11.0+10.2)/5=10.6；close=10.2 < MA5 → 触发
        {"trade_date": "20240110", "close": 10.2, "low": 10.0},
    ]
    quotes = _build_quotes(rows)
    out = simulate_exit(
        buy_date="20240102",
        ts_code="000001.SZ",
        prices_df=quotes,
        rules=default_rules(),
    )
    assert out is not None
    assert out.exit_reason == EXIT_BELOW_MA5
    assert out.exit_date == "20240110"
    assert out.exit_price == 10.2


def test_stop_loss_triggers_on_low_penetration() -> None:
    """当日 low 触及 -8% → stop_loss 路径，成交价 = min(stop_price, low)。"""

    rows = [
        {"trade_date": "20240102", "close": 10.0, "low": 9.9},
        # low=9.0 vs stop=9.2 → 穿透，按 low=9.0 成交
        {"trade_date": "20240103", "close": 9.5, "low": 9.0},
    ]
    quotes = _build_quotes(rows)
    out = simulate_exit(
        buy_date="20240102",
        ts_code="000001.SZ",
        prices_df=quotes,
        rules=default_rules(),
    )
    assert out is not None
    assert out.exit_reason == EXIT_STOP_LOSS
    assert out.exit_date == "20240103"
    assert out.exit_price == 9.0


def test_max_hold_triggers_on_day_20() -> None:
    """持仓 20 个交易日触发 max_hold。"""

    # 构造 25 个交易日，全部单调缓涨，不会跌破 MA5、不会触发止损
    dates = pd.bdate_range("2024-01-02", periods=25).strftime("%Y%m%d").tolist()
    rows = [
        {"trade_date": d, "close": 10.0 + 0.01 * i, "low": 9.99 + 0.01 * i}
        for i, d in enumerate(dates)
    ]
    quotes = _build_quotes(rows)
    out = simulate_exit(
        buy_date=dates[0],
        ts_code="000001.SZ",
        prices_df=quotes,
        rules=default_rules(),
    )
    assert out is not None
    assert out.exit_reason == EXIT_MAX_HOLD
    assert out.hold_days == 20
    # 第 21 个交易日为出场日（hold_days=20 时触发）
    assert out.exit_date == dates[20]


def test_force_close_on_data_end() -> None:
    """走完所有日子未触发任何规则 → force_close 路径（数据末尾兜底）。"""

    rows = [
        {"trade_date": "20240102", "close": 10.0, "low": 9.9},
        {"trade_date": "20240103", "close": 10.05, "low": 9.95},
        {"trade_date": "20240104", "close": 10.10, "low": 10.00},
    ]
    quotes = _build_quotes(rows)
    out = simulate_exit(
        buy_date="20240102",
        ts_code="000001.SZ",
        prices_df=quotes,
        rules=default_rules(),
    )
    assert out is not None
    assert out.exit_reason == EXIT_FORCE_CLOSE
    assert out.exit_date == "20240104"


def test_force_close_on_delisting_flag() -> None:
    """持仓期内某日 is_delisted=True → force_close 路径。"""

    rows = [
        {"trade_date": "20240102", "close": 10.0, "low": 9.9},
        {"trade_date": "20240103", "close": 10.05, "low": 9.95},
        {
            "trade_date": "20240104",
            "close": 9.5,
            "low": 9.3,
            "is_delisted": True,
        },
    ]
    quotes = _build_quotes(rows)
    out = simulate_exit(
        buy_date="20240102",
        ts_code="000001.SZ",
        prices_df=quotes,
        rules=default_rules(),
    )
    assert out is not None
    assert out.exit_reason == EXIT_FORCE_CLOSE
    assert out.exit_date == "20240104"


def test_force_close_on_external_force_date() -> None:
    """force_close_date 触发强制平仓（退市公告等外部输入）。"""

    rows = [
        {"trade_date": "20240102", "close": 10.0, "low": 9.9},
        {"trade_date": "20240103", "close": 10.05, "low": 9.95},
        {"trade_date": "20240104", "close": 10.10, "low": 10.00},
    ]
    quotes = _build_quotes(rows)
    out = simulate_exit(
        buy_date="20240102",
        ts_code="000001.SZ",
        prices_df=quotes,
        rules=default_rules(),
        force_close_date="20240104",
    )
    assert out is not None
    assert out.exit_reason == EXIT_FORCE_CLOSE
    assert out.exit_date == "20240104"


def test_suspended_days_do_not_advance_hold_days() -> None:
    """停牌日 hold_days 不递增、规则不触发；走完数据末尾按 force_close。"""

    rows = [{"trade_date": "20240102", "close": 10.0, "low": 9.9}]
    # 22 个连续交易日全部停牌
    dates_suspended = pd.bdate_range("2024-01-03", periods=22).strftime("%Y%m%d").tolist()
    for d in dates_suspended:
        rows.append(
            {"trade_date": d, "close": 10.0, "low": 10.0, "is_suspended": True}
        )
    # 第 23 日复牌
    rows.append(
        {"trade_date": "20240204", "close": 10.5, "low": 10.4, "is_suspended": False}
    )
    quotes = _build_quotes(rows)
    out = simulate_exit(
        buy_date="20240102",
        ts_code="000001.SZ",
        prices_df=quotes,
        rules=default_rules(),
    )
    # 只有复牌当日 hold_days=1，未触发任何规则 → force_close 兜底
    assert out is not None
    assert out.exit_reason == EXIT_FORCE_CLOSE
    assert out.hold_days == 1


def test_combine_rules_first_match_priority() -> None:
    """同日多规则同时触发时，按 combine_rules 顺序取第一个。

    构造：stop_loss + ma5_break 同日都成立。
    顺序 [StopLoss, MA5] → stop_loss 优先；顺序 [MA5, StopLoss] → ma5_break 优先。
    """

    # 构造：入场 close=10.0；前 5 日单调上涨建立 MA5；第 6 日 close 仍高于 MA5 但
    # low=9.0 触发 stop_loss；第 7 日同时跌破 MA5 且 low=8.5 → 同日两规则都成立。
    rows = [
        {"trade_date": "20240102", "close": 10.0, "low": 10.0},
        {"trade_date": "20240103", "close": 10.5, "low": 10.4},
        {"trade_date": "20240104", "close": 11.0, "low": 10.9},
        {"trade_date": "20240105", "close": 11.5, "low": 11.4},
        {"trade_date": "20240108", "close": 12.0, "low": 11.9},
        # 第 6 日 close=11.8 > MA5(11.4)；low=10.5 > stop_price(9.2) → 不触发
        {"trade_date": "20240109", "close": 11.8, "low": 10.5},
        # 第 7 日 MA5=(10.5+11+11.5+12+11.8)/5=11.36；close=8.5 < MA5；
        # low=8.5 < stop(9.2) → 同日 ma5_break + stop_loss 都成立
        {"trade_date": "20240110", "close": 8.5, "low": 8.5},
    ]
    quotes = _build_quotes(rows)

    out1 = simulate_exit(
        buy_date="20240102",
        ts_code="000001.SZ",
        prices_df=quotes,
        rules=combine_rules([StopLossRule(), MA5BreakRule(), MaxHoldRule()]),
    )
    assert out1 is not None
    assert out1.exit_reason == EXIT_STOP_LOSS

    out2 = simulate_exit(
        buy_date="20240102",
        ts_code="000001.SZ",
        prices_df=quotes,
        rules=combine_rules([MA5BreakRule(), StopLossRule(), MaxHoldRule()]),
    )
    assert out2 is not None
    assert out2.exit_reason == EXIT_BELOW_MA5


def test_exit_postponed_on_limit_down_day() -> None:
    """触发日 is_limit_down=True → 顺延到下一个非跌停 / 非停牌日成交，但 reason 保留。"""

    rows = [
        {"trade_date": "20240102", "close": 10.0, "low": 10.0},
        {"trade_date": "20240103", "close": 10.2, "low": 10.1},
        {"trade_date": "20240104", "close": 10.4, "low": 10.3},
        {"trade_date": "20240105", "close": 10.6, "low": 10.5},
        {"trade_date": "20240108", "close": 10.8, "low": 10.7},
        # 第 6 日跌停且跌破 MA5
        {"trade_date": "20240109", "close": 9.7, "low": 9.7, "is_limit_down": True},
        # 第 7 日正常成交
        {"trade_date": "20240110", "close": 9.9, "low": 9.8},
    ]
    quotes = _build_quotes(rows)
    out = simulate_exit(
        buy_date="20240102",
        ts_code="000001.SZ",
        prices_df=quotes,
        rules=combine_rules([MA5BreakRule(), MaxHoldRule()]),  # 排除 stop_loss 避免干扰
    )
    assert out is not None
    assert out.exit_reason == EXIT_BELOW_MA5
    assert out.exit_date == "20240110"
    assert out.exit_price == 9.9
