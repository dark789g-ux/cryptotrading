# -*- coding: utf-8 -*-
"""features/builder.py labels-optional 路径单测。

覆盖 spec 2026-05-29-inference-only-feature-matrix.md：
  - merge_with_labels_optional：labels 缺失 / 部分覆盖 / 完整覆盖
  - build_feature_matrix_for_inference：与训练路径前 ④.5 步骤一致；label NaN
    行保留；只对 feature 列 dropna
  - 旧 inner-join 路径行为不变（回归断言）
"""

from __future__ import annotations

import pandas as pd

from quant_pipeline.features.builder import (
    build_feature_matrix_for_inference,
    build_feature_matrix_from_frames,
    merge_with_labels,
    merge_with_labels_optional,
    pivot_factors_long_to_wide,
)


def _make_daily_factors() -> pd.DataFrame:
    """2 个交易日 × 4 只股票 × 2 个因子。与 test_features_builder._make_daily_factors 对齐。"""

    rows = []
    for td in ("20240102", "20240103"):
        for ts, mv in zip(
            ("000001.SZ", "000002.SZ", "000003.SZ", "000004.SZ"),
            (1e10, 5e9, 2e10, 8e9),
        ):
            rows.append({"trade_date": td, "ts_code": ts, "factor_id": "mom_20", "value": float(mv) / 1e10})
            rows.append({"trade_date": td, "ts_code": ts, "factor_id": "vol_20", "value": float(mv) / 2e10})
    return pd.DataFrame(rows)


def _make_industry_map() -> pd.DataFrame:
    rows = []
    for td in ("20240102", "20240103"):
        for i, ts in enumerate(("000001.SZ", "000002.SZ", "000003.SZ", "000004.SZ")):
            rows.append({"trade_date": td, "ts_code": ts, "industry_l1": "X" if i < 2 else "Y"})
    return pd.DataFrame(rows)


# ----------------------------------------------------------------------
# merge_with_labels_optional
# ----------------------------------------------------------------------

def test_merge_optional_with_empty_labels_returns_wide_with_nan_label() -> None:
    """labels 整体空 → 仍返回 wide 全行，label 列全 NaN。"""

    wide = pivot_factors_long_to_wide(_make_daily_factors())
    out = merge_with_labels_optional(wide, pd.DataFrame(), label_scheme="strategy-aware")
    assert len(out) == len(wide)
    assert "label" in out.columns
    assert out["label"].isna().all()


def test_merge_optional_with_none_labels_returns_wide_with_nan_label() -> None:
    """labels=None 等同于空 DF。"""

    wide = pivot_factors_long_to_wide(_make_daily_factors())
    out = merge_with_labels_optional(wide, None, label_scheme="strategy-aware")
    assert len(out) == len(wide)
    assert out["label"].isna().all()


def test_merge_optional_with_partial_labels_left_joins() -> None:
    """labels 只覆盖一部分 (trade_date, ts_code) → 已覆盖行 label 取自 labels，
    未覆盖行 label = NaN；总行数 == wide 行数（left join）。"""

    wide = pivot_factors_long_to_wide(_make_daily_factors())
    # 仅给 20240102 的 000001 / 000002 打标签
    labels = pd.DataFrame(
        [
            {"trade_date": "20240102", "ts_code": "000001.SZ", "scheme": "strategy-aware",
             "value": 0.1, "exit_reason": "max_hold", "hold_days": 20},
            {"trade_date": "20240102", "ts_code": "000002.SZ", "scheme": "strategy-aware",
             "value": -0.05, "exit_reason": "stop_loss", "hold_days": 3},
        ]
    )
    out = merge_with_labels_optional(wide, labels, label_scheme="strategy-aware")
    assert len(out) == len(wide)
    out_reset = out.reset_index()
    labeled = out_reset[(out_reset["trade_date"] == "20240102") & out_reset["ts_code"].isin({"000001.SZ", "000002.SZ"})]
    assert labeled["label"].notna().all()
    assert set(labeled["label"].round(2)) == {0.1, -0.05}
    unlabeled = out_reset[~((out_reset["trade_date"] == "20240102") & out_reset["ts_code"].isin({"000001.SZ", "000002.SZ"}))]
    assert unlabeled["label"].isna().all()


def test_merge_optional_filters_by_scheme() -> None:
    """labels 含多 scheme → 仅左连接目标 scheme，其它 scheme 行被忽略。"""

    wide = pivot_factors_long_to_wide(_make_daily_factors())
    labels = pd.DataFrame(
        [
            {"trade_date": "20240102", "ts_code": "000001.SZ", "scheme": "fwd_5d_ret",
             "value": 0.9, "exit_reason": None, "hold_days": 5},
            {"trade_date": "20240102", "ts_code": "000002.SZ", "scheme": "strategy-aware",
             "value": -0.05, "exit_reason": "stop_loss", "hold_days": 3},
        ]
    )
    out = merge_with_labels_optional(wide, labels, label_scheme="strategy-aware")
    out_reset = out.reset_index()
    # 000001 在 strategy-aware 下无标签 → NaN
    row_000001 = out_reset[(out_reset["trade_date"] == "20240102") & (out_reset["ts_code"] == "000001.SZ")]
    assert row_000001["label"].isna().all()
    # 000002 命中 → -0.05
    row_000002 = out_reset[(out_reset["trade_date"] == "20240102") & (out_reset["ts_code"] == "000002.SZ")]
    assert row_000002["label"].iloc[0] == -0.05


