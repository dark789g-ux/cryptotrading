"""Purged Walk-Forward 单测（M3 Part I）。

覆盖：
  - n_folds == 期望值
  - 每折训练 / 测试无重叠
  - embargo 间隙 >= 21 日
  - 训练集 >= min_train_days
  - 构造函数对 n_folds<6 / embargo<21 / min_train<252 都拒绝
  - 输入交易日不够时抛 ValueError
  - SingleFoldSplit 保留（兼容）
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.training.walk_forward import (
    PurgedWalkForwardSplit,
    SingleFoldSplit,
)


def _build_df(n_dates: int = 400, n_codes_per_day: int = 5) -> pd.DataFrame:
    """生成 n_dates 个交易日的 DataFrame（每日 n_codes 行）。"""

    rows: list[dict[str, str]] = []
    for d in range(n_dates):
        td = f"2026{1 + d // 28:02d}{1 + d % 28:02d}"
        for i in range(n_codes_per_day):
            rows.append({"trade_date": td, "ts_code": f"00000{i}.SZ"})
    return pd.DataFrame(rows)


def test_purged_walk_forward_rejects_embargo_below_21() -> None:
    with pytest.raises(ValueError, match="embargo_days"):
        PurgedWalkForwardSplit(n_folds=6, embargo_days=10, min_train_days=252)


def test_purged_walk_forward_rejects_n_folds_below_6() -> None:
    with pytest.raises(ValueError, match="n_folds"):
        PurgedWalkForwardSplit(n_folds=5, embargo_days=21, min_train_days=252)


def test_purged_walk_forward_rejects_min_train_below_252() -> None:
    with pytest.raises(ValueError, match="min_train_days"):
        PurgedWalkForwardSplit(n_folds=6, embargo_days=21, min_train_days=200)


def test_purged_walk_forward_default_args_valid() -> None:
    """默认参数应通过校验：n_folds=6 / embargo=21 / min_train=252。"""

    splitter = PurgedWalkForwardSplit()
    assert splitter.n_folds == 6
    assert splitter.embargo_days == 21
    assert splitter.min_train_days == 252


def test_purged_walk_forward_yields_n_folds() -> None:
    # 总交易日：min_train(252) + embargo(21) + 6 fold * 5 days = 303；用 400 保险
    df = _build_df(n_dates=400, n_codes_per_day=3)
    splitter = PurgedWalkForwardSplit(n_folds=6, embargo_days=21, min_train_days=252)
    folds = list(splitter.split(df))
    assert len(folds) == 6


def test_purged_walk_forward_no_overlap_and_embargo_gap() -> None:
    df = _build_df(n_dates=400, n_codes_per_day=3)
    splitter = PurgedWalkForwardSplit(n_folds=6, embargo_days=21, min_train_days=252)
    unique_dates = sorted(df["trade_date"].astype(str).unique().tolist())
    date_to_pos = {d: i for i, d in enumerate(unique_dates)}

    for train_idx, test_idx in splitter.split(df):
        # 1) 无重叠
        assert len(set(train_idx) & set(test_idx)) == 0

        train_dates = df.iloc[train_idx]["trade_date"].astype(str).unique().tolist()
        test_dates = df.iloc[test_idx]["trade_date"].astype(str).unique().tolist()
        assert len(set(train_dates) & set(test_dates)) == 0

        # 2) train 最后一日 <= test 第一日 - embargo
        max_train_pos = max(date_to_pos[d] for d in train_dates)
        min_test_pos = min(date_to_pos[d] for d in test_dates)
        gap = min_test_pos - max_train_pos - 1
        assert gap >= 21, f"embargo gap {gap} < 21"


def test_purged_walk_forward_train_size_meets_min() -> None:
    df = _build_df(n_dates=400, n_codes_per_day=3)
    splitter = PurgedWalkForwardSplit(n_folds=6, embargo_days=21, min_train_days=252)
    for train_idx, _test_idx in splitter.split(df):
        n_train_days = df.iloc[train_idx]["trade_date"].nunique()
        assert n_train_days >= 252


def test_purged_walk_forward_insufficient_data_raises() -> None:
    """交易日数 < min_train + embargo + n_folds → 抛 ValueError。"""

    df = _build_df(n_dates=100, n_codes_per_day=3)
    splitter = PurgedWalkForwardSplit(n_folds=6, embargo_days=21, min_train_days=252)
    with pytest.raises(ValueError, match="PurgedWalkForwardSplit"):
        list(splitter.split(df))


def test_purged_walk_forward_test_windows_cover_remaining_days() -> None:
    """最后一折应吃完尾部所有交易日（不丢日）。"""

    df = _build_df(n_dates=400, n_codes_per_day=3)
    splitter = PurgedWalkForwardSplit(n_folds=6, embargo_days=21, min_train_days=252)
    folds = list(splitter.split(df))
    # 所有 fold test 的并集
    all_test_idx = np.concatenate([fold[1] for fold in folds])
    test_dates = df.iloc[all_test_idx]["trade_date"].astype(str).unique()
    unique_dates = sorted(df["trade_date"].astype(str).unique().tolist())
    # 最后一日必须在 test 中
    assert unique_dates[-1] in set(test_dates)


def test_single_fold_split_retained() -> None:
    """M2 遗留：SingleFoldSplit 仍可调用。"""

    df = _build_df(n_dates=50, n_codes_per_day=3)
    splitter = SingleFoldSplit(train_ratio=0.7, embargo_days=0)
    folds = list(splitter.split(df))
    assert len(folds) == 1
    train_idx, test_idx = folds[0]
    assert len(set(train_idx) & set(test_idx)) == 0
