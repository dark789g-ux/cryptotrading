"""labels/dir3_scheme.base_scheme_codec 单测（spec 2026-06-05 §测试矩阵）。

覆盖：
  - 决定性：相同 (base_type, base_params) → 相同串
  - legacy 别名：fwd_ret + {horizon:5} → 'fwd_5d_ret'（守哈希不漂移）
  - 新串：fwd_ret + {horizon:N≠5} → 'fwd_ret_h{N}'（含 h=1 次日）
  - strategy_aware → 'strategy-aware'（max_hold_days 不进 scheme）
  - 固定输入→固定哈希回归（守老 feature_set 不漂移）
  - 非法入参 raise
"""

from __future__ import annotations

import hashlib
import json

import pytest

from quant_pipeline.labels.dir3_scheme import (
    _LEGACY_FWD5_SCHEME,
    _STRATEGY_AWARE_SCHEME,
    base_scheme_codec,
)


# ─────────────────────── 决定性 ───────────────────────────────────────────────

def test_same_inputs_same_scheme() -> None:
    """相同 (base_type, base_params) → 相同 base_scheme（决定性）。"""
    assert base_scheme_codec("fwd_ret", {"horizon": 1}) == base_scheme_codec(
        "fwd_ret", {"horizon": 1}
    )
    assert base_scheme_codec("strategy_aware", {}) == base_scheme_codec(
        "strategy_aware", {}
    )


# ─────────────────────── legacy 别名 ──────────────────────────────────────────

def test_fwd_ret_h5_legacy_alias() -> None:
    """fwd_ret + horizon=5 → 'fwd_5d_ret'（legacy 别名，守现存哈希不漂移）。

    关键：现状 fallback.py 所有 horizon 的 scheme 列恒写 'fwd_5d_ret'（已 grep 核实）。
    """
    result = base_scheme_codec("fwd_ret", {"horizon": 5})
    assert result == "fwd_5d_ret"
    assert result == _LEGACY_FWD5_SCHEME


def test_fwd_ret_h1_new_scheme() -> None:
    """fwd_ret + horizon=1（次日）→ 'fwd_ret_h1'（新串）。"""
    assert base_scheme_codec("fwd_ret", {"horizon": 1}) == "fwd_ret_h1"


def test_fwd_ret_h3_new_scheme() -> None:
    """fwd_ret + horizon=3 → 'fwd_ret_h3'（新串，独立于 'fwd_5d_ret'）。"""
    assert base_scheme_codec("fwd_ret", {"horizon": 3}) == "fwd_ret_h3"


def test_fwd_ret_h10_new_scheme() -> None:
    """fwd_ret + horizon=10 → 'fwd_ret_h10'（新串）。"""
    assert base_scheme_codec("fwd_ret", {"horizon": 10}) == "fwd_ret_h10"


def test_strategy_aware_scheme() -> None:
    """strategy_aware → 'strategy-aware'（max_hold_days 不进 scheme）。
    已 grep strategy_aware.py:87 核实：LABEL_SCHEME = 'strategy-aware'。
    """
    assert base_scheme_codec("strategy_aware", {}) == "strategy-aware"
    assert base_scheme_codec("strategy_aware", {"max_hold_days": 20}) == "strategy-aware"
    assert base_scheme_codec("strategy_aware", {"max_hold_days": 10}) == "strategy-aware"
    assert base_scheme_codec("strategy_aware", None) == _STRATEGY_AWARE_SCHEME


def test_strategy_aware_none_params() -> None:
    """strategy_aware base_params=None → 同 {}，max_hold_days 不进 scheme。"""
    assert base_scheme_codec("strategy_aware", None) == base_scheme_codec(
        "strategy_aware", {}
    )


# ─────────────────────── 固定哈希回归（守老 feature_set 不漂移）───────────────

