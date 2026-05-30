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
>   - trial 内部跑**全部** PurgedWalkForwardSplit 折 + LightGBM LambdaRank（重用 M3 链路）
>   - objective 为各折 OOS NDCG@10 的均值（越大越好）

评审 04-#8 修正：原实现每个 trial 只取 `splits[-1]` 同一折，所有 trial 在同一固定
OOS 窗口比较，等价于在测试集上对超参 overfitting。改为每 trial 跑全部折取均值，
objective 才能反映泛化能力。代价：单 trial 耗时 ×n_folds，调参阶段建议
num_boost_round ≤ 200、n_trials 适度。

中断恢复测试：trial 50% 时 kill Python，重启后从断点继续（load_if_exists=True）。

搜索空间配置已拆分到 search_spaces.py。

────────────────────────────────────────────────────────────────────────
「调参集 = 评估集」乐观偏差 + holdout 缓解（本次改动）
────────────────────────────────────────────────────────────────────────
**方法论局限（务必如实告知消费者）**：04-#8 修正后，objective = 各 walk-forward
折 OOS NDCG@10 均值，这已是「样本外」均值。但 best_params 是在**这 n_folds 折**上
被 Optuna 挑选出来的，若下游又用**同一批折**报告 OOS（如 train_model 复用同样的
PurgedWalkForwardSplit），则「在评估集上调参」——best_value 对这批折系统性乐观。
这是搜参与评估同源的固有偏差，不是 bug，但必须标注，否则消费者会把
in-tuning OOS 当干净泛化指标。

**缓解（方案甲，holdout_n_folds > 0 时启用，默认 0 = 关闭，完全向后兼容）**：
按交易日把序列切成「调参区」+「embargo gap」+「最终 holdout 区」。Optuna 只在
**调参区**的 walk-forward 折上搜参；拿到 best_params 后，用调参区**全量**训练一个
模型，在**从未参与搜参**的 holdout 区评估真实 OOS（`holdout_metrics`）。

防泄漏：holdout 区严格在调参区之后，二者之间在原始全序列里至少隔 `embargo_days`
个交易日（标签视界 PIT）。holdout 区交易日**绝不**进入任何调参折的 train/test。

**回退（方案乙兜底）**：若切出 holdout 后调参区交易日数不足以让
PurgedWalkForwardSplit 跑动（min_train + embargo + n_folds），则**不抛错**，
回退到默认 in-tuning 路径，并照常标注 `optimistic_bias=True`。这样数据量不够的
小数据集仍可调参，只是拿不到干净 holdout（如实告知，不静默伪装）。

返回结果新增（不删改既有字段，向后兼容）：
  - objective_source: "in_tuning_oos" | "holdout_oos"
  - optimistic_bias:  bool（best_value 是否带搜参/评估同源偏差）
  - best_value_kind:  best_value 的语义标签
  - holdout_evaluated: bool
  - holdout_metrics:  dict | None（holdout 区真实 OOS，仅 holdout_oos 路径有）
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

