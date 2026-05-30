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

⚠️ OOS 覆盖范围（2026-05-23 评审 #3 如实说明）：
  测试窗口**只覆盖数据的后半段**。`test_pool_start = min_train_days + embargo_days`，
  n_folds 个测试窗口全部从「测试池」`[test_pool_start, N)` 里等分。
  **前 min_train_days + embargo_days 天交易日仅作为第一折的训练垫底，永远不会
  作为任何一折的 OOS 测试集。** 这是有意取舍：保证第一折也有 >= 252 日训练数据。
  代价是 OOS 评估带有「只测后段」的系统性偏差——若需覆盖全时段，应改用
  expanding-window（每折训练集扩张、测试紧随其后），M3 阶段不做此切换。

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
      2) 取「测试池」= 交易日序列中 [test_pool_start, N) 这一段，
         其中 test_pool_start = min_train_days + embargo_days；
         把测试池**等分**为 n_folds 个连续 **测试** 窗口（窗口大小 ≈ 测试池 // n_folds）
      3) 第 i 折训练集 = 测试窗口前的所有交易日 → 去掉尾部 embargo_days 天
      4) 整体交易日数不足以同时满足"n_folds 折 + min_train + embargo"
         则抛 ValueError 让上层去补数据 / 调参数

    ⚠️ 测试窗口只覆盖数据后半段（评审 #3）：前 test_pool_start 天交易日仅作训练
       垫底，不参与任何一折 OOS。详见模块 docstring「OOS 覆盖范围」。

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


# 默认 inner-validation 占训练折交易日的比例（防泄漏早停用，见 time_series_inner_split）
_DEFAULT_INNER_VAL_RATIO = 0.2


def time_series_inner_split(
    trade_dates: np.ndarray,
    *,
    val_ratio: float = _DEFAULT_INNER_VAL_RATIO,
    embargo_days: int,
) -> tuple[np.ndarray, np.ndarray]:
    """把一个训练折按交易日时序切成 (inner_train_pos, inner_val_pos)。

    用途（防泄漏修复 #1/#2）：lgb-multiclass / LSTM 的 walk-forward fold 内需要一个
    early-stopping / 选最优轮次的验证集。绝不能用 OOS 测试折（测试集泄漏），改为从
    **训练折自身的时序尾部**切出 inner-validation：

        [····· inner-train ·····][ embargo ][ inner-val ]
                                 └ 防 label(t+1)/序列回看跨界泄漏

    切法：
      1) 取输入行对应的 unique 交易日并升序；
      2) inner-val = 时序最后 ``ceil(n_unique * val_ratio)``（至少 1）个交易日的**所有行**；
      3) inner-train = 其前段，再去掉尾部 ``embargo_days`` 个交易日；
      4) 若 inner-train 或 inner-val 切完为空（交易日不足）→ 回退
         ``(arange(n), empty)``：由调用方决定是否退化为不早停 / 跳过该折。

    同一交易日的所有行整体落在一侧（不拆截面）。返回值是相对输入数组的整数位置。

    Args:
        trade_dates: 训练折每行的 trade_date（顺序与对应特征矩阵行一致，已按时序排列）。
        val_ratio:   inner-val 占 unique 交易日的比例（默认 0.2）。
        embargo_days: inner-train 与 inner-val 之间保留的交易日 gap（防泄漏）。
    """

    if not 0.0 < val_ratio < 1.0:
        raise ValueError(f"val_ratio 必须在 (0,1)，got {val_ratio}")
    if embargo_days < 0:
        raise ValueError(f"embargo_days 不能为负，got {embargo_days}")

    td = np.asarray([str(x) for x in np.asarray(trade_dates)])
    n_rows = td.shape[0]
    fallback = (np.arange(n_rows), np.empty(0, dtype=np.int64))
    if n_rows == 0:
        return fallback

    uniq = sorted(set(td.tolist()))
    n_uniq = len(uniq)

    n_val = max(1, int(np.ceil(n_uniq * val_ratio)))
    n_train = n_uniq - n_val - int(embargo_days)
    if n_train < 1 or n_val < 1:
        return fallback

    train_dates = set(uniq[:n_train])
    val_dates = set(uniq[n_uniq - n_val:])

    tr_pos = np.where(np.isin(td, list(train_dates)))[0].astype(np.int64)
    va_pos = np.where(np.isin(td, list(val_dates)))[0].astype(np.int64)
    if tr_pos.size == 0 or va_pos.size == 0:
        return fallback
    return tr_pos, va_pos


__all__ = [
    "WalkForwardSplit",
    "SingleFoldSplit",
    "PurgedWalkForwardSplit",
    "time_series_inner_split",
]
