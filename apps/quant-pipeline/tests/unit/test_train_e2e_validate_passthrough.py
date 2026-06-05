"""train_e2e _validate_params 新参数严格校验单测
（分类后移改造后，spec 2026-06-05）。

覆盖：
  - hyperparams（lgb 白名单 + 范围；未知键 warn+跳过；single_fold early_stopping warn）
  - neutralize_cols 三档规范组合
  - robust_z / factor_clip_sigma / label_winsorize
  - classify_mode / classify_params 校验（代替旧 fwd_horizon_days / max_hold_days）
  - base_params（fwd_ret.horizon / strategy_aware.max_hold_days）

不连 DB / 不依赖 lightgbm / torch（纯 _validate_params 校验逻辑）。
"""

from __future__ import annotations

from typing import Any

import pytest

from quant_pipeline.worker import train_e2e_runner as tr


def _valid(**ov: Any) -> dict[str, Any]:
    b: dict[str, Any] = {
        "factor_version": "v1",
        "base_type": "strategy_aware",
        # strategy_aware 现要求引用命名策略（spec 03 §3.3），不再用 max_hold_days。
        "base_params": {"strategy_id": "default_exit", "strategy_version": "v1"},
        "classify_mode": None,
        "classify_params": None,
        "new_listing_min_days": 60,
        "date_range": "20240601:20240630",
        "model": "lgb-lambdarank",
        "walk_forward": True,
        "seed": 42,
    }
    b.update(ov)
    return b


def _valid_fwd(**ov: Any) -> dict[str, Any]:
    b: dict[str, Any] = {
        "factor_version": "v1",
        "base_type": "fwd_ret",
        "base_params": {"horizon": 5},
        "classify_mode": None,
        "classify_params": None,
        "new_listing_min_days": 60,
        "date_range": "20240601:20240630",
        "model": "lgb-lambdarank",
        "walk_forward": True,
        "seed": 42,
    }
    b.update(ov)
    return b


# ---------------------------------------------------------------- model 白名单
def test_lgb_multiclass_is_allowed_model() -> None:
    p = tr._validate_params(
        _valid(model="lgb-multiclass", classify_mode="band", classify_params={"eps": 0.005})
    )
    assert p.model == "lgb-multiclass"


# ---------------------------------------------------------------- 默认全 None
def test_all_optional_params_default_to_none() -> None:
    p = tr._validate_params(_valid())
    assert p.hyperparams is None
    assert p.neutralize_cols is None
    assert p.robust_z is None
    assert p.factor_clip_sigma is None
    assert p.label_winsorize is None
    assert p.classify_mode is None
    assert p.classify_params is None
    assert p.label_id is None
    assert p.label_version is None


# ---------------------------------------------------------------- hyperparams
def test_hyperparams_valid_lgb_passthrough() -> None:
    p = tr._validate_params(_valid(hyperparams={"num_leaves": 63, "learning_rate": 0.1}))
    assert p.hyperparams == {"num_leaves": 63, "learning_rate": 0.1}


@pytest.mark.parametrize(
    "hp,key",
    [
        ({"num_leaves": 200}, "num_leaves"),
        ({"num_leaves": 10}, "num_leaves"),
        ({"learning_rate": 0.5}, "learning_rate"),
        ({"feature_fraction": 0.1}, "feature_fraction"),
        ({"min_data_in_leaf": 10}, "min_data_in_leaf"),
        ({"num_boost_round": 5000}, "num_boost_round"),
        ({"early_stopping_rounds": 5}, "early_stopping_rounds"),
        ({"bagging_fraction": 0.1}, "bagging_fraction"),
        ({"lambda_l1": -1}, "lambda_l1"),
        ({"lambda_l2": -0.5}, "lambda_l2"),
    ],
)
def test_hyperparams_out_of_range_raises(hp: dict[str, Any], key: str) -> None:
    with pytest.raises(ValueError, match=key):
        tr._validate_params(_valid(hyperparams=hp))


