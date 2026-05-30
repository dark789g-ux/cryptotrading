"""training runner —— CLI / worker dispatcher 共用入口（M2 / M3）。

`train_model(feature_set_id, model='lgb-lambdarank', walk_forward=True, seed=42, job_id=None)`

M3 升级：
  - walk_forward=True（M3 默认开）：调用 PurgedWalkForwardSplit + ab_compare.compare_three
    跑三组对照 + 集成，按每折结束更新 progress；训练完自动生成 report.md
  - walk_forward=False：M2 单 fold 通路（保留，仅供冷启动 / 调试）

顺序：
  1) 训练前 quality 门禁（strict=True）
  2) 加载 feature_matrix → 排序 + 展平 + 过滤 NaN label
  3) [WF] PurgedWalkForwardSplit → compare_three（每折结束更新 progress）
     [single] SingleFoldSplit → train_lambdarank
  4) artifact 落盘：./artifacts/<run_id>/{model.txt, meta.json, report.md, daily_returns.csv}
  5) 写 ml.model_runs（含 oos_metrics + artifact_uri + report_uri）
  6) 任一失败回滚另一个

model_version 命名（硬约束）：`<algo>-v1-<YYYYMMDD>-seed<N>`

标签口径（贯穿全链路；2026-05-23 修正）：
  feature_matrix.label 是原始连续收益率，**全链路保持连续不分桶**。
  LambdaRank 要求整数 gain，只在 `train_lambdarank` 调用入口处对 y_train 做一次
  截面 rank（见 ab_compare._label_to_cross_sectional_rank / tuning._label_to_int_rank）；
  评估（IC / RankIC / portfolio）一律用原始连续 label。曾经在此层用
  `_bin_labels_by_group` 把连续 label 提前分桶成 0..4 整数再下传，导致回归目标被压成
  5 档台阶、评估指标全部失真，已移除。

Walk-Forward + ensemble 逻辑已拆分到 walk_forward_runner.py；
单 fold 通路已拆分到 single_fold_runner.py。
"""

from __future__ import annotations

import json
import logging
import shutil
from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID

import numpy as np
import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.quality.report import gate_check
from quant_pipeline.training.group_utils import build_groups, flatten_features
from quant_pipeline.utils.paths import (
    artifact_uri,
    ensure_artifact_dir,
)
from quant_pipeline.worker.progress import ProgressCallback, update_progress

logger = logging.getLogger(__name__)


class ArtifactWriteError(RuntimeError):
    """artifact 目录写不进去 / 文件落盘失败时由 runner 抛出。

    dispatcher 接住后清理半成品 + 把 job status='failed'。
    """


@dataclass(slots=True)
class TrainResult:
    """train_model 的最小返回结构。"""

    model_run_id: UUID
    model_version: str
    artifact_uri: str
    oos_metrics: dict[str, Any]
    report_uri: str | None = None


# ----------------------------------------------------------------------
# DB 访问
# ----------------------------------------------------------------------


def _load_feature_matrix(feature_set_id: str) -> pd.DataFrame:
    """从 factors.feature_matrix 拉某个 feature_set 的全量样本。

    性能备注（#6）：此函数在多条训练通路（lambdarank / lstm / lgb-mc / tuning /
    ab_compare）中各自被调用，单次 e2e 可能重复全量查库。
    **故意不加 lru_cache**：
      1. 大量单测通过 ``monkeypatch.setattr(runner, "_load_feature_matrix", ...)`` 打桩；
         lru_cache 包装后 monkeypatch 只替换模块属性，底层已绑定的闭包不受影响，
         会导致所有打桩测试失效。
      2. 进程内跨 job 的全局缓存有陈旧数据风险（不同 feature_set_id 或同一 ID
         在训练周期内更新）。
    调用方如需避免重复查库，应自行在外层复用已加载的 DataFrame，再按需传入各训练函数。
    """

    sql = text(
        """
        SELECT trade_date, ts_code, features, label
        FROM factors.feature_matrix
        WHERE feature_set_id = :fs
        ORDER BY trade_date, ts_code
        """
    )
    with session_scope() as session:
        rows = session.execute(sql, {"fs": feature_set_id}).mappings().all()
    if not rows:
        raise ValueError(
            f"feature_matrix 中找不到 feature_set_id={feature_set_id!r} 的样本"
        )
    df = pd.DataFrame(
        [
            {
                "trade_date": r["trade_date"],
                "ts_code": r["ts_code"],
                "features": dict(r["features"]) if r["features"] else {},
                "label": float(r["label"]) if r["label"] is not None else np.nan,
            }
            for r in rows
        ]
    )
    return df


