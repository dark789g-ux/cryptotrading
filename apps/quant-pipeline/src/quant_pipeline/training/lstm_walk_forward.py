"""LSTM 专用 Purged Walk-Forward 训练编排（spec 02 §5 / §6）。

与 lgb 路径平行、独立（分类任务 + torch 训练循环 + 序列输入）：
  · 复用 walk_forward.PurgedWalkForwardSplit 的切分原语；
  · 复用 runner._load_feature_matrix / _flatten_features 的数据加载；
  · 复用 quality.report.gate_check 的训练前门禁；
  · 复用 runner._insert_model_run 的落库原语（通过 insert_model_run 回调注入）；
  · 分类指标 / oos_metrics 组装抽到 lstm_metrics.build_oos_metrics（避免本文件超 500 行）。

torch 延迟 import：embargo 计算、数据加载、切分、指标全不依赖 torch；
仅「每 fold 训练 + 推理」一步触 torch（在 train_one_fold / _predict_proba 内 import）。

产物（spec 02 §6）：
  ./artifacts/<run_uuid>/
    ├─ model.pt    torch.save(model.state_dict())
    └─ meta.json   {algorithm:"lstm", input_size, lookback, hidden_size, num_layers,
                    dropout, feature_cols(顺序), label_scheme, class_order:[down,flat,up]}
  model_version = f"lstm-v1-{today}-seed{seed}"
  artifact_uri  = "./artifacts/<run_uuid>/model.pt"

> 注意：runner 传入的 write_artifact=_write_artifact 是 lgb 专用
> （`booster.save_model('model.txt')`），对 torch nn.Module 不适用。本模块自行用
> ensure_artifact_dir / artifact_uri 落 model.pt + meta.json；write_artifact 入参仅为
> 与 runner 分派签名对齐而保留，model artifact 不经它（见报告「关键决策」）。
"""

from __future__ import annotations

import json
import logging
import shutil
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import numpy as np
import pandas as pd

from quant_pipeline.quality.report import gate_check
from quant_pipeline.training.forward_returns import load_forward_returns
from quant_pipeline.training.group_utils import flatten_features
from quant_pipeline.training.lstm_metrics import CLASS_ORDER, build_oos_metrics
from quant_pipeline.training.lstm_model import (
    DEFAULT_LSTM_HYPERPARAMS,
    _macro_f1_and_acc,
    train_one_fold,
)
from quant_pipeline.training.sequence_builder import build_sequences
from quant_pipeline.training.walk_forward import (
    PurgedWalkForwardSplit,
    time_series_inner_split,
)
from quant_pipeline.utils.paths import artifact_dir, artifact_uri, ensure_artifact_dir

logger = logging.getLogger(__name__)

# embargo 既有硬下限（与 walk_forward._MIN_EMBARGO_DAYS 一致；A 股财报披露窗口 PIT）。
_MIN_EMBARGO_DAYS = 21
# label_horizon：次日方向三分类，标签视界 = 1 天 → 回看窗 + 1。
_LABEL_HORIZON = 1


def _resolve_lookback(hyperparams: dict[str, Any]) -> int:
    lb = hyperparams.get("lookback", DEFAULT_LSTM_HYPERPARAMS["lookback"])
    lb = int(lb)
    if lb < 1:
        raise ValueError(f"lookback 必须 >= 1，got {lb}")
    return lb


def compute_embargo_eff(walk_forward_params: dict[str, Any], lookback: int) -> int:
    """embargo 扩容公式（spec 02 §5「泄漏防护」）。

        embargo_eff = max(walk_forward_params.embargo_days(默认21), lookback + 1, 21)

    三者取 max：
      · walk_forward_params.embargo_days —— 调用方显式传入（默认 21）；
      · lookback + label_horizon(=1) —— LSTM 回看窗口 + 次日标签；
      · 21 —— 既有硬下限 _MIN_EMBARGO_DAYS（A 股财报窗口）。
    因结果恒 >= 21，传给 PurgedWalkForwardSplit 既不触碰其内部 _MIN_EMBARGO_DAYS 地板，
    也不重复施加。
    """

    requested = int(walk_forward_params.get("embargo_days", _MIN_EMBARGO_DAYS))
    return max(requested, lookback + _LABEL_HORIZON, _MIN_EMBARGO_DAYS)


