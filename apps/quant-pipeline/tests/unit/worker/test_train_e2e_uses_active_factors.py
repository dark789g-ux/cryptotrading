"""train_e2e_runner 入口必须 `registry.reload_from_db()`，且生成的
feature_set 不含 enabled=false 的 factor_id（spec 06 §1 第 3 块）。

不连真实 DB：
  - 把 `registry.reload_from_db` mock 成往 `_meta_cache` 灌入测试 rows
    （其中一行 enabled=false）
  - 把 labels / features / train 三个子 runner 替换成 fake
  - features 子 runner 的 fake 透过 `build_feature_matrix` 拿到一个能反映
    "active factor 集合"的 feature_set_id；这里直接断言 `list_active` 在
    runner 调度链路上反映了禁用项

为什么不真去拼 feature_matrix：feature_matrix 的"列集合"由 builder 内部
按 daily_factors 数据透视决定，与 registry 状态无强关联（spec §enabled=false
跳过逻辑只直接影响哈希；列集合的实际剔除是因为 _load_factor_ids 做了交集）。
本测试聚焦"reload 被调用 + list_active 反映禁用"，与 spec 06 §1 表述一致。
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import pytest

from quant_pipeline.factors.registry import (
    FactorMeta,
    _meta_cache,
    list_active,
)
from quant_pipeline.worker import train_e2e_runner as tr

_JOB_ID = UUID("99999999-aaaa-bbbb-cccc-dddddddddddd")


def _valid_params(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "factor_version": "v1",
        "base_type": "strategy_aware",
        "base_params": {},
        "classify_mode": None,
        "classify_params": None,
        "new_listing_min_days": 60,
        "date_range": "20240601:20240630",
        "model": "lgb-lambdarank",
        "walk_forward": True,
        "seed": 42,
    }
    base.update(overrides)
    return base


def _seed_with_one_disabled(disabled_id: str = "amihud_illiq_20d") -> None:
    """模拟 reload_from_db 的副作用：清空 + 写入新一批 meta（disabled 一条）。

    与 conftest seed 不同的是：把 disabled_id 标为 enabled=False。
    """

    _meta_cache.clear()
    BASE = [
        ("amihud_illiq_20d", "price", 35),
        ("bollinger_position_20d", "price", 35),
        ("close_to_high_60d", "price", 115),
        ("ma_ratio_20d", "price", 35),
        ("momentum_20d", "price", 35),
        ("momentum_60d", "price", 115),
        ("price_max_drawdown_60d", "price", 115),
        ("rsi_14", "price", 60),
        ("turnover_mean_20d", "price", 35),
        ("volatility_20d", "price", 35),
        ("volume_ratio_20d", "price", 35),
        ("industry_momentum_20d", "industry", 35),
        ("momentum_20d_neu", "industry", 35),
        ("industry_rank_in_sector_mom20", "industry", 35),
        ("industry_relative_strength", "industry", 35),
        ("sector_volume_concentration", "industry", 5),
    ]
    for fid, cat, win in BASE:
        _meta_cache[(fid, "v1")] = FactorMeta(
            factor_id=fid,
            factor_version="v1",
            description=f"desc:{fid}",
            category=cat,
            pit_window_days=win,
            pit_anchor="trade_date",
            enabled=(fid != disabled_id),
            display_order=100,
        )


class _FakeBundle:
    def __init__(self, feature_set_id: str) -> None:
        self.feature_set_id = feature_set_id


def test_run_train_e2e_calls_reload_then_uses_active_factors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """断言 (a) `reload_from_db` 被调用一次；(b) 调用后 `list_active` 不含被
    禁用的 factor_id。"""

    from quant_pipeline.factors import registry as _registry

    reload_calls: list[int] = []

    def _fake_reload() -> None:
        reload_calls.append(1)
        _seed_with_one_disabled("amihud_illiq_20d")

    monkeypatch.setattr(_registry, "reload_from_db", _fake_reload)

    # mock 三个子 runner
    captured: dict[str, Any] = {}

    def _fake_labels(*, progress_callback=None, **kwargs: Any) -> None:
        return None

    def _fake_features(*, progress_callback=None, **kwargs: Any) -> _FakeBundle:
        # 子 runner 在 features 阶段才会调用 list_active；这里直接断言
        active_ids = {f.factor_id for f in list_active("v1")}
        captured["active_ids"] = active_ids
        return _FakeBundle("fs_active_test")

    def _fake_train(*, progress_callback=None, **kwargs: Any) -> dict[str, Any]:
        return {"model_version": "v_test", "feature_set_id": kwargs["feature_set_id"]}

    import quant_pipeline.features.runner as features_mod
    import quant_pipeline.labels.runner as labels_mod
    import quant_pipeline.training.runner as training_mod

    monkeypatch.setattr(labels_mod, "compute_labels", _fake_labels)
    monkeypatch.setattr(features_mod, "build_feature_matrix", _fake_features)
    monkeypatch.setattr(training_mod, "train_model", _fake_train)
    monkeypatch.setattr(tr, "check_cancel_requested", lambda _job_id: False)

    result = tr.run_train_e2e(_JOB_ID, _valid_params(), lambda p, m: None)

    # (a) reload 被调用 1 次
    assert reload_calls == [1], reload_calls

    # (b) 禁用的 factor_id 不在 list_active 返回里
    active = captured["active_ids"]
    assert "amihud_illiq_20d" not in active
    assert "momentum_20d" in active
    assert len(active) == 15  # 16 - 1

    assert result["feature_set_id"] == "fs_active_test"
    assert result["last_completed_step"] == "train"


def test_run_train_e2e_wraps_reload_failure_as_runtime_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`reload_from_db` 抛 Exception → 包成 RuntimeError("factor_definitions
    unreachable")，让 dispatcher 区分"DB 故障" vs "step 失败"。"""

    from quant_pipeline.factors import registry as _registry

    def _broken_reload() -> None:
        raise ConnectionError("postgres down")

    monkeypatch.setattr(_registry, "reload_from_db", _broken_reload)

    with pytest.raises(RuntimeError, match="factor_definitions unreachable"):
        tr.run_train_e2e(_JOB_ID, _valid_params(), lambda p, m: None)