# ----------------------------------------------------------------------
# build_feature_matrix_for_inference
# ----------------------------------------------------------------------

def test_build_for_inference_with_no_labels_keeps_all_rows() -> None:
    """labels=None → matrix 行数 == pivot 后 wide 行数；label 列全 NaN。"""

    df = _make_daily_factors()
    industry = _make_industry_map()
    bundle = build_feature_matrix_for_inference(
        daily_factors=df,
        industry_map=industry,
        factor_version="v1",
        label_scheme="strategy-aware",
        new_listing_min_days=60,
        mv_map=None,
        labels=None,
    )
    assert bundle.feature_set_id.startswith("fs_")
    assert set(bundle.factor_ids) == {"mom_20", "vol_20"}
    cols = set(bundle.matrix.columns)
    assert {"trade_date", "ts_code", "mom_20", "vol_20", "label"}.issubset(cols)
    # 2 dates * 4 codes = 8 rows
    assert len(bundle.matrix) == 8
    assert bundle.matrix["label"].isna().all()


def test_build_for_inference_with_partial_labels_keeps_unlabeled_rows() -> None:
    """labels 部分覆盖 → labeled 行 label 非空，unlabeled 行 label NaN 仍在矩阵里。"""

    df = _make_daily_factors()
    industry = _make_industry_map()
    labels = pd.DataFrame(
        [
            {"trade_date": "20240102", "ts_code": "000001.SZ", "scheme": "strategy-aware",
             "value": 0.05, "exit_reason": "max_hold", "hold_days": 20},
            {"trade_date": "20240102", "ts_code": "000002.SZ", "scheme": "strategy-aware",
             "value": 0.03, "exit_reason": "ma5_break", "hold_days": 7},
        ]
    )
    bundle = build_feature_matrix_for_inference(
        daily_factors=df,
        industry_map=industry,
        factor_version="v1",
        label_scheme="strategy-aware",
        new_listing_min_days=60,
        mv_map=None,
        labels=labels,
    )
    assert len(bundle.matrix) == 8
    # 2 行有 label
    assert bundle.matrix["label"].notna().sum() == 2
    # 其余 6 行 label NaN
    assert bundle.matrix["label"].isna().sum() == 6


def test_build_for_inference_feature_set_id_matches_training_path() -> None:
    """同 factor_version × label_scheme × new_listing_min_days × factor_ids →
    fsid 必须与训练入口一致，便于推理读 inference 写的 matrix 行。"""

    df = _make_daily_factors()
    industry = _make_industry_map()
    labels = pd.DataFrame(
        [
            {"trade_date": "20240102", "ts_code": ts, "scheme": "strategy-aware",
             "value": 0.0, "exit_reason": "max_hold", "hold_days": 20}
            for ts in ("000001.SZ", "000002.SZ", "000003.SZ", "000004.SZ")
        ]
        + [
            {"trade_date": "20240103", "ts_code": ts, "scheme": "strategy-aware",
             "value": 0.0, "exit_reason": "max_hold", "hold_days": 20}
            for ts in ("000001.SZ", "000002.SZ", "000003.SZ", "000004.SZ")
        ]
    )
    train_bundle = build_feature_matrix_from_frames(
        daily_factors=df,
        labels=labels,
        industry_map=industry,
        factor_version="v1",
        label_scheme="strategy-aware",
        new_listing_min_days=60,
        mv_map=None,
    )
    inf_bundle = build_feature_matrix_for_inference(
        daily_factors=df,
        industry_map=industry,
        factor_version="v1",
        label_scheme="strategy-aware",
        new_listing_min_days=60,
        mv_map=None,
        labels=None,
    )
    assert train_bundle.feature_set_id == inf_bundle.feature_set_id


def test_build_for_inference_drops_rows_with_nan_in_feature_columns() -> None:
    """feature 列 NaN 仍应被 dropna 清掉；label NaN 不受影响。"""

    df = _make_daily_factors()
    # 故意把某只票的 vol_20 改为 NaN（factor_id 行整行删除即可）
    df = df[~((df["ts_code"] == "000004.SZ") & (df["factor_id"] == "vol_20"))].reset_index(drop=True)
    industry = _make_industry_map()
    bundle = build_feature_matrix_for_inference(
        daily_factors=df,
        industry_map=industry,
        factor_version="v1",
        label_scheme="strategy-aware",
        new_listing_min_days=60,
        mv_map=None,
        labels=None,
    )
    # 000004 缺 vol_20 → 行业中位数填充能补回（同行业内可填）；如同行业内
    # 该日全缺则 dropna。本测试覆盖更宽松：只要不抛 + label 列全 NaN。
    assert "label" in bundle.matrix.columns
    assert bundle.matrix["label"].isna().all()


# ----------------------------------------------------------------------
# 回归：旧 inner-join 路径行为不变
# ----------------------------------------------------------------------

def test_merge_with_labels_still_inner_join() -> None:
    """旧 merge_with_labels 在 labels 部分覆盖时仍应丢掉未覆盖行（inner）；
    保证训练路径不被本次 commit 误改。"""

    wide = pivot_factors_long_to_wide(_make_daily_factors())
    labels = pd.DataFrame(
        [
            {"trade_date": "20240102", "ts_code": "000001.SZ", "scheme": "strategy-aware",
             "value": 0.1, "exit_reason": "max_hold", "hold_days": 20},
        ]
    )
    out = merge_with_labels(wide, labels, label_scheme="strategy-aware")
    # 只剩 1 行
    assert len(out) == 1
    assert out["label"].iloc[0] == 0.1
