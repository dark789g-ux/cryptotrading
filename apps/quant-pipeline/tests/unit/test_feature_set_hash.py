"""feature_set_id 覆盖层哈希（方案 A）单测（spec 04 §Python pytest 回归红线）。

核心断言：
  - 回归红线：全默认配置算出的 id == 改动前 id（基础层 id）。
  - 「不传」与「显式传默认值」→ 同一 id（默认不入覆盖层）。
  - 非默认 factor_clip_sigma / label_winsorize → 不同 id。
  - 非默认 neutralize_cols / robust_z → 不同 base id（基础层）。
  - neutralize_cols / factor_ids 顺序无关。
  - scheme 裁剪：label_winsorize 仅连续标签、fwd_horizon_days 仅 fwd_5d_ret、
    max_hold_days 仅 strategy-aware 入覆盖层。

不连 DB / 不依赖 lightgbm / torch（纯哈希函数）。
"""

from __future__ import annotations

from quant_pipeline.features.builder import (
    FACTOR_CLIP_SIGMA,
    build_feature_set_id,
)
from quant_pipeline.features.feature_set_hash import (
    apply_overlay_to_feature_set_id,
    build_overlay,
    overlay_canonical_str,
)
from quant_pipeline.labels.fallback import FWD_HORIZON_DAYS
from quant_pipeline.labels.strategy_aware import WINSORIZE_HI, WINSORIZE_LO
from quant_pipeline.strategy.exit_rules import MAX_HOLD_DAYS

_FIDS = ("momentum_20d", "rsi_14", "volatility_20d")


def _base_id(scheme: str = "strategy-aware") -> str:
    return build_feature_set_id("v1", scheme, new_listing_min_days=60, factor_ids=_FIDS)


# ---------------------------------------------------------------- 回归红线
def test_all_default_id_equals_pre_change_base_id() -> None:
    pre = _base_id()
    overlay = build_overlay(label_scheme="strategy-aware")
    assert overlay == {}
    assert apply_overlay_to_feature_set_id(pre, overlay) == pre


def test_not_passed_equals_explicit_default() -> None:
    pre = _base_id()
    overlay = build_overlay(
        label_scheme="strategy-aware",
        factor_clip_sigma=FACTOR_CLIP_SIGMA,
        label_winsorize=(WINSORIZE_LO, WINSORIZE_HI),
        max_hold_days=MAX_HOLD_DAYS,
    )
    assert overlay == {}
    assert apply_overlay_to_feature_set_id(pre, overlay) == pre


# ---------------------------------------------------------------- 非默认 → 不同 id
def test_non_default_factor_clip_sigma_changes_id() -> None:
    pre = _base_id()
    overlay = build_overlay(label_scheme="strategy-aware", factor_clip_sigma=2.5)
    assert overlay == {"factor_clip_sigma": 2.5}
    new_id = apply_overlay_to_feature_set_id(pre, overlay)
    assert new_id != pre and new_id.startswith("fs_")


def test_non_default_label_winsorize_changes_id() -> None:
    pre = _base_id()
    overlay = build_overlay(label_scheme="strategy-aware", label_winsorize=(-0.3, 0.3))
    assert overlay == {"label_winsorize": [-0.3, 0.3]}
    assert apply_overlay_to_feature_set_id(pre, overlay) != pre


def test_non_default_neutralize_cols_changes_base_id() -> None:
    pre = _base_id()
    other = build_feature_set_id(
        "v1", "strategy-aware", new_listing_min_days=60,
        neutralize_cols=("industry_l1",), factor_ids=_FIDS,
    )
    assert other != pre


def test_non_default_robust_z_changes_base_id() -> None:
    pre = _base_id()
    other = build_feature_set_id(
        "v1", "strategy-aware", new_listing_min_days=60, robust_z=False, factor_ids=_FIDS,
    )
    assert other != pre


# ---------------------------------------------------------------- 顺序无关
def test_neutralize_cols_order_independent() -> None:
    a = build_feature_set_id(
        "v1", "strategy-aware", new_listing_min_days=60,
        neutralize_cols=("mv", "industry_l1"), factor_ids=_FIDS,
    )
    b = build_feature_set_id(
        "v1", "strategy-aware", new_listing_min_days=60,
        neutralize_cols=("industry_l1", "mv"), factor_ids=_FIDS,
    )
    assert a == b


def test_factor_ids_order_independent() -> None:
    a = _base_id()
    b = build_feature_set_id(
        "v1", "strategy-aware", new_listing_min_days=60, factor_ids=tuple(reversed(_FIDS)),
    )
    assert a == b


def test_overlay_canonical_order_independent() -> None:
    o1 = build_overlay(
        label_scheme="strategy-aware",
        factor_clip_sigma=2.5, label_winsorize=(-0.3, 0.3), max_hold_days=15,
    )
    o2 = build_overlay(
        label_scheme="strategy-aware",
        max_hold_days=15, label_winsorize=(-0.3, 0.3), factor_clip_sigma=2.5,
    )
    assert overlay_canonical_str(o1) == overlay_canonical_str(o2)


# ---------------------------------------------------------------- scheme 裁剪
def test_label_winsorize_ignored_for_dir3() -> None:
    assert build_overlay(label_scheme="dir3_band", label_winsorize=(-0.3, 0.3)) == {}


def test_label_winsorize_applies_for_fwd() -> None:
    assert build_overlay(label_scheme="fwd_5d_ret", label_winsorize=(-0.3, 0.3)) == {
        "label_winsorize": [-0.3, 0.3]
    }


def test_fwd_horizon_days_only_fwd_scheme() -> None:
    assert build_overlay(label_scheme="fwd_5d_ret", fwd_horizon_days=10) == {"fwd_horizon_days": 10}
    assert build_overlay(label_scheme="strategy-aware", fwd_horizon_days=10) == {}


def test_fwd_horizon_days_default_not_in_overlay() -> None:
    assert build_overlay(label_scheme="fwd_5d_ret", fwd_horizon_days=FWD_HORIZON_DAYS) == {}


def test_max_hold_days_only_strategy_aware() -> None:
    assert build_overlay(label_scheme="strategy-aware", max_hold_days=15) == {"max_hold_days": 15}
    assert build_overlay(label_scheme="fwd_5d_ret", max_hold_days=15) == {}