def _latest_trade_date_from_features(df: pd.DataFrame) -> str:
    if df.empty:
        raise ValueError("feature_matrix 为空，无法定位最近交易日")
    return str(df["trade_date"].astype(str).max())


# #14：group / features 工具已统一到 training.group_utils；此处保留旧私名做别名，
# 兼容 ab_compare 等模块 `from quant_pipeline.training.runner import _flatten_features`。
_build_groups = build_groups
_flatten_features = flatten_features


# ----------------------------------------------------------------------
# 评估（M2 单 fold 用）—— 保留兼容
# ----------------------------------------------------------------------


def _ndcg_at_k(scores: np.ndarray, labels: np.ndarray, groups: np.ndarray, k: int = 10) -> float:
    """旧入口：转调 evaluation.ranking_metrics.ndcg_at_k（保留旧名给单测）。"""

    from quant_pipeline.evaluation.ranking_metrics import ndcg_at_k

    return ndcg_at_k(scores, labels, groups, k=k)


def _pearson_ic(scores: np.ndarray, labels: np.ndarray) -> float:
    from quant_pipeline.evaluation.ranking_metrics import ic_pearson

    return ic_pearson(scores, labels)


def _spearman_rank_ic(scores: np.ndarray, labels: np.ndarray) -> float:
    from quant_pipeline.evaluation.ranking_metrics import rank_ic_spearman

    return rank_ic_spearman(scores, labels)


# ----------------------------------------------------------------------
# Artifact I/O
# ----------------------------------------------------------------------


