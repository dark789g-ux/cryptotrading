"""lgb-multiclass 训练 / 推理 / 评估单测（spec 04 §Python pytest）。

不依赖真实 lightgbm：用 sys.modules 注入 fake lightgbm（确定性 softmax over 前 3 列），
配合 monkeypatch 的 DB 加载 / 门禁 / forward_returns 跑通完整 walk-forward 编排。

覆盖：
  - 标签护栏：dir3 标签放行；连续 / 越界标签报错「需 dir3 系标签」。
  - 参数合并：用户树参数覆盖；objective/num_class/metric 固定不被覆盖；非树键剔除。
  - DEFAULT_LGB_MC_HYPERPARAMS 树参数与 lightgbm_lambdarank.DEFAULT_HYPERPARAMS 对齐。
  - 小样本端到端：meta.json algorithm/class_order/feature_columns_order；model.txt 落盘；
    oos_metrics 结构（task=classification_3class + accuracy/macro_f1/per_class/confusion/
    ic/rank_ic/fold_metrics）；model_version 命名。
  - 推理：score=P(涨)-P(跌)；rank 降序；行数 == 当日全量股票数（缺票补 NaN）；
    列按 feature_columns_order 对齐。
"""

from __future__ import annotations

import json
import sys
import types
from typing import Any
from uuid import uuid4

import numpy as np
import pandas as pd
import pytest


# ---------------------------------------------------------------- fake lightgbm
class _FakeBooster:
    def __init__(
        self, params: dict | None = None, model_file: str | None = None, **kw: Any
    ) -> None:
        self.params = params or {}
        if model_file is not None:
            with open(model_file) as fh:
                self._blob = fh.read()

    def predict(self, X: Any) -> np.ndarray:
        X = np.asarray(X, dtype=float)
        n = X.shape[0]
        z = np.zeros((n, 3))
        for j in range(min(3, X.shape[1])):
            z[:, j] = X[:, j]
        e = np.exp(z - z.max(axis=1, keepdims=True))
        return e / e.sum(axis=1, keepdims=True)

    def save_model(self, path: str) -> None:
        with open(path, "w") as fh:
            fh.write("FAKE_LGB_MODEL")

    def feature_name(self) -> list[str]:
        return []


class _FakeDataset:
    def __init__(self, X: Any, label: Any = None, **kw: Any) -> None:
        self.X = X
        self.label = label


def _make_fake_lgb() -> types.ModuleType:
    m = types.ModuleType("lightgbm")
    m.Dataset = _FakeDataset
    m.Booster = _FakeBooster

    def _train(params=None, train_set=None, num_boost_round=0, **kw: Any) -> _FakeBooster:
        return _FakeBooster(params=params)

    m.train = _train
    m.early_stopping = lambda stopping_rounds=0, verbose=False: ("es", stopping_rounds)
    m.log_evaluation = lambda period=0: ("log", period)
    return m


@pytest.fixture
def fake_lgb(monkeypatch: pytest.MonkeyPatch) -> types.ModuleType:
    m = _make_fake_lgb()
    monkeypatch.setitem(sys.modules, "lightgbm", m)
    return m


