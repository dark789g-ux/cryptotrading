"""sequence_builder 单测。

覆盖 spec 01 §3 / 02 §3 契约：
  - 完整 L 窗才出样本；不足 L 丢弃；
  - 绝不跨 ts_code 串窗（两票交错日期，断言窗口纯净 / 索引正确）；
  - 连续性按该票实际出现的交易日序号判定（停牌跳日不算断裂）；
  - 含 NaN 的样本丢弃 + logger.warning 计数；
  - feature_cols 顺序稳定（X 最后一维严格按传入顺序）；
  - 标签整数护栏：连续标签（如收益率）触发 ValueError，禁静默截断。

本模块不依赖 torch，必须能独立跑。
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.training.sequence_builder import SequenceBundle, build_sequences

FEATS = ["f1", "f2"]


def _row(ts_code: str, trade_date: str, f1: float, f2: float, label: float) -> dict:
    return {
        "ts_code": ts_code,
        "trade_date": trade_date,
        "f1": f1,
        "f2": f2,
        "label": label,
    }


def _make_df(rows: list[dict]) -> pd.DataFrame:
    return pd.DataFrame(rows)


class TestWindowing:
    def test_full_window_produces_sample(self) -> None:
        # 5 行连续交易日，L=3 → 末 3 行有标签即可出样本
        rows = [
            _row("A.SZ", "20260501", 1.0, 10.0, 0.0),
            _row("A.SZ", "20260502", 2.0, 20.0, 1.0),
            _row("A.SZ", "20260503", 3.0, 30.0, 2.0),
            _row("A.SZ", "20260504", 4.0, 40.0, 0.0),
            _row("A.SZ", "20260505", 5.0, 50.0, 1.0),
        ]
        b = build_sequences(_make_df(rows), lookback=3, feature_cols=FEATS)
        assert isinstance(b, SequenceBundle)
        # 目标行可取 idx 2,3,4 → 3 个样本
        assert b.X.shape == (3, 3, 2)
        assert b.X.dtype == np.float32
        assert b.y.dtype == np.int64
        assert list(b.y) == [2, 0, 1]
        # 第一个样本窗口 = 前 3 行 f1
        np.testing.assert_array_equal(b.X[0, :, 0], np.array([1.0, 2.0, 3.0], dtype=np.float32))
        assert list(b.index["trade_date"]) == ["20260503", "20260504", "20260505"]
        assert list(b.index["ts_code"]) == ["A.SZ", "A.SZ", "A.SZ"]

    def test_insufficient_rows_dropped(self) -> None:
        # 只有 2 行但 L=3 → 无样本
        rows = [
            _row("A.SZ", "20260501", 1.0, 10.0, 0.0),
            _row("A.SZ", "20260502", 2.0, 20.0, 1.0),
        ]
        b = build_sequences(_make_df(rows), lookback=3, feature_cols=FEATS)
        assert b.X.shape == (0, 3, 2)
        assert b.y.shape == (0,)
        assert len(b.index) == 0

    def test_exact_window_one_sample(self) -> None:
        rows = [
            _row("A.SZ", "20260501", 1.0, 10.0, 0.0),
            _row("A.SZ", "20260502", 2.0, 20.0, 1.0),
            _row("A.SZ", "20260503", 3.0, 30.0, 2.0),
        ]
        b = build_sequences(_make_df(rows), lookback=3, feature_cols=FEATS)
        assert b.X.shape == (1, 3, 2)
        assert list(b.y) == [2]


class TestNoCrossTsCode:
    def test_never_cross_ts_code(self) -> None:
        # 两票 A/B 交错日期混在一起；窗口不得跨票拼接
        rows = [
            _row("A.SZ", "20260501", 1.0, 0.0, 0.0),
            _row("B.SZ", "20260501", 100.0, 0.0, 0.0),
            _row("A.SZ", "20260502", 2.0, 0.0, 1.0),
            _row("B.SZ", "20260502", 200.0, 0.0, 1.0),
            _row("A.SZ", "20260503", 3.0, 0.0, 2.0),
            _row("B.SZ", "20260503", 300.0, 0.0, 2.0),
        ]
        b = build_sequences(_make_df(rows), lookback=3, feature_cols=FEATS)
        # 每票各 1 个完整窗口 → 共 2 样本
        assert b.X.shape == (2, 3, 2)
        # 找到 A 票样本：其 f1 窗口必须全部来自 A（1,2,3），不混入 B 的百位值
        for i in range(b.X.shape[0]):
            ts = b.index.iloc[i]["ts_code"]
            f1_win = b.X[i, :, 0]
            if ts == "A.SZ":
                np.testing.assert_array_equal(
                    f1_win, np.array([1.0, 2.0, 3.0], dtype=np.float32)
                )
            else:
                np.testing.assert_array_equal(
                    f1_win, np.array([100.0, 200.0, 300.0], dtype=np.float32)
                )

    def test_one_ts_code_short_other_long(self) -> None:
        # A 票 3 行（出 1 样本），B 票 2 行（不足 L 丢弃）
        rows = [
            _row("A.SZ", "20260501", 1.0, 0.0, 0.0),
            _row("A.SZ", "20260502", 2.0, 0.0, 1.0),
            _row("A.SZ", "20260503", 3.0, 0.0, 2.0),
            _row("B.SZ", "20260501", 100.0, 0.0, 0.0),
            _row("B.SZ", "20260502", 200.0, 0.0, 1.0),
        ]
        b = build_sequences(_make_df(rows), lookback=3, feature_cols=FEATS)
        assert b.X.shape == (1, 3, 2)
        assert b.index.iloc[0]["ts_code"] == "A.SZ"


class TestContinuityByTradeDateRank:
    def test_suspension_gap_not_treated_as_break(self) -> None:
        # A 票交易日有缺口（20260502 停牌缺失），但实际出现的行相邻即连续。
        # 连续性按出现序号判定，不依赖自然日差 → 4 行可出 2 个 L=3 样本。
        rows = [
            _row("A.SZ", "20260501", 1.0, 0.0, 0.0),
            # 20260502 停牌，无行
            _row("A.SZ", "20260503", 3.0, 0.0, 1.0),
            _row("A.SZ", "20260504", 4.0, 0.0, 2.0),
            _row("A.SZ", "20260505", 5.0, 0.0, 0.0),
        ]
        b = build_sequences(_make_df(rows), lookback=3, feature_cols=FEATS)
        assert b.X.shape == (2, 3, 2)
        # 第一个窗口由该票最近 3 个有数据交易日组成：f1=[1,3,4]
        np.testing.assert_array_equal(
            b.X[0, :, 0], np.array([1.0, 3.0, 4.0], dtype=np.float32)
        )
        assert list(b.index["trade_date"]) == ["20260504", "20260505"]

    def test_unsorted_input_sorted_by_trade_date(self) -> None:
        # 输入乱序 → 内部按 trade_date 升序排窗
        rows = [
            _row("A.SZ", "20260503", 3.0, 0.0, 2.0),
            _row("A.SZ", "20260501", 1.0, 0.0, 0.0),
            _row("A.SZ", "20260502", 2.0, 0.0, 1.0),
        ]
        b = build_sequences(_make_df(rows), lookback=3, feature_cols=FEATS)
        np.testing.assert_array_equal(
            b.X[0, :, 0], np.array([1.0, 2.0, 3.0], dtype=np.float32)
        )
        assert list(b.index["trade_date"]) == ["20260503"]


class TestNaNDropping:
    def test_nan_feature_sample_dropped_and_warns(self, caplog) -> None:
        # 中间一行特征 NaN → 任何覆盖该行的窗口都被丢弃
        rows = [
            _row("A.SZ", "20260501", 1.0, 0.0, 0.0),
            _row("A.SZ", "20260502", np.nan, 0.0, 1.0),
            _row("A.SZ", "20260503", 3.0, 0.0, 2.0),
            _row("A.SZ", "20260504", 4.0, 0.0, 0.0),
        ]
        with caplog.at_level(logging.WARNING):
            b = build_sequences(_make_df(rows), lookback=3, feature_cols=FEATS)
        # idx2 窗口[0,1,2] 含 NaN 丢弃；idx3 窗口[1,2,3] 也含 NaN（行 idx1）丢弃 → 0 样本
        assert b.X.shape == (0, 3, 2)
        assert any("sequence_builder_dropped_nan_samples" in r.message for r in caplog.records)

    def test_nan_label_row_not_target(self, caplog) -> None:
        # 末行 label NaN（每票末行被 shift 丢弃属正常）→ 该目标行跳过，不计 NaN-drop
        rows = [
            _row("A.SZ", "20260501", 1.0, 0.0, 0.0),
            _row("A.SZ", "20260502", 2.0, 0.0, 1.0),
            _row("A.SZ", "20260503", 3.0, 0.0, 2.0),
            _row("A.SZ", "20260504", 4.0, 0.0, np.nan),
        ]
        b = build_sequences(_make_df(rows), lookback=3, feature_cols=FEATS)
        # 目标行 idx2 出样本；idx3 label NaN 跳过 → 1 样本
        assert b.X.shape == (1, 3, 2)
        assert list(b.y) == [2]


class TestFeatureColOrder:
    def test_feature_cols_order_stable(self) -> None:
        # 传入顺序 [f2, f1] → X 最后一维严格按该顺序，与 df 物理列序无关
        rows = [
            _row("A.SZ", "20260501", 1.0, 10.0, 0.0),
            _row("A.SZ", "20260502", 2.0, 20.0, 1.0),
            _row("A.SZ", "20260503", 3.0, 30.0, 2.0),
        ]
        b = build_sequences(_make_df(rows), lookback=3, feature_cols=["f2", "f1"])
        assert b.feature_cols == ["f2", "f1"]
        # 通道0 = f2(10,20,30)，通道1 = f1(1,2,3)
        np.testing.assert_array_equal(
            b.X[0, :, 0], np.array([10.0, 20.0, 30.0], dtype=np.float32)
        )
        np.testing.assert_array_equal(
            b.X[0, :, 1], np.array([1.0, 2.0, 3.0], dtype=np.float32)
        )


class TestLabelIntegerGuard:
    def test_continuous_label_raises(self) -> None:
        # 误配连续标签（收益率浮点）→ 必须 ValueError，禁静默截断
        rows = [
            _row("A.SZ", "20260501", 1.0, 0.0, 0.013),
            _row("A.SZ", "20260502", 2.0, 0.0, -0.027),
            _row("A.SZ", "20260503", 3.0, 0.0, 0.004),
        ]
        with pytest.raises(ValueError, match="fwd_5d_ret|整数类别"):
            build_sequences(_make_df(rows), lookback=3, feature_cols=FEATS)

    def test_out_of_range_integer_label_raises(self) -> None:
        # 整数但越界（出现类别 3）→ ValueError
        rows = [
            _row("A.SZ", "20260501", 1.0, 0.0, 0.0),
            _row("A.SZ", "20260502", 2.0, 0.0, 3.0),
            _row("A.SZ", "20260503", 3.0, 0.0, 1.0),
        ]
        with pytest.raises(ValueError):
            build_sequences(_make_df(rows), lookback=3, feature_cols=FEATS)

    def test_valid_float_classes_pass(self) -> None:
        # {0.0,1.0,2.0} 浮点类别合法，不 raise
        rows = [
            _row("A.SZ", "20260501", 1.0, 0.0, 0.0),
            _row("A.SZ", "20260502", 2.0, 0.0, 1.0),
            _row("A.SZ", "20260503", 3.0, 0.0, 2.0),
        ]
        b = build_sequences(_make_df(rows), lookback=3, feature_cols=FEATS)
        assert list(b.y) == [2]
        assert b.y.dtype == np.int64


class TestInputValidation:
    def test_lookback_below_one_raises(self) -> None:
        rows = [_row("A.SZ", "20260501", 1.0, 0.0, 0.0)]
        with pytest.raises(ValueError):
            build_sequences(_make_df(rows), lookback=0, feature_cols=FEATS)

    def test_empty_feature_cols_raises(self) -> None:
        rows = [_row("A.SZ", "20260501", 1.0, 0.0, 0.0)]
        with pytest.raises(ValueError):
            build_sequences(_make_df(rows), lookback=1, feature_cols=[])

    def test_missing_required_column_raises(self) -> None:
        df = pd.DataFrame([{"ts_code": "A.SZ", "trade_date": "20260501", "f1": 1.0}])
        with pytest.raises(ValueError, match="缺少"):
            build_sequences(df, lookback=1, feature_cols=["f1"])
