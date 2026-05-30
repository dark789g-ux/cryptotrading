# -*- coding: utf-8 -*-
"""lgb-multiclass 专用 Purged Walk-Forward 训练编排（spec 03）。

LightGBM 三分类（跌/横盘/涨），吃 dir3 整数标签，与 lstm 平行、独立路径：
  · 固定 objective="multiclass" / num_class=3 / metric="multi_logloss"（不暴露用户）；
  · 可调项 = 与 lgb-lambdarank 共享的 LightGBM 树参数（DEFAULT_LGB_MC_HYPERPARAMS）；
  · 复用 walk_forward.PurgedWalkForwardSplit（6 折，embargo ≥ 21；lgb 非序列模型，
    embargo 无 lookback 扩容，下限 21）；
  · 复用 runner._load_feature_matrix / _flatten_features 加载数据；
  · 复用 quality.report.gate_check 训练前门禁；
  · 复用 runner._insert_model_run 落库原语（通过 insert_model_run 回调注入）；
  · 分类指标 / oos_metrics 组装复用 classification_metrics.build_oos_metrics。

score = P(涨) − P(跌)（与 LSTM 同口径），保证 ml.scores_daily.score 跨模型同向。

产物（spec 03）：
  ./artifacts/<run_uuid>/
    ├─ model.txt   LightGBM booster.save_model（非 LSTM 的 model.pt）
    └─ meta.json   {algorithm:"lgb-multiclass", class_order:[down,flat,up],
                    feature_columns_order(推理列对齐权威), num_class, objective, metric, ...}
  model_version = f"lgb-multiclass-v1-{today}-seed{seed}"

lightgbm 延迟 import（worker 启动不强依赖；门禁/切分/指标均不需 lightgbm）。
"""

from __future__ import annotations

import json
import logging
import shutil
from datetime import datetime, timezone
from typing import Any, Callable
from uuid import UUID, uuid4

import numpy as np
import pandas as pd

from quant_pipeline.quality.report import gate_check
from quant_pipeline.training.classification_metrics import CLASS_ORDER, build_oos_metrics
from quant_pipeline.training.forward_returns import load_forward_returns
from quant_pipeline.training.walk_forward import (
    PurgedWalkForwardSplit,
    time_series_inner_split,
)
from quant_pipeline.utils.paths import artifact_dir, artifact_uri, ensure_artifact_dir

logger = logging.getLogger(__name__)

# embargo 硬下限（与 walk_forward._MIN_EMBARGO_DAYS 一致；A 股财报披露窗口 PIT）。
_MIN_EMBARGO_DAYS = 21
# 固定多分类目标（不暴露给用户，spec 03 §定位与原则）。
_FIXED_PARAMS: dict[str, Any] = {
    "objective": "multiclass",
    "num_class": 3,
    "metric": "multi_logloss",
}
# 树参数默认值：与 lightgbm_lambdarank.DEFAULT_HYPERPARAMS 的树参数对齐，仅目标函数为
# multiclass（spec 03）。不含 objective/metric 等（由 _FIXED_PARAMS 覆盖）。
DEFAULT_LGB_MC_HYPERPARAMS: dict[str, Any] = {
    "boosting_type": "gbdt",
    "num_leaves": 31,
    "max_depth": -1,
    "min_data_in_leaf": 200,
    "learning_rate": 0.05,
    "feature_fraction": 0.85,
    "bagging_fraction": 0.85,
    "bagging_freq": 5,
    "verbose": -1,
    "force_col_wise": True,
}
# 用户可覆盖的树参数白名单（与 train_e2e_runner._LGB_HYPERPARAM_RANGES 对齐；
# num_boost_round / early_stopping_rounds 单列处理，不入 params）。
_TREE_PARAM_KEYS = {
    "num_leaves",
    "min_data_in_leaf",
    "feature_fraction",
    "learning_rate",
    "bagging_fraction",
    "lambda_l1",
    "lambda_l2",
}
_DEFAULT_NUM_BOOST_ROUND = 500
_DEFAULT_EARLY_STOPPING_ROUNDS = 50

_UP_IDX = CLASS_ORDER.index("up")
_DOWN_IDX = CLASS_ORDER.index("down")