def _build_wide_df(feature_set_id: str) -> tuple[pd.DataFrame, list[str]]:
    """加载 feature_matrix → 展平 features:dict → 拼成 build_sequences 所需宽表。

    返回 (wide_df[trade_date, ts_code, *feature_cols, label], feature_cols)。
    feature_cols 顺序由 flatten_features 升序固定（与训练 / 推理一致，存 meta）。
    """

    # 延迟 import 避免与 runner 互相引用（runner 在 lstm 分派时才 import 本模块）
    from quant_pipeline.training.runner import _load_feature_matrix

    df = _load_feature_matrix(feature_set_id)
    if df.empty:
        raise ValueError(f"feature_set_id={feature_set_id!r} 无样本，无法训练 LSTM")

    X_feat, feature_cols = flatten_features(df)
    wide = pd.DataFrame(
        {
            "trade_date": df["trade_date"].astype(str).to_numpy(),
            "ts_code": df["ts_code"].astype(str).to_numpy(),
            "label": df["label"].to_numpy(),
        }
    )
    # X_feat 行序与 df 一致（flatten_features 按 df["features"] 逐行展开）
    for col in feature_cols:
        wide[col] = X_feat[col].to_numpy()
    # build_sequences 内按 ts_code 分组、trade_date 升序滑窗；此处先整体排序保稳定
    wide = wide.sort_values(["trade_date", "ts_code"], kind="stable").reset_index(drop=True)
    return wide, feature_cols


def _predict_proba(model: Any, X: np.ndarray) -> np.ndarray:
    """对序列样本做前向 + softmax，返回 (N, 3) 概率。torch 延迟 import。"""

    import torch

    if X.shape[0] == 0:
        return np.empty((0, len(CLASS_ORDER)), dtype=np.float64)
    model.eval()
    with torch.no_grad():
        logits = model(torch.from_numpy(np.asarray(X, dtype=np.float32)))
        proba = torch.softmax(logits, dim=1).cpu().numpy()
    return proba.astype(np.float64, copy=False)


def _fold_date_span(index: pd.DataFrame) -> str:
    """SequenceBundle.index 的 trade_date 跨度，形如 'YYYYMMDD..YYYYMMDD'。"""

    if index.empty:
        return ""
    dates = sorted(index["trade_date"].astype(str).unique().tolist())
    return f"{dates[0]}..{dates[-1]}"


def _progress(progress_callback: Callable[[int, str], None] | None, pct: int, stage: str) -> None:
    if progress_callback is not None:
        progress_callback(int(pct), stage)


