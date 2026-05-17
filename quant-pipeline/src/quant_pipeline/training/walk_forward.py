"""Walk-Forward 交叉验证 —— M3 升级：Purged Walk-Forward + embargo。

> doc/量化/05-LightGBM训练体系.md §5.4 Purged Walk-Forward：
>     [train 2y][gap 5d][val 6m]
>     [train 2.5y][gap 5d][val 6m]
>     [train 3y][gap 5d][val 6m]
> embargo = 标签视界 + 1（fwd_5d_ret → 6 个交易日；strategy-aware → 21 个交易日）

M3 引入 `PurgedWalkForwardSplit`：
- 把交易日序列等分为 `n_folds` 个连续测试窗口
- 每折训练集 = 测试集之前的所有交易日 - embargo_days（避免 PIT 泄漏）
- 强制 embargo_days >= 21（A 股财报披露窗口；硬约束）
- 强制 n_folds >= 6（M3 验收门槛）
- 强制 min_train_days >= 252（约 1 年）

保留 `SingleFoldSplit`（M2 遗留，仅用于冷启动调试）。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator

import numpy as np
import pandas as pd


# Purged Walk-Forward 强约束（doc/05 §5.4 + spec m3 §验收门槛）
_MIN_EMBARGO_DAYS = 21
_MIN_N_FOLDS = 6
_MIN_TRAIN_DAYS = 252


class WalkForwardSplit(ABC):
    """Walk-Forward splitter 抽象接口。

    Args:
        n_folds:      fold 数（SingleFoldSplit 强制为 1）
        embargo_days: 训练 → 验证之间的 embargo 交易日数
    """

    def __init__(self, n_folds: int, embargo_days: int) -> None:
        if n_folds < 1:
            raise ValueError(f"n_folds 必须 >= 1，got {n_folds}")
        if embargo_days < 0:
            raise ValueError(f"embargo_days 不能为负，got {embargo_days}")
        self.n_folds = int(n_folds)
        self.embargo_days = int(embargo_days)

    @abstractmethod
    def split(self, df: pd.DataFrame) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        """生成 (train_idx, test_idx) 序列，idx 为 df 的整数位置。"""


class SingleFoldSplit(WalkForwardSplit):
    """M2 遗留，仅用于冷启动调试：按交易日时间序列 70% / 30% 切一刀。

    输入 df 必须含 `trade_date` 列（YYYYMMDD 字符串）；M2 不强制 embargo，
    但允许传入 embargo_days，会在 train 尾部砍掉对应天数。

    NOTE(M3): 正式训练通路改用 PurgedWalkForwardSplit。本类保留仅供
    mock / cold-start 冒烟，不允许在 m3 正式 runner 默认路径上使用。
    """

    def __init__(self, train_ratio: float = 0.7, embargo_days: int = 0) -> None:
        super().__init__(n_folds=1, embargo_days=embargo_days)
        if not 0.0 < train_ratio < 1.0:
            raise ValueError(f"train_ratio 必须在 (0,1)，got {train_ratio}")
        self.train_ratio = float(train_ratio)

    def split(self, df: pd.DataFrame) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        if "trade_date" not in df.columns:
            raise ValueError("SingleFoldSplit.split 要求 df 含 'trade_date' 列")
        unique_dates = sorted(df["trade_date"].astype(str).unique().tolist())
        if len(unique_dates) < 2:
            raise ValueError(
                f"SingleFoldSplit 至少需 2 个交易日，got {len(unique_dates)}"
            )

        cut = max(1, int(round(len(unique_dates) * self.train_ratio)))
        train_dates_full = unique_dates[:cut]
        test_dates = unique_dates[cut:]
        if not test_dates:
            test_dates = [train_dates_full.pop()]

        # embargo：从 train 尾部去掉 embargo_days 个交易日
        if self.embargo_days > 0 and len(train_dates_full) > self.embargo_days:
            train_dates = train_dates_full[: -self.embargo_days]
        else:
            train_dates = train_dates_full

        td_arr = df["trade_date"].astype(str).to_numpy()
        train_mask = np.isin(td_arr, train_dates)
        test_mask = np.isin(td_arr, test_dates)
        train_idx = np.where(train_mask)[0]
        test_idx = np.where(test_mask)[0]
        if train_idx.size == 0 or test_idx.size == 0:
            raise ValueError(
                "SingleFoldSplit 切分后 train 或 test 为空，请检查输入交易日数量"
            )
        yield train_idx, test_idx


class PurgedWalkForwardSplit(WalkForwardSplit):
    """Purged Walk-Forward（M3 标准）。

    切法：
      1) 收集 df 中所有 unique trade_date 并升序
      2) 把交易日总数 N 等分为 n_folds 个连续 **测试** 窗口（窗口大小 ≈ N // n_folds）
      3) 第 i 折训练集 = 测试窗口前的所有交易日 → 去掉尾部 embargo_days 天
      4) 第一折的训练长度必须 ≥ min_train_days，否则丢弃前 K 折（向后偏移），
         若整体交易日数不足以同时满足"6 折 + min_train 252 日 + embargo 21 日"
         则抛 ValueError 让上层去补数据 / 调参数

    约束（构造函数强校验）：
      - n_folds >= 6
      - embargo_days >= 21（A 股财报披露窗口 PIT）
      - min_train_days >= 252

    Args:
        n_folds:        fold 数（M3 默认 6，验收门槛 ≥ 6）
        embargo_days:   embargo 日数（M3 默认 21）
        min_train_days: 单折最少训练日数（M3 默认 252，约 1 年）
    """

    def __init__(
        self,
        n_folds: int = _MIN_N_FOLDS,
        embargo_days: int = _MIN_EMBARGO_DAYS,
        min_train_days: int = _MIN_TRAIN_DAYS,
    ) -> None:
        if embargo_days < _MIN_EMBARGO_DAYS:
            raise ValueError(
                f"embargo_days 必须 >= {_MIN_EMBARGO_DAYS}（A 股财报披露窗口 PIT），"
                f"got {embargo_days}"
            )
        if n_folds < _MIN_N_FOLDS:
            raise ValueError(
                f"n_folds 必须 >= {_MIN_N_FOLDS}（M3 验收门槛），got {n_folds}"
            )
        if min_train_days < _MIN_TRAIN_DAYS:
            raise ValueError(
                f"min_train_days 必须 >= {_MIN_TRAIN_DAYS}（约 1 年），got {min_train_days}"
            )
        super().__init__(n_folds=n_folds, embargo_days=embargo_days)
        self.min_train_days = int(min_train_days)

    def split(self, df: pd.DataFrame) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        if "trade_date" not in df.columns:
            raise ValueError("PurgedWalkForwardSplit.split 要求 df 含 'trade_date' 列")
        td_str = df["trade_date"].astype(str)
        unique_dates = sorted(td_str.unique().tolist())
        n_total = len(unique_dates)

        # 整体可行性：min_train + embargo + n_folds 个测试窗口（每窗 ≥ 1 日）
        min_needed = self.min_train_days + self.embargo_days + self.n_folds
        if n_total < min_needed:
            raise ValueError(
                f"PurgedWalkForwardSplit 需要至少 {min_needed} 个交易日 "
                f"(min_train={self.min_train_days} + embargo={self.embargo_days} + "
                f"n_folds={self.n_folds})，got {n_total}"
            )

        # 把 (min_train + embargo 之后) 的所有日子等分为 n_folds 个测试窗口
        test_pool_start = self.min_train_days + self.embargo_days
        test_pool_size = n_total - test_pool_start
        # fold_size 至少 1（前面已校验）
        fold_size = test_pool_size // self.n_folds

        td_arr = td_str.to_numpy()

        for fold_i in range(self.n_folds):
            test_start = test_pool_start + fold_i * fold_size
            # 最后一折吃掉剩余尾部，避免丢日
            if fold_i == self.n_folds - 1:
                test_end = n_total
            else:
                test_end = test_start + fold_size

            test_dates = unique_dates[test_start:test_end]
            # 训练集 = test 之前 - embargo
            train_end_exclusive = test_start - self.embargo_days
            if train_end_exclusive < self.min_train_days:
                # 理论上由 min_needed 校验保证不会发生；保守再校验一次
                raise ValueError(
                    f"fold {fold_i} 训练日数 {train_end_exclusive} 不足 "
                    f"min_train_days={self.min_train_days}"
                )
            train_dates = unique_dates[:train_end_exclusive]

            train_mask = np.isin(td_arr, train_dates)
            test_mask = np.isin(td_arr, test_dates)
            train_idx = np.where(train_mask)[0]
            test_idx = np.where(test_mask)[0]
            if train_idx.size == 0 or test_idx.size == 0:
                raise ValueError(
                    f"PurgedWalkForwardSplit fold {fold_i} 切分后 train/test 为空"
                )
            yield train_idx, test_idx


__all__ = [
    "WalkForwardSplit",
    "SingleFoldSplit",
    "PurgedWalkForwardSplit",
]