from quant_pipeline.db.engine import session_scope
from quant_pipeline.evaluation.ranking_metrics import ndcg_at_k
from quant_pipeline.training.group_utils import build_groups, flatten_features
from quant_pipeline.training.lightgbm_lambdarank import (
    DEFAULT_HYPERPARAMS,
    DEFAULT_NUM_BOOST_ROUND,
    train_lambdarank,
)
from quant_pipeline.training.search_spaces import (
    SEARCH_SPACES,
    build_storage_url,
    build_study_name,
    suggest_hyperparams,
)
from quant_pipeline.training.walk_forward import PurgedWalkForwardSplit
from quant_pipeline.utils.paths import artifact_dir, artifact_uri, ensure_artifact_dir
from quant_pipeline.worker.progress import update_progress

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# 单 trial 内部训练（1 折 PurgedWalkForwardSplit）
# ----------------------------------------------------------------------


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
    df_clean: pd.DataFrame,
    X_clean: pd.DataFrame,
    y_clean: pd.Series,
    feature_cols: list[str],
    splits: list[tuple[np.ndarray, np.ndarray]],
    space_name: str,
    seed: int,
    num_boost_round: int,
) -> float:
    """单 trial 内部：跑**全部** walk-forward 折 → 各折 OOS NDCG@10 的均值。

    评审 04-#8：原实现只取 `splits[-1]` 一折，所有 trial 在同一固定 OOS 窗口比较，
    等价于在该窗口上对超参 overfitting，best_params 无泛化保证（「在测试集上调参」
    的变体）。改为每个 trial 跑全部折取均值，objective 才有泛化意义。

    评审 04-#9：`_flatten_features` / split 已在 `tune` 中只算一次后传入，
    不再每个 trial 重复展平。
    """

    hp_suggest = suggest_hyperparams(trial, space_name)

    # 合并默认 hp + suggested
    hp: dict[str, Any] = dict(DEFAULT_HYPERPARAMS)
    hp.update(hp_suggest)

    fold_ndcgs: list[float] = []
    n_train_total = 0
    n_test_total = 0
    for train_idx, test_idx in splits:
        X_train = X_clean.iloc[train_idx].reset_index(drop=True)
        y_train = y_clean.iloc[train_idx].reset_index(drop=True)
        df_train = df_clean.iloc[train_idx].reset_index(drop=True)
        groups_train = build_groups(df_train)
        # 标签保持连续；只在 train_lambdarank 入口处做截面 rank（评审 04-#1 口径）
        y_train_rank = _label_to_int_rank(df_train, y_train)

        X_test = X_clean.iloc[test_idx].reset_index(drop=True)
        y_test = y_clean.iloc[test_idx].reset_index(drop=True)
        df_test = df_clean.iloc[test_idx].reset_index(drop=True)
        groups_test = build_groups(df_test)

        booster = train_lambdarank(
            X_train,
            y_train_rank,
            groups_train,
            hyperparams=hp,
            seed=seed,
            num_boost_round=num_boost_round,
            early_stopping_rounds=None,
        )
        # 评审 05-#6：传 DataFrame 让 LightGBM 按列名校验列顺序
        scores = np.asarray(booster.predict(X_test), dtype=np.float64)
        # 评估用原始连续 label（ndcg_at_k 内部转有界整数 gain）
        ndcg10 = ndcg_at_k(scores, y_test.to_numpy(dtype=np.float64), groups_test, k=10)
        if not np.isnan(ndcg10):
            fold_ndcgs.append(float(ndcg10))
        n_train_total += int(len(X_train))
        n_test_total += int(len(X_test))

    # 把审计信息写到 trial.user_attrs
    trial.set_user_attr("feature_cols", feature_cols)
    trial.set_user_attr("n_folds", len(splits))
    trial.set_user_attr("n_train_total", n_train_total)
    trial.set_user_attr("n_test_total", n_test_total)

    if not fold_ndcgs:
        return float("nan")
    return float(np.mean(fold_ndcgs))


# ----------------------------------------------------------------------
# 方案甲：调参区 / holdout 区切分 + holdout 评估
# ----------------------------------------------------------------------