def test_hyperparams_unknown_key_warns_and_skips(caplog: pytest.LogCaptureFixture) -> None:
    import logging

    with caplog.at_level(logging.WARNING):
        p = tr._validate_params(_valid(hyperparams={"bogus_key": 5, "num_leaves": 31}))
    assert p.hyperparams == {"num_leaves": 31}
    assert any("unknown_hyperparam" in r.message for r in caplog.records)


def test_hyperparams_int_param_non_integer_raises() -> None:
    with pytest.raises(ValueError, match="num_leaves"):
        tr._validate_params(_valid(hyperparams={"num_leaves": 31.5}))


def test_hyperparams_bool_rejected() -> None:
    with pytest.raises(ValueError, match="num_leaves"):
        tr._validate_params(_valid(hyperparams={"num_leaves": True}))


def test_hyperparams_non_dict_raises() -> None:
    with pytest.raises(ValueError, match="hyperparams"):
        tr._validate_params(_valid(hyperparams=[1, 2, 3]))


def test_single_fold_early_stopping_warns(caplog: pytest.LogCaptureFixture) -> None:
    import logging

    with caplog.at_level(logging.WARNING):
        p = tr._validate_params(
            _valid(walk_forward=False, hyperparams={"early_stopping_rounds": 50})
        )
    assert p.hyperparams == {"early_stopping_rounds": 50}
    assert any("early_stopping_ignored_single_fold" in r.message for r in caplog.records)


# ---------------------------------------------------------------- neutralize_cols
@pytest.mark.parametrize(
    "raw,expected",
    [
        ([], ()),
        (["industry_l1"], ("industry_l1",)),
        (["industry_l1", "mv"], ("industry_l1", "mv")),
        (["mv", "industry_l1"], ("industry_l1", "mv")),  # 顺序无关
        (["industry_l1", "industry_l1"], ("industry_l1",)),  # 去重
    ],
)
def test_neutralize_cols_canonical(raw: list[str], expected: tuple[str, ...]) -> None:
    p = tr._validate_params(_valid(neutralize_cols=raw))
    assert p.neutralize_cols == expected


@pytest.mark.parametrize("raw", [["mv"], ["bogus"], ["industry_l1", "bogus"]])
def test_neutralize_cols_non_canonical_raises(raw: list[str]) -> None:
    with pytest.raises(ValueError, match="neutralize_cols"):
        tr._validate_params(_valid(neutralize_cols=raw))


def test_neutralize_cols_non_list_raises() -> None:
    with pytest.raises(ValueError, match="neutralize_cols"):
        tr._validate_params(_valid(neutralize_cols="industry_l1"))


# ---------------------------------------------------------------- robust_z
def test_robust_z_bool_ok() -> None:
    assert tr._validate_params(_valid(robust_z=False)).robust_z is False
    assert tr._validate_params(_valid(robust_z=True)).robust_z is True


def test_robust_z_non_bool_raises() -> None:
    with pytest.raises(ValueError, match="robust_z"):
        tr._validate_params(_valid(robust_z="yes"))


# ---------------------------------------------------------------- factor_clip_sigma
def test_factor_clip_sigma_in_range() -> None:
    assert tr._validate_params(_valid(factor_clip_sigma=2.5)).factor_clip_sigma == 2.5


@pytest.mark.parametrize("v", [1.0, 5.5, 0.0])
def test_factor_clip_sigma_out_of_range_raises(v: float) -> None:
    with pytest.raises(ValueError, match="factor_clip_sigma"):
        tr._validate_params(_valid(factor_clip_sigma=v))


# ---------------------------------------------------------------- label_winsorize
def test_label_winsorize_valid() -> None:
    assert tr._validate_params(_valid(label_winsorize=[-0.3, 0.3])).label_winsorize == (-0.3, 0.3)


