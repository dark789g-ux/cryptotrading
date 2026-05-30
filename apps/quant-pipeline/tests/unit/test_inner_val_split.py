"""training/walk_forward.time_series_inner_split 单测（防泄漏修复 #1/#2）。

修复背景：lgb-multiclass / LSTM 两条 walk-forward 通路曾把 OOS 测试折同时用作
early-stopping / 选最优轮次的验证集 —— 测试集泄漏。修复改为从**训练折时序尾部**
切出 inner-validation 专供早停，测试折只用于评估。本文件锁定切分契约：
  · inner-val 永远是时序最靠后的交易日；
  · inner-train 与 inner-val 之间留 embargo_days 个交易日 gap（防 label/序列泄漏）；
  · 同一交易日的所有行整体落在一侧（不拆截面）；
  · 数据不足切不出非空两段时回退 (全部 train, 空 val)。
"""

from __future__ import annotations

import numpy as np

from quant_pipeline.training.walk_forward import time_series_inner_split


def _make_dates(n_unique: int, per_day: int = 2) -> np.ndarray:
    """n_unique 个连续交易日，每日 per_day 行，行序按交易日升序。"""

    out: list[str] = []
    for d in range(n_unique):
        td = f"{10_000_000 + d}"
        out.extend([td] * per_day)
    return np.asarray(out)


def test_basic_split_sizes_and_tail() -> None:
    # 30 unique 日 × 2 行；val_ratio=0.2 → val = 最后 6 日；embargo=3 →
    # train = 前 30-6-3 = 21 日；中间 3 日（embargo）两侧都不含。
    dates = _make_dates(30, per_day=2)
    tr_pos, va_pos = time_series_inner_split(dates, val_ratio=0.2, embargo_days=3)

    tr_dates = sorted(set(dates[tr_pos].tolist()))
    va_dates = sorted(set(dates[va_pos].tolist()))

    assert len(va_dates) == 6
    assert len(tr_dates) == 21
    # 行数 = 交易日数 × per_day
    assert tr_pos.size == 21 * 2
    assert va_pos.size == 6 * 2


def test_val_is_strictly_after_train_with_embargo_gap() -> None:
    dates = _make_dates(40, per_day=3)
    tr_pos, va_pos = time_series_inner_split(dates, val_ratio=0.25, embargo_days=5)

    uniq = sorted(set(dates.tolist()))
    pos = {d: i for i, d in enumerate(uniq)}
    max_train = max(pos[d] for d in set(dates[tr_pos].tolist()))
    min_val = min(pos[d] for d in set(dates[va_pos].tolist()))

    # inner-val 严格在 inner-train 之后，且中间至少隔 embargo_days 个交易日
    assert min_val - max_train - 1 >= 5


def test_no_overlap_and_cross_section_not_split() -> None:
    dates = _make_dates(25, per_day=4)
    tr_pos, va_pos = time_series_inner_split(dates, val_ratio=0.2, embargo_days=2)

    # 行级无交集
    assert set(tr_pos.tolist()).isdisjoint(set(va_pos.tolist()))
    # 同一交易日不会被拆到两侧
    tr_dates = set(dates[tr_pos].tolist())
    va_dates = set(dates[va_pos].tolist())
    assert tr_dates.isdisjoint(va_dates)
    # 每个交易日的 4 行要么全在 train、要么全在 val、要么落在 embargo 间隙
    for d in set(dates.tolist()):
        rows = set(np.where(dates == d)[0].tolist())
        in_tr = rows & set(tr_pos.tolist())
        in_va = rows & set(va_pos.tolist())
        assert not (in_tr and in_va), f"交易日 {d} 被拆到 train/val 两侧"


def test_insufficient_data_falls_back_to_all_train_empty_val() -> None:
    # 只有 4 个交易日，val_ratio=0.2 → n_val=1，embargo=5 → inner-train 段为空 → 回退
    dates = _make_dates(4, per_day=2)
    tr_pos, va_pos = time_series_inner_split(dates, val_ratio=0.2, embargo_days=5)
    assert va_pos.size == 0
    assert tr_pos.size == dates.size
    assert np.array_equal(tr_pos, np.arange(dates.size))


def test_val_ratio_rounds_to_at_least_one_day() -> None:
    # 极小 val_ratio 仍至少切 1 个交易日作 val（只要数据够留 embargo + train）
    dates = _make_dates(60, per_day=1)
    tr_pos, va_pos = time_series_inner_split(dates, val_ratio=0.001, embargo_days=3)
    assert len(set(dates[va_pos].tolist())) == 1
    assert va_pos.size >= 1
