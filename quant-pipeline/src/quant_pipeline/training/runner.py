"""training runner —— CLI / worker dispatcher 共用入口（M2 Part G）。

`train_model(feature_set_id, model='lgb-lambdarank', walk_forward=False, seed=42, job_id=None)`
顺序（与 spec 04 §1-2 + m2-training-mvp.md "训练前 quality 门禁" 对齐）：

  1. 训练前 quality 门禁：strict=True 调 quality.runner.run_checks(最近交易日)
     失败抛 QualityGateBlocked（dispatcher 接住转 status='blocked'）
  2. 从 factors.feature_matrix 按 feature_set_id 加载 features + label
  3. 按 (trade_date, ts_code) 升序排序；以 trade_date 为 query group
  4. 调用 SingleFoldSplit 取 70/30 切分（M3 接 Purged Walk-Forward）
  5. 调用 lightgbm_lambdarank.train_lambdarank 训练（带验证集 + 早停）
  6. 计算 OOS NDCG@10 + 简单 IC（Pearson）
  7. artifact 落盘：./artifacts/<model_run_id>/{model.txt, meta.json}
  8. 写 ml.model_runs（含 oos_metrics + artifact_uri）—— 任一失败回滚另一个
  9. 进度回写：0 → 25 → 50 → 75 → 100

artifact 写盘失败处理（spec 04 §1）：
  - ArtifactWriteError：清理半成品 + 抛 ValueError 让 dispatcher fail
  - model.txt 落库但 metrics 没写完是禁止态：先确保 metrics 计算成功，再写 model.txt，
    最后 INSERT model_runs；任一失败回滚另一个

model_version 命名（硬约束）：`lgb-lambdarank-v1-<YYYYMMDD>-seed<N>`
"""

from __future__ import annotations

import json
import logging
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import numpy as np
import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.quality.report import gate_check
from quant_pipeline.training.lightgbm_lambdarank import (
    DEFAULT_EARLY_STOPPING_ROUNDS,
    DEFAULT_HYPERPARAMS,
    DEFAULT_NUM_BOOST_ROUND,
    train_lambdarank,
)
from quant_pipeline.training.walk_forward import SingleFoldSplit
from quant_pipeline.utils.paths import (
    artifact_dir,
    artifact_uri,
    ensure_artifact_dir,
)
from quant_pipeline.worker.progress import update_progress

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


# ----------------------------------------------------------------------
# DB 访问
# ----------------------------------------------------------------------


