"""train_e2e_runner._validate_params 对 LSTM/lgb-multiclass 接入的单测
（分类后移改造后，spec 2026-06-05）。

新单路径：model='lstm'/'lgb-multiclass' + classify_mode 非 NULL；
classify_mode=NULL 的误配由训练入口护栏兜（不在 _validate_params 强制）。
不连 DB / 不依赖 torch。
"""

from __future__ import annotations

from typing import Any

import pytest

from quant_pipeline.worker import train_e2e_runner as tr


def _params(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "factor_version": "v1",
        "base_type": "fwd_ret",
        "base_params": {"horizon": 1},
        "classify_mode": "band",
        "classify_params": {"eps": 0.005},
        "new_listing_min_days": 60,
        "date_range": "20240601:20240630",
        "model": "lstm",
        "walk_forward": True,
        "seed": 42,
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# 放行：lstm / lgb-multiclass + classify_mode 非 NULL
# ---------------------------------------------------------------------------


def test_lstm_with_band_classify_passes() -> None:
    p = tr._validate_params(_params(model="lstm", classify_mode="band", classify_params={"eps": 0.005}))
    assert p.model == "lstm"
    assert p.classify_mode == "band"
    assert p.classify_params == {"eps": 0.005}


def test_lstm_with_tercile_classify_passes() -> None:
    p = tr._validate_params(_params(model="lstm", classify_mode="tercile", classify_params={}))
    assert p.model == "lstm"
    assert p.classify_mode == "tercile"


def test_lgb_multiclass_with_band_classify_passes() -> None:
    p = tr._validate_params(
        _params(model="lgb-multiclass", classify_mode="band", classify_params={"eps": 0.01})
    )
    assert p.model == "lgb-multiclass"
    assert p.classify_mode == "band"


def test_lgb_multiclass_with_tercile_classify_passes() -> None:
    p = tr._validate_params(
        _params(model="lgb-multiclass", classify_mode="tercile", classify_params={})
    )
    assert p.model == "lgb-multiclass"
    assert p.classify_mode == "tercile"


def test_allowed_classify_modes_in_set() -> None:
    assert "band" in tr._ALLOWED_CLASSIFY_MODES
    assert "tercile" in tr._ALLOWED_CLASSIFY_MODES
    assert "custom" in tr._ALLOWED_CLASSIFY_MODES


def test_lstm_in_allowed_models() -> None:
    assert "lstm" in tr._ALLOWED_MODELS


def test_lgb_multiclass_in_allowed_models() -> None:
    assert "lgb-multiclass" in tr._ALLOWED_MODELS


def test_lstm_keeps_lgb_path_intact() -> None:
    """新增 lstm 不破坏既有 lgb-lambdarank 放行。"""
    p = tr._validate_params(
        _params(model="lgb-lambdarank", classify_mode=None, classify_params=None)
    )
    assert p.model == "lgb-lambdarank"
    assert p.classify_mode is None


# ---------------------------------------------------------------------------
# classify_mode=None + 分类模型：_validate_params 放行（误配护栏在训练入口）
# ---------------------------------------------------------------------------


def test_lstm_with_classify_none_passes_validate_params() -> None:
    """_validate_params 松耦合：不在此处强制 model↔classify_mode 配对。
    误配（lstm + classify_mode=None）由训练入口护栏兜（train_model 检测）。
    """
    # 这里 _validate_params 放行；误配护栏在 train_model 里 raise
    p = tr._validate_params(
        _params(model="lstm", classify_mode=None, classify_params=None)
    )
    assert p.model == "lstm"
    assert p.classify_mode is None


# ---------------------------------------------------------------------------
# 非法 classify 参数
# ---------------------------------------------------------------------------


def test_unknown_classify_mode_raises() -> None:
    with pytest.raises(ValueError, match="classify_mode"):
        tr._validate_params(_params(classify_mode="dir3_band"))


def test_band_missing_eps_raises() -> None:
    with pytest.raises(ValueError, match="eps"):
        tr._validate_params(_params(classify_mode="band", classify_params={}))


def test_band_eps_zero_raises() -> None:
    with pytest.raises(ValueError, match="eps"):
        tr._validate_params(
            _params(classify_mode="band", classify_params={"eps": 0.0})
        )
