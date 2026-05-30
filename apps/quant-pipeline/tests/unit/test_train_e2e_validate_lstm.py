# -*- coding: utf-8 -*-
"""train_e2e_runner._validate_params 对 LSTM 接入的白名单单测（spec 04 §2.1）。

放行 model='lstm' + label_scheme∈{dir3_band, dir3_tercile}；仍拒绝未知 model/scheme。
不连 DB、不依赖 torch。
"""

from __future__ import annotations

from typing import Any

import pytest

from quant_pipeline.worker import train_e2e_runner as tr


def _params(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "factor_version": "v1",
        "label_scheme": "dir3_band",
        "new_listing_min_days": 60,
        "date_range": "20240601:20240630",
        "model": "lstm",
        "walk_forward": True,
        "seed": 42,
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# 放行：lstm + dir3_band / dir3_tercile
# ---------------------------------------------------------------------------


def test_lstm_with_dir3_band_passes() -> None:
    p = tr._validate_params(_params(model="lstm", label_scheme="dir3_band"))
    assert p.model == "lstm"
    assert p.label_scheme == "dir3_band"


def test_lstm_with_dir3_tercile_passes() -> None:
    p = tr._validate_params(_params(model="lstm", label_scheme="dir3_tercile"))
    assert p.model == "lstm"
    assert p.label_scheme == "dir3_tercile"


def test_dir3_schemes_in_allowed_set() -> None:
    assert "dir3_band" in tr._ALLOWED_SCHEMES
    assert "dir3_tercile" in tr._ALLOWED_SCHEMES


def test_lstm_in_allowed_models() -> None:
    assert "lstm" in tr._ALLOWED_MODELS


def test_lstm_keeps_lgb_path_intact() -> None:
    """新增 lstm 不破坏既有 lgb-lambdarank 放行。"""

    p = tr._validate_params(_params(model="lgb-lambdarank", label_scheme="strategy-aware"))
    assert p.model == "lgb-lambdarank"


# ---------------------------------------------------------------------------
# 仍拒绝：未知 model / 未知 scheme
# ---------------------------------------------------------------------------


def test_unknown_model_still_rejected() -> None:
    with pytest.raises(ValueError, match="model"):
        tr._validate_params(_params(model="xgboost"))


def test_unknown_scheme_still_rejected() -> None:
    with pytest.raises(ValueError, match="label_scheme"):
        tr._validate_params(_params(label_scheme="dir3_bogus"))


def test_lstm_with_unknown_scheme_rejected() -> None:
    """lstm + 非白名单 scheme 仍拒。

    v1 不强制 model↔scheme 配对，但 scheme 自身白名单仍生效。
    """

    with pytest.raises(ValueError, match="label_scheme"):
        tr._validate_params(_params(model="lstm", label_scheme="not_a_scheme"))


def test_lstm_with_continuous_scheme_passes_validate_guarded_at_train() -> None:
    """v1 _validate_params 不强制 model↔scheme 配对：lstm + fwd_5d_ret 在校验层放行，
    误配由 LSTM 训练入口 label 整数护栏兜住（spec 02 §3 / 04 §2.1 备注）。"""

    p = tr._validate_params(_params(model="lstm", label_scheme="fwd_5d_ret"))
    assert p.model == "lstm"
    assert p.label_scheme == "fwd_5d_ret"