def _load_feature_matrix(feature_set_id: str) -> pd.DataFrame:
    """从 factors.feature_matrix 拉某个 feature_set 的全量样本。

    返回 DataFrame：trade_date / ts_code / features:dict / label:float。
    调用方负责把 features 展平成列、按 (trade_date, ts_code) 排序。
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


def _build_groups(df: pd.DataFrame) -> np.ndarray:
    """以 trade_date 为 query group；返回每日样本数数组（顺序与 df 一致）。"""

    counts = df.groupby("trade_date", sort=False).size().to_numpy()
    return counts.astype(np.int64)


def _flatten_features(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    """把 features:dict 列展平为多列，返回 (X_df, feature_columns)。

    features 列各行 dict 的键应该一致（feature_sets.factor_ids 保证）；
    若不一致则按所有键的并集 + 缺失填 NaN。
    """

    if df.empty:
        return pd.DataFrame(), []
    feature_keys: list[str] = sorted(
        {k for row in df["features"] if isinstance(row, dict) for k in row.keys()}
    )
    if not feature_keys:
        raise ValueError("feature_matrix.features 为空，没有可训练的列")
    records = [
        {k: row.get(k, np.nan) if isinstance(row, dict) else np.nan for k in feature_keys}
        for row in df["features"]
    ]
    X = pd.DataFrame.from_records(records, columns=feature_keys)
    return X, feature_keys


# ----------------------------------------------------------------------
# 评估
# ----------------------------------------------------------------------


def _ndcg_at_k(scores: np.ndarray, labels: np.ndarray, groups: np.ndarray, k: int = 10) -> float:
    """简易 NDCG@K（按 group 平均）。

    实现：标签直接当作 gain（label >= 0）；DCG = sum( (2^gain - 1) / log2(i+2) )。
    标签为负值时裁剪为 0（避免 2^负 太大）。
    """

    if scores.shape != labels.shape:
        raise ValueError("scores/labels 形状不一致")
    if groups.sum() != len(scores):
        raise ValueError("groups 总和 != 样本数")

    ndcgs: list[float] = []
    offset = 0
    for g in groups:
        end = offset + int(g)
        s = scores[offset:end]
        y = np.clip(labels[offset:end], 0.0, None)  # 负值裁 0
        order = np.argsort(-s)
        gains = y[order][:k]
        ideal_order = np.argsort(-y)
        ideal_gains = y[ideal_order][:k]
        discounts = 1.0 / np.log2(np.arange(len(gains)) + 2)
        ideal_discounts = 1.0 / np.log2(np.arange(len(ideal_gains)) + 2)
        dcg = float(np.sum((np.power(2.0, gains) - 1.0) * discounts))
        idcg = float(np.sum((np.power(2.0, ideal_gains) - 1.0) * ideal_discounts))
        if idcg > 0:
            ndcgs.append(dcg / idcg)
        offset = end
    if not ndcgs:
        return float("nan")
    return float(np.mean(ndcgs))


def _pearson_ic(scores: np.ndarray, labels: np.ndarray) -> float:
    """全样本 Pearson IC（粗略指标，用于 sanity check）。"""

    s = pd.Series(scores)
    y = pd.Series(labels)
    if s.std() == 0 or y.std() == 0:
        return 0.0
    return float(s.corr(y))


def _spearman_rank_ic(scores: np.ndarray, labels: np.ndarray) -> float:
    """全样本 Spearman RankIC（doc/05 §5.7 因子层指标）。"""

    s = pd.Series(scores).rank()
    y = pd.Series(labels).rank()
    if s.std() == 0 or y.std() == 0:
        return 0.0
    return float(s.corr(y))


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
        # 清理半成品（spec 04 §1）
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
) -> None:
    """写 ml.model_runs；失败则由调用方清理 artifact 目录。"""

    sql = text(
        """
        INSERT INTO ml.model_runs
            (id, job_id, model_version, feature_set_id, hyperparams,
             oos_metrics, artifact_uri)
        VALUES
            (:id, :job_id, :model_version, :feature_set_id,
             CAST(:hyperparams AS jsonb), CAST(:oos_metrics AS jsonb), :artifact_uri)
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
            },
        )


# ----------------------------------------------------------------------
# 主入口
# ----------------------------------------------------------------------