@pytest.fixture
def artifact_tmp(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("ARTIFACT_DIR", str(tmp_path))
    return tmp_path


# ---------------------------------------------------------------- 标签护栏
def test_dir3_labels_accepted() -> None:
    from quant_pipeline.training.lgb_multiclass_walk_forward import _validate_dir3_labels

    y = _validate_dir3_labels(np.array([0.0, 1.0, 2.0, 1.0, np.nan]))
    assert y.dtype == np.int64


@pytest.mark.parametrize(
    "bad",
    [np.array([0.0, 0.03, -0.02]), np.array([0.0, 1.0, 3.0])],
)
def test_continuous_or_out_of_range_labels_rejected(bad: np.ndarray) -> None:
    from quant_pipeline.training.lgb_multiclass_walk_forward import _validate_dir3_labels

    with pytest.raises(ValueError, match="dir3"):
        _validate_dir3_labels(bad)


def test_all_nan_labels_rejected() -> None:
    from quant_pipeline.training.lgb_multiclass_walk_forward import _validate_dir3_labels

    with pytest.raises(ValueError, match="NaN"):
        _validate_dir3_labels(np.array([np.nan, np.nan]))


# ---------------------------------------------------------------- 参数合并
def test_merge_params_fixes_multiclass_objective() -> None:
    from quant_pipeline.training.lgb_multiclass_walk_forward import _merge_params

    p = _merge_params(
        {"num_leaves": 63, "learning_rate": 0.1, "objective": "regression", "bogus": 1}, seed=7
    )
    assert p["num_leaves"] == 63 and p["learning_rate"] == 0.1
    assert p["objective"] == "multiclass" and p["num_class"] == 3 and p["metric"] == "multi_logloss"
    assert "bogus" not in p
    assert p["seed"] == 7


def test_default_tree_params_align_with_lambdarank() -> None:
    from quant_pipeline.training.lgb_multiclass_walk_forward import DEFAULT_LGB_MC_HYPERPARAMS
    from quant_pipeline.training.lightgbm_lambdarank import DEFAULT_HYPERPARAMS as LR

    for key in (
        "num_leaves",
        "max_depth",
        "min_data_in_leaf",
        "learning_rate",
        "feature_fraction",
        "bagging_fraction",
        "bagging_freq",
        "boosting_type",
    ):
        assert DEFAULT_LGB_MC_HYPERPARAMS[key] == LR[key], key


def test_resolve_boost_controls() -> None:
    from quant_pipeline.training.lgb_multiclass_walk_forward import _resolve_boost_controls

    assert _resolve_boost_controls(
        {"num_boost_round": 100, "early_stopping_rounds": 20}
    ) == (100, 20)
    assert _resolve_boost_controls(None) == (500, 50)


# ---------------------------------------------------------------- oos_metrics 结构
def test_oos_metrics_structure() -> None:
    from quant_pipeline.training.classification_metrics import build_oos_metrics

    m = build_oos_metrics(
        y_true=np.array([0, 1, 2, 2]),
        y_pred=np.array([0, 1, 2, 1]),
        score=np.array([-0.5, 0.0, 0.6, 0.3]),
        true_ret=np.array([-0.02, 0.0, 0.03, 0.01]),
        fold_metrics=[{"fold": 1, "accuracy": 0.75, "macro_f1": 0.7}],
    )
    assert m["task"] == "classification_3class"
    assert set(m.keys()) >= {
        "task",
        "accuracy",
        "macro_f1",
        "per_class",
        "confusion_matrix",
        "ic",
        "rank_ic",
        "fold_metrics",
    }
    assert set(m["per_class"].keys()) == {"down", "flat", "up"}
    assert len(m["confusion_matrix"]) == 3 and len(m["confusion_matrix"][0]) == 3


# ---------------------------------------------------------------- 端到端训练
def _synthetic_feature_matrix() -> pd.DataFrame:
    rng = np.random.default_rng(0)
    dates = [f"d{d:04d}" for d in range(320)]  # 320 trade days，足够 6 折 + min_train 252
    codes = [f"{i:06d}.SZ" for i in range(5)]
    rows = []
    for d in dates:
        for c in codes:
            rows.append(
                {
                    "trade_date": d,
                    "ts_code": c,
                    "features": {
                        "f0": float(rng.normal()),
                        "f1": float(rng.normal()),
                        "f2": float(rng.normal()),
                    },
                    "label": float(rng.integers(0, 3)),
                }
            )
    return pd.DataFrame(rows)


def test_train_lgb_multiclass_end_to_end(
    fake_lgb: types.ModuleType, artifact_tmp: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    import quant_pipeline.training.lgb_multiclass_walk_forward as wf
    import quant_pipeline.training.runner as runner_mod
    import quant_pipeline.utils.paths as paths

    fm = _synthetic_feature_matrix()
    monkeypatch.setattr(runner_mod, "_load_feature_matrix", lambda fsid: fm.copy())
    monkeypatch.setattr(wf, "gate_check", lambda *a, **k: None)
    rng = np.random.default_rng(1)
    monkeypatch.setattr(
        wf,
        "load_forward_returns",
        lambda pairs, **k: {p: float(rng.normal() * 0.01) for p in pairs},
    )

    inserted: dict[str, Any] = {}

    def fake_insert(run_id: Any, **kw: Any) -> None:
        inserted.update(kw)
        inserted["run_id"] = run_id

    res = wf.train_lgb_multiclass_model(
        "fs_test",
        seed=42,
        job_id=None,
        hyperparams={"label_scheme": "dir3_band", "num_leaves": 31},
        walk_forward_params={"n_folds": 6, "embargo_days": 21, "min_train_days": 252},
        progress_callback=None,
        today_yyyymmdd="20260530",
        insert_model_run=fake_insert,
        write_artifact=None,
    )

    assert res.model_version == "lgb-multiclass-v1-20260530-seed42"

    art_dir = paths.artifact_dir(res.model_run_id)
    assert (art_dir / "model.txt").exists()
    meta = json.loads((art_dir / "meta.json").read_text(encoding="utf-8"))
    assert meta["algorithm"] == "lgb-multiclass"
    assert meta["class_order"] == ["down", "flat", "up"]
    assert meta["num_class"] == 3
    assert meta["objective"] == "multiclass"
    assert meta["metric"] == "multi_logloss"
    assert meta["feature_columns_order"] == ["f0", "f1", "f2"]

    om = res.oos_metrics
    assert om["task"] == "classification_3class"
    assert set(om.keys()) >= {
        "accuracy",
        "macro_f1",
        "per_class",
        "confusion_matrix",
        "ic",
        "rank_ic",
        "fold_metrics",
        "walk_forward_params",
    }
    assert om["walk_forward_params"]["n_folds"] == 6
    assert om["walk_forward_params"]["embargo_days"] == 21
    assert len(om["fold_metrics"]) == 6
    assert inserted["model_version"] == "lgb-multiclass-v1-20260530-seed42"
    assert inserted["hyperparams"]["objective"] == "multiclass"


def test_early_stop_valid_is_inner_split_not_test_fold(
    artifact_tmp: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """防泄漏回归（评审 #1）：每折 early-stopping 验证集必须来自训练区时序尾部，
    与 OOS 测试折零交集 —— 此前用 test 折同时早停又评估构成测试集泄漏。"""

    import quant_pipeline.training.lgb_multiclass_walk_forward as wf
    import quant_pipeline.training.runner as runner_mod
    from quant_pipeline.training.walk_forward import PurgedWalkForwardSplit

    fm = _synthetic_feature_matrix()
    monkeypatch.setattr(runner_mod, "_load_feature_matrix", lambda fsid: fm.copy())
    monkeypatch.setattr(wf, "gate_check", lambda *a, **k: None)
    monkeypatch.setattr(wf, "load_forward_returns", lambda pairs, **k: {p: 0.0 for p in pairs})

    # 捕获每次 lgb.train 的 (train_set.X, valid_sets[0].X | None)
    captured: list[tuple[np.ndarray, np.ndarray | None]] = []
    fake = _make_fake_lgb()

    def _capture_train(params=None, train_set=None, num_boost_round=0, valid_sets=None, **kw: Any):  # noqa: ANN001
        vX = np.asarray(valid_sets[0].X, dtype=float) if valid_sets else None
        captured.append((np.asarray(train_set.X, dtype=float), vX))
        return _FakeBooster(params=params)

    fake.train = _capture_train
    monkeypatch.setitem(sys.modules, "lightgbm", fake)

    # 复算与生产同参的 walk-forward 切分，取每折 train/test 行集合
    wide_df, feature_cols = wf._build_wide_df("fs")
    X_full = wide_df[feature_cols].to_numpy(dtype=float)
    splits = list(
        PurgedWalkForwardSplit(n_folds=6, embargo_days=21, min_train_days=252).split(wide_df)
    )

    wf.train_lgb_multiclass_model(
        "fs",
        seed=42,
        job_id=None,
        hyperparams={"label_scheme": "dir3_band"},  # 不传 early_stopping_rounds → 默认 50 启用
        walk_forward_params={"n_folds": 6, "embargo_days": 21, "min_train_days": 252},
        progress_callback=None,
        today_yyyymmdd="20260530",
        insert_model_run=lambda *a, **k: None,
        write_artifact=None,
    )

    fold_calls = [c for c in captured if c[1] is not None]
    assert len(fold_calls) == 6  # 每折一次带 inner-val 的早停训练（final booster 无 valid）

    def _rowset(arr: np.ndarray) -> set[tuple[float, ...]]:
        return {tuple(r) for r in arr}

    for (train_X, valid_X), (train_idx, test_idx) in zip(fold_calls, splits, strict=True):
        assert valid_X is not None
        test_rows = _rowset(X_full[test_idx])
        valid_rows = _rowset(valid_X)
        train_rows = _rowset(X_full[train_idx])
        # 核心：inner-val 与该折 OOS 测试集零交集（测试集未被早停偷看）
        assert valid_rows.isdisjoint(test_rows)
        # inner-val 全部来自训练区
        assert valid_rows <= train_rows
        # 训练拟合集本身也不含测试折（X_eval 只用于 predict）
        assert _rowset(train_X).isdisjoint(test_rows)


def test_train_lgb_multiclass_guardrail_continuous_labels_no_classify_mode(
    fake_lgb: types.ModuleType, artifact_tmp: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """分类后移护栏：连续 label + classify_mode=None（缺省）→ _validate_dir3_labels raise。

    runner.train_model 已在上游拦截"分类模型 + classify_mode=None"的误配；
    此处直接调子 runner 验证内部护栏（最后一道防线）依然有效。
    """
    import quant_pipeline.training.lgb_multiclass_walk_forward as wf
    import quant_pipeline.training.runner as runner_mod

    fm = _synthetic_feature_matrix()
    rng = np.random.default_rng(2)
    fm["label"] = rng.normal(size=len(fm)) * 0.02  # 连续收益标签（无 classify_mode 离散）
    monkeypatch.setattr(runner_mod, "_load_feature_matrix", lambda fsid: fm.copy())
    monkeypatch.setattr(wf, "gate_check", lambda *a, **k: None)

    with pytest.raises(ValueError, match="dir3"):
        wf.train_lgb_multiclass_model(
            "fs_bad",
            seed=1,
            job_id=None,
            hyperparams={},          # 不传 classify_mode → 连续标签直达护栏
            walk_forward_params={},
            progress_callback=None,
            today_yyyymmdd="20260530",
            insert_model_run=lambda *a, **k: None,
            write_artifact=None,
        )


def _synthetic_continuous_feature_matrix() -> pd.DataFrame:
    """同 _synthetic_feature_matrix，但 label 为连续涨跌幅（分类后移闭环测试用）。"""
    rng = np.random.default_rng(99)
    dates = [f"d{d:04d}" for d in range(320)]
    codes = [f"{i:06d}.SZ" for i in range(5)]
    rows = []
    for d in dates:
        for c in codes:
            rows.append(
                {
                    "trade_date": d,
                    "ts_code": c,
                    "features": {
                        "f0": float(rng.normal()),
                        "f1": float(rng.normal()),
                        "f2": float(rng.normal()),
                    },
                    "label": float(rng.normal() * 0.02),  # 连续收益（如 0.013 / -0.007）
                }
            )
    return pd.DataFrame(rows)


@pytest.mark.parametrize("classify_mode,classify_params", [
    ("band", {"eps": 0.005}),
    ("tercile", {}),
])
def test_lgb_multiclass_classify_mode_end_to_end(
    classify_mode: str,
    classify_params: dict,
    fake_lgb: types.ModuleType,
    artifact_tmp: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """闭环测试（分类后移 spec 2026-06-05）：连续 label + classify_mode → 离散后训练成功。

    连续 fwd_ret_h1 label（如 0.013）经 classify() 离散为 {0,1,2} 后，
    _validate_dir3_labels 护栏通过，lgb-multiclass walk-forward 正常完成。
    """
    import quant_pipeline.training.lgb_multiclass_walk_forward as wf
    import quant_pipeline.training.runner as runner_mod

    fm = _synthetic_continuous_feature_matrix()
    monkeypatch.setattr(runner_mod, "_load_feature_matrix", lambda fsid: fm.copy())
    monkeypatch.setattr(wf, "gate_check", lambda *a, **k: None)
    rng = np.random.default_rng(7)
    monkeypatch.setattr(
        wf, "load_forward_returns",
        lambda pairs, **k: {p: float(rng.normal() * 0.01) for p in pairs},
    )

    # 不应 raise —— classify 先离散，护栏后通过
    res = wf.train_lgb_multiclass_model(
        "fs_cls",
        seed=42,
        job_id=None,
        hyperparams={"classify_mode": classify_mode, "classify_params": classify_params},
        walk_forward_params={"n_folds": 6, "embargo_days": 21, "min_train_days": 252},
        progress_callback=None,
        today_yyyymmdd="20260601",
        insert_model_run=lambda *a, **k: None,
        write_artifact=None,
    )
    assert res.model_version.startswith("lgb-multiclass-v1-")
    assert res.oos_metrics["task"] == "classification_3class"


# ---------------------------------------------------------------- 端到端推理
def test_predict_one_day_lgb_multiclass(
    fake_lgb: types.ModuleType, artifact_tmp: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    import quant_pipeline.inference.lgb_multiclass_predictor as pr
    import quant_pipeline.inference.runner as ir
    import quant_pipeline.utils.paths as paths

    rid = uuid4()
    d = paths.ensure_artifact_dir(rid)
    (d / "model.txt").write_text("FAKE", encoding="utf-8")
    (d / "meta.json").write_text(
        json.dumps(
            {
                "algorithm": "lgb-multiclass",
                "feature_columns_order": ["f0", "f1", "f2"],
                "class_order": ["down", "flat", "up"],
            }
        ),
        encoding="utf-8",
    )
    uri = paths.artifact_uri(rid, "model.txt")

    monkeypatch.setattr(
        ir,
        "_load_model_run",
        lambda session, model_version=None, model_run_id=None: {
            "feature_set_id": "fs1",
            "artifact_uri": uri,
        },
    )
    # 截面列顺序故意打乱（f2,f0,f1），验证预测侧按 feature_columns_order 重排。
    section = pd.DataFrame(
        {
            "ts_code": ["A", "B", "C"],
            "f2": [0.0, 2.0, 0.5],
            "f0": [2.0, 0.0, 0.0],
            "f1": [0.0, 0.0, 0.0],
        }
    )
    monkeypatch.setattr(
        ir,
        "_load_daily_feature_section",
        lambda session, fsid, td, cols: section[["ts_code", *cols]].copy(),
    )
    monkeypatch.setattr(ir, "_load_all_ts_codes", lambda session, td: ["A", "B", "C", "D"])

    out = pr.predict_one_day_lgb_multiclass("mv", "20260530", session=object())

    assert list(out.columns) == ["ts_code", "score", "rank_in_day"]
    # 行数 == 当日全量股票数（A,B,C,D；D 缺票补 NaN）
    assert len(out) == 4
    assert out.loc[out["ts_code"] == "D", "score"].isna().all()

    # score = P(up) - P(down)；B（f2 高 = up logit 高）应得分最高、rank 1
    scored = out.dropna(subset=["score"]).sort_values("rank_in_day")
    assert scored.iloc[0]["ts_code"] == "B"

    def _softmax(z: list[float]) -> np.ndarray:
        e = np.exp(np.array(z) - max(z))
        return e / e.sum()

    pB = _softmax([0.0, 0.0, 2.0])  # B: f0=0,f1=0,f2=2
    got = float(out.loc[out["ts_code"] == "B", "score"].iloc[0])
    assert abs((pB[2] - pB[0]) - got) < 1e-9


# ---- #9 final booster meta 标注：early_stopping=False + best_iteration=num_boost_round
def test_final_booster_used_hp_no_early_stopping(
    fake_lgb: types.ModuleType, artifact_tmp: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#9 回归：final booster 的 used_hp 必须明确标注 early_stopping=False
    且 best_iteration=num_boost_round，且不含 early_stopping_rounds 键——
    防止误读为 final booster 也用了早停（与 walk_forward_runner.py:160-164 同口径）。
    """

    import quant_pipeline.training.lgb_multiclass_walk_forward as wf
    import quant_pipeline.training.runner as runner_mod

    fm = _synthetic_feature_matrix()
    monkeypatch.setattr(runner_mod, "_load_feature_matrix", lambda fsid: fm.copy())
    monkeypatch.setattr(wf, "gate_check", lambda *a, **k: None)
    monkeypatch.setattr(wf, "load_forward_returns", lambda pairs, **k: {p: 0.0 for p in pairs})

    inserted: dict[str, Any] = {}

    def _capture_insert(run_id: Any, **kw: Any) -> None:
        inserted.update(kw)

    num_boost_round = 300
    wf.train_lgb_multiclass_model(
        "fs_test",
        seed=7,
        job_id=None,
        hyperparams={"num_boost_round": num_boost_round, "early_stopping_rounds": 30},
        walk_forward_params={"n_folds": 6, "embargo_days": 21, "min_train_days": 252},
        progress_callback=None,
        today_yyyymmdd="20260530",
        insert_model_run=_capture_insert,
        write_artifact=None,
    )

    hp = inserted["hyperparams"]
    # 关键标注：final booster 无早停
    assert hp.get("early_stopping") is False, (
        "final booster used_hp 必须含 early_stopping=False，实际: "
        f"early_stopping={hp.get('early_stopping')!r}"
    )
    # best_iteration 记固定轮数（无早停时 best_iteration 无意义，标注为 num_boost_round）
    assert hp.get("best_iteration") == num_boost_round, (
        f"final booster best_iteration 应等于 num_boost_round={num_boost_round}，"
        f"实际: {hp.get('best_iteration')!r}"
    )
    # early_stopping_rounds 不得出现在 final booster meta 里（fold 内超参，不属于 final）
    assert "early_stopping_rounds" not in hp, (
        "final booster used_hp 不应含 early_stopping_rounds（fold 内超参），"
        f"实际: {hp}"
    )
