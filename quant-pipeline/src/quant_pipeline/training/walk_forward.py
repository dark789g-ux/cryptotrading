"""Walk-Forward 交叉验证 —— M2 占位框架（单 fold）。

> doc/量化/05-LightGBM训练体系.md §5.4 Purged Walk-Forward：
>     [train 2y][gap 5d][val 6m]
>     [train 2.5y][gap 5d][val 6m]
>     [train 3y][gap 5d][val 6m]
> embargo = 标签视界 + 1（fwd_5d_ret → 6 个交易日；strategy-aware → 21 个交易日）

M2 阶段只实现 `SingleFoldSplit`（70% / 30% 时间序列切分，**无 embargo**），
仅供 mock 数据训练通路冒烟。完整 Purged Walk-Forward 实现留 M3。

API 约定（M3 时保持 stable）：
- 所有 splitter 继承 `WalkForwardSplit`
- `split(df)` 接收按 trade_date 升序的 DataFrame（含 `trade_date` 列）
- 返回 `Iterator[(train_idx, test_idx)]`；索引为 `np.ndarray[int]`，绝对位置而非
  DataFrame 的 label 索引（避免 MultiIndex 转换困难）

TODO(M3): 接入 Purged Walk-Forward，含 embargo_days、可配 fold 数 / 训练窗口长度。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator

import numpy as np
import pandas as pd


class WalkForwardSplit(ABC):
    """Walk-Forward splitter 抽象接口。

    Args:
        n_folds:      fold 数（M2 SingleFoldSplit 强制为 1）
        embargo_days: 训练 → 验证之间的 embargo 交易日数（M3 启用）
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
    """M2 简化版：按交易日时间序列 70% / 30% 切一刀。

    输入 df 必须含 `trade_date` 列（YYYYMMDD 字符串）；M2 不强制 embargo，
    但允许传入 embargo_days，会在 train 尾部砍掉对应天数。

    TODO(M3): 替换为真正的 Purged Walk-Forward（n_folds >= 3 + embargo ≥ 21）。
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
