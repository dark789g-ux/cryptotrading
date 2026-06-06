"""labels/direction_3class.py 单测（分类后移改造后，spec 2026-06-05）。

分类后移后 direction_3class.py 只保留 legacy 解码常量：
  SCHEME_DIR3_BAND / SCHEME_DIR3_TERCILE / DIR3_BAND_EPS / DIR3_HOLD_DAYS。

分桶数学已迁入 classify.py（见 test_classify.py）。

本文件改造后覆盖：
  - direction_3class 常量可正常导入（向后兼容）
  - fwd_ret(h=1) 一致性：== 原 dir3 内部次日收益 close_adj(t+1)/close_adj(t)-1
  - fwd_ret(h=5) 一致性：== 原 fwd_5d_ret 结果
  - compute_dir3_labels 已删除（不再产出离散标签）；测试不再调用它
  - runner 仍支持 legacy dir3_band / dir3_tercile scheme（从 compute_labels 调用路径确认
    已移除，旧 DB 数据靠历史数据保留，不靠重跑旧代码）
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any

import pandas as pd
import pytest

from quant_pipeline.labels import runner as labels_runner
from quant_pipeline.labels.direction_3class import (
    DIR3_BAND_EPS,
    DIR3_HOLD_DAYS,
    SCHEME_DIR3_BAND,
    SCHEME_DIR3_TERCILE,
)
from quant_pipeline.labels.fallback import (
    SCHEME_FWD_5D_RET,
    FallbackInputs,
    compute_fwd_5d_ret,
)

# 类别 id（与 direction_3class 向后兼容常量对齐）
_DOWN = 0.0
_FLAT = 1.0
_UP = 2.0


# ─────────────────────── 常量向后兼容 ─────────────────────────────────────────

def test_constants_importable() -> None:
    """direction_3class 常量可正常导入（向后兼容，供已有代码引用）。"""
    assert SCHEME_DIR3_BAND == "dir3_band"
    assert SCHEME_DIR3_TERCILE == "dir3_tercile"
    assert DIR3_BAND_EPS == 0.005
    assert DIR3_HOLD_DAYS == 1


def test_compute_dir3_labels_not_exported() -> None:
    """compute_dir3_labels 已从 direction_3class 删除（分类后移，不再产出离散标签）。"""
    import quant_pipeline.labels.direction_3class as d3m
    assert not hasattr(d3m, "compute_dir3_labels"), (
        "compute_dir3_labels 已按 spec 删除，不应还存在于 direction_3class"
    )


# ─────────────────────── fwd_ret 一致性测试 ───────────────────────────────────

def _quote_row(ts: str, date: str, close_adj: float) -> dict:
    return {
        "ts_code": ts,
        "trade_date": date,
        "close": close_adj,
        "low": close_adj * 0.99,
        "adj_factor": 1.0,
        "close_adj": close_adj,
        "low_adj": close_adj * 0.99,
    }


def _multi_stock_quotes(
    stocks: list[tuple[str, list[float]]],
    start_date: str = "20240102",
) -> pd.DataFrame:
    """构造多只票的 daily_quote DataFrame。"""
    rows = []
    for ts, closes in stocks:
        dates = pd.bdate_range(start_date, periods=len(closes)).strftime("%Y%m%d").tolist()
        for d, c in zip(dates, closes, strict=True):
            rows.append(_quote_row(ts, d, c))
    return pd.DataFrame(rows)


def test_fwd_ret_h1_equals_dir3_next_day_return() -> None:
    """fwd_ret(h=1) 一致性：== 原 dir3 内部次日收益 close_adj(t+1)/close_adj(t)-1。

    dir3 内部算 r = close_adj(t+1)/close_adj(t) - 1（后复权，单交易日前向收益）。
    fwd_ret(h=1) 算法一致（同一函数 compute_fwd_5d_ret 以 horizon=1 调用）。
    """
    quotes = _multi_stock_quotes([("000001.SZ", [10.0, 10.5, 11.0])])
    inputs = FallbackInputs(daily_quotes=quotes)

    # fwd_ret h=1（次日收益）
    df_h1 = compute_fwd_5d_ret(inputs, fwd_horizon_days=1)
    # 手动计算 r = close_adj(t+1)/close_adj(t) - 1
    df_sorted = quotes.sort_values(["ts_code", "trade_date"]).reset_index(drop=True)
    g = df_sorted.groupby("ts_code", sort=False)
    r_manual = g["close_adj"].shift(-1) / df_sorted["close_adj"] - 1.0
    keep = r_manual.notna()
    expected_values = r_manual[keep].tolist()

    assert len(df_h1) == len(expected_values)
    for actual, expected in zip(df_h1["value"].tolist(), expected_values, strict=False):
        assert abs(actual - expected) < 1e-10, f"fwd_ret h=1 值不一致: {actual} != {expected}"


def test_fwd_ret_h5_equals_original_fwd_5d_ret() -> None:
    """fwd_ret(h=5) 一致性：== 原 fwd_5d_ret 结果（相同 horizon=5 默认值）。

    h=5 是 legacy 路径：scheme='fwd_5d_ret'（legacy 别名，守哈希不漂移）。
    """
    quotes = _multi_stock_quotes([
        ("000001.SZ", [10.0, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6]),
    ])
    inputs = FallbackInputs(daily_quotes=quotes)

    # 原 fwd_5d_ret 默认（horizon=5）
    df_default = compute_fwd_5d_ret(inputs)
    # fwd_ret h=5（显式传 horizon=5）
    df_h5 = compute_fwd_5d_ret(inputs, fwd_horizon_days=5)

    pd.testing.assert_frame_equal(
        df_default.sort_values(["trade_date", "ts_code"]).reset_index(drop=True),
        df_h5.sort_values(["trade_date", "ts_code"]).reset_index(drop=True),
    )
    # 两者的 scheme 列均为 'fwd_5d_ret'（legacy 别名）
    assert (df_default["scheme"] == SCHEME_FWD_5D_RET).all()
    assert (df_h5["scheme"] == SCHEME_FWD_5D_RET).all()


def test_fwd_ret_h1_scheme_is_fwd_ret_h1() -> None:
    """fwd_ret(h=1) 写入 scheme='fwd_ret_h1'（新串，非 legacy 别名）。"""
    quotes = _multi_stock_quotes([("000001.SZ", [10.0, 10.1])])
    df = compute_fwd_5d_ret(FallbackInputs(daily_quotes=quotes), fwd_horizon_days=1)
    assert len(df) == 1
    assert df["scheme"].iloc[0] == "fwd_ret_h1"


def test_fwd_ret_h5_scheme_is_fwd_5d_ret() -> None:
    """fwd_ret(h=5) 写入 scheme='fwd_5d_ret'（legacy 别名，守哈希不漂移）。"""
    quotes = _multi_stock_quotes([("000001.SZ", [10.0, 10.1, 10.2, 10.3, 10.4, 10.5])])
    df = compute_fwd_5d_ret(FallbackInputs(daily_quotes=quotes), fwd_horizon_days=5)
    assert len(df) >= 1
    assert (df["scheme"] == SCHEME_FWD_5D_RET).all()


# ─────────────────────── runner 新路径 ────────────────────────────────────────

@contextmanager
def _noop_session_scope() -> Any:
    """labels_runner.session_scope 的内存替身（不接触真实 DB）。"""

    yield None


def _patch_loaders(monkeypatch: pytest.MonkeyPatch, quotes: pd.DataFrame) -> None:
    """桩掉所有 DB IO，只留 compute_fwd_5d_ret 逻辑。

    增量缺口循环（spec 02）默认会查 materialized / trading_days / trade_cal；这里把
    已物化置空、trading_days=[start,end] → gap_subranges 必回单一子区间 (start,end)，
    等价整段重算（与本文件 fwd_ret_h1 一致性断言所依赖的"整段"语义对齐）。
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
    # 全局交易日历（窗口无关 new_listing 计数，bug3）：listing 为空时 filter 短路，
    # 日历值不影响结果，返回 quotes 自身日期作占位。
    monkeypatch.setattr(
        labels_runner, "_load_trade_calendar",
        lambda: sorted(quotes["trade_date"].astype(str).unique().tolist()),
    )
    monkeypatch.setattr(labels_runner, "session_scope", _noop_session_scope)
    monkeypatch.setattr(
        labels_runner, "query_materialized_dates",
        lambda s, table, col, val, start, end: set(),
    )
    monkeypatch.setattr(
        labels_runner, "query_trading_days",
        lambda s, start, end: [start, end],
    )