def _split_tuning_holdout_dates(
    unique_dates: list[str],
    *,
    holdout_n_folds: int,
    n_folds: int,
    embargo_days: int,
    min_train_days: int,
) -> tuple[list[str], list[str]] | None:
    """把升序交易日切成 (tuning_dates, holdout_dates)。

    语义：把「测试池」（`min_train_days + embargo_days` 之后的所有交易日）按 n_folds
    等分后，取末尾 `holdout_n_folds` 份划给独立 holdout，其余仍归调参区。这样 holdout
    正是原本会被当作评估的最后若干折，最贴近下游真实评估窗口。

    防泄漏：holdout 与调参区之间在原序列里再扣掉 `embargo_days` 个交易日做 gap，保证
    调参区任何样本与 holdout 第一日相隔 >= embargo。

    回退（返回 None）条件——任一不满足即视为数据不足，由调用方退回 in-tuning 路径：
      - holdout_n_folds 落在 [1, n_folds)（不能把全部折都划走）
      - 测试池能切出 >= holdout_n_folds 份且 holdout 非空
      - 扣掉 holdout + gap 后，调参区交易日数 >= PurgedWalkForwardSplit 跑动门槛
        （min_train_days + embargo_days + n_folds）
    """

    if holdout_n_folds < 1 or holdout_n_folds >= n_folds:
        return None

    n_total = len(unique_dates)
    test_pool_start = min_train_days + embargo_days
    test_pool_size = n_total - test_pool_start
    if test_pool_size < n_folds:
        return None
    fold_size = test_pool_size // n_folds
    if fold_size < 1:
        return None

    # holdout = 测试池末尾 holdout_n_folds 份（含最后一折吃掉的尾部余数）
    holdout_len = holdout_n_folds * fold_size
    holdout_start = n_total - holdout_len
    holdout_dates = unique_dates[holdout_start:]
    if not holdout_dates:
        return None

    # 调参区 = holdout 之前再扣掉 embargo_days 个交易日 gap（防泄漏）
    tuning_end_exclusive = holdout_start - embargo_days
    if tuning_end_exclusive < 1:
        return None
    tuning_dates = unique_dates[:tuning_end_exclusive]

    # 调参区必须够 PurgedWalkForwardSplit 跑动，否则回退
    min_needed = min_train_days + embargo_days + n_folds
    if len(tuning_dates) < min_needed:
        return None

    return tuning_dates, holdout_dates


