# -*- coding: utf-8 -*-
"""labels/fallback.py 单测（D-1 缺口补齐）。

覆盖 compute_fwd_5d_ret 的新股过滤路径：
  - listing=None 向后兼容（不过滤）
  - new_listing_min_days=0 显式短路（不过滤）
  - listing + min_days > 0：新股 < min_days 被过滤
  - 非法 min_days 抛 ValueError

注：fwd_5d_ret 基础功能（停牌/退市/向量化一致性）已由 test_labels_strategy_aware.py
覆盖，本文件仅聚焦新增的新股过滤分支。
"""

from __future__ import annotations

import pandas as pd
import pytest

from quant_pipeline.labels.fallback import (
    FWD_HORIZON_DAYS,
    FallbackInputs,
    compute_fwd_5d_ret,
)


def _make_two_stock_quotes(
    *,
    n_days: int = 30,
) -> tuple[pd.DataFrame, list[str]]:
    """两只票、n_days 个交易日、close 每日 +1%。"""

    dates = pd.bdate_range("2024-01-02", periods=n_days).strftime("%Y%m%d").tolist()
    rows = []
    for ts in ("000001.SZ", "000002.SZ"):
        for i, d in enumerate(dates):
            close = 10.0 * (1.01 ** i)
            rows.append(
                {
                    "ts_code": ts,
                    "trade_date": d,
                    "close": close,
                    "low": close * 0.999,
                    "adj_factor": 1.0,
                    "close_adj": close,
                    "low_adj": close * 0.999,
                }
            )
    return pd.DataFrame(rows), dates


def test_compute_fwd_5d_ret_listing_none_skips_filter() -> None:
    """listing=None → 向后兼容，不过滤；输出行数与无 listing 时一致。"""

    quotes, _ = _make_two_stock_quotes(n_days=20)
    out_no_listing = compute_fwd_5d_ret(FallbackInputs(daily_quotes=quotes))
    out_listing_none = compute_fwd_5d_ret(
        FallbackInputs(
            daily_quotes=quotes,
            listing=None,
            new_listing_min_days=60,  # 即便给了 min_days，listing=None 也不过滤
        )
    )
    pd.testing.assert_frame_equal(
        out_no_listing.sort_values(["ts_code", "trade_date"]).reset_index(drop=True),
        out_listing_none.sort_values(["ts_code", "trade_date"]).reset_index(drop=True),
        check_dtype=False,
    )


def test_compute_fwd_5d_ret_min_days_zero_skips_filter() -> None:
    """min_days=0 显式短路，即便 listing 非空也不过滤（防 `if min_days:` 误判 0）。"""

    quotes, dates = _make_two_stock_quotes(n_days=20)
    # 让 000002.SZ 是"刚上市"票（list_date = dates[0]）；min_days=0 应不过滤
    listing = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "list_date": dates[0]},
            {"ts_code": "000002.SZ", "list_date": dates[0]},
        ]
    )
    out = compute_fwd_5d_ret(
        FallbackInputs(
            daily_quotes=quotes,
            listing=listing,
            new_listing_min_days=0,
        )
    )
    # 两只票都应保留所有可计算 fwd_5d 的行（n_days - FWD_HORIZON_DAYS）
    expected_rows_per_ts = 20 - FWD_HORIZON_DAYS
    counts = out.groupby("ts_code").size().to_dict()
    assert counts["000001.SZ"] == expected_rows_per_ts
    assert counts["000002.SZ"] == expected_rows_per_ts