def test_runner_fwd_ret_h1_scheme(monkeypatch: pytest.MonkeyPatch) -> None:
    """runner 支持 fwd_ret_h1 scheme，物化连续值（非离散 0/1/2）。"""
    quotes = _multi_stock_quotes([("000001.SZ", [10.0, 10.5, 11.0])])
    _patch_loaders(monkeypatch, quotes)
    captured: dict[str, object] = {}

    def _fake_upsert(rows: list[dict]) -> int:
        captured["rows"] = rows
        return len(rows)

    monkeypatch.setattr(labels_runner, "_upsert_labels", _fake_upsert)
    n = labels_runner.compute_labels(scheme="fwd_ret_h1", date_range="20240102:20240103")
    assert n > 0
    rows = captured["rows"]
    # 新路径：scheme='fwd_ret_h1'（非 dir3_band）；value 为连续涨跌幅（非 {0,1,2}）
    assert all(r["scheme"] == "fwd_ret_h1" for r in rows)
    for row in rows:
        val = row["value"]
        # 连续涨跌幅不应是精确整数（除非恰好整数，但这里是 10.5/10.0-1=0.05）
        assert isinstance(val, float)
        # 确认不是离散类别 {0,1,2}
        assert val not in (_DOWN, _FLAT, _UP) or val == 0.05  # 若恰好是，靠 scheme 区分


def test_runner_dir3_band_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    """runner compute_labels 不再支持 dir3_band（分类后移，历史数据靠 DB 保留）。"""
    quotes = _multi_stock_quotes([("000001.SZ", [10.0, 10.5])])
    _patch_loaders(monkeypatch, quotes)
    with pytest.raises(NotImplementedError, match="dir3_band"):
        labels_runner.compute_labels(scheme="dir3_band", date_range="20240102:20240102")


def test_runner_dir3_tercile_not_implemented(monkeypatch: pytest.MonkeyPatch) -> None:
    """runner compute_labels 不再支持 dir3_tercile。"""
    quotes = _multi_stock_quotes([("000001.SZ", [10.0, 10.5])])
    _patch_loaders(monkeypatch, quotes)
    with pytest.raises(NotImplementedError, match="dir3_tercile"):
        labels_runner.compute_labels(scheme="dir3_tercile", date_range="20240102:20240102")