def _build_wide_df(feature_set_id: str) -> tuple[pd.DataFrame, list[str]]:
    """加载 feature_matrix → 展平 features:dict → 宽表 [trade_date, ts_code, *cols, label]。

    feature_cols 顺序由 flatten_features 升序固定（与训练/推理一致，存 meta）。
    """

    from quant_pipeline.training.group_utils import flatten_features
    from quant_pipeline.training.runner import _load_feature_matrix

    df = _load_feature_matrix(feature_set_id)
    if df.empty:
        raise ValueError(
            f"feature_set_id={feature_set_id!r} 无样本，无法训练 lgb-multiclass"
        )
    X_feat, feature_cols = flatten_features(df)
    wide = pd.DataFrame(
        {
            "trade_date": df["trade_date"].astype(str).to_numpy(),
            "ts_code": df["ts_code"].astype(str).to_numpy(),
            "label": df["label"].to_numpy(),
        }
    )
    for col in feature_cols:
        wide[col] = X_feat[col].to_numpy()
    wide = wide.sort_values(["trade_date", "ts_code"], kind="stable").reset_index(drop=True)
    return wide, feature_cols


def _validate_dir3_labels(y: np.ndarray) -> np.ndarray:
    """标签护栏（spec 03 §标签消费）：lgb-multiclass 需 dir3 系标签，取值 ⊆ {0,1,2}。

    feature_matrix.label 是 float（0.0/1.0/2.0）。先丢 NaN，再校验取值集合，
    最后转 int。任何非 {0,1,2} 取值（如连续收益标签 strategy-aware / fwd_5d_ret）
    → 报错「需 dir3 系标签」（对齐 LSTM 护栏，禁静默接受 CLAUDE.md）。
    """

    arr = np.asarray(y, dtype=np.float64)
    finite_mask = np.isfinite(arr)
    finite = arr[finite_mask]
    if finite.size == 0:
        raise ValueError("lgb-multiclass 训练标签全为 NaN，无有效样本")
    uniq = set(np.unique(finite).tolist())
    if not uniq.issubset({0.0, 1.0, 2.0}):
        raise ValueError(
            "lgb-multiclass 需 dir3 系标签（取值⊆{0,1,2}），"
            f"实际出现 {sorted(uniq)[:10]}；请改用 dir3_band / dir3_tercile 标签方案"
        )
    # NaN 位置先置 -1 再转 int（避免 float NaN→int64 的 RuntimeWarning）；
    # 调用方按 finite_mask 过滤后这些占位值不会进训练。
    out = np.where(finite_mask, arr, -1.0)
    return out.astype(np.int64)


def _merge_params(hyperparams: dict[str, Any] | None, seed: int) -> dict[str, Any]:
    """DEFAULT_LGB_MC_HYPERPARAMS ∪ 用户覆盖（仅树参数白名单）∪ 固定多分类目标 + seed。"""

    params: dict[str, Any] = dict(DEFAULT_LGB_MC_HYPERPARAMS)
    if hyperparams:
        for k, v in hyperparams.items():
            if k in _TREE_PARAM_KEYS:
                params[k] = v
    params.update(_FIXED_PARAMS)
    params.setdefault("seed", seed)
    params.setdefault("deterministic", True)
    return params


def _resolve_boost_controls(hyperparams: dict[str, Any] | None) -> tuple[int, int | None]:
    """从 hyperparams 取 num_boost_round / early_stopping_rounds（不入 params）。"""

    hp = hyperparams or {}
    nbr = int(hp.get("num_boost_round", _DEFAULT_NUM_BOOST_ROUND))
    esr_raw = hp.get("early_stopping_rounds", _DEFAULT_EARLY_STOPPING_ROUNDS)
    esr = None if esr_raw is None else int(esr_raw)
    return nbr, esr