def train_model(
    feature_set_id: str,
    model: str = "lgb-lambdarank",
    *,
    walk_forward: bool = False,
    seed: int = 42,
    job_id: UUID | None = None,
    hyperparams: dict[str, Any] | None = None,
) -> TrainResult:
    """完整训练通路。

    M2 仅支持 model='lgb-lambdarank' + walk_forward=False（SingleFoldSplit）。
    """

    if model != "lgb-lambdarank":
        raise ValueError(
            f"M2 只支持 model='lgb-lambdarank'，got {model!r}（其它后续里程碑接入）"
        )
    if walk_forward:
        # M2 单 fold；多 fold 留 M3
        logger.warning(
            "walk_forward_requested_but_m2_single_fold",
            extra={"feature_set_id": feature_set_id},
        )

    # 0% 起步
    if job_id is not None:
        update_progress(job_id, 0, stage="train:start")

    # ---- 1. 数据加载 ----
    df = _load_feature_matrix(feature_set_id)
    # 排序：(trade_date, ts_code) 升序 —— LambdaRank 必需
    df = df.sort_values(["trade_date", "ts_code"]).reset_index(drop=True)

    # 训练前必检（spec 04 §2 硬约束）：strict=True；任一 critical 抛 QualityGateBlocked
    # 由 dispatcher 接住 → status='blocked' + blocked_reason=<rule>
    latest_trade_date = _latest_trade_date_from_features(df)
    gate_check(latest_trade_date, mode="training_pregate", strict=True, job_id=job_id)

    if job_id is not None:
        update_progress(job_id, 25, stage="train:data_loaded")

    # 展平 features
    X_all, feature_cols = _flatten_features(df)
    y_all = df["label"]
    # 丢弃 label 为 NaN 的样本（停牌等）
    valid_mask = y_all.notna()
    if int(valid_mask.sum()) < 20:
        raise ValueError(
            f"feature_set_id={feature_set_id} 有效样本数 {int(valid_mask.sum())} < 20，无法训练"
        )
    df_train = df.loc[valid_mask].reset_index(drop=True)
    X_all = X_all.loc[valid_mask].reset_index(drop=True)
    y_all = y_all.loc[valid_mask].reset_index(drop=True)

    # ---- 2. 切分 ----
    splitter = SingleFoldSplit(train_ratio=0.7, embargo_days=0)
    (train_idx, test_idx) = next(splitter.split(df_train))

    X_train = X_all.iloc[train_idx].reset_index(drop=True)
    y_train = y_all.iloc[train_idx].reset_index(drop=True)
    df_train_part = df_train.iloc[train_idx].reset_index(drop=True)
    groups_train = _build_groups(df_train_part)

    X_test = X_all.iloc[test_idx].reset_index(drop=True)
    y_test = y_all.iloc[test_idx].reset_index(drop=True)
    df_test_part = df_train.iloc[test_idx].reset_index(drop=True)
    groups_test = _build_groups(df_test_part)

    # ---- 3. 训练 ----
    booster = train_lambdarank(
        X_train,
        y_train,
        groups_train,
        valid_data=(X_test, y_test, groups_test),
        hyperparams=hyperparams,
        seed=seed,
        early_stopping_rounds=DEFAULT_EARLY_STOPPING_ROUNDS,
        num_boost_round=DEFAULT_NUM_BOOST_ROUND,
    )

    if job_id is not None:
        update_progress(job_id, 50, stage="train:fit_done")

    # ---- 4. OOS 评估 ----
    scores_test = booster.predict(X_test.values)
    ndcg10 = _ndcg_at_k(scores_test, y_test.to_numpy(), groups_test, k=10)
    ndcg5 = _ndcg_at_k(scores_test, y_test.to_numpy(), groups_test, k=5)
    ic = _pearson_ic(scores_test, y_test.to_numpy())
    rank_ic = _spearman_rank_ic(scores_test, y_test.to_numpy())

    # oos_metrics schema 严格对齐 spec m2-training-mvp Part B 硬约束：
    # {ndcg@5, ndcg@10, ic, rank_ic, portfolio_annual_after_cost(M3), fold_metrics[]}
    oos_metrics: dict[str, Any] = {
        "ndcg@5": ndcg5,
        "ndcg@10": ndcg10,
        "ic": ic,
        "rank_ic": rank_ic,
        "portfolio_annual_after_cost": None,
        "fold_metrics": [
            {"fold": 0, "ndcg@10": ndcg10, "ndcg@5": ndcg5, "ic": ic, "rank_ic": rank_ic}
        ],
        "n_train": int(len(X_train)),
        "n_test": int(len(X_test)),
        "n_test_groups": int(len(groups_test)),
    }

    if job_id is not None:
        update_progress(job_id, 75, stage="train:eval_done")

    # ---- 5. 命名 + artifact 落盘 ----
    run_id = uuid4()
    today_yyyymmdd = datetime.now(timezone.utc).strftime("%Y%m%d")
    model_version = f"lgb-lambdarank-v1-{today_yyyymmdd}-seed{seed}"

    used_hp: dict[str, Any] = dict(DEFAULT_HYPERPARAMS)
    if hyperparams:
        used_hp.update(hyperparams)
    used_hp["num_boost_round"] = DEFAULT_NUM_BOOST_ROUND
    used_hp["best_iteration"] = int(booster.best_iteration or booster.current_iteration())
    used_hp["seed"] = seed

    # 训练 / 验证集所用的交易日列表（meta 必填，spec Part B 硬约束）
    train_dates_used = sorted(
        df_train_part["trade_date"].astype(str).unique().tolist()
    )
    valid_dates_used = sorted(
        df_test_part["trade_date"].astype(str).unique().tolist()
    )

    meta = {
        "model_run_id": str(run_id),
        "model_version": model_version,
        "feature_set_id": feature_set_id,
        # `feature_columns` 兼容旧字段；`feature_columns_order` 是 spec Part B 推理时
        # 必读的列顺序契约，inference.runner 据此对齐预测输入。
        "feature_columns": feature_cols,
        "feature_columns_order": feature_cols,
        "factor_ids": feature_cols,
        "hyperparams": used_hp,
        "oos_metrics": oos_metrics,
        "trained_at_utc": datetime.now(timezone.utc).isoformat(),
        "latest_train_date": latest_trade_date,
        "train_dates": train_dates_used,
        "valid_dates": valid_dates_used,
        "seed": seed,
    }

    model_uri, _meta_uri = _write_artifact(run_id, booster, meta)

    # ---- 6. 写 ml.model_runs（落盘成功后才写库；写库失败回滚 artifact）----
    try:
        _insert_model_run(
            run_id,
            job_id=job_id,
            model_version=model_version,
            feature_set_id=feature_set_id,
            hyperparams=used_hp,
            oos_metrics=oos_metrics,
            artifact_uri_str=model_uri,
        )
    except Exception:
        # 回滚 artifact（保持"任一失败回滚另一个"的不变量）
        try:
            shutil.rmtree(artifact_dir(run_id), ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass
        raise

    if job_id is not None:
        update_progress(job_id, 100, stage="train:done")

    logger.info(
        "train_done",
        extra={
            "model_run_id": str(run_id),
            "model_version": model_version,
            "ndcg@10": ndcg10,
            "ic": ic,
            "n_train": int(len(X_train)),
            "n_test": int(len(X_test)),
        },
    )

    return TrainResult(
        model_run_id=run_id,
        model_version=model_version,
        artifact_uri=model_uri,
        oos_metrics=oos_metrics,
    )


# ----------------------------------------------------------------------
# Dispatcher 入口
# ----------------------------------------------------------------------


def runner_entrypoint(job: Any) -> None:
    """供 worker.dispatcher 调用：从 job.params 解析参数后转 train_model。

    params schema（01-pg-schema §4.1）：
        {
            "feature_set_id": "fs_v1",
            "model": "lgb-lambdarank",          # optional, default lgb-lambdarank
            "walk_forward": false,              # optional, default false
            "seed": 42                          # optional, default 42
        }
    """

    params = getattr(job, "params", {}) or {}
    feature_set_id = params.get("feature_set_id")
    if not isinstance(feature_set_id, str) or not feature_set_id:
        raise ValueError(
            f"train job.params.feature_set_id 必须是非空字符串，got {feature_set_id!r}"
        )
    model = str(params.get("model", "lgb-lambdarank"))
    walk_forward = bool(params.get("walk_forward", False))
    seed = int(params.get("seed", 42))

    train_model(
        feature_set_id=feature_set_id,
        model=model,
        walk_forward=walk_forward,
        seed=seed,
        job_id=getattr(job, "id", None),
        hyperparams=params.get("hyperparams"),
    )


# spec Part B 明确入口名称 `train_one_fold`；本里程碑实际就是单 fold，故为同名
# 别名，保留 train_model 旧名兼容既有调用方。
train_one_fold = train_model

__all__ = [
    "ArtifactWriteError",
    "TrainResult",
    "train_model",
    "train_one_fold",
    "runner_entrypoint",
]
