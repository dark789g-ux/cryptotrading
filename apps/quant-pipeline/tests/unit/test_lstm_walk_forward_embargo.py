"""LSTM walk-forward embargo 扩容 + 泄漏边界单测（spec 02 §5）。

不依赖 torch：只测 compute_embargo_eff 公式 + PurgedWalkForwardSplit 在扩容后的
切分结果满足「验证样本输入窗 [t-L+1..t] + t+1 标签都不与训练区 trade_date 重叠」。
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.training import lstm_walk_forward
from quant_pipeline.training.lstm_walk_forward import (
    _MIN_EMBARGO_DAYS,
    _build_true_ret,
    compute_embargo_eff,
)
from quant_pipeline.training.walk_forward import PurgedWalkForwardSplit

# ---------------------------------------------------------------------------
# compute_embargo_eff = max(embargo_days, lookback + 1, 21)
# ---------------------------------------------------------------------------


def test_embargo_eff_takes_lookback_plus_one_when_dominant() -> None:
    # lookback=32 → lookback+1=33 > 21 且 > 默认 embargo_days=21 → 33
    assert compute_embargo_eff({}, lookback=32) == 33


def test_embargo_eff_floor_is_21_for_small_lookback() -> None:
    # lookback=5 → lookback+1=6 < 21；embargo_days 默认 21 → 取硬下限 21
    assert compute_embargo_eff({}, lookback=5) == _MIN_EMBARGO_DAYS
    assert compute_embargo_eff({}, lookback=5) == 21


def test_embargo_eff_respects_explicit_large_embargo() -> None:
    # 调用方显式传 embargo_days=40，大于 lookback+1=11 与 21 → 40
    assert compute_embargo_eff({"embargo_days": 40}, lookback=10) == 40


def test_embargo_eff_is_max_of_three() -> None:
    # 三者：embargo_days=25 / lookback+1=51 / 21 → 51
    assert compute_embargo_eff({"embargo_days": 25}, lookback=50) == 51


def test_embargo_eff_never_below_min_embargo() -> None:
    # 即便调用方传 0（合法非负），结果仍 >= 21（不绕过硬下限）
    assert compute_embargo_eff({"embargo_days": 0}, lookback=1) == _MIN_EMBARGO_DAYS


def test_embargo_eff_safe_to_feed_purged_split() -> None:
    """embargo_eff 恒 >= 21，喂给 PurgedWalkForwardSplit 不触发 embargo<21 校验。"""

    eff = compute_embargo_eff({"embargo_days": 21}, lookback=32)
    assert eff == 33
    # 构造不抛（embargo>=21 通过内部 _MIN_EMBARGO_DAYS 地板）
    splitter = PurgedWalkForwardSplit(n_folds=6, embargo_days=eff, min_train_days=252)
    assert splitter.embargo_days == 33


# ---------------------------------------------------------------------------
# 泄漏边界：验证样本输入窗 + 次日标签不与训练区 trade_date 重叠
# ---------------------------------------------------------------------------


def _build_df(n_dates: int, n_codes: int = 3) -> pd.DataFrame:
    """n_dates 个连续交易日，每日 n_codes 票。

    trade_date 用纯序号（10_000_000+d）保证字符串严格单调可比，避免月份回绕导致
    字符串排序与时间序错位（不影响 PurgedWalkForwardSplit 的按 unique 升序切分）。
    """

    rows: list[dict[str, str]] = []
    for d in range(n_dates):
        td = f"{10_000_000 + d}"
        for i in range(n_codes):
            rows.append({"trade_date": td, "ts_code": f"{i:06d}.SZ"})
    return pd.DataFrame(rows)


def test_valid_input_window_does_not_overlap_train_dates() -> None:
    """对每个 fold：验证集每个样本的输入窗 [t-L+1..t] 与训练区 trade_date 不相交。

    嵌入泄漏断言：训练区最后一个交易日序号 + embargo_eff <= 第一个验证样本输入窗
    的起始交易日序号。
    """

    lookback = 32
    embargo_eff = compute_embargo_eff({"embargo_days": 21}, lookback=lookback)
    assert embargo_eff == 33

    n_dates = 252 + embargo_eff + 6 * 20  # 够 6 折 + min_train + embargo
    df = _build_df(n_dates)
    unique_dates = sorted(df["trade_date"].astype(str).unique().tolist())
    date_to_pos = {d: i for i, d in enumerate(unique_dates)}

    splitter = PurgedWalkForwardSplit(
        n_folds=6, embargo_days=embargo_eff, min_train_days=252
    )

    folds = list(splitter.split(df))
    assert len(folds) == 6

    td_arr = df["trade_date"].astype(str).to_numpy()
    for train_idx, test_idx in folds:
        train_dates = set(td_arr[train_idx])
        test_dates = sorted(set(td_arr[test_idx]))
        train_positions = {date_to_pos[d] for d in train_dates}
        max_train_pos = max(train_positions)

        # 验证集首个交易日位置
        first_test_pos = date_to_pos[test_dates[0]]

        # 该验证样本的输入窗起点 = first_test_pos - (lookback - 1)
        # （build_sequences 窗口为 [t-L+1 .. t]，t 为目标行交易日位置）
        window_start_pos = first_test_pos - (lookback - 1)

        # 泄漏护栏：embargo_eff >= lookback + 1 保证 window_start_pos > max_train_pos
        assert window_start_pos > max_train_pos, (
            f"输入窗起点位置 {window_start_pos} 落入训练区（max_train_pos={max_train_pos}），"
            f"embargo_eff={embargo_eff} 不足以覆盖 lookback={lookback}"
        )

        # 次日标签位置 = first_test_pos + 1，亦不在训练区内（训练区在 test 之前）
        assert (first_test_pos + 1) not in train_positions


def test_smaller_embargo_would_leak_proving_expansion_needed() -> None:
    """反证：若只用基础 embargo=21（不扩容到 lookback+1），输入窗会回看进训练区。

    构造与上一测试同结构，但故意用 21（小于 lookback+1=33）切分，断言至少一折的
    验证输入窗起点 <= 训练区末位（即发生泄漏）——证明扩容必要。
    """

    lookback = 32
    base_embargo = 21  # 故意不扩容
    n_dates = 252 + base_embargo + 6 * 20
    df = _build_df(n_dates)
    unique_dates = sorted(df["trade_date"].astype(str).unique().tolist())
    date_to_pos = {d: i for i, d in enumerate(unique_dates)}

    splitter = PurgedWalkForwardSplit(
        n_folds=6, embargo_days=base_embargo, min_train_days=252
    )
    td_arr = df["trade_date"].astype(str).to_numpy()

    leaked = False
    for train_idx, test_idx in splitter.split(df):
        train_positions = {date_to_pos[d] for d in set(td_arr[train_idx])}
        max_train_pos = max(train_positions)
        first_test_pos = date_to_pos[sorted(set(td_arr[test_idx]))[0]]
        window_start_pos = first_test_pos - (lookback - 1)
        if window_start_pos <= max_train_pos:
            leaked = True
            break

    assert leaked, "base_embargo=21 + lookback=32 本应发生输入窗泄漏，扩容公式才有意义"


# ---------------------------------------------------------------------------
# A1：_build_true_ret 行序对齐（val_index_all → load_forward_returns → true_ret_all）
# ---------------------------------------------------------------------------


def test_build_true_ret_row_order_alignment(monkeypatch) -> None:  # noqa: ANN001
    """val_index_all 各折 concat 后与 score_all 同序；命中 r / 未命中 NaN 按行对齐。"""

    # 两折验证索引：行序 = 折1[(A,d1),(B,d1)] + 折2[(A,d2)]
    fold1 = pd.DataFrame(
        {"ts_code": ["000001.SZ", "000002.SZ"], "trade_date": ["20260105", "20260105"]}
    )
    fold2 = pd.DataFrame({"ts_code": ["000001.SZ"], "trade_date": ["20260106"]})
    val_index_all = [fold1, fold2]

    # 桩 load_forward_returns：仅 (000001.SZ,20260105)、(000001.SZ,20260106) 命中。
    fake_map = {
        ("000001.SZ", "20260105"): 0.011,
        ("000001.SZ", "20260106"): 0.022,
    }

    captured_pairs: list[tuple[str, str]] = []

    def _fake_load(pairs):  # noqa: ANN001
        captured_pairs.extend(pairs)
        return {p: fake_map[p] for p in pairs if p in fake_map}

    monkeypatch.setattr(lstm_walk_forward, "load_forward_returns", _fake_load)

    true_ret = _build_true_ret(val_index_all, n_score=3)

    # pairs 顺序严格等于 concat 行序（折1 两行 + 折2 一行）
    assert captured_pairs == [
        ("000001.SZ", "20260105"),
        ("000002.SZ", "20260105"),
        ("000001.SZ", "20260106"),
    ]
    # 行 0 命中、行 1 未命中(NaN)、行 2 命中——与样本一一对应
    assert true_ret[0] == 0.011
    assert np.isnan(true_ret[1])
    assert true_ret[2] == 0.022


def test_build_true_ret_empty_folds_all_nan() -> None:
    out = _build_true_ret([], n_score=4)
    assert out.shape == (4,)
    assert np.isnan(out).all()


# ---------------------------------------------------------------------------
# 防泄漏回归（评审 #2）：每折早停 / 选最优 epoch 的验证序列必须来自训练折时序尾部
# 切出的 inner-val，绝不是 OOS 测试折（此前用 test 折早停 + 选权重再在同一 test 报告）。
# 纯 numpy 验证：桩掉 train_one_fold / _predict_proba（不引 torch）。
# ---------------------------------------------------------------------------


def _build_wide(n_dates: int, n_codes: int = 4) -> pd.DataFrame:
    rng = np.random.default_rng(7)
    rows: list[dict[str, object]] = []
    for d in range(n_dates):
        td = f"{10_000_000 + d}"
        for i in range(n_codes):
            rows.append(
                {
                    "trade_date": td,
                    "ts_code": f"{i:06d}.SZ",
                    "f0": float(rng.normal()),
                    "f1": float(rng.normal()),
                    "label": float(rng.integers(0, 3)),
                }
            )
    return pd.DataFrame(rows).sort_values(["trade_date", "ts_code"]).reset_index(drop=True)


def test_lstm_fold_early_stop_uses_inner_val_not_test(monkeypatch) -> None:  # noqa: ANN001
    from quant_pipeline.training import lstm_walk_forward as lwf
    from quant_pipeline.training.sequence_builder import build_sequences

    lookback = 3
    feature_cols = ["f0", "f1"]
    n_dates = 252 + 21 + 6 * 8
    wide = _build_wide(n_dates)
    splits = list(
        PurgedWalkForwardSplit(n_folds=6, embargo_days=21, min_train_days=252).split(wide)
    )

    captured_val: list[np.ndarray] = []

    def _fake_train_one_fold(x_tr, y_tr, x_va, y_va, *, hyperparams, seed):  # noqa: ANN001, ANN202
        captured_val.append(np.asarray(x_va, dtype=np.float32))
        return object(), {"accuracy": 0.0, "macro_f1": 0.0}

    def _fake_predict_proba(model, x):  # noqa: ANN001, ANN202
        n = np.asarray(x).shape[0]
        return np.full((n, 3), 1.0 / 3.0)

    monkeypatch.setattr(lwf, "train_one_fold", _fake_train_one_fold)
    monkeypatch.setattr(lwf, "_predict_proba", _fake_predict_proba)
    monkeypatch.setattr(lwf, "load_forward_returns", lambda pairs, **k: {p: 0.0 for p in pairs})

    last_model, buffers, fold_pack = lwf._run_folds(
        wide,
        feature_cols,
        splits=splits,
        lookback=lookback,
        hyperparams={},
        seed=42,
        progress_callback=None,
    )

    assert len(captured_val) == 6  # 每折一次，验证集来自 inner-val
    for cap_val, (train_idx, test_idx) in zip(captured_val, splits, strict=True):
        df_tr = wide.iloc[train_idx].reset_index(drop=True)
        df_va = wide.iloc[test_idx].reset_index(drop=True)
        # inner embargo 与生产一致：lookback + _LABEL_HORIZON(=1)
        from quant_pipeline.training.walk_forward import time_series_inner_split

        _itr, iva = time_series_inner_split(
            df_tr["trade_date"].to_numpy(), embargo_days=lookback + 1
        )
        exp_inner_val = build_sequences(
            df_tr.iloc[iva].reset_index(drop=True), lookback, feature_cols
        ).X
        test_seq = build_sequences(df_va, lookback, feature_cols).X

        # 传给早停的验证序列 == inner-val
        assert cap_val.shape == exp_inner_val.shape
        assert np.allclose(cap_val, exp_inner_val)
        # 且不是测试折序列（测试集未被当验证集偷看）
        assert not (
            cap_val.shape == test_seq.shape and np.allclose(cap_val, test_seq)
        )


# ---------------------------------------------------------------------------
# 闭环测试（分类后移 spec 2026-06-05）：连续 label + classify_mode → 离散后训练成功
# ---------------------------------------------------------------------------


def _build_wide_continuous(n_dates: int, n_codes: int = 4) -> pd.DataFrame:
    """连续涨跌幅标签（分类后移闭环测试用）。"""
    rng = np.random.default_rng(42)
    rows: list[dict[str, object]] = []
    for d in range(n_dates):
        td = f"{10_000_000 + d}"
        for i in range(n_codes):
            rows.append(
                {
                    "trade_date": td,
                    "ts_code": f"{i:06d}.SZ",
                    "f0": float(rng.normal()),
                    "f1": float(rng.normal()),
                    "label": float(rng.normal() * 0.02),  # 连续收益（如 0.013 / -0.007）
                }
            )
    return pd.DataFrame(rows).sort_values(["trade_date", "ts_code"]).reset_index(drop=True)


@pytest.mark.parametrize("classify_mode,classify_params", [
    ("band", {"eps": 0.005}),
    ("tercile", {}),
])
def test_lstm_classify_mode_discretizes_label_before_build_sequences(
    classify_mode: str,
    classify_params: dict,
    monkeypatch,  # noqa: ANN001
) -> None:
    """闭环测试（分类后移 spec 2026-06-05）：连续 label + classify_mode → _run_folds 不 raise。

    _build_wide_df 返回连续 label 后，train_lstm_model 在调 _run_folds 前已对
    wide_df["label"] 执行 classify 离散（{0,1,2}）；build_sequences 的整数护栏自然通过。
    不引入 torch：mock train_one_fold / _predict_proba。
    """
    import pytest as _pytest

    from quant_pipeline.labels.classify import classify as classify_fn
    from quant_pipeline.training import lstm_walk_forward as lwf

    lookback = 3
    feature_cols = ["f0", "f1"]
    n_dates = 252 + 21 + 6 * 8
    wide_cont = _build_wide_continuous(n_dates)

    # 先手动验证：连续 label + classify → 取值 ⊆ {0.0, 1.0, 2.0}
    td_kw: dict[str, object] = {}
    if classify_mode == "tercile":
        td_kw["trade_date"] = wide_cont["trade_date"].to_numpy()
    discrete = classify_fn(
        wide_cont["label"].to_numpy(), classify_mode, classify_params, **td_kw
    )
    uniq = set(discrete.dropna().unique().tolist())
    assert uniq.issubset({0.0, 1.0, 2.0}), f"classify 离散后出现意外值: {uniq}"

    # 验证 _run_folds 接受已离散的 wide_df（mock train_one_fold / _predict_proba）
    wide_disc = wide_cont.copy()
    wide_disc["label"] = discrete

    def _fake_train(x_tr, y_tr, x_va, y_va, *, hyperparams, seed):  # noqa: ANN001, ANN202
        return object(), {"accuracy": 0.0, "macro_f1": 0.0}

    def _fake_predict(model, x):  # noqa: ANN001, ANN202
        n = np.asarray(x).shape[0]
        return np.full((n, 3), 1.0 / 3.0)

    monkeypatch.setattr(lwf, "train_one_fold", _fake_train)
    monkeypatch.setattr(lwf, "_predict_proba", _fake_predict)
    monkeypatch.setattr(lwf, "load_forward_returns", lambda pairs, **k: {p: 0.0 for p in pairs})

    splits = list(
        PurgedWalkForwardSplit(n_folds=6, embargo_days=21, min_train_days=252).split(wide_disc)
    )

    # 不应 raise（build_sequences 的整数护栏被离散标签通过）
    last_model, buffers, _ = lwf._run_folds(
        wide_disc,
        feature_cols,
        splits=splits,
        lookback=lookback,
        hyperparams={},
        seed=0,
        progress_callback=None,
    )
    assert last_model is not None
    y_true_all = buffers[0]
    assert set(y_true_all.tolist()).issubset({0, 1, 2})
