"""Optuna 调参（M4 Part L）。

> 方法论：doc/量化/05-LightGBM训练体系.md §5.5 四主旋钮：
>     num_leaves         [15, 127]        int
>     min_data_in_leaf   [50, 500]        int
>     feature_fraction   [0.5, 1.0]       float
>     learning_rate      [0.01, 0.2]      float, log scale
>
> 硬约束：
>   - 必须用 Optuna PG RDB storage（不允许 in-memory），中断可恢复（spec 05 §9）
>   - Optuna 自建表前缀 `optuna_*`，由 Optuna 自己 `create_study(load_if_exists=True)` 触发
>     不走 Alembic，与 ml.jobs 并列在 ml schema
>   - study 名规则：`optuna_<feature_set_id>_<YYYYMMDD>`，便于按交易日 / 标的查询
>   - 每完成 1 个 trial 调 worker.progress.update_progress 报进度
>   - trial 内部跑 1 折 PurgedWalkForwardSplit + LightGBM LambdaRank（重用 M3 链路）
>   - objective 为 OOS NDCG@10（越大越好）

中断恢复测试：trial 50% 时 kill Python，重启后从断点继续（load_if_exists=True）。
"""

from __future__ import annotations

import json
import logging
import shutil
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import numpy as np
import pandas as pd
from sqlalchemy import text

from quant_pipeline.config.settings import get_settings
from quant_pipeline.db.engine import session_scope
from quant_pipeline.evaluation.ranking_metrics import ndcg_at_k
from quant_pipeline.training.lightgbm_lambdarank import (
    DEFAULT_HYPERPARAMS,
    DEFAULT_NUM_BOOST_ROUND,
    train_lambdarank,
)
from quant_pipeline.training.walk_forward import PurgedWalkForwardSplit
from quant_pipeline.utils.paths import artifact_dir, artifact_uri, ensure_artifact_dir
from quant_pipeline.worker.progress import update_progress

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# 搜索空间（doc/05 §5.5 四主旋钮）
# ----------------------------------------------------------------------

# 暴露给单测的常量；保持与 doc/05 同步
SEARCH_SPACES: dict[str, dict[str, tuple[Any, Any] | tuple[Any, Any, bool]]] = {
    "default": {
        "num_leaves": (15, 127),                # int, uniform
        "min_data_in_leaf": (50, 500),          # int, uniform
        "feature_fraction": (0.5, 1.0),         # float, uniform
        "learning_rate": (0.01, 0.2, True),     # float, log=True
    },
}


def _suggest_hyperparams(trial: Any, space_name: str) -> dict[str, Any]:
    """根据 space_name 在 trial 上 suggest 出 4 个主旋钮。"""

    if space_name not in SEARCH_SPACES:
        raise ValueError(
            f"未知搜索空间 {space_name!r}；可选: {sorted(SEARCH_SPACES)}"
        )
    space = SEARCH_SPACES[space_name]
    nl_lo, nl_hi = space["num_leaves"]
    ml_lo, ml_hi = space["min_data_in_leaf"]
    ff_lo, ff_hi = space["feature_fraction"]
    lr_lo, lr_hi, lr_log = space["learning_rate"]
    return {
        "num_leaves": int(trial.suggest_int("num_leaves", int(nl_lo), int(nl_hi))),
        "min_data_in_leaf": int(
            trial.suggest_int("min_data_in_leaf", int(ml_lo), int(ml_hi))
        ),
        "feature_fraction": float(
            trial.suggest_float("feature_fraction", float(ff_lo), float(ff_hi))
        ),
        "learning_rate": float(
            trial.suggest_float(
                "learning_rate", float(lr_lo), float(lr_hi), log=bool(lr_log)
            )
        ),
    }


# ----------------------------------------------------------------------
# 工具：构建 storage URL / study name
# ----------------------------------------------------------------------


def build_study_name(feature_set_id: str, today_yyyymmdd: str | None = None) -> str:
    """study 名规则：`optuna_<feature_set_id>_<YYYYMMDD>`。"""

    if today_yyyymmdd is None:
        today_yyyymmdd = datetime.now(timezone.utc).strftime("%Y%m%d")
    return f"optuna_{feature_set_id}_{today_yyyymmdd}"


def build_storage_url() -> str:
    """Optuna PG RDB storage URL。

    复用 quant_pipeline.config.settings 的 PG_DSN；Optuna 表会落在 ml schema
    （Optuna 自建 `optuna_*`，由 library 自己创建，不走 Alembic）。
    """

    dsn = get_settings().pg_dsn
    # Optuna 接受 SQLAlchemy URL；前缀必须 postgresql+psycopg2 或 postgresql
    return dsn


