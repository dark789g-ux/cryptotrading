"""prepare_runner 单测（spec 2026-06-06-labels-features-incremental-prepare-design §03）。

不连 DB：用 monkeypatch 把 compute_labels / build_feature_matrix 替换成 fake，
验证：
  1. labels 在 features 前、cancel 在步间生效（编排顺序）
  2. force_recompute 透传给两个 step
  3. params 解析（_validate_params 合法/非法 case 均复用 prepare_runner 路径）
  4. StepError 包装、JobCancelled 穿透
  5. 进度窗口：labels=[0,50] / features=[50,100]
  6. registry.reload_from_db 被调用 + 失败 → RuntimeError
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import pytest

import quant_pipeline.worker.prepare_runner as pr
from quant_pipeline.worker.progress import JobCancelled

_JOB_ID = UUID("aaaabbbb-cccc-dddd-eeee-ffffffffffff")


@pytest.fixture(autouse=True)
def _stub_reload_from_db(monkeypatch: pytest.MonkeyPatch) -> None:
    """run_prepare 入口会 `registry.reload_from_db()`，单测 noop。"""

    from quant_pipeline.factors import registry as _registry

    monkeypatch.setattr(_registry, "reload_from_db", lambda: None)


def _valid_params(**overrides: Any) -> dict[str, Any]:
    """构造能通过 _validate_params 的 baseline params（prepare 专用，model 可省）。"""

    base: dict[str, Any] = {
        "factor_version": "v1",
        "base_type": "fwd_ret",
        "base_params": {"horizon": 1},
        "classify_mode": None,
        "classify_params": None,
        "new_listing_min_days": 60,
        "date_range": "20240601:20240630",
        # prepare 允许省 model，但也接受显式传
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# 辅助：安装 fake substeps
# ---------------------------------------------------------------------------


class _FakeBundle:
    def __init__(self, feature_set_id: str) -> None:
        self.feature_set_id = feature_set_id


def _install_fakes(
    monkeypatch: pytest.MonkeyPatch,
    *,
    feature_set_id: str = "fs_prepare_test",
    labels_side_effect: Exception | None = None,
    features_side_effect: Exception | None = None,
    record_calls: list[str] | None = None,
    record_force: dict[str, bool] | None = None,
    progress_log: list[tuple[str, int]] | None = None,
) -> None:
    """把 compute_labels / build_feature_matrix 替换成可观测的 fake。

    record_force: 若传入，则记录 labels/features 收到的 force_recompute 值。
    progress_log: 若传入，则每个 fake 各调 progress_callback(0/50/100)。
    """

    def _fake_labels(*, progress_callback=None, force_recompute=False, **kwargs: Any) -> None:
        if record_calls is not None:
            record_calls.append("labels")
        if record_force is not None:
            record_force["labels"] = force_recompute
        if progress_log is not None and progress_callback is not None:
            for pct in (0, 50, 100):
                progress_callback(pct, f"labels:{pct}")
                progress_log.append((f"labels:{pct}", pct))
        if labels_side_effect is not None:
            raise labels_side_effect

    def _fake_features(*, progress_callback=None, force_recompute=False, **kwargs: Any):
        if record_calls is not None:
            record_calls.append("features")
        if record_force is not None:
            record_force["features"] = force_recompute
        if progress_log is not None and progress_callback is not None:
            for pct in (0, 50, 100):
                progress_callback(pct, f"features:{pct}")
                progress_log.append((f"features:{pct}", pct))
        if features_side_effect is not None:
            raise features_side_effect
        return _FakeBundle(feature_set_id)

    import quant_pipeline.features.runner as features_mod
    import quant_pipeline.labels.runner as labels_mod

    monkeypatch.setattr(labels_mod, "compute_labels", _fake_labels)
    monkeypatch.setattr(features_mod, "build_feature_matrix", _fake_features)


# ---------------------------------------------------------------------------
# 1. 编排顺序 + result dict
# ---------------------------------------------------------------------------


def test_two_steps_called_in_order(monkeypatch: pytest.MonkeyPatch) -> None:
    """labels → features 顺序，result dict 含 feature_set_id + last_completed_step。"""

    calls: list[str] = []
    _install_fakes(monkeypatch, record_calls=calls)
    monkeypatch.setattr(pr, "check_cancel_requested", lambda _: False)

    result = pr.run_prepare(_JOB_ID, _valid_params(), lambda p, m: None)

    assert calls == ["labels", "features"]
    assert result["feature_set_id"] == "fs_prepare_test"
    assert result["last_completed_step"] == "features"


def test_cancel_between_labels_and_features(monkeypatch: pytest.MonkeyPatch) -> None:
    """第二次 check_cancel 返回 True → features 不执行。"""

    calls: list[str] = []
    _install_fakes(monkeypatch, record_calls=calls)

    cancel_seq = iter([False, True])
    monkeypatch.setattr(pr, "check_cancel_requested", lambda _: next(cancel_seq))

    with pytest.raises(JobCancelled):
        pr.run_prepare(_JOB_ID, _valid_params(), lambda p, m: None)

    assert calls == ["labels"]


def test_cancel_before_labels(monkeypatch: pytest.MonkeyPatch) -> None:
    """第一次 check_cancel 返回 True → labels/features 都不执行。"""

    calls: list[str] = []
    _install_fakes(monkeypatch, record_calls=calls)
    monkeypatch.setattr(pr, "check_cancel_requested", lambda _: True)

    with pytest.raises(JobCancelled):
        pr.run_prepare(_JOB_ID, _valid_params(), lambda p, m: None)

    assert calls == []


# ---------------------------------------------------------------------------
# 2. force_recompute 透传
# ---------------------------------------------------------------------------


def test_force_recompute_false_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """params 无 force_recompute → 两个 step 收到 False。"""

    force: dict[str, bool] = {}
    _install_fakes(monkeypatch, record_force=force)
    monkeypatch.setattr(pr, "check_cancel_requested", lambda _: False)

    pr.run_prepare(_JOB_ID, _valid_params(), lambda p, m: None)

    assert force == {"labels": False, "features": False}


def test_force_recompute_true_propagated(monkeypatch: pytest.MonkeyPatch) -> None:
    """params force_recompute=True → 两个 step 均收到 True。"""

    force: dict[str, bool] = {}
    _install_fakes(monkeypatch, record_force=force)
    monkeypatch.setattr(pr, "check_cancel_requested", lambda _: False)

    pr.run_prepare(_JOB_ID, _valid_params(force_recompute=True), lambda p, m: None)

    assert force == {"labels": True, "features": True}


# ---------------------------------------------------------------------------
# 3. StepError 包装 / JobCancelled 穿透
# ---------------------------------------------------------------------------


def test_labels_error_wrapped_as_step_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """labels 失败 → StepError(step='labels')。"""

    boom = RuntimeError("labels blew up")
    _install_fakes(monkeypatch, labels_side_effect=boom)
    monkeypatch.setattr(pr, "check_cancel_requested", lambda _: False)

    with pytest.raises(pr.StepError) as ei:
        pr.run_prepare(_JOB_ID, _valid_params(), lambda p, m: None)

    assert ei.value.step == "labels"
    assert ei.value.original is boom


def test_features_error_wrapped_as_step_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """features 失败 → StepError(step='features')。"""

    boom = ValueError("features blew up")
    _install_fakes(monkeypatch, features_side_effect=boom)
    monkeypatch.setattr(pr, "check_cancel_requested", lambda _: False)

    with pytest.raises(pr.StepError) as ei:
        pr.run_prepare(_JOB_ID, _valid_params(), lambda p, m: None)

    assert ei.value.step == "features"
    assert "[step:features]" in str(ei.value)


def test_job_cancelled_not_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    """labels 内抛 JobCancelled → 不被 StepError 包装，原样穿透。"""

    _install_fakes(monkeypatch, labels_side_effect=JobCancelled())
    monkeypatch.setattr(pr, "check_cancel_requested", lambda _: False)

    with pytest.raises(JobCancelled):
        pr.run_prepare(_JOB_ID, _valid_params(), lambda p, m: None)


# ---------------------------------------------------------------------------
# 4. 进度窗口
# ---------------------------------------------------------------------------


def test_progress_windows_labels_0_50_features_50_100(monkeypatch: pytest.MonkeyPatch) -> None:
    """父 callback 收到的进度：labels 窗口 [0,50]，features 窗口 [50,100]。

    fake substep 各调 progress_callback(0/50/100)，make_scaled_callback 缩放到父窗口：
      labels:   0→0, 50→25, 100→50
      features: 0→50, 50→75, 100→100
    """

    progress_log: list[tuple[str, int]] = []
    parent_log: list[tuple[int, str]] = []
    _install_fakes(monkeypatch, progress_log=progress_log)
    monkeypatch.setattr(pr, "check_cancel_requested", lambda _: False)

    pr.run_prepare(
        _JOB_ID,
        _valid_params(),
        lambda p, m: parent_log.append((p, m)),
    )

    pcts = [p for p, _ in parent_log]
    assert all(0 <= p <= 100 for p in pcts), pcts

    pct_by_msg = {m: p for p, m in parent_log}
    # labels 窗口 [0, 50]
    assert pct_by_msg["labels:0"] == 0
    assert pct_by_msg["labels:50"] == 25
    assert pct_by_msg["labels:100"] == 50
    # features 窗口 [50, 100]
    assert pct_by_msg["features:0"] == 50
    assert pct_by_msg["features:50"] == 75
    assert pct_by_msg["features:100"] == 100


# ---------------------------------------------------------------------------
# 5. params 解析（_validate_params via prepare 路径）
# ---------------------------------------------------------------------------


class TestValidateParamsViaPrepare:
    """通过 pr._validate_params 直接测试（与 train_e2e 测试的校验逻辑完全共享）。"""

    def test_fwd_ret_h1_valid(self) -> None:
        p = pr._validate_params(_valid_params())
        assert p.base_type == "fwd_ret"
        assert p.base_scheme == "fwd_ret_h1"

    def test_model_none_uses_sentinel(self) -> None:
        """prepare job 可以省略 model 字段；校验层 fallback sentinel。"""
        p = pr._validate_params(_valid_params())
        # 不 raise，sentinel 'lgb-lambdarank' 保持类型满足 dataclass
        assert isinstance(p.model, str)

    def test_model_explicit_valid(self) -> None:
        p = pr._validate_params(_valid_params(model="lstm"))
        assert p.model == "lstm"

    def test_model_invalid_raises(self) -> None:
        with pytest.raises(ValueError, match="model"):
            pr._validate_params(_valid_params(model="xgboost"))

    def test_missing_factor_version_raises(self) -> None:
        with pytest.raises(ValueError, match="factor_version"):
            pr._validate_params(_valid_params(factor_version=None))

    def test_new_listing_min_days_zero_ok(self) -> None:
        p = pr._validate_params(_valid_params(new_listing_min_days=0))
        assert p.new_listing_min_days == 0

    def test_new_listing_min_days_bool_rejected(self) -> None:
        with pytest.raises(ValueError, match="new_listing_min_days"):
            pr._validate_params(_valid_params(new_listing_min_days=True))

    def test_date_range_start_after_end_raises(self) -> None:
        with pytest.raises(ValueError, match="date_range"):
            pr._validate_params(_valid_params(date_range="20240701:20240601"))

    def test_force_recompute_not_in_validated_params(self) -> None:
        """force_recompute 由 run_prepare 直接从 params dict 读取，
        不进 ValidatedParams（与 model/seed 等无关备料参数一致）。"""
        p = pr._validate_params(_valid_params(force_recompute=True))
        assert not hasattr(p, "force_recompute")


# ---------------------------------------------------------------------------
# 6. registry.reload_from_db 调用 + 失败包装
# ---------------------------------------------------------------------------


def test_run_prepare_calls_reload_from_db(monkeypatch: pytest.MonkeyPatch) -> None:
    """reload_from_db 被调用 1 次。"""

    from quant_pipeline.factors import registry as _registry

    reload_calls: list[int] = []

    def _fake_reload() -> None:
        reload_calls.append(1)

    monkeypatch.setattr(_registry, "reload_from_db", _fake_reload)
    _install_fakes(monkeypatch)
    monkeypatch.setattr(pr, "check_cancel_requested", lambda _: False)

    pr.run_prepare(_JOB_ID, _valid_params(), lambda p, m: None)

    assert reload_calls == [1]


def test_run_prepare_wraps_reload_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """reload_from_db 抛 Exception → RuntimeError("factor_definitions unreachable")。"""

    from quant_pipeline.factors import registry as _registry

    def _broken_reload() -> None:
        raise ConnectionError("pg down")

    monkeypatch.setattr(_registry, "reload_from_db", _broken_reload)

    with pytest.raises(RuntimeError, match="factor_definitions unreachable"):
        pr.run_prepare(_JOB_ID, _valid_params(), lambda p, m: None)


# ---------------------------------------------------------------------------
# 7. StepError 公开类（dispatcher 可 import）
# ---------------------------------------------------------------------------


def test_step_error_is_public_class() -> None:
    assert pr.StepError.__name__ == "StepError"
    assert not pr.StepError.__name__.startswith("_")
    se = pr.StepError("labels", ValueError("x"))
    assert se.step == "labels"
    assert "[step:labels]" in str(se)