def _run_folds(
    wide_df: pd.DataFrame,
    feature_cols: list[str],
    *,
    splits: list[tuple[np.ndarray, np.ndarray]],
    lookback: int,
    hyperparams: dict[str, Any],
    seed: int,
    progress_callback: Callable[[int, str], None] | None,
) -> tuple[Any, list[np.ndarray], dict[str, list[Any]]]:
    """逐 fold 训练 + 收集 OOS。

    返回 (last_model, acc_buffers, fold_metrics_list)。
    acc_buffers = [y_true_all, y_pred_all, score_all, true_ret_all]，跨折累计。

    折内 buffer 只累计 [y_true_all, y_pred_all, score_all] + val_index_all（验证样本的
    [ts_code, trade_date]，与 score 同行序）；true_ret_all 不在折内累计，由折后
    load_forward_returns 结果按 score 行序整体构造（命中真实收益 / 未命中 NaN）。
    """

    n_folds = len(splits)
    y_true_all: list[int] = []
    y_pred_all: list[int] = []
    score_all: list[float] = []
    val_index_all: list[pd.DataFrame] = []  # 每折 bundle_va.index，与 score 同序
    fold_metrics: list[dict[str, Any]] = []
    last_model: Any = None

    prog_lo, prog_hi = 10, 70
    up_idx = CLASS_ORDER.index("up")
    down_idx = CLASS_ORDER.index("down")

    for fold_i, (train_idx, test_idx) in enumerate(splits, start=1):
        df_tr = wide_df.iloc[train_idx].reset_index(drop=True)
        df_va = wide_df.iloc[test_idx].reset_index(drop=True)

        # 防泄漏（评审 #2）：early-stopping / 选最优 epoch 的验证集从训练折时序尾部
        # 切出，**绝不**用 OOS 测试折 —— 此前用 test 折早停 + 选最优权重再在同一 test
        # 上报告 OOS，构成测试集泄漏。inner embargo 用 lookback+1（防序列回看 + 次日
        # 标签跨界）。切不出（训练折交易日不足）→ 跳过该折。
        itr_pos, iva_pos = time_series_inner_split(
            df_tr["trade_date"].to_numpy(), embargo_days=lookback + _LABEL_HORIZON
        )
        if iva_pos.size == 0:
            logger.warning(
                "lstm_fold_inner_val_unavailable_skip",
                extra={"fold": fold_i, "n_train_rows": int(len(df_tr)), "lookback": lookback},
            )
            continue
        df_itr = df_tr.iloc[itr_pos].reset_index(drop=True)
        df_iva = df_tr.iloc[iva_pos].reset_index(drop=True)

        bundle_itr = build_sequences(df_itr, lookback, feature_cols)
        bundle_iva = build_sequences(df_iva, lookback, feature_cols)
        bundle_va = build_sequences(df_va, lookback, feature_cols)

        if (
            bundle_itr.X.shape[0] == 0
            or bundle_iva.X.shape[0] == 0
            or bundle_va.X.shape[0] == 0
        ):
            logger.warning(
                "lstm_fold_empty_sequences",
                extra={
                    "fold": fold_i,
                    "n_inner_train_seq": int(bundle_itr.X.shape[0]),
                    "n_inner_val_seq": int(bundle_iva.X.shape[0]),
                    "n_valid_seq": int(bundle_va.X.shape[0]),
                    "lookback": lookback,
                },
            )
            continue

        # 早停 / 选最优 epoch 用 inner-val（bundle_iva），测试折（bundle_va）只评估。
        model, _fm_inner = train_one_fold(
            bundle_itr.X,
            bundle_itr.y,
            bundle_iva.X,
            bundle_iva.y,
            hyperparams=hyperparams,
            seed=seed,
        )
        last_model = model

        proba = _predict_proba(model, bundle_va.X)
        y_pred = proba.argmax(axis=1)
        y_true = bundle_va.y
        score = proba[:, up_idx] - proba[:, down_idx]

        y_true_all.extend(int(v) for v in y_true)
        y_pred_all.extend(int(v) for v in y_pred)
        score_all.extend(float(v) for v in score)
        # bundle_va.index 列 [ts_code, trade_date]，与 score 行序一一对齐，
        # 折后用于 load_forward_returns 回表算真实次日后复权收益。
        val_index_all.append(bundle_va.index)

        # fold 分类指标基于 OOS 测试折（bundle_va）重算，而非 inner-val 的 _fm_inner
        # （评审 #2：此前 fm 来自 val=test，恰好是 test 指标；切开后必须显式用 test 重算）。
        fold_macro_f1, fold_acc = _macro_f1_and_acc(np.asarray(y_true, dtype=np.int64), y_pred)
        fold_metrics.append(
            {
                "fold": fold_i,
                "train_dates": _fold_date_span(bundle_itr.index),
                "valid_dates": _fold_date_span(bundle_va.index),
                "accuracy": float(fold_acc),
                "macro_f1": float(fold_macro_f1),
                "n_valid_seq": int(bundle_va.X.shape[0]),
            }
        )

        pct = prog_lo + (prog_hi - prog_lo) * fold_i // max(1, n_folds)
        _progress(progress_callback, pct, f"train:lstm_fold_{fold_i}/{n_folds}")

    if last_model is None:
        raise ValueError(
            "LSTM walk-forward 所有 fold 序列样本均为空，无法训练；"
            "请检查 lookback 是否过大 / 单票连续交易日是否足够。"
        )

    # 折后：concat 验证样本索引 → pairs → 回表算真实次日后复权收益 → 按 score 行序构造
    # true_ret_all（命中 r / 未命中 NaN）。score_all 与 val_index_all 行序严格一致。
    true_ret_all = _build_true_ret(val_index_all, n_score=len(score_all))

    buffers = [
        np.asarray(y_true_all, dtype=np.int64),
        np.asarray(y_pred_all, dtype=np.int64),
        np.asarray(score_all, dtype=np.float64),
        true_ret_all,
    ]
    return last_model, buffers, {"fold_metrics": fold_metrics}