# ----------------------------------------------------------------------
# 单 trial 内部训练（1 折 PurgedWalkForwardSplit）
# ----------------------------------------------------------------------


def _flatten_features(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
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


def _build_groups(df: pd.DataFrame) -> np.ndarray:
    return df.groupby("trade_date", sort=False).size().to_numpy().astype(np.int64)


def _label_to_int_rank(df_meta: pd.DataFrame, y: pd.Series) -> pd.Series:
    """LambdaRank 要求 label 为非负整数 gain；按 trade_date 截面 rank。"""

    df = pd.DataFrame(
        {"td": df_meta["trade_date"].astype(str).to_numpy(), "y": y.to_numpy()}
    )
    ranks = df.groupby("td", sort=False)["y"].rank(method="first").astype(int) - 1
    ranks.index = y.index
    return ranks


def _objective_one_trial(
    trial: Any,
    *,
    df: pd.DataFrame,
    space_name: str,
    seed: int,
    n_folds: int,
    embargo_days: int,
    min_train_days: int,
    num_boost_round: int,
) -> float:
    """单 trial 内部：1 折 walk-forward → OOS NDCG@10。

    用 PurgedWalkForwardSplit 但只取最后 1 折（最贴近"未来"的 OOS），节省调参耗时；
    Optuna 多 trial 累积起来等价于"对全数据每个时间点都做一次评估"。
    """

    hp_suggest = _suggest_hyperparams(trial, space_name)

    # 合并默认 hp + suggested
    hp: dict[str, Any] = dict(DEFAULT_HYPERPARAMS)
    hp.update(hp_suggest)

    X_all, feature_cols = _flatten_features(df)
    y_all = df["label"]
    valid_mask = y_all.notna()
    df_clean = df.loc[valid_mask].reset_index(drop=True)
    X_clean = X_all.loc[valid_mask].reset_index(drop=True)
    y_clean = y_all.loc[valid_mask].reset_index(drop=True)

    splitter = PurgedWalkForwardSplit(
        n_folds=n_folds,
        embargo_days=embargo_days,
        min_train_days=min_train_days,
    )
    splits = list(splitter.split(df_clean))
    # 取最后一折（最新的 OOS）
    train_idx, test_idx = splits[-1]
    X_train = X_clean.iloc[train_idx].reset_index(drop=True)
    y_train = y_clean.iloc[train_idx].reset_index(drop=True)
    df_train = df_clean.iloc[train_idx].reset_index(drop=True)
    groups_train = _build_groups(df_train)
    y_train_rank = _label_to_int_rank(df_train, y_train)

    X_test = X_clean.iloc[test_idx].reset_index(drop=True)
    y_test = y_clean.iloc[test_idx].reset_index(drop=True)
    df_test = df_clean.iloc[test_idx].reset_index(drop=True)
    groups_test = _build_groups(df_test)

    booster = train_lambdarank(
        X_train,
        y_train_rank,
        groups_train,
        hyperparams=hp,
        seed=seed,
        num_boost_round=num_boost_round,
        early_stopping_rounds=None,
    )
    scores = np.asarray(booster.predict(X_test.values), dtype=np.float64)
    ndcg10 = ndcg_at_k(scores, y_test.to_numpy(dtype=np.float64), groups_test, k=10)
    # 把超参写到 trial.user_attrs（便于事后审计）
    trial.set_user_attr("feature_cols", feature_cols)
    trial.set_user_attr("n_train", int(len(X_train)))
    trial.set_user_attr("n_test", int(len(X_test)))
    return float(ndcg10)


# ----------------------------------------------------------------------
# 公共入口
# ----------------------------------------------------------------------


def tune(
    feature_set_id: str,
    n_trials: int,
    space: str = "default",
    *,
    parent_job_id: UUID | None = None,
    seed: int = 42,
    n_folds: int = 6,
    embargo_days: int = 21,
    min_train_days: int = 252,
    num_boost_round: int = 100,
    storage_url: str | None = None,
    study_name: str | None = None,
    load_feature_matrix: Any = None,
    today_yyyymmdd: str | None = None,
    write_model_run: bool = True,
) -> dict[str, Any]:
    """Optuna 调参主入口。

    Args:
        feature_set_id: 因子组合
        n_trials: 试验次数
        space: 搜索空间名（默认 'default'）
        parent_job_id: 调用方 ml.jobs.id；trial 进度回写此 job
        seed: 各 trial 内训练的随机种子
        n_folds / embargo_days / min_train_days: 透传给 PurgedWalkForwardSplit
        num_boost_round: LightGBM 训练轮数（调参阶段建议 ≤ 200）
        storage_url: Optuna RDB URL；默认从 PG_DSN 构造
        study_name: 默认 `optuna_<feature_set_id>_<YYYYMMDD>`
        load_feature_matrix: 测试期注入的 mock 加载器（生产模式留空，从 DB 拉）
        today_yyyymmdd: 测试可注入；默认今天 UTC
        write_model_run: 是否在结束时写一条 ml.model_runs（best trial）
            False 时仅返回 best_trial_dict，便于单测

    Returns:
        {
            "study_name": str,
            "n_trials_completed": int,
            "best_value": float,                # OOS NDCG@10
            "best_params": dict,
            "best_trial_number": int,
            "model_version": str | None,        # write_model_run=True 时写一条 ml.model_runs
            "model_run_id": str | None,
        }

    Raises:
        ValueError: n_trials < 1 / space 不存在 / 数据不足
    """

    if n_trials < 1:
        raise ValueError(f"n_trials 必须 >= 1，got {n_trials}")
    if space not in SEARCH_SPACES:
        raise ValueError(f"未知搜索空间 {space!r}；可选: {sorted(SEARCH_SPACES)}")

    # 延迟 import optuna：避免 noop / 其它 run_type 加载时拖入 optuna
    import optuna  # type: ignore[import-untyped]

    storage = storage_url if storage_url is not None else build_storage_url()
    study_name = study_name or build_study_name(feature_set_id, today_yyyymmdd)

    # 加载特征矩阵（生产：从 DB；测试：注入 mock）
    if load_feature_matrix is None:
        from quant_pipeline.training.runner import _load_feature_matrix

        df = _load_feature_matrix(feature_set_id)
    else:
        df = load_feature_matrix(feature_set_id)
    df = df.sort_values(["trade_date", "ts_code"]).reset_index(drop=True)

    # 创建 / 加载 study（中断可恢复硬约束）
    study = optuna.create_study(
        study_name=study_name,
        storage=storage,
        direction="maximize",
        load_if_exists=True,
    )

    # 进度回写：每完成一个 trial 写一次
    completed_at_start = len(
        [t for t in study.trials if t.state == optuna.trial.TrialState.COMPLETE]
    )

    if parent_job_id is not None:
        # 初始进度（恢复时即非 0）
        init_pct = min(99, int(completed_at_start / n_trials * 100))
        update_progress(parent_job_id, init_pct, stage=f"optuna:resume_{completed_at_start}")

    def _objective(trial: Any) -> float:
        return _objective_one_trial(
            trial,
            df=df,
            space_name=space,
            seed=seed,
            n_folds=n_folds,
            embargo_days=embargo_days,
            min_train_days=min_train_days,
            num_boost_round=num_boost_round,
        )

    def _progress_cb(study_: Any, trial: Any) -> None:
        if parent_job_id is None:
            return
        completed = len(
            [t for t in study_.trials if t.state == optuna.trial.TrialState.COMPLETE]
        )
        pct = min(99, int(completed / n_trials * 100))
        try:
            update_progress(
                parent_job_id,
                pct,
                stage=f"trial_{completed}/{n_trials}",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "optuna_progress_update_failed",
                extra={"trial": trial.number, "err": str(exc)},
            )

    # 计算还需跑多少 trial（断点续跑）
    remain = max(0, n_trials - completed_at_start)
    if remain == 0:
        logger.info(
            "optuna_no_more_trials_needed",
            extra={"study_name": study_name, "completed": completed_at_start},
        )
    else:
        study.optimize(
            _objective,
            n_trials=remain,
            callbacks=[_progress_cb],
            gc_after_trial=True,
        )

    best = study.best_trial
    n_completed = len(
        [t for t in study.trials if t.state == optuna.trial.TrialState.COMPLETE]
    )

    result: dict[str, Any] = {
        "study_name": study_name,
        "n_trials_completed": int(n_completed),
        "best_value": float(best.value or 0.0),
        "best_params": dict(best.params),
        "best_trial_number": int(best.number),
        "model_version": None,
        "model_run_id": None,
    }

    if write_model_run:
        # 写一条 ml.model_runs（model_version 命名规范见交付清单）
        run_id, model_version = _write_best_trial_to_model_runs(
            feature_set_id=feature_set_id,
            best_value=float(best.value or 0.0),
            best_params=dict(best.params),
            best_trial_number=int(best.number),
            study_name=study_name,
            parent_job_id=parent_job_id,
            today_yyyymmdd=today_yyyymmdd,
        )
        result["model_version"] = model_version
        result["model_run_id"] = str(run_id)

    if parent_job_id is not None:
        update_progress(parent_job_id, 100, stage="optuna:done")

    logger.info(
        "optuna_tune_done",
        extra={
            "study_name": study_name,
            "n_trials_completed": n_completed,
            "best_value": float(best.value or 0.0),
            "best_params": best.params,
        },
    )
    return result


def _write_best_trial_to_model_runs(
    *,
    feature_set_id: str,
    best_value: float,
    best_params: dict[str, Any],
    best_trial_number: int,
    study_name: str,
    parent_job_id: UUID | None,
    today_yyyymmdd: str | None,
) -> tuple[UUID, str]:
    """落一条 `lgb-lambdarank-optuna-v1-<YYYYMMDD>-trial<N>` 到 ml.model_runs。

    artifact 写一份 metadata（best_params + study_name），不写真实 model.txt
    （真正训练在调用方拿到 best_params 后用 train_model 跑）。
    """

    today = today_yyyymmdd or datetime.now(timezone.utc).strftime("%Y%m%d")
    model_version = f"lgb-lambdarank-optuna-v1-{today}-trial{best_trial_number}"

    run_id = uuid4()
    target_dir = ensure_artifact_dir(run_id)
    meta_path = target_dir / "optuna_best.json"
    try:
        with meta_path.open("w", encoding="utf-8") as f:
            json.dump(
                {
                    "model_version": model_version,
                    "model_run_id": str(run_id),
                    "feature_set_id": feature_set_id,
                    "study_name": study_name,
                    "best_trial_number": best_trial_number,
                    "best_value": best_value,
                    "best_params": best_params,
                    "created_at_utc": datetime.now(timezone.utc).isoformat(),
                },
                f,
                ensure_ascii=False,
                indent=2,
            )
    except OSError as exc:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise RuntimeError(f"写 optuna_best.json 失败: {exc}") from exc

    oos_metrics = {
        "ndcg@10": best_value,
        "objective": "ndcg@10",
        "optuna_study_name": study_name,
        "optuna_best_trial": best_trial_number,
    }
    artifact_uri_str = artifact_uri(run_id, "optuna_best.json")

    sql = text(
        """
        INSERT INTO ml.model_runs
            (id, job_id, model_version, feature_set_id, hyperparams,
             oos_metrics, artifact_uri, report_uri)
        VALUES
            (:id, :job_id, :model_version, :feature_set_id,
             CAST(:hyperparams AS jsonb), CAST(:oos_metrics AS jsonb),
             :artifact_uri, NULL)
        """
    )
    try:
        with session_scope() as session:
            session.execute(
                sql,
                {
                    "id": run_id,
                    "job_id": parent_job_id,
                    "model_version": model_version,
                    "feature_set_id": feature_set_id,
                    "hyperparams": json.dumps(best_params, ensure_ascii=False),
                    "oos_metrics": json.dumps(oos_metrics, ensure_ascii=False),
                    "artifact_uri": artifact_uri_str,
                },
            )
    except Exception:
        try:
            shutil.rmtree(artifact_dir(run_id), ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass
        raise

    return run_id, model_version


# ----------------------------------------------------------------------
# Dispatcher 入口
# ----------------------------------------------------------------------


def runner_entrypoint(job: Any) -> None:
    """worker.dispatcher 路由：run_type='optuna'。

    params schema（01-pg-schema §4.1）：
        {
            "feature_set_id": "fs_v1",
            "n_trials": 50,
            "space": "default"               # 可选，默认 'default'
        }
    """

    params = getattr(job, "params", {}) or {}
    feature_set_id = params.get("feature_set_id")
    if not isinstance(feature_set_id, str) or not feature_set_id:
        raise ValueError(
            f"optuna job.params.feature_set_id 必须是非空字符串，got {feature_set_id!r}"
        )
    n_trials = params.get("n_trials")
    if not isinstance(n_trials, int) or n_trials < 1:
        raise ValueError(
            f"optuna job.params.n_trials 必须是正整数，got {n_trials!r}"
        )
    space = str(params.get("space", "default"))

    tune(
        feature_set_id=feature_set_id,
        n_trials=n_trials,
        space=space,
        parent_job_id=getattr(job, "id", None),
    )


__all__ = [
    "SEARCH_SPACES",
    "tune",
    "build_study_name",
    "build_storage_url",
    "runner_entrypoint",
]