def _write_artifact(
    run_id: UUID,
    booster: Any,
    meta: dict[str, Any],
) -> tuple[str, str]:
    """落盘 model.txt + meta.json；任一失败抛 ArtifactWriteError 并清理目录。"""

    try:
        target_dir = ensure_artifact_dir(run_id)
    except OSError as exc:
        raise ArtifactWriteError(f"无法创建 artifact 目录 {run_id}: {exc}") from exc

    model_path = target_dir / "model.txt"
    meta_path = target_dir / "meta.json"
    try:
        booster.save_model(str(model_path))
        with meta_path.open("w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
    except Exception as exc:  # noqa: BLE001
        try:
            shutil.rmtree(target_dir, ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass
        raise ArtifactWriteError(f"artifact 写盘失败: {exc}") from exc

    return artifact_uri(run_id, "model.txt"), artifact_uri(run_id, "meta.json")


def _insert_model_run(
    run_id: UUID,
    *,
    job_id: UUID | None,
    model_version: str,
    feature_set_id: str,
    hyperparams: dict[str, Any],
    oos_metrics: dict[str, Any],
    artifact_uri_str: str,
    report_uri_str: str | None = None,
) -> None:
    """写 ml.model_runs；失败则由调用方清理 artifact 目录。"""

    sql = text(
        """
        INSERT INTO ml.model_runs
            (id, job_id, model_version, feature_set_id, hyperparams,
             oos_metrics, artifact_uri, report_uri)
        VALUES
            (:id, :job_id, :model_version, :feature_set_id,
             CAST(:hyperparams AS jsonb), CAST(:oos_metrics AS jsonb),
             :artifact_uri, :report_uri)
        """
    )
    with session_scope() as session:
        session.execute(
            sql,
            {
                "id": run_id,
                "job_id": job_id,
                "model_version": model_version,
                "feature_set_id": feature_set_id,
                "hyperparams": json.dumps(hyperparams, ensure_ascii=False),
                "oos_metrics": json.dumps(oos_metrics, ensure_ascii=False),
                "artifact_uri": artifact_uri_str,
                "report_uri": report_uri_str,
            },
        )


# ----------------------------------------------------------------------
# 主入口
# ----------------------------------------------------------------------


def train_model(
    feature_set_id: str,
    model: str = "lgb-lambdarank",
    *,
    walk_forward: bool = True,
    seed: int = 42,
    job_id: UUID | None = None,
    progress_callback: ProgressCallback | None = None,
    hyperparams: dict[str, Any] | None = None,
    walk_forward_params: dict[str, Any] | None = None,
    with_shap: bool = True,
    today_yyyymmdd: str | None = None,
    extra_hyperparams: dict[str, Any] | None = None,
) -> TrainResult:
    """完整训练通路。

    M3 默认 walk_forward=True，跑 Purged Walk-Forward + 三组对照 + 集成；
    walk_forward=False 走 M2 单 fold 通路。

    walk_forward_params 可选字段：
        n_folds (默认 6) / embargo_days (默认 21) / min_train_days (默认 252)
        top_k (默认 20) / commission_rate (默认 0.0003) / slippage_bps (默认 5)
        lgb_num_boost_round / lgb_early_stopping_rounds

    today_yyyymmdd: 可注入今天日期（YYYYMMDD）用于 model_version / trained_at；
        默认 None 时由各子通路硬取 datetime.now(UTC)。注入后跨 UTC 午夜运行也可控。
    """

    def _progress(progress: int, stage: str) -> None:
        if progress_callback is not None:
            progress_callback(progress, stage)
        if job_id is not None:
            update_progress(job_id, progress, stage=stage)

    # D-23：train_e2e 编排把 factor_version / label_scheme / new_listing_min_days
    # 通过 extra_hyperparams 透传进 ml.model_runs.hyperparams。
    # merge 顺序：调用方 hyperparams 在前，extra_hyperparams 覆盖（让 e2e 元字段
    # 即便与既有键冲突也优先生效，避免被 LightGBM 调参字段覆盖）。
    # 老调用方（runner_entrypoint / CLI train）不传 extra_hyperparams，行为不变。
    # merge 在 model 分派**之前**完成：LSTM 路径拿到的 hyperparams 已含元字段
    # （label_scheme 等），照常落 ml.model_runs.hyperparams（spec 02 §2）。
    if extra_hyperparams:
        merged_hyperparams: dict[str, Any] = dict(hyperparams or {})
        merged_hyperparams.update(extra_hyperparams)
        hyperparams = merged_hyperparams

    if model == "lstm":
        # LSTM 走独立路径（分类任务 + torch 训练循环 + 序列输入），自带数据加载 +
        # 序列构造 + Purged Walk-Forward；不走下方 lgb 通路、不挂 lgb SHAP——分派
        # 在 SHAP 后置钩子之前 return，天然不触发（spec 02 §2）。
        from quant_pipeline.training.lstm_walk_forward import train_lstm_model

        # 被调入口声明 -> Any（自带训练循环，未细化返回类型）；运行时返回 TrainResult，cast 仅修类型
        return cast(
            TrainResult,
            train_lstm_model(
                feature_set_id=feature_set_id,
                seed=seed,
                job_id=job_id,
                hyperparams=hyperparams,
                walk_forward_params=walk_forward_params or {},
                progress_callback=_progress,
                today_yyyymmdd=today_yyyymmdd,
                insert_model_run=_insert_model_run,
                write_artifact=_write_artifact,
            ),
        )
    if model == "lgb-multiclass":
        # lgb-multiclass 走独立路径（多分类 + 自己的 walk-forward），完全绕开
        # ranking 的 compare_three；分派在 SHAP 后置钩子之前 return，天然不触发
        # lgb-lambdarank 的 SHAP（spec 03 §定位）。始终 walk-forward（无 single_fold）。
        from quant_pipeline.training.lgb_multiclass_walk_forward import (
            train_lgb_multiclass_model,
        )

        # 同上：被调入口声明 -> Any，运行时返回 TrainResult，cast 仅修类型不改值
        return cast(
            TrainResult,
            train_lgb_multiclass_model(
                feature_set_id=feature_set_id,
                seed=seed,
                job_id=job_id,
                hyperparams=hyperparams,
                walk_forward_params=walk_forward_params or {},
                progress_callback=_progress,
                today_yyyymmdd=today_yyyymmdd,
                insert_model_run=_insert_model_run,
                write_artifact=_write_artifact,
            ),
        )
    if model not in ("lgb-lambdarank",):
        raise ValueError(
            f"不支持的 model={model!r}（支持 lgb-lambdarank / lgb-multiclass / lstm）"
        )

    _progress(0, "train:start")

    # ---- 1. 数据加载 ----
    df = _load_feature_matrix(feature_set_id)
    df = df.sort_values(["trade_date", "ts_code"]).reset_index(drop=True)

    latest_trade_date = _latest_trade_date_from_features(df)
    gate_check(latest_trade_date, mode="training_pregate", strict=True, job_id=job_id)

    _progress(10, "train:data_loaded")

    X_all, feature_cols = _flatten_features(df)
    y_all = df["label"]
    valid_mask = y_all.notna()
    if int(valid_mask.sum()) < 20:
        raise ValueError(
            f"feature_set_id={feature_set_id} 有效样本数 {int(valid_mask.sum())} < 20，无法训练"
        )
    df_train = df.loc[valid_mask].reset_index(drop=True)
    X_all = X_all.loc[valid_mask].reset_index(drop=True)
    y_all = y_all.loc[valid_mask].reset_index(drop=True)

    # 标签保持原始连续值（不分桶）；LambdaRank 需要的整数 gain 由
    # compare_three / _train_single_fold 在 train_lambdarank 入口处单独做截面 rank。

    if walk_forward:
        from quant_pipeline.training.walk_forward_runner import train_walk_forward

        # 被调入口声明 -> Any，运行时返回 TrainResult；显式注解修类型不改值
        result: TrainResult = train_walk_forward(
            feature_set_id=feature_set_id,
            df_train=df_train,
            X_all=X_all,
            y_all=y_all,
            feature_cols=feature_cols,
            seed=seed,
            job_id=job_id,
            hyperparams=hyperparams,
            walk_forward_params=walk_forward_params or {},
            latest_trade_date=latest_trade_date,
            insert_model_run=_insert_model_run,
            write_artifact=_write_artifact,
            progress_callback=_progress,
            today_yyyymmdd=today_yyyymmdd,
        )
    else:
        from quant_pipeline.training.single_fold_runner import train_single_fold

        result = train_single_fold(
            feature_set_id=feature_set_id,
            df_train=df_train,
            X_all=X_all,
            y_all=y_all,
            feature_cols=feature_cols,
            seed=seed,
            job_id=job_id,
            hyperparams=hyperparams,
            latest_trade_date=latest_trade_date,
            insert_model_run=_insert_model_run,
            write_artifact=_write_artifact,
            progress_callback=_progress,
            today_yyyymmdd=today_yyyymmdd,
        )

    # M4 Part L 后置钩子：SHAP 解释（默认开；失败不阻塞主流程，写 quality_reports）
    if with_shap:
        try:
            from quant_pipeline.evaluation.shap_explainer import safely_explain_after_train

            safely_explain_after_train(
                result.model_run_id,
                trade_date=latest_trade_date,
                job_id=job_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "shap_post_train_hook_failed",
                extra={"model_run_id": str(result.model_run_id), "err": str(exc)},
            )

    return result


# ----------------------------------------------------------------------
# Dispatcher 入口
# ----------------------------------------------------------------------


def runner_entrypoint(job: Any) -> None:
    """供 worker.dispatcher 调用：从 job.params 解析参数后转 train_model。

    params schema（01-pg-schema §4.1）：
        {
            "feature_set_id": "fs_v1",
            "model": "lgb-lambdarank",          # optional, default lgb-lambdarank
            "walk_forward": true,               # optional, default true (M3)
            "seed": 42,                         # optional, default 42
            "hyperparams": {...},               # optional
            "walk_forward_params": {...}        # optional (n_folds / embargo_days / ...)
        }
    """

    params = getattr(job, "params", {}) or {}
    feature_set_id = params.get("feature_set_id")
    if not isinstance(feature_set_id, str) or not feature_set_id:
        raise ValueError(
            f"train job.params.feature_set_id 必须是非空字符串，got {feature_set_id!r}"
        )
    model = str(params.get("model", "lgb-lambdarank"))
    walk_forward = bool(params.get("walk_forward", True))
    seed = int(params.get("seed", 42))
    # M4 Part A：params.skip_shap=true 跳过 SHAP 后置钩子（用于 Optuna 快速 trial）
    with_shap = not bool(params.get("skip_shap", False))

    train_model(
        feature_set_id=feature_set_id,
        model=model,
        walk_forward=walk_forward,
        seed=seed,
        job_id=getattr(job, "id", None),
        hyperparams=params.get("hyperparams"),
        walk_forward_params=params.get("walk_forward_params"),
        with_shap=with_shap,
    )


# 兼容 M2 命名
train_one_fold = train_model

__all__ = [
    "ArtifactWriteError",
    "TrainResult",
    "train_model",
    "train_one_fold",
    "runner_entrypoint",
]
