# -*- coding: utf-8 -*-
"""labels/runner.py 单测。

覆盖 spec 04 §item-10 空数据硬约束：
  - quotes 为空 → compute_labels 抛 RuntimeError
  - labels_df 为空 → compute_labels 抛 RuntimeError
通过 monkeypatch 替换 _load_* DB IO 函数，不接触真实 DB。
"""

from __future__ import annotations

import pandas as pd
import pytest

from quant_pipeline.labels import runner as labels_runner


def _empty_quotes() -> pd.DataFrame:
    return pd.DataFrame(
        columns=["ts_code", "trade_date", "close", "low",
                 "adj_factor", "close_adj", "low_adj"]
    )


def _patch_loaders(
    monkeypatch: pytest.MonkeyPatch,
    *,
    quotes: pd.DataFrame,
) -> None:
    monkeypatch.setattr(labels_runner, "_compute_end_padded", lambda end: end)
    monkeypatch.setattr(labels_runner, "_load_daily_quotes", lambda s, e: quotes)
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