def _evaluate_on_holdout(
    *,
    df_tuning: pd.DataFrame,
    df_holdout: pd.DataFrame,
    X_tuning: pd.DataFrame,
    X_holdout: pd.DataFrame,
    y_tuning: pd.Series,
    y_holdout: pd.Series,
    best_params: dict[str, Any],
    embargo_days: int,
    seed: int,
    num_boost_round: int,
) -> dict[str, Any]:
    """用 best_params 在**调参区全量**训练，于**独立 holdout 区**评估真实 OOS。

    口径与 `_objective_one_trial` 一致（train_lambdarank + ndcg_at_k，标签入口截面
    rank，评估用原始连续 label）。holdout 区从未参与 Optuna 搜参，故此处 NDCG 不带
    搜参/评估同源偏差。

    `embargo_days` 形参在此显式保留：调用方（split 阶段）已保证调参区与 holdout 之间
    隔 embargo gap，本函数不再二次切分，仅把该值原样记入返回 meta 供审计/测试断言。
    """

    hp: dict[str, Any] = dict(DEFAULT_HYPERPARAMS)
    hp.update(best_params)

    X_tr = X_tuning.reset_index(drop=True)
    y_tr = y_tuning.reset_index(drop=True)
    df_tr = df_tuning.reset_index(drop=True)
    groups_tr = build_groups(df_tr)
    y_tr_rank = _label_to_int_rank(df_tr, y_tr)

    X_ho = X_holdout.reset_index(drop=True)
    y_ho = y_holdout.reset_index(drop=True)
    df_ho = df_holdout.reset_index(drop=True)
    groups_ho = build_groups(df_ho)

    booster = train_lambdarank(
        X_tr,
        y_tr_rank,
        groups_tr,
        hyperparams=hp,
        seed=seed,
        num_boost_round=num_boost_round,
        early_stopping_rounds=None,
    )
    scores = np.asarray(booster.predict(X_ho), dtype=np.float64)
    ndcg10 = ndcg_at_k(scores, y_ho.to_numpy(dtype=np.float64), groups_ho, k=10)

    return {
        "ndcg@10": float(ndcg10) if not np.isnan(ndcg10) else None,
        "objective": "ndcg@10",
        "n_train": int(len(X_tr)),
        "n_holdout": int(len(X_ho)),
        "embargo_days": int(embargo_days),
        "kind": "holdout_oos_ndcg@10",
    }


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
    holdout_n_folds: int = 0,
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
        holdout_n_folds: >0 时启用方案甲——把交易日序列末尾对应 holdout_n_folds 折划为
            独立 holdout 评估区（与调参区留 embargo gap），Optuna 只在调参区搜参，
            best_params 在调参区全量训练后于 holdout 区报告**干净 OOS**。默认 0 = 关闭
            （完全向后兼容，仅返回 in-tuning OOS 并如实标注乐观偏差）。数据不足以切出
            合规 holdout 时自动回退到关闭路径（不抛错）。
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
            "best_value": float,                # 各折 in-tuning OOS NDCG@10 的均值
            "best_params": dict,
            "best_trial_number": int,
            "model_version": str | None,        # write_model_run=True 时写一条 ml.model_runs
            "model_run_id": str | None,
            # 乐观偏差 / holdout 标注（本次新增，向后兼容）：
            "objective_source": str,            # "in_tuning_oos" | "holdout_oos"
            "optimistic_bias": bool,            # best_value 是否搜参/评估同源乐观
            "best_value_kind": str,             # best_value 语义标签
            "holdout_evaluated": bool,
            "holdout_metrics": dict | None,     # holdout 区干净 OOS（holdout_oos 路径）
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

    # 评审 04-#9：特征展平 + walk-forward 切分只算一次，传给每个 trial 复用，
    # 不再每个 trial 重复 _flatten_features（n_trials=50 就展平 50 次）。
    X_all, feature_cols = flatten_features(df)
    y_all = df["label"]
    valid_mask = y_all.notna()
    df_clean = df.loc[valid_mask].reset_index(drop=True)
    X_clean = X_all.loc[valid_mask].reset_index(drop=True)
    y_clean = y_all.loc[valid_mask].reset_index(drop=True)

    # 方案甲：尝试切出独立 holdout 评估区（默认 holdout_n_folds=0 关闭）。
    # 切成功 → 调参只在「调参区」做，holdout 区保留供 best_params 干净 OOS 评估；
    # 切失败（数据不足）→ 回退到默认 in-tuning 路径（holdout_dates 为 None）。
    holdout_dates: list[str] | None = None
    df_tuning_full = df_clean
    X_tuning_full = X_clean
    y_tuning_full = y_clean
    if holdout_n_folds > 0:
        all_unique_dates = sorted(df_clean["trade_date"].astype(str).unique().tolist())
        split_res = _split_tuning_holdout_dates(
            all_unique_dates,
            holdout_n_folds=holdout_n_folds,
            n_folds=n_folds,
            embargo_days=embargo_days,
            min_train_days=min_train_days,
        )
        if split_res is None:
            logger.warning(
                "optuna_holdout_fallback_insufficient_data",
                extra={
                    "study_name": study_name,
                    "holdout_n_folds": holdout_n_folds,
                    "n_unique_dates": len(all_unique_dates),
                },
            )
        else:
            tuning_dates, holdout_dates = split_res
            td_arr = df_clean["trade_date"].astype(str).to_numpy()
            tuning_mask = np.isin(td_arr, tuning_dates)
            holdout_mask = np.isin(td_arr, holdout_dates)
            df_tuning_full = df_clean.loc[tuning_mask].reset_index(drop=True)
            X_tuning_full = X_clean.loc[tuning_mask].reset_index(drop=True)
            y_tuning_full = y_clean.loc[tuning_mask].reset_index(drop=True)
            df_holdout = df_clean.loc[holdout_mask].reset_index(drop=True)
            X_holdout = X_clean.loc[holdout_mask].reset_index(drop=True)
            y_holdout = y_clean.loc[holdout_mask].reset_index(drop=True)

    splitter = PurgedWalkForwardSplit(
        n_folds=n_folds,
        embargo_days=embargo_days,
        min_train_days=min_train_days,
    )
    splits = list(splitter.split(df_tuning_full))

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
            df_clean=df_tuning_full,
            X_clean=X_tuning_full,
            y_clean=y_tuning_full,
            feature_cols=feature_cols,
            splits=splits,
            space_name=space,
            seed=seed,
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
    # 评审 04-#18：用显式 None 判断而非 `or` 兜底（NDCG=0.0 是合法值，不该被兜底覆盖）
    best_value = float(best.value) if best.value is not None else 0.0

    result: dict[str, Any] = {
        "study_name": study_name,
        "n_trials_completed": int(n_completed),
        "best_value": best_value,
        "best_params": dict(best.params),
        "best_trial_number": int(best.number),
        "model_version": None,
        "model_run_id": None,
        # 默认：in-tuning OOS（搜参与评估同源，乐观偏差）。下面若 holdout 评估成功再升级。
        "objective_source": "in_tuning_oos",
        "optimistic_bias": True,
        "best_value_kind": "in_tuning_oos_ndcg@10",
        "holdout_evaluated": False,
        "holdout_metrics": None,
    }

    # 方案甲：holdout 切分成功 → 用 best_params 在调参区全量训练，于 holdout 区报告干净 OOS。
    if holdout_dates is not None:
        holdout_metrics = _evaluate_on_holdout(
            df_tuning=df_tuning_full,
            df_holdout=df_holdout,
            X_tuning=X_tuning_full,
            X_holdout=X_holdout,
            y_tuning=y_tuning_full,
            y_holdout=y_holdout,
            best_params=dict(best.params),
            embargo_days=embargo_days,
            seed=seed,
            num_boost_round=num_boost_round,
        )
        result["holdout_evaluated"] = True
        result["holdout_metrics"] = holdout_metrics
        # 干净 OOS 已拿到：objective_source 升级、去掉乐观偏差标注。best_value 仍是
        # in-tuning 均值（best_params 在这批折上被挑选），下游真实泛化看
        # holdout_metrics["ndcg@10"]。
        result["objective_source"] = "holdout_oos"
        result["optimistic_bias"] = False
        logger.info(
            "optuna_holdout_evaluated",
            extra={
                "study_name": study_name,
                "holdout_ndcg10": holdout_metrics.get("ndcg@10"),
                "in_tuning_best_value": best_value,
            },
        )

    if write_model_run:
        # 写一条 ml.model_runs（model_version 命名规范见交付清单）
        run_id, model_version = _write_best_trial_to_model_runs(
            feature_set_id=feature_set_id,
            best_value=best_value,
            best_params=dict(best.params),
            best_trial_number=int(best.number),
            study_name=study_name,
            parent_job_id=parent_job_id,
            today_yyyymmdd=today_yyyymmdd,
            objective_source=result["objective_source"],
            optimistic_bias=result["optimistic_bias"],
            holdout_metrics=result["holdout_metrics"],
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
            "best_value": best_value,
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
    objective_source: str = "in_tuning_oos",
    optimistic_bias: bool = True,
    holdout_metrics: dict[str, Any] | None = None,
) -> tuple[UUID, str]:
    """落一条 `lgb-lambdarank-optuna-v1-<YYYYMMDD>-trial<N>` 到 ml.model_runs。

    artifact 写一份 metadata（best_params + study_name），不写真实 model.txt
    （真正训练在调用方拿到 best_params 后用 train_model 跑）。

    oos_metrics 里如实标注 `objective_source` / `optimistic_bias`：默认
    in_tuning_oos（搜参与评估同源，乐观偏差）；holdout 路径会带 `holdout_metrics`
    （干净 OOS）。消费者据此区分乐观 best_value 与真实泛化指标。
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

    oos_metrics: dict[str, Any] = {
        "ndcg@10": best_value,
        "objective": "ndcg@10",
        "optuna_study_name": study_name,
        "optuna_best_trial": best_trial_number,
        # 乐观偏差如实标注：in_tuning 路径下 best_value 与下游评估同源，乐观。
        "objective_source": objective_source,
        "optimistic_bias": optimistic_bias,
        # best_value 始终是 in-tuning 各折 OOS 均值（即便 holdout 路径，干净指标在
        # holdout_metrics 里，不覆盖 best_value）。
        "best_value_kind": "in_tuning_oos_ndcg@10",
    }
    if holdout_metrics is not None:
        # 干净 holdout OOS（与搜参不同源），消费者优先用此判断真实泛化。
        oos_metrics["holdout_metrics"] = holdout_metrics
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