def _build_true_ret(val_index_all: list[pd.DataFrame], *, n_score: int) -> np.ndarray:
    """折后整体构造 true_ret_all：按 score 行序映射真实次日后复权收益。

    val_index_all 各折 [ts_code, trade_date] 按折序 concat，行序与 score_all 严格一致。
    load_forward_returns 命中 → r；未命中（停牌 / 退市 / 末日 / 缺数）→ NaN。

    无验证样本（理论不可达，last_model 非空已保证至少一折有样本）→ 全 NaN 兜底。
    """

    if not val_index_all:
        return np.full(n_score, np.nan, dtype=np.float64)

    val_index = pd.concat(val_index_all, ignore_index=True)
    pairs = [
        (str(c), str(d))
        for c, d in zip(
            val_index["ts_code"].to_numpy(),
            val_index["trade_date"].to_numpy(),
            strict=False,
        )
    ]
    ret_map = load_forward_returns(pairs)

    true_ret = np.array(
        [ret_map.get(p, np.nan) for p in pairs], dtype=np.float64
    )
    n_hit = int(np.isfinite(true_ret).sum())
    if n_hit < len(pairs):
        sample = [p for p in pairs if p not in ret_map][:5]
        logger.warning(
            "lstm_true_ret_coverage_gap",
            extra={
                "missing": len(pairs) - n_hit,
                "total": len(pairs),
                "resolved": n_hit,
                "sample": sample,
            },
        )
    return true_ret