@pytest.mark.parametrize(
    "v",
    [[0.1, 0.3], [-0.3, -0.1], [-2.0, 0.3], [-0.3, 2.0], [-0.3], [0.0, 0.5], [-0.5, 0.0]],
)
def test_label_winsorize_invalid_raises(v: list[float]) -> None:
    with pytest.raises(ValueError, match="label_winsorize"):
        tr._validate_params(_valid(label_winsorize=v))


# ---------------------------------------------------------------- base_params fwd_ret
def test_fwd_ret_horizon_accepted() -> None:
    """fwd_ret.horizon 任意正整数（spec 2026-06-05）。"""
    p = tr._validate_params(_valid_fwd(base_params={"horizon": 10}))
    assert p.base_params == {"horizon": 10}
    assert p.base_scheme == "fwd_ret_h10"


def test_fwd_ret_horizon_1_valid() -> None:
    p = tr._validate_params(_valid_fwd(base_params={"horizon": 1}))
    assert p.base_scheme == "fwd_ret_h1"


def test_fwd_ret_horizon_5_legacy_alias() -> None:
    p = tr._validate_params(_valid_fwd(base_params={"horizon": 5}))
    assert p.base_scheme == "fwd_5d_ret"


@pytest.mark.parametrize("v", [0, -1])
def test_fwd_ret_horizon_invalid_raises(v: int) -> None:
    with pytest.raises(ValueError, match="horizon"):
        tr._validate_params(_valid_fwd(base_params={"horizon": v}))


# ---------------------------------------------------------------- base_params strategy_aware
def test_strategy_aware_default_exit_legacy_scheme() -> None:
    """default_exit@v1 → base_scheme 回 legacy 'strategy-aware'（守历史数据）。"""
    p = tr._validate_params(
        _valid(base_params={"strategy_id": "default_exit", "strategy_version": "v1"})
    )
    assert p.base_params == {"strategy_id": "default_exit", "strategy_version": "v1"}
    assert p.base_scheme == "strategy-aware"


def test_strategy_aware_named_strategy_scheme() -> None:
    """非 default 策略 → base_scheme = 'strategy-aware__{id}_{ver}'。"""
    p = tr._validate_params(
        _valid(base_params={"strategy_id": "tight_exit", "strategy_version": "v1"})
    )
    assert p.base_scheme == "strategy-aware__tight_exit_v1"


@pytest.mark.parametrize(
    "params",
    [
        {},  # 缺 strategy_id / strategy_version
        {"strategy_id": "default_exit"},  # 缺 version
        {"strategy_version": "v1"},  # 缺 id
        {"strategy_id": "Bad-Id", "strategy_version": "v1"},  # 大写 + 连字符非法
        {"strategy_id": "x" * 65, "strategy_version": "v1"},  # 超 64 长度
        {"strategy_id": "ok", "strategy_version": "1"},  # version 缺 v 前缀
        {"strategy_id": "ok", "strategy_version": "vx"},  # version 非数字
    ],
)
def test_strategy_aware_invalid_strategy_ref_raises(params: dict) -> None:
    with pytest.raises(ValueError, match="strategy_id|strategy_version"):
        tr._validate_params(_valid(base_params=params))


# ---------------------------------------------------------------- classify 校验
def test_classify_mode_band_with_eps() -> None:
    p = tr._validate_params(
        _valid(
            model="lstm",
            classify_mode="band",
            classify_params={"eps": 0.008},
        )
    )
    assert p.classify_params == {"eps": 0.008}


def test_classify_mode_tercile_no_params() -> None:
    p = tr._validate_params(
        _valid(
            model="lgb-multiclass",
            classify_mode="tercile",
            classify_params={},
        )
    )
    assert p.classify_mode == "tercile"
    assert p.classify_params == {}


def test_classify_mode_custom_thresholds() -> None:
    p = tr._validate_params(
        _valid(
            model="lgb-multiclass",
            classify_mode="custom",
            classify_params={"thresholds": [-0.01, 0.01]},
        )
    )
    assert p.classify_params == {"thresholds": [-0.01, 0.01]}