def _train_one_fold(
    X_tr: np.ndarray,
    y_tr: np.ndarray,
    X_eval: np.ndarray,
    *,
    valid_data: tuple[np.ndarray, np.ndarray] | None,
    feature_cols: list[str],
    params: dict[str, Any],
    num_boost_round: int,
    early_stopping_rounds: int | None,
) -> tuple[Any, np.ndarray]:
    """单折训练 + 在 X_eval（OOS 测试折）上预测概率。返回 (booster, proba(N,3))。

    防泄漏（评审 #1）：early-stopping 验证集由调用方从**训练折时序尾部**切出并经
    ``valid_data`` 传入，**绝不**传 OOS 测试折 —— 此前用 test 折同时早停又评估构成
    测试集泄漏。``valid_data=None`` 时不早停、固定训练 ``num_boost_round`` 轮。
    ``X_eval`` 只用于最终 predict，不进任何训练 / 早停。lightgbm 延迟 import。
    """

    import lightgbm as lgb

    train_set = lgb.Dataset(
        X_tr, label=y_tr, feature_name=list(feature_cols), free_raw_data=False
    )
    valid_sets: list[Any] = []
    valid_names: list[str] = []
    callbacks: list[Any] = []
    if valid_data is not None and early_stopping_rounds:
        x_iv, y_iv = valid_data
        valid_sets.append(
            lgb.Dataset(
                x_iv, label=y_iv, feature_name=list(feature_cols),
                reference=train_set, free_raw_data=False,
            )
        )
        valid_names.append("inner_val")
        callbacks.append(
            lgb.early_stopping(stopping_rounds=int(early_stopping_rounds), verbose=False)
        )
    callbacks.append(lgb.log_evaluation(period=0))
    booster = lgb.train(
        params=params,
        train_set=train_set,
        num_boost_round=int(num_boost_round),
        valid_sets=valid_sets or None,
        valid_names=valid_names or None,
        callbacks=callbacks,
    )
    proba = np.asarray(booster.predict(X_eval), dtype=np.float64).reshape(-1, 3)
    return booster, proba


def _fold_date_span(dates: pd.Series) -> str:
    if dates.empty:
        return ""
    ds = sorted(dates.astype(str).unique().tolist())
    return f"{ds[0]}..{ds[-1]}"


def _build_true_ret(val_pairs: list[tuple[str, str]]) -> np.ndarray:
    """按 score 行序回表算真实次日后复权收益；命中 r / 未命中 NaN。"""

    if not val_pairs:
        return np.empty(0, dtype=np.float64)
    ret_map = load_forward_returns(val_pairs)
    true_ret = np.array([ret_map.get(p, np.nan) for p in val_pairs], dtype=np.float64)
    n_hit = int(np.isfinite(true_ret).sum())
    if n_hit < len(val_pairs):
        sample = [p for p in val_pairs if p not in ret_map][:5]
        logger.warning(
            "lgb_mc_true_ret_coverage_gap",
            extra={
                "missing": len(val_pairs) - n_hit,
                "total": len(val_pairs),
                "resolved": n_hit,
                "sample": sample,
            },
        )
    return true_ret


def _progress(cb: Callable[[int, str], None] | None, pct: int, stage: str) -> None:
    if cb is not None:
        cb(int(pct), stage)


