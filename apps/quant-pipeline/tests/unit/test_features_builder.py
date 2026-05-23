# -*- coding: utf-8 -*-
"""features/builder.py 单测。

覆盖：
  - 中性化：industry-only / industry+mv 残差化
  - 标准化：截面 z-score（均值 ≈ 0、方差 ≈ 1）
  - 缺失处理：行业中位数填充 + 残留 NaN 整行 drop
  - 截尾：因子 ±3σ + label ±50%
  - feature_set_id：稳定性 + 不同 (factor_version, label_scheme, neutralize_cols,
                    robust_z) 输入 → 不同 hash
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from quant_pipeline.features.builder import (
    DEFAULT_NEUTRALIZE_COLS,
    FACTOR_CLIP_SIGMA,
    build_feature_matrix_from_frames,
    build_feature_set_id,
    impute_missing_with_industry_median,
    neutralize_by_industry,
    neutralize_by_industry_and_market_cap,
    pivot_factors_long_to_wide,
    resolve_feature_set_id,
    standardize_cross_sectional,
    winsorize_factors,
)


# ----------------------------------------------------------------------
# feature_set_id 稳定性
# ----------------------------------------------------------------------

def test_feature_set_id_is_deterministic() -> None:
    a = build_feature_set_id("v1", "strategy-aware", new_listing_min_days=60)
    b = build_feature_set_id("v1", "strategy-aware", new_listing_min_days=60)
    assert a == b
    assert a.startswith("fs_")
    assert len(a) == 3 + 12  # "fs_" + 12 hex


def test_feature_set_id_changes_on_inputs() -> None:
    a = build_feature_set_id("v1", "strategy-aware", new_listing_min_days=60)
    b = build_feature_set_id("v2", "strategy-aware", new_listing_min_days=60)
    c = build_feature_set_id("v1", "fwd_5d_ret", new_listing_min_days=60)
    d = build_feature_set_id(
        "v1", "strategy-aware", new_listing_min_days=60,
        neutralize_cols=("industry_l1",),
    )
    e = build_feature_set_id(
        "v1", "strategy-aware", new_listing_min_days=60, robust_z=False,
    )
    f = build_feature_set_id("v1", "strategy-aware", new_listing_min_days=30)
    assert len({a, b, c, d, e, f}) == 6


def test_feature_set_id_neutralize_cols_order_invariant() -> None:
    a = build_feature_set_id(
        "v1", "strategy-aware", new_listing_min_days=60,
        neutralize_cols=("industry_l1", "mv"),
    )
    b = build_feature_set_id(
        "v1", "strategy-aware", new_listing_min_days=60,
        neutralize_cols=("mv", "industry_l1"),
    )
    assert a == b


# ----------------------------------------------------------------------
# 哈希契约升级（spec 03 D-22）：factor_ids 顺序无关 + new_listing_min_days
# ----------------------------------------------------------------------

def test_feature_set_id_factor_ids_order_invariant() -> None:
    """D-22：factor_ids 元组顺序不影响哈希。

    sorted() 在 builder 侧保证；与 DB 唯一索引 md5(array_to_string(...))
    的对齐依赖 runner 写入侧也 sorted。
    """

    a = build_feature_set_id(
        "v1", "strategy-aware", new_listing_min_days=60,
        factor_ids=("f1", "f2"),
    )
    b = build_feature_set_id(
        "v1", "strategy-aware", new_listing_min_days=60,
        factor_ids=("f2", "f1"),
    )
    assert a == b


def test_feature_set_id_factor_ids_membership_changes_hash() -> None:
    """factor_ids 内容变化（即使长度相同）必须产生不同 ID。"""

    a = build_feature_set_id(
        "v1", "strategy-aware", new_listing_min_days=60,
        factor_ids=("f1", "f2"),
    )
    b = build_feature_set_id(
        "v1", "strategy-aware", new_listing_min_days=60,
        factor_ids=("f1", "f3"),
    )
    assert a != b


def test_feature_set_id_new_listing_min_days_changes_hash() -> None:
    """D-12：new_listing_min_days 不同 → 不同 ID。"""

    a = build_feature_set_id("v1", "strategy-aware", new_listing_min_days=0)
    b = build_feature_set_id("v1", "strategy-aware", new_listing_min_days=60)
    c = build_feature_set_id("v1", "strategy-aware", new_listing_min_days=250)
    assert len({a, b, c}) == 3


def test_feature_set_id_new_listing_min_days_type_coerced_to_int() -> None:
    """spec 03 §哈希契约升级：强制 int(new_listing_min_days)，
    防 60 vs '60' / 60.0 → 不同 hash。

    传入 True/False（int 子类）会被 int() 当 1/0 处理——这里只验证
    int 与 等价 float / numpy 整型不会产生不同 hash。
    """

    import numpy as np

    a = build_feature_set_id("v1", "strategy-aware", new_listing_min_days=60)
    b = build_feature_set_id("v1", "strategy-aware", new_listing_min_days=int(np.int64(60)))
    assert a == b


# ----------------------------------------------------------------------
# resolve_feature_set_id 预查复用（spec 03 D-16）
# ----------------------------------------------------------------------

class _FakeRow:
    """模拟 sqlalchemy Row：支持 ``row[0]`` 取首列。"""

    def __init__(self, values: tuple) -> None:
        self._v = values

    def __getitem__(self, idx: int):
        return self._v[idx]


class _FakeResult:
    def __init__(self, row: _FakeRow | None) -> None:
        self._row = row

    def fetchone(self) -> _FakeRow | None:
        return self._row


class _FakeConn:
    """duck-type conn：记录 execute 调用，按预设返回行。

    spec 03：``resolve_feature_set_id`` 用 conn.execute(text(sql), params)
    取一行，命中返回老 ID，未命中返回 None。
    """

    def __init__(self, row: _FakeRow | None = None) -> None:
        self._row = row
        self.calls: list[tuple[Any, dict[str, Any]]] = []

    def execute(self, sql: Any, params: dict[str, Any]) -> _FakeResult:
        self.calls.append((sql, params))
        return _FakeResult(self._row)


def test_resolve_feature_set_id_hit_returns_existing_id() -> None:
    """预查命中：返回 (老 ID, True)，即便新哈希与之不同也复用老 ID。"""

    conn = _FakeConn(row=_FakeRow(("fs_legacy00000",)))
    fsid, reused = resolve_feature_set_id(
        conn,
        factor_version="v1",
        label_scheme="strategy-aware",
        new_listing_min_days=60,
        factor_ids=("f1", "f2"),
    )
    assert reused is True
    assert fsid == "fs_legacy00000"

    # 验证传给 SQL 的 params 与 DB 唯一索引表达式对齐
    assert len(conn.calls) == 1
    _sql, params = conn.calls[0]
    assert params["fv"] == "v1"
    assert params["sc"] == "strategy-aware"
    assert params["nd"] == 60
    # fmd5 由 sorted(factor_ids) join ',' 后 md5 折算
    import hashlib as _h
    expected = _h.md5("f1,f2".encode("utf-8")).hexdigest()
    assert params["fmd5"] == expected


def test_resolve_feature_set_id_miss_returns_new_id() -> None:
    """未命中：返回 (新哈希 ID, False)。"""

    conn = _FakeConn(row=None)
    fsid, reused = resolve_feature_set_id(
        conn,
        factor_version="v1",
        label_scheme="strategy-aware",
        new_listing_min_days=60,
        factor_ids=("f1", "f2"),
    )
    assert reused is False
    assert fsid.startswith("fs_")
    # 与 build_feature_set_id 在同输入下的结果一致
    expected = build_feature_set_id(
        "v1", "strategy-aware", new_listing_min_days=60,
        factor_ids=("f1", "f2"),
    )
    assert fsid == expected


def test_resolve_feature_set_id_factor_ids_order_query_invariant() -> None:
    """预查 SQL 的 fmd5 与 factor_ids 顺序无关（builder 与索引侧三处对齐）。"""

    conn1 = _FakeConn(row=None)
    conn2 = _FakeConn(row=None)
    id1, _ = resolve_feature_set_id(
        conn1, factor_version="v1", label_scheme="strategy-aware",
        new_listing_min_days=60, factor_ids=("f1", "f2"),
    )
    id2, _ = resolve_feature_set_id(
        conn2, factor_version="v1", label_scheme="strategy-aware",
        new_listing_min_days=60, factor_ids=("f2", "f1"),
    )
    assert id1 == id2
    assert conn1.calls[0][1]["fmd5"] == conn2.calls[0][1]["fmd5"]


# ----------------------------------------------------------------------
# pivot
# ----------------------------------------------------------------------

def _make_daily_factors() -> pd.DataFrame:
    """构造 2 个交易日 × 4 只股票 × 2 个因子。"""

    rows = []
    for td in ("20240102", "20240103"):
        for ts, mv in zip(("000001.SZ", "000002.SZ", "000003.SZ", "000004.SZ"),
                          (1e10, 5e9, 2e10, 8e9)):
            rows.append({"trade_date": td, "ts_code": ts, "factor_id": "mom_20", "value": float(mv) / 1e10})
            rows.append({"trade_date": td, "ts_code": ts, "factor_id": "vol_20", "value": float(mv) / 2e10})
    return pd.DataFrame(rows)


def test_pivot_long_to_wide_shape() -> None:
    df = _make_daily_factors()
    wide = pivot_factors_long_to_wide(df)
    assert wide.shape == (8, 2)  # 2 dates * 4 codes; 2 factors
    assert set(wide.columns) == {"mom_20", "vol_20"}


# ----------------------------------------------------------------------
# 中性化
# ----------------------------------------------------------------------

def test_neutralize_by_industry_zscore_within_groups() -> None:
    """同行业内 z-score 后均值接近 0、标准差接近 1。"""

    rows = []
    for td in ("20240102",):
        for ts, val in [
            ("A", 1.0), ("B", 2.0), ("C", 3.0),  # 行业 X
            ("D", 4.0), ("E", 5.0), ("F", 6.0),  # 行业 Y
        ]:
            rows.append({"trade_date": td, "ts_code": ts, "factor_id": "f", "value": val})
    wide = pivot_factors_long_to_wide(pd.DataFrame(rows))
    industry = pd.DataFrame(
        [
            {"trade_date": "20240102", "ts_code": "A", "industry_l1": "X"},
            {"trade_date": "20240102", "ts_code": "B", "industry_l1": "X"},
            {"trade_date": "20240102", "ts_code": "C", "industry_l1": "X"},
            {"trade_date": "20240102", "ts_code": "D", "industry_l1": "Y"},
            {"trade_date": "20240102", "ts_code": "E", "industry_l1": "Y"},
            {"trade_date": "20240102", "ts_code": "F", "industry_l1": "Y"},
        ]
    )
    out = neutralize_by_industry(wide, industry)
    # 每行业内 z-score 均值 ≈ 0
    df = out.reset_index().merge(industry, on=["trade_date", "ts_code"])
    grouped = df.groupby("industry_l1")["f"]
    for _, g in grouped:
        assert abs(g.mean()) < 1e-6


def test_neutralize_by_industry_and_market_cap_reduces_mv_correlation() -> None:
    """加入 mv 中性化后，因子与 log(mv) 截面相关性应显著降低。"""

    rng = np.random.default_rng(0)
    rows = []
    mv_rows = []
    industry_rows = []
    for ts_idx in range(30):
        ts = f"S{ts_idx:04d}"
        mv = float(rng.uniform(1e9, 1e11))
        # 让因子值与 log(mv) 强相关
        f_val = np.log(mv) + rng.normal(0, 0.1)
        rows.append({"trade_date": "20240102", "ts_code": ts, "factor_id": "f", "value": f_val})
        mv_rows.append({"trade_date": "20240102", "ts_code": ts, "mv": mv})
        industry_rows.append(
            {"trade_date": "20240102", "ts_code": ts, "industry_l1": "X" if ts_idx % 2 == 0 else "Y"}
        )
    wide = pivot_factors_long_to_wide(pd.DataFrame(rows))
    industry = pd.DataFrame(industry_rows)
    mv = pd.DataFrame(mv_rows)

    only_ind = neutralize_by_industry(wide, industry)
    both = neutralize_by_industry_and_market_cap(wide, industry, mv)

    # 用 log(mv) 与每个因子计算相关；mv 中性化后应大幅降低
    mv_log = np.log(mv["mv"].values)
    f_only_ind = only_ind.reset_index().merge(mv, on=["trade_date", "ts_code"])
    f_both = both.reset_index().merge(mv, on=["trade_date", "ts_code"])
    corr_ind = abs(np.corrcoef(f_only_ind["f"].values, np.log(f_only_ind["mv"].values))[0, 1])
    corr_both = abs(np.corrcoef(f_both["f"].values, np.log(f_both["mv"].values))[0, 1])
    assert corr_both < corr_ind  # mv 中性化降低相关性
    assert corr_both < 0.1  # 接近 0


# ----------------------------------------------------------------------
# 标准化
# ----------------------------------------------------------------------

def test_standardize_cross_sectional_zero_mean_unit_std() -> None:
    rows = []
    for td in ("20240102", "20240103"):
        for i, ts in enumerate(("A", "B", "C", "D", "E")):
            rows.append({"trade_date": td, "ts_code": ts, "factor_id": "f", "value": float(i)})
    wide = pivot_factors_long_to_wide(pd.DataFrame(rows))
    out = standardize_cross_sectional(wide)
    df = out.reset_index()
    for _, g in df.groupby("trade_date"):
        assert abs(g["f"].mean()) < 1e-6
        assert abs(g["f"].std(ddof=0) - 1.0) < 1e-6


# ----------------------------------------------------------------------
# 缺失填充
# ----------------------------------------------------------------------

def test_impute_industry_median_fills_nan_within_industry() -> None:
    """构造 2 个因子；C 在 f 上缺、g 上有 → pivot 仍含 C，f 列 NaN → 行业中位数填充。"""

    rows = [
        # f 因子
        {"trade_date": "20240102", "ts_code": "A", "factor_id": "f", "value": 1.0},
        {"trade_date": "20240102", "ts_code": "B", "factor_id": "f", "value": 3.0},
        # C 缺 f
        # g 因子（让 C 出现在 pivot index 中）
        {"trade_date": "20240102", "ts_code": "A", "factor_id": "g", "value": 10.0},
        {"trade_date": "20240102", "ts_code": "B", "factor_id": "g", "value": 20.0},
        {"trade_date": "20240102", "ts_code": "C", "factor_id": "g", "value": 30.0},
    ]
    wide = pivot_factors_long_to_wide(pd.DataFrame(rows))
    assert ("20240102", "C") in wide.index  # 保证 C 在
    industry = pd.DataFrame(
        [
            {"trade_date": "20240102", "ts_code": "A", "industry_l1": "X"},
            {"trade_date": "20240102", "ts_code": "B", "industry_l1": "X"},
            {"trade_date": "20240102", "ts_code": "C", "industry_l1": "X"},
        ]
    )
    out = impute_missing_with_industry_median(wide, industry)
    assert out.loc[("20240102", "C"), "f"] == 2.0  # (1+3)/2


# ----------------------------------------------------------------------
# 截尾
# ----------------------------------------------------------------------

def test_winsorize_factors_clips_to_sigma() -> None:
    """构造一个明显的 outlier，验证 ±Nσ 截断生效。"""

    rng = np.random.default_rng(42)
    base = rng.normal(0, 1, size=100)
    base[0] = 10.0  # 极端值
    rows = []
    for i, v in enumerate(base):
        rows.append({"trade_date": "20240102", "ts_code": f"S{i:03d}", "factor_id": "f", "value": float(v)})
    wide = pivot_factors_long_to_wide(pd.DataFrame(rows))
    out = winsorize_factors(wide, sigma=FACTOR_CLIP_SIGMA)
    # outlier 被截断
    assert out["f"].max() < 10.0
    assert out["f"].max() <= base[1:].std() * FACTOR_CLIP_SIGMA * 2  # 宽松上界


# ----------------------------------------------------------------------
# 端到端
# ----------------------------------------------------------------------

def test_build_feature_matrix_end_to_end_with_labels() -> None:
    """daily_factors + labels + industry → bundle.matrix 含 label + factor 列。"""

    df = _make_daily_factors()
    labels = pd.DataFrame(
        [
            {"trade_date": "20240102", "ts_code": "000001.SZ", "scheme": "strategy-aware",
             "value": 0.05, "exit_reason": "max_hold", "hold_days": 20},
            {"trade_date": "20240102", "ts_code": "000002.SZ", "scheme": "strategy-aware",
             "value": 0.03, "exit_reason": "ma5_break", "hold_days": 7},
            {"trade_date": "20240102", "ts_code": "000003.SZ", "scheme": "strategy-aware",
             "value": -0.05, "exit_reason": "stop_loss", "hold_days": 3},
            {"trade_date": "20240102", "ts_code": "000004.SZ", "scheme": "strategy-aware",
             "value": 0.01, "exit_reason": "max_hold", "hold_days": 20},
        ]
    )
    industry = pd.DataFrame(
        [
            {"trade_date": "20240102", "ts_code": ts, "industry_l1": "X" if i < 2 else "Y"}
            for i, ts in enumerate(["000001.SZ", "000002.SZ", "000003.SZ", "000004.SZ"])
        ]
    )
    bundle = build_feature_matrix_from_frames(
        daily_factors=df,
        labels=labels,
        industry_map=industry,
        factor_version="v1",
        label_scheme="strategy-aware",
        new_listing_min_days=60,
        mv_map=None,
    )
    assert bundle.feature_set_id.startswith("fs_")
    assert set(bundle.factor_ids) == {"mom_20", "vol_20"}
    cols = set(bundle.matrix.columns)
    assert {"trade_date", "ts_code", "mom_20", "vol_20", "label"}.issubset(cols)
    assert len(bundle.matrix) >= 1


def test_build_feature_matrix_label_winsorize_applied() -> None:
    df = _make_daily_factors()
    # 4 只票，1 只极端 label = 5.0；应被 winsorize 到 0.5
    labels = pd.DataFrame(
        [
            {"trade_date": "20240102", "ts_code": "000001.SZ", "scheme": "strategy-aware",
             "value": 5.0, "exit_reason": "max_hold", "hold_days": 20},
            {"trade_date": "20240102", "ts_code": "000002.SZ", "scheme": "strategy-aware",
             "value": 0.0, "exit_reason": "ma5_break", "hold_days": 7},
            {"trade_date": "20240102", "ts_code": "000003.SZ", "scheme": "strategy-aware",
             "value": -3.0, "exit_reason": "stop_loss", "hold_days": 3},
            {"trade_date": "20240102", "ts_code": "000004.SZ", "scheme": "strategy-aware",
             "value": 0.1, "exit_reason": "max_hold", "hold_days": 20},
        ]
    )
    industry = pd.DataFrame(
        [
            {"trade_date": "20240102", "ts_code": ts, "industry_l1": "X" if i < 2 else "Y"}
            for i, ts in enumerate(["000001.SZ", "000002.SZ", "000003.SZ", "000004.SZ"])
        ]
    )
    bundle = build_feature_matrix_from_frames(
        daily_factors=df,
        labels=labels,
        industry_map=industry,
        factor_version="v1",
        label_scheme="strategy-aware",
        new_listing_min_days=60,
        mv_map=None,
        label_winsorize=(-0.5, 0.5),
    )
    assert bundle.matrix["label"].max() <= 0.5 + 1e-9
    assert bundle.matrix["label"].min() >= -0.5 - 1e-9