def _write_lstm_artifact(
    run_id: UUID,
    model: Any,
    meta: dict[str, Any],
) -> str:
    """落 model.pt（torch.save state_dict）+ meta.json；失败清目录后抛。

    返回 model.pt 的 POSIX 相对 artifact_uri。
    """

    import torch

    from quant_pipeline.training.runner import ArtifactWriteError

    try:
        target_dir = ensure_artifact_dir(run_id)
    except OSError as exc:
        raise ArtifactWriteError(f"无法创建 artifact 目录 {run_id}: {exc}") from exc

    model_path = target_dir / "model.pt"
    meta_path = target_dir / "meta.json"
    try:
        torch.save(model.state_dict(), str(model_path))
        with meta_path.open("w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(target_dir, ignore_errors=True)
        raise ArtifactWriteError(f"LSTM artifact 写盘失败: {exc}") from exc

    return artifact_uri(run_id, "model.pt")


def train_lstm_model(
    feature_set_id: str,
    *,
    seed: int,
    job_id: UUID | None,
    hyperparams: dict[str, Any] | None,
    walk_forward_params: dict[str, Any],
    progress_callback: Callable[[int, str], None] | None,
    today_yyyymmdd: str | None,
    insert_model_run: Any,
    write_artifact: Any,  # noqa: ARG001 - 见模块 docstring：lgb 专用，LSTM 自落 model.pt
) -> Any:
    """LSTM 三分类 Purged Walk-Forward 训练入口（runner model=='lstm' 分派目标）。

    返回与 lgb 路径同型的 TrainResult（model_run_id / model_version / artifact_uri /
    oos_metrics / report_uri=None），让 train_e2e_runner._normalize_train_result 零改动。

    Args:
        feature_set_id: factors.feature_matrix 的 feature_set。
        seed: 随机种子（进 model_version + hyperparams）。
        job_id: ml.jobs 行 id（进度 / 落库 job_id）。
        hyperparams: 已含 e2e 元字段（label_scheme 等，runner 分派前已 merge）。
        walk_forward_params: n_folds / embargo_days / min_train_days。
        progress_callback: runner._progress 包装（同时回写 job progress）。
        today_yyyymmdd: 注入今日（YYYYMMDD）；None 取 UTC now。
        insert_model_run: runner._insert_model_run 回调。
        write_artifact: runner._write_artifact（lgb 专用，LSTM 不经它，见 docstring）。
    """

    from quant_pipeline.training.runner import TrainResult

    hp: dict[str, Any] = dict(hyperparams or {})
    lookback = _resolve_lookback(hp)
    classify_mode: str | None = hp.get("classify_mode")
    classify_params: dict[str, Any] = hp.get("classify_params") or {}

    _progress(progress_callback, 0, "train:lstm_start")

    # ---- 0%：加载 feature_matrix + 展平为宽表 ----
    wide_df, feature_cols = _build_wide_df(feature_set_id)
    if not feature_cols:
        raise ValueError(f"feature_set_id={feature_set_id!r} 无可训练特征列")
    latest_trade_date = str(wide_df["trade_date"].astype(str).max())

    # 分类后移（spec 2026-06-05 §training/runner.py 训练时套分类）：
    # feature_matrix.label 是连续涨跌幅，先按 classify_mode/classify_params 离散成
    # {0=跌, 1=横盘, 2=涨} 再传入 _run_folds → build_sequences（其整数护栏离散后自然通过）。
    if classify_mode is not None:
        from quant_pipeline.labels.classify import classify

        wide_df["label"] = classify(
            wide_df["label"].to_numpy(),
            classify_mode,
            classify_params,
            trade_date=(
                wide_df["trade_date"].to_numpy() if classify_mode == "tercile" else None
            ),
        )

    # ---- 10%：训练前 quality 门禁（与 lgb 同一 training_pregate）----
    gate_check(latest_trade_date, mode="training_pregate", strict=True, job_id=job_id)
    _progress(progress_callback, 10, "train:lstm_data_loaded")

    # ---- embargo 扩容 + Purged Walk-Forward 切分 ----
    embargo_eff = compute_embargo_eff(walk_forward_params, lookback)
    n_folds = int(walk_forward_params.get("n_folds", 6))
    min_train_days = int(walk_forward_params.get("min_train_days", 252))
    splitter = PurgedWalkForwardSplit(
        n_folds=n_folds,
        embargo_days=embargo_eff,
        min_train_days=min_train_days,
    )
    splits = list(splitter.split(wide_df))

    # ---- 10-70%：逐 fold build_sequences → train_one_fold → 累计 OOS ----
    last_model, buffers, fold_pack = _run_folds(
        wide_df,
        feature_cols,
        splits=splits,
        lookback=lookback,
        hyperparams=hp,
        seed=seed,
        progress_callback=progress_callback,
    )
    y_true_all, y_pred_all, score_all, true_ret_all = buffers

    # ---- 70-85%：组装 oos_metrics（分类 + 排序代理指标）----
    oos_metrics = build_oos_metrics(
        y_true=y_true_all,
        y_pred=y_pred_all,
        score=score_all,
        true_ret=true_ret_all,
        fold_metrics=fold_pack["fold_metrics"],
    )
    oos_metrics["walk_forward_params"] = {
        "n_folds": n_folds,
        "embargo_days": embargo_eff,
        "embargo_days_requested": int(walk_forward_params.get("embargo_days", _MIN_EMBARGO_DAYS)),
        "min_train_days": min_train_days,
        "lookback": lookback,
    }
    _progress(progress_callback, 85, "train:lstm_eval_done")

    # ---- 85-100%：产物落盘（model.pt + meta.json）+ 写 ml.model_runs ----
    run_id = uuid4()
    today = today_yyyymmdd or datetime.now(UTC).strftime("%Y%m%d")
    model_version = f"lstm-v1-{today}-seed{seed}"

    input_size = len(feature_cols)
    used_hp: dict[str, Any] = dict(DEFAULT_LSTM_HYPERPARAMS)
    used_hp.update(hp)
    used_hp["seed"] = seed
    used_hp["lookback"] = lookback

    meta: dict[str, Any] = {
        # algorithm 是 T4 推理分派的依据（lstm vs lgb），务必写入。
        "algorithm": "lstm",
        "model_run_id": str(run_id),
        "model_version": model_version,
        "feature_set_id": feature_set_id,
        "input_size": input_size,
        "lookback": lookback,
        "hidden_size": int(used_hp["hidden_size"]),
        "num_layers": int(used_hp["num_layers"]),
        "dropout": float(used_hp["dropout"]),
        "feature_cols": feature_cols,
        "classify_mode": classify_mode,
        "classify_params": classify_params,
        "class_order": list(CLASS_ORDER),
        "trained_at_utc": datetime.now(UTC).isoformat(),
        "latest_train_date": latest_trade_date,
        "seed": seed,
    }

    model_uri = _write_lstm_artifact(run_id, last_model, meta)

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

    _progress(progress_callback, 100, "train:lstm_done")

    logger.info(
        "train_lstm_model_done",
        extra={
            "model_run_id": str(run_id),
            "model_version": model_version,
            "n_folds": n_folds,
            "embargo_eff": embargo_eff,
            "lookback": lookback,
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


__all__ = ["train_lstm_model", "compute_embargo_eff"]