def train_lgb_multiclass_model(
    feature_set_id: str,
    *,
    seed: int,
    job_id: UUID | None,
    hyperparams: dict[str, Any] | None,
    walk_forward_params: dict[str, Any],
    progress_callback: Callable[[int, str], None] | None,
    today_yyyymmdd: str | None,
    insert_model_run: Any,
    write_artifact: Any,  # noqa: ARG001 - lgb 自落 model.txt，与 lstm 同（见 docstring）
) -> Any:
    """lgb-multiclass 三分类 Purged Walk-Forward 训练入口（runner 分派目标）。

    返回与 lgb/lstm 路径同型的 TrainResult（model_run_id / model_version /
    artifact_uri / oos_metrics / report_uri=None）。

    write_artifact 入参仅为与 runner 分派签名对齐；lgb-multiclass 自行用
    booster.save_model 落 model.txt + meta.json（与 lambdarank 一致），不经 write_artifact。
    """

    from quant_pipeline.training.runner import ArtifactWriteError, TrainResult

    hp: dict[str, Any] = dict(hyperparams or {})
    label_scheme = hp.get("label_scheme")

    _progress(progress_callback, 0, "train:lgb_mc_start")

    # ---- 0%：加载 feature_matrix + 展平 ----
    wide_df, feature_cols = _build_wide_df(feature_set_id)
    if not feature_cols:
        raise ValueError(f"feature_set_id={feature_set_id!r} 无可训练特征列")

    # 标签护栏（spec 03 §标签消费）：必须 dir3 系（⊆{0,1,2}）。
    y_all_int = _validate_dir3_labels(wide_df["label"].to_numpy())
    # 丢 NaN label 行（与整数化口径一致：以 finite mask 过滤）。
    finite_mask = np.isfinite(wide_df["label"].to_numpy(dtype=np.float64))
    wide_df = wide_df.loc[finite_mask].reset_index(drop=True)
    wide_df["label"] = y_all_int[finite_mask]
    if len(wide_df) < 20:
        raise ValueError(
            f"feature_set_id={feature_set_id} 有效样本数 {len(wide_df)} < 20，无法训练"
        )

    latest_trade_date = str(wide_df["trade_date"].astype(str).max())

    # ---- 10%：训练前 quality 门禁（与 lgb/lstm 同一 training_pregate）----
    gate_check(latest_trade_date, mode="training_pregate", strict=True, job_id=job_id)
    _progress(progress_callback, 10, "train:lgb_mc_data_loaded")

    # ---- Purged Walk-Forward 切分（lgb 非序列：embargo 无 lookback 扩容，下限 21）----
    embargo_req = int(walk_forward_params.get("embargo_days", _MIN_EMBARGO_DAYS))
    embargo_eff = max(embargo_req, _MIN_EMBARGO_DAYS)
    n_folds = int(walk_forward_params.get("n_folds", 6))
    min_train_days = int(walk_forward_params.get("min_train_days", 252))
    splitter = PurgedWalkForwardSplit(
        n_folds=n_folds, embargo_days=embargo_eff, min_train_days=min_train_days
    )
    splits = list(splitter.split(wide_df))

    params = _merge_params(hp, seed)
    num_boost_round, early_stopping_rounds = _resolve_boost_controls(hp)

    X_full = wide_df[feature_cols].to_numpy(dtype=np.float64)
    y_full = wide_df["label"].to_numpy(dtype=np.int64)

    # ---- 10-70%：逐折训练 + 累计 OOS ----
    y_true_all: list[int] = []
    y_pred_all: list[int] = []
    score_all: list[float] = []
    val_pairs: list[tuple[str, str]] = []
    fold_metrics: list[dict[str, Any]] = []
    last_booster: Any = None

    prog_lo, prog_hi = 10, 70
    for fold_i, (train_idx, test_idx) in enumerate(splits, start=1):
        X_tr, y_tr = X_full[train_idx], y_full[train_idx]
        X_va, y_va = X_full[test_idx], y_full[test_idx]
        if X_tr.shape[0] == 0 or X_va.shape[0] == 0:
            logger.warning(
                "lgb_mc_fold_empty",
                extra={
                    "fold": fold_i,
                    "n_train": int(X_tr.shape[0]),
                    "n_valid": int(X_va.shape[0]),
                },
            )
            continue
        # 防泄漏（评审 #1）：early-stopping 验证集从训练折时序尾部切出，绝不用 OOS 测试折。
        # 切不出（训练折交易日不足留 inner-val + embargo）→ 退化为本折不早停，固定轮数训练。
        valid_data: tuple[np.ndarray, np.ndarray] | None = None
        x_fit, y_fit = X_tr, y_tr
        if early_stopping_rounds:
            tr_dates = wide_df.iloc[train_idx]["trade_date"].to_numpy()
            itr_pos, iva_pos = time_series_inner_split(tr_dates, embargo_days=embargo_eff)
            if iva_pos.size > 0:
                x_fit, y_fit = X_tr[itr_pos], y_tr[itr_pos]
                valid_data = (X_tr[iva_pos], y_tr[iva_pos])
            else:
                logger.warning(
                    "lgb_mc_inner_val_unavailable_no_early_stop",
                    extra={"fold": fold_i, "n_train_rows": int(X_tr.shape[0])},
                )
        booster, proba = _train_one_fold(
            x_fit, y_fit, X_va,
            valid_data=valid_data,
            feature_cols=feature_cols, params=params,
            num_boost_round=num_boost_round, early_stopping_rounds=early_stopping_rounds,
        )
        last_booster = booster
        y_pred = proba.argmax(axis=1)
        score = proba[:, _UP_IDX] - proba[:, _DOWN_IDX]

        y_true_all.extend(int(v) for v in y_va)
        y_pred_all.extend(int(v) for v in y_pred)
        score_all.extend(float(v) for v in score)
        va_rows = wide_df.iloc[test_idx]
        val_pairs.extend(
            (str(c), str(d))
            for c, d in zip(va_rows["ts_code"].to_numpy(), va_rows["trade_date"].to_numpy())
        )

        # 折内分类指标（accuracy / macro_f1），复用共享纯函数。
        from quant_pipeline.training.classification_metrics import (
            accuracy_from_cm,
            confusion_matrix_3class,
            macro_f1_from_per_class,
            per_class_prf,
        )
        cm = confusion_matrix_3class(np.asarray(y_va), y_pred)
        fold_metrics.append(
            {
                "fold": fold_i,
                "train_dates": _fold_date_span(wide_df.iloc[train_idx]["trade_date"]),
                "valid_dates": _fold_date_span(va_rows["trade_date"]),
                "accuracy": accuracy_from_cm(cm),
                "macro_f1": macro_f1_from_per_class(per_class_prf(cm)),
                "n_valid": int(X_va.shape[0]),
            }
        )
        pct = prog_lo + (prog_hi - prog_lo) * fold_i // max(1, len(splits))
        _progress(progress_callback, pct, f"train:lgb_mc_fold_{fold_i}/{len(splits)}")

    if last_booster is None:
        raise ValueError(
            "lgb-multiclass walk-forward 所有 fold 样本均为空，无法训练；请检查数据量。"
        )

    # ---- 70-85%：组装 oos_metrics ----
    true_ret_all = _build_true_ret(val_pairs)
    oos_metrics = build_oos_metrics(
        y_true=np.asarray(y_true_all, dtype=np.int64),
        y_pred=np.asarray(y_pred_all, dtype=np.int64),
        score=np.asarray(score_all, dtype=np.float64),
        true_ret=true_ret_all,
        fold_metrics=fold_metrics,
    )
    oos_metrics["walk_forward_params"] = {
        "n_folds": n_folds,
        "embargo_days": embargo_eff,
        "min_train_days": min_train_days,
    }
    _progress(progress_callback, 85, "train:lgb_mc_eval_done")

    # ---- 85-100%：全量重训 final booster（关闭早停）+ 落盘 + 写 ml.model_runs ----
    import lightgbm as _lgb

    full_set = _lgb.Dataset(
        X_full, label=y_full, feature_name=list(feature_cols), free_raw_data=False
    )
    final_booster = _lgb.train(
        params=params,
        train_set=full_set,
        num_boost_round=int(num_boost_round),
        callbacks=[_lgb.log_evaluation(period=0)],
    )

    run_id = uuid4()
    today = today_yyyymmdd or datetime.now(timezone.utc).strftime("%Y%m%d")
    model_version = f"lgb-multiclass-v1-{today}-seed{seed}"

    used_hp: dict[str, Any] = dict(params)
    used_hp["num_boost_round"] = num_boost_round
    used_hp["early_stopping_rounds"] = early_stopping_rounds
    used_hp["seed"] = seed

    meta: dict[str, Any] = {
        "algorithm": "lgb-multiclass",
        "model_run_id": str(run_id),
        "model_version": model_version,
        "feature_set_id": feature_set_id,
        "feature_cols": feature_cols,
        "feature_columns_order": feature_cols,  # 推理列对齐权威契约
        "label_scheme": label_scheme,
        "class_order": list(CLASS_ORDER),
        "num_class": 3,
        "objective": "multiclass",
        "metric": "multi_logloss",
        "hyperparams": used_hp,
        "oos_metrics": oos_metrics,
        "trained_at_utc": datetime.now(timezone.utc).isoformat(),
        "latest_train_date": latest_trade_date,
        "seed": seed,
        "walk_forward": True,
    }

    try:
        target_dir = ensure_artifact_dir(run_id)
    except OSError as exc:
        raise ArtifactWriteError(f"无法创建 artifact 目录 {run_id}: {exc}") from exc
    model_path = target_dir / "model.txt"
    meta_path = target_dir / "meta.json"
    try:
        final_booster.save_model(str(model_path))
        with meta_path.open("w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(target_dir, ignore_errors=True)
        raise ArtifactWriteError(f"lgb-multiclass artifact 写盘失败: {exc}") from exc

    model_uri = artifact_uri(run_id, "model.txt")

    try:
        insert_model_run(
            run_id,
            job_id=job_id,
            model_version=model_version,
            feature_set_id=feature_set_id,
            hyperparams=used_hp,
            oos_metrics=oos_metrics,
            artifact_uri_str=model_uri,
            report_uri_str=None,
        )
    except Exception:
        shutil.rmtree(artifact_dir(run_id), ignore_errors=True)
        raise

    _progress(progress_callback, 100, "train:lgb_mc_done")
    logger.info(
        "train_lgb_multiclass_model_done",
        extra={
            "model_run_id": str(run_id),
            "model_version": model_version,
            "n_folds": n_folds,
            "embargo_eff": embargo_eff,
            "accuracy": oos_metrics.get("accuracy"),
            "macro_f1": oos_metrics.get("macro_f1"),
        },
    )

    return TrainResult(
        model_run_id=run_id,
        model_version=model_version,
        artifact_uri=model_uri,
        oos_metrics=oos_metrics,
        report_uri=None,
    )


__all__ = [
    "train_lgb_multiclass_model",
    "DEFAULT_LGB_MC_HYPERPARAMS",
]