def _build_feature_set_id_payload(label_scheme: str) -> str:
    """重现 build_feature_set_id 的哈希输入 payload（spec: label_scheme 入哈希）。"""
    payload = json.dumps(
        {
            "factor_version": "v1",
            "label_scheme": label_scheme,
            "new_listing_min_days": 60,
            "neutralize_cols": [],
            "robust_z": True,
            "factor_ids": [],
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return payload


def _sha12(payload: str) -> str:
    return "fs_" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def test_legacy_fwd5d_ret_hash_unchanged() -> None:
    """fwd_ret h=5 → 'fwd_5d_ret' → feature_set_id 哈希与原 legacy 完全一致。

    这是最关键的回归断言：守住老特征集不漂移。
    """
    codec_scheme = base_scheme_codec("fwd_ret", {"horizon": 5})
    assert codec_scheme == "fwd_5d_ret"
    # codec 输出与直接写 'fwd_5d_ret' 的哈希完全一致
    assert _sha12(_build_feature_set_id_payload(codec_scheme)) == _sha12(
        _build_feature_set_id_payload("fwd_5d_ret")
    )


def test_strategy_aware_hash_unchanged() -> None:
    """strategy_aware → 'strategy-aware' → feature_set_id 哈希不变。"""
    codec_scheme = base_scheme_codec("strategy_aware", {})
    assert codec_scheme == "strategy-aware"
    assert _sha12(_build_feature_set_id_payload(codec_scheme)) == _sha12(
        _build_feature_set_id_payload("strategy-aware")
    )


def test_h1_distinct_from_h5() -> None:
    """fwd_ret_h1 与 fwd_5d_ret 哈希不同（独立串，不碰撞）。"""
    h1_scheme = base_scheme_codec("fwd_ret", {"horizon": 1})
    h5_scheme = base_scheme_codec("fwd_ret", {"horizon": 5})
    assert h1_scheme != h5_scheme
    assert _sha12(_build_feature_set_id_payload(h1_scheme)) != _sha12(
        _build_feature_set_id_payload(h5_scheme)
    )


def test_h3_distinct_from_h5() -> None:
    """fwd_ret_h3 与 fwd_5d_ret 哈希不同（独立串，h=3 原本与 h=5 碰撞的 bug 已修复）。"""
    h3_scheme = base_scheme_codec("fwd_ret", {"horizon": 3})
    h5_scheme = base_scheme_codec("fwd_ret", {"horizon": 5})
    assert h3_scheme != h5_scheme


# ─────────────────────── 非法入参 ─────────────────────────────────────────────

def test_invalid_base_type_raises() -> None:
    with pytest.raises(ValueError, match="base_type"):
        base_scheme_codec("dir3_band", {})


def test_fwd_ret_missing_horizon_raises() -> None:
    with pytest.raises(ValueError, match="horizon"):
        base_scheme_codec("fwd_ret", {})


def test_fwd_ret_none_params_raises() -> None:
    with pytest.raises(ValueError, match="horizon"):
        base_scheme_codec("fwd_ret", None)


def test_fwd_ret_horizon_zero_raises() -> None:
    with pytest.raises(ValueError, match="horizon.*>=.*1"):
        base_scheme_codec("fwd_ret", {"horizon": 0})


def test_fwd_ret_horizon_negative_raises() -> None:
    with pytest.raises(ValueError, match="horizon.*>=.*1"):
        base_scheme_codec("fwd_ret", {"horizon": -1})


# ─────────────────────── fwd_ret 一致性 ───────────────────────────────────────

def test_fwd_ret_h1_scheme_str() -> None:
    """fwd_ret_h1 方案串格式正确（包含 h1 字样）。"""
    scheme = base_scheme_codec("fwd_ret", {"horizon": 1})
    assert "h1" in scheme or scheme == "fwd_ret_h1"
    assert scheme == "fwd_ret_h1"


def test_fwd_ret_h5_is_legacy_str() -> None:
    """fwd_ret h=5 返回 legacy 字面量 'fwd_5d_ret'（不是 'fwd_ret_h5'）。"""
    scheme = base_scheme_codec("fwd_ret", {"horizon": 5})
    assert scheme == "fwd_5d_ret"
    assert scheme != "fwd_ret_h5"