def test_compute_fwd_5d_ret_filters_new_listing_below_threshold() -> None:
    """listing + min_days=60：新股 < 60 个交易日 → 过滤；老股保留。

    构造 80 个交易日；000001.SZ 上市 dates[0]（老股，全保留），000002.SZ 上市
    dates[50]（新股，trade_date < dates[50+60] = 越界 → 全部被过滤）。
    """

    quotes, dates = _make_two_stock_quotes(n_days=80)
    listing = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "list_date": dates[0]},
            {"ts_code": "000002.SZ", "list_date": dates[50]},
        ]
    )
    out = compute_fwd_5d_ret(
        FallbackInputs(
            daily_quotes=quotes,
            listing=listing,
            new_listing_min_days=60,
        )
    )
    # 000002.SZ 的所有 trade_date 距 list_date 都 < 60 → 全过滤
    assert "000002.SZ" not in out["ts_code"].unique().tolist()
    # 000001.SZ（老股）保留
    assert "000001.SZ" in out["ts_code"].unique().tolist()


def test_compute_fwd_5d_ret_partial_filter_recent_listing() -> None:
    """部分过滤：新股的 trade_date 在 list_date + min_days 之后的行应保留。

    000002.SZ 上市 dates[5]，min_days=10 → trade_date >= dates[15] 的行保留；
    之前的行被过滤。
    """

    quotes, dates = _make_two_stock_quotes(n_days=30)
    listing = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "list_date": dates[0]},
            {"ts_code": "000002.SZ", "list_date": dates[5]},
        ]
    )
    out = compute_fwd_5d_ret(
        FallbackInputs(
            daily_quotes=quotes,
            listing=listing,
            new_listing_min_days=10,
        )
    )
    out_002 = out[out["ts_code"] == "000002.SZ"]
    # 所有 000002.SZ 的留存行 trade_date 都应 >= dates[15]
    assert (out_002["trade_date"] >= dates[15]).all()


def test_compute_fwd_5d_ret_default_min_days_when_none() -> None:
    """new_listing_min_days=None + listing 非空 → 走默认 60。

    与 explicit min_days=60 行为一致（同样过滤新股）。
    """

    quotes, dates = _make_two_stock_quotes(n_days=80)
    listing = pd.DataFrame(
        [
            {"ts_code": "000001.SZ", "list_date": dates[0]},
            {"ts_code": "000002.SZ", "list_date": dates[50]},
        ]
    )
    out_default = compute_fwd_5d_ret(
        FallbackInputs(
            daily_quotes=quotes,
            listing=listing,
            new_listing_min_days=None,
        )
    )
    out_explicit = compute_fwd_5d_ret(
        FallbackInputs(
            daily_quotes=quotes,
            listing=listing,
            new_listing_min_days=60,
        )
    )
    pd.testing.assert_frame_equal(
        out_default.sort_values(["ts_code", "trade_date"]).reset_index(drop=True),
        out_explicit.sort_values(["ts_code", "trade_date"]).reset_index(drop=True),
        check_dtype=False,
    )


@pytest.mark.parametrize("bad", [-1, 251, "60", 60.0])
def test_compute_fwd_5d_ret_invalid_min_days_raises(bad: object) -> None:
    """非法 min_days → ValueError。仅在 listing 非空时校验才触发。"""

    quotes, dates = _make_two_stock_quotes(n_days=20)
    listing = pd.DataFrame([{"ts_code": "000001.SZ", "list_date": dates[0]}])
    with pytest.raises(ValueError, match="new_listing_min_days"):
        compute_fwd_5d_ret(
            FallbackInputs(
                daily_quotes=quotes,
                listing=listing,
                new_listing_min_days=bad,  # type: ignore[arg-type]
            )
        )


def test_compute_fwd_5d_ret_listing_none_with_invalid_min_days_does_not_raise() -> None:
    """listing=None 时跳过过滤，连 _validate_min_days 都不走 → 非法值不抛错。

    这是有意的：保持完全向后兼容老调用方（不传 listing 时即便参数有遗留也不影响）。
    """

    quotes, _ = _make_two_stock_quotes(n_days=20)
    # 不应抛错
    out = compute_fwd_5d_ret(
        FallbackInputs(
            daily_quotes=quotes,
            listing=None,
            new_listing_min_days=-1,  # 非法值，但 listing=None 时被跳过
        )
    )
    assert not out.empty
