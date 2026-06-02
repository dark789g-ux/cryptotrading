"""train_e2e_runner 单测（spec 04 + 06）。

不连 DB：用 monkeypatch 把 compute_labels / build_feature_matrix / train_model
全替换成 fake，验证编排顺序、错误包装、取消传播、进度回调范围。
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import pytest

from quant_pipeline.worker import train_e2e_runner as tr
from quant_pipeline.worker.progress import JobCancelled

_JOB_ID = UUID("11111111-2222-3333-4444-555555555555")


@pytest.fixture(autouse=True)
def _stub_reload_from_db(monkeypatch: pytest.MonkeyPatch) -> None:
    """run_train_e2e 入口会 `registry.reload_from_db()`（spec 02 §加载流程），
    单元测试不连 DB；conftest 已 seed `_meta_cache`，这里把 reload 替换成 noop
    防它把 seed 清空又拉空。"""

    from quant_pipeline.factors import registry as _registry

    monkeypatch.setattr(_registry, "reload_from_db", lambda: None)


def _valid_params(**overrides: Any) -> dict[str, Any]:
    """构造一个能通过 _validate_params 的 baseline params dict。"""

    base: dict[str, Any] = {
        "factor_version": "v1",
        "label_scheme": "strategy-aware",
        "new_listing_min_days": 60,
        "date_range": "20240601:20240630",
        "model": "lgb-lambdarank",
        "walk_forward": True,
        "seed": 42,
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# _validate_params：8 个非法 case
# ---------------------------------------------------------------------------


class TestValidateParams:
    def test_missing_factor_version(self) -> None:
        with pytest.raises(ValueError, match="factor_version"):
            tr._validate_params(_valid_params(factor_version=None))

    def test_blank_factor_version(self) -> None:
        with pytest.raises(ValueError, match="factor_version"):
            tr._validate_params(_valid_params(factor_version="   "))

    def test_unknown_label_scheme(self) -> None:
        with pytest.raises(ValueError, match="label_scheme"):
            tr._validate_params(_valid_params(label_scheme="bogus"))

    # ---- A2：dir3_band ε 可配（前端发 'dir3_band' + 独立字段 dir3_band_eps）----

    def test_dir3_band_default_eps_canonical_to_legacy(self) -> None:
        """label_scheme='dir3_band' 缺 dir3_band_eps → 走 legacy 0.005 →
        canonical 回 legacy 串 'dir3_band'（守哈希不漂移）。"""

        p = tr._validate_params(_valid_params(label_scheme="dir3_band"))
        assert p.label_scheme == "dir3_band"

    def test_dir3_band_explicit_legacy_eps_canonical_to_legacy(self) -> None:
        """显式 dir3_band_eps=0.005 也 canonical 回 legacy 串。"""

        p = tr._validate_params(
            _valid_params(label_scheme="dir3_band", dir3_band_eps=0.005)
        )
        assert p.label_scheme == "dir3_band"

    def test_dir3_band_custom_eps_canonical_to_eps_scheme(self) -> None:
        """自定义 ε=0.008 → canonical 写回 'dir3_band_eps0080'。"""

        p = tr._validate_params(
            _valid_params(label_scheme="dir3_band", dir3_band_eps=0.008)
        )
        assert p.label_scheme == "dir3_band_eps0080"

    def test_dir3_band_off_grid_eps_quantized(self) -> None:
        """off-grid ε=0.0083 → 量化 0.008 → 'dir3_band_eps0080'。"""

        p = tr._validate_params(
            _valid_params(label_scheme="dir3_band", dir3_band_eps=0.0083)
        )
        assert p.label_scheme == "dir3_band_eps0080"

    def test_dir3_band_eps_out_of_range_raises(self) -> None:
        with pytest.raises(ValueError, match="dir3_band_eps"):
            tr._validate_params(
                _valid_params(label_scheme="dir3_band", dir3_band_eps=0.2)
            )
        with pytest.raises(ValueError, match="dir3_band_eps"):
            tr._validate_params(
                _valid_params(label_scheme="dir3_band", dir3_band_eps=0.0)
            )

    def test_dir3_band_eps_non_number_raises(self) -> None:
        with pytest.raises(ValueError, match="dir3_band_eps"):
            tr._validate_params(
                _valid_params(label_scheme="dir3_band", dir3_band_eps="0.008")
            )

    def test_dir3_band_eps_family_scheme_passes_through(self) -> None:
        """前端如直接发 canonical 串 'dir3_band_eps0200'（家族成员）→ 放行不变。"""

        p = tr._validate_params(_valid_params(label_scheme="dir3_band_eps0200"))
        assert p.label_scheme == "dir3_band_eps0200"

    def test_dir3_band_eps_ignored_for_tercile(self) -> None:
        """ε 给了非 dir3_band 方案（dir3_tercile）→ 忽略（不影响 scheme）。"""

        p = tr._validate_params(
            _valid_params(label_scheme="dir3_tercile", dir3_band_eps=0.02)
        )
        assert p.label_scheme == "dir3_tercile"

    def test_new_listing_min_days_wrong_type(self) -> None:
        with pytest.raises(ValueError, match="new_listing_min_days"):
            tr._validate_params(_valid_params(new_listing_min_days="60"))

    def test_new_listing_min_days_out_of_range(self) -> None:
        with pytest.raises(ValueError, match="new_listing_min_days"):
            tr._validate_params(_valid_params(new_listing_min_days=-1))
        with pytest.raises(ValueError, match="new_listing_min_days"):
            tr._validate_params(_valid_params(new_listing_min_days=251))

    def test_new_listing_min_days_bool_rejected(self) -> None:
        """bool 是 int 子类，必须显式排除，否则 True 会被当成 1 通过。"""

        with pytest.raises(ValueError, match="new_listing_min_days"):
            tr._validate_params(_valid_params(new_listing_min_days=True))

    def test_invalid_date_range_format(self) -> None:
        with pytest.raises(ValueError, match="date_range"):
            tr._validate_params(_valid_params(date_range="2024-06-01:2024-06-30"))

    def test_date_range_start_after_end(self) -> None:
        with pytest.raises(ValueError, match="date_range"):
            tr._validate_params(_valid_params(date_range="20240701:20240601"))

    def test_unknown_model(self) -> None:
        with pytest.raises(ValueError, match="model"):
            tr._validate_params(_valid_params(model="xgboost"))

    # 合法 case：min_days=0 是合法值（不过滤新股），不应抛
    def test_min_days_zero_is_legal(self) -> None:
        p = tr._validate_params(_valid_params(new_listing_min_days=0))
        assert p.new_listing_min_days == 0

    def test_min_days_boundary_250(self) -> None:
        p = tr._validate_params(_valid_params(new_listing_min_days=250))
        assert p.new_listing_min_days == 250


# ---------------------------------------------------------------------------
# step 顺序调用 / 返回值
# ---------------------------------------------------------------------------


class _FakeBundle:
    def __init__(self, feature_set_id: str) -> None:
        self.feature_set_id = feature_set_id


def _install_fake_substeps(
    monkeypatch: pytest.MonkeyPatch,
    *,
    feature_set_id: str = "fs_test123",
    model_version: str = "lgb-lambdarank-v1-20240630-seed42",
    labels_side_effect: Exception | None = None,
    features_side_effect: Exception | None = None,
    train_side_effect: Exception | None = None,
    record_calls: list[str] | None = None,
    progress_log: list[tuple[str, int]] | None = None,
) -> None:
    """把三个子 runner 替换成可观测的 fake。

    progress_log: 若传入，则每个 fake 子 runner 会用 progress_callback(0/50/100)
    各调一次，方便断言父 callback 收到的进度值范围。
    """

    def _fake_labels(*, progress_callback=None, **kwargs: Any) -> None:
        if record_calls is not None:
            record_calls.append("labels")
        if progress_log is not None and progress_callback is not None:
            for pct in (0, 50, 100):
                progress_callback(pct, f"labels:{pct}")
                progress_log.append((f"labels:{pct}", pct))
        if labels_side_effect is not None:
            raise labels_side_effect

    def _fake_features(*, progress_callback=None, **kwargs: Any):
        if record_calls is not None:
            record_calls.append("features")
        if progress_log is not None and progress_callback is not None:
            for pct in (0, 50, 100):
                progress_callback(pct, f"features:{pct}")
                progress_log.append((f"features:{pct}", pct))
        if features_side_effect is not None:
            raise features_side_effect
        return _FakeBundle(feature_set_id)

    def _fake_train(*, progress_callback=None, **kwargs: Any):
        if record_calls is not None:
            record_calls.append("train")
        if progress_log is not None and progress_callback is not None:
            for pct in (0, 50, 100):
                progress_callback(pct, f"train:{pct}")
                progress_log.append((f"train:{pct}", pct))
        if train_side_effect is not None:
            raise train_side_effect
        return {"model_version": model_version, "feature_set_id": feature_set_id}

    # 关键：monkeypatch 模块属性，三个 _step_* 内部都是延迟 import
    # 所以要 patch 源模块的函数
    import quant_pipeline.features.runner as features_mod
    import quant_pipeline.labels.runner as labels_mod
    import quant_pipeline.training.runner as training_mod

    monkeypatch.setattr(labels_mod, "compute_labels", _fake_labels)
    monkeypatch.setattr(features_mod, "build_feature_matrix", _fake_features)
    monkeypatch.setattr(training_mod, "train_model", _fake_train)


def test_three_steps_called_in_order(monkeypatch: pytest.MonkeyPatch) -> None:
    """labels → features → train 顺序、且 result dict 含三个关键字段。"""

    calls: list[str] = []
    _install_fake_substeps(monkeypatch, record_calls=calls)

    # 取消查询：永不取消
    monkeypatch.setattr(tr, "check_cancel_requested", lambda _job_id: False)

    parent_log: list[tuple[int, str]] = []
    result = tr.run_train_e2e(
        _JOB_ID,
        _valid_params(),
        lambda p, m: parent_log.append((p, m)),
    )

    assert calls == ["labels", "features", "train"]
    assert result["feature_set_id"] == "fs_test123"
    assert result["model_version"] == "lgb-lambdarank-v1-20240630-seed42"
    assert result["last_completed_step"] == "train"


def test_cancel_on_second_step_skips_remaining(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """check_cancel_requested 第二次返回 True 时，features / train 都不应跑。"""

    calls: list[str] = []
    _install_fake_substeps(monkeypatch, record_calls=calls)

    # 取消查询：第二次返回 True（第一次在 labels 前，已过）
    cancel_seq = iter([False, True, False])
    monkeypatch.setattr(
        tr, "check_cancel_requested", lambda _job_id: next(cancel_seq)
    )

    with pytest.raises(JobCancelled):
        tr.run_train_e2e(_JOB_ID, _valid_params(), lambda p, m: None)

    # labels 跑了，features 在被 cancel 拦住时还未调
    assert calls == ["labels"]


def test_features_runtime_error_wrapped_as_step_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """子 runner 抛 RuntimeError → 被包装为 StepError(step='features')。"""

    boom = RuntimeError("factor_version 'nonexistent' has no factors")
    _install_fake_substeps(monkeypatch, features_side_effect=boom)
    monkeypatch.setattr(tr, "check_cancel_requested", lambda _job_id: False)

    with pytest.raises(tr.StepError) as ei:
        tr.run_train_e2e(_JOB_ID, _valid_params(), lambda p, m: None)

    assert ei.value.step == "features"
    assert ei.value.original is boom
    assert "[step:features]" in str(ei.value)


def test_labels_value_error_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    """labels 失败也走 StepError(step='labels')。"""

    boom = ValueError("compute_labels: 0 rows")
    _install_fake_substeps(monkeypatch, labels_side_effect=boom)
    monkeypatch.setattr(tr, "check_cancel_requested", lambda _job_id: False)

    with pytest.raises(tr.StepError) as ei:
        tr.run_train_e2e(_JOB_ID, _valid_params(), lambda p, m: None)
    assert ei.value.step == "labels"


def test_job_cancelled_not_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    """子 runner 抛 JobCancelled 应原样穿透，不被 StepError 包装。"""

    _install_fake_substeps(monkeypatch, features_side_effect=JobCancelled())
    monkeypatch.setattr(tr, "check_cancel_requested", lambda _job_id: False)

    with pytest.raises(JobCancelled):
        tr.run_train_e2e(_JOB_ID, _valid_params(), lambda p, m: None)


def test_progress_callback_values_always_in_range(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """父 callback 收到的所有 pct 值都必须 ∈ [0,100]，且窗口边界严格落点。"""

    progress_log: list[tuple[str, int]] = []
    parent_log: list[tuple[int, str]] = []
    _install_fake_substeps(monkeypatch, progress_log=progress_log)
    monkeypatch.setattr(tr, "check_cancel_requested", lambda _job_id: False)

    tr.run_train_e2e(
        _JOB_ID,
        _valid_params(),
        lambda p, m: parent_log.append((p, m)),
    )

    pcts = [p for p, _ in parent_log]
    assert all(0 <= p <= 100 for p in pcts), pcts

    # 三个窗口的边界值：
    #   labels:    [0, 30]   ⇒ pct 0/50/100 → 0/15/30
    #   features:  [30, 60]  ⇒ 30/45/60
    #   train:     [60, 100] ⇒ 60/80/100
    # parent_log 元素是 (scaled_pct, msg)；按 msg key 反查 pct
    pct_by_msg = {m: p for p, m in parent_log}
    assert pct_by_msg["labels:0"] == 0
    assert pct_by_msg["labels:50"] == 15
    assert pct_by_msg["labels:100"] == 30
    assert pct_by_msg["features:0"] == 30
    assert pct_by_msg["features:50"] == 45
    assert pct_by_msg["features:100"] == 60
    assert pct_by_msg["train:0"] == 60
    assert pct_by_msg["train:50"] == 80
    assert pct_by_msg["train:100"] == 100


def test_features_returns_plain_string_compat(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """兼容老签名：build_feature_matrix 直接返回 str 时也能取到 feature_set_id。

    spec 04 表格规定返回 bundle；老仓库返回纯字符串。getattr 兜底应工作。
    """

    import quant_pipeline.features.runner as features_mod
    import quant_pipeline.labels.runner as labels_mod
    import quant_pipeline.training.runner as training_mod

    monkeypatch.setattr(labels_mod, "compute_labels", lambda **kw: None)
    monkeypatch.setattr(
        features_mod, "build_feature_matrix", lambda **kw: "fs_legacy_str"
    )
    monkeypatch.setattr(
        training_mod,
        "train_model",
        lambda **kw: {"model_version": "v", "feature_set_id": kw["feature_set_id"]},
    )
    monkeypatch.setattr(tr, "check_cancel_requested", lambda _job_id: False)

    result = tr.run_train_e2e(_JOB_ID, _valid_params(), lambda p, m: None)
    assert result["feature_set_id"] == "fs_legacy_str"


def test_step_error_is_public_class() -> None:
    """StepError 必须可由 dispatcher 直接 import（无下划线前缀）。"""

    from quant_pipeline.worker.train_e2e_runner import StepError

    assert StepError.__name__ == "StepError"
    assert not StepError.__name__.startswith("_")
