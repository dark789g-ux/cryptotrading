"""LightGBM LambdaRank 训练函数（M2 Part B）。

参数按 spec m2-training-mvp.md Part B 给定值（与 doc/量化/05-LightGBM训练体系.md
§5.3 略有差异，spec 为准）：
    objective                    = "lambdarank"
    metric                       = "ndcg"
    ndcg_eval_at                 = [5, 10]
    lambdarank_truncation_level  = 10
    boosting_type                = "gbdt"
    n_estimators                 = 500            (num_boost_round)
    learning_rate                = 0.05
    num_leaves                   = 31
    max_depth                    = -1
    min_data_in_leaf             = 200
    feature_fraction             = 0.85
    bagging_fraction             = 0.85
    bagging_freq                 = 5
    early_stopping_rounds        = 50

反过拟合三件套（doc/05 §5.6）：
    1) 单调性约束：通过 `monotone_constraints: list[int] | None` 传入；列长必须 =
       特征列数。每个元素取值 ∈ {-1, 0, 1}。Factor 注册表的 monotonic 标记由
       上层 runner 翻译为列表后传入，M2 阶段允许全部传 0。
    2) 特征 / 样本比 ≥ 1:1000：训练前 logger.warn 不达标的情况，但不强制阻塞
    3) 早停：默认 50 轮验证集无提升停止；传 None 关闭（小样本 mock 测试用）

LambdaRank 输入语义：
- X：DataFrame，行=样本，列=特征；调用方负责保证特征列顺序稳定
- y：Series，与 X 对齐的相关性整数标签（建议为分桶后的 0..K）
- groups (group_sizes)：np.ndarray[int]，长度 = query group 数（每日一个 group）；
  每个元素 = 该 group 内样本数；**X 必须按 (trade_date, ...) 排序，groups 与之对齐**
- valid_data：可选 (X_valid, y_valid, groups_valid)；提供后启用早停

返回：训练好的 `lightgbm.Booster`，可独立用 `Booster.save_model` 写文本格式
（spec 硬约束：M2 验收要求 CLI 可独立加载，禁止 pickle / joblib）。
"""

from __future__ import annotations

import logging
from typing import Any

import lightgbm as lgb
import numpy as np
from pandas import DataFrame, Series

logger = logging.getLogger(__name__)


# ---- spec m2-training-mvp Part B 标准配置 ----
DEFAULT_HYPERPARAMS: dict[str, Any] = {
    # 1) 学习目标 / 评估
    "objective": "lambdarank",
    "metric": "ndcg",
    "ndcg_eval_at": [5, 10],
    "lambdarank_truncation_level": 10,
    # 2) Boosting / 树结构
    "boosting_type": "gbdt",
    "num_leaves": 31,
    "max_depth": -1,
    "min_data_in_leaf": 200,
    # 3) 优化器
    "learning_rate": 0.05,
    # 4) 随机性 / 防过拟合
    "feature_fraction": 0.85,
    "bagging_fraction": 0.85,
    "bagging_freq": 5,
    # 5) 系统
    "verbose": -1,
    "force_col_wise": True,
}

# spec：n_estimators=500（LightGBM 的 num_boost_round 入参）
DEFAULT_NUM_BOOST_ROUND = 500
DEFAULT_EARLY_STOPPING_ROUNDS = 50


def train_lambdarank(
    X: DataFrame,
    y: Series,
    group_sizes: np.ndarray,
    valid_data: tuple[DataFrame, Series, np.ndarray] | None = None,
    hyperparams: dict[str, Any] | None = None,
    *,
    monotone_constraints: list[int] | None = None,
    num_boost_round: int = DEFAULT_NUM_BOOST_ROUND,
    early_stopping_rounds: int | None = DEFAULT_EARLY_STOPPING_ROUNDS,
    seed: int = 42,
) -> lgb.Booster:
    """单次 LambdaRank 训练。

    Args:
        X / y / group_sizes:
            训练数据。**X 必须已按 query group 排序**（同一日所有样本相邻）；
            ``group_sizes`` 元素为各 group 大小，``sum(group_sizes) == len(X)``
        valid_data:
            可选 (X_valid, y_valid, group_sizes_valid)；传入即启用早停
        hyperparams:
            覆盖 DEFAULT_HYPERPARAMS 的字段；不传则全部使用默认
        monotone_constraints:
            长度 = 特征列数的 int 列表（{-1, 0, 1}）；M2 阶段 base.py 暂无 monotonic
            字段时一律全 0 由调用方构造
        num_boost_round:
            默认 500（spec Part B / doc/05 §5.3 / "n_estimators"）
        early_stopping_rounds:
            默认 50；传 None 关闭早停（无 valid_data 时自动忽略）
        seed:
            可复现 seed；同时写入 params['seed']

    Returns:
        lightgbm.Booster

    Raises:
        ValueError: 输入形状不一致 / groups 与样本数不匹配 / monotone 长度不对
    """

    # ---- 输入校验 ----
    if len(X) != len(y):
        raise ValueError(f"len(X)={len(X)} != len(y)={len(y)}")
    if int(np.sum(group_sizes)) != len(X):
        raise ValueError(
            f"sum(group_sizes)={int(np.sum(group_sizes))} != len(X)={len(X)}；"
            "LambdaRank 要求样本按 query group 连续排列，group_sizes 元素为各 group 大小"
        )

    n_features = X.shape[1]
    n_samples = len(X)

    # ---- 反过拟合：特征/样本比 1:1000 警告 ----
    if n_samples > 0 and n_features * 1000 > n_samples:
        logger.warning(
            "feature_sample_ratio_below_1to1000",
            extra={
                "n_features": n_features,
                "n_samples": n_samples,
                "ratio": f"1:{n_samples // max(n_features, 1)}",
            },
        )

    # ---- 合并 hyperparams ----
    params: dict[str, Any] = dict(DEFAULT_HYPERPARAMS)
    if hyperparams:
        params.update(hyperparams)
    params.setdefault("seed", seed)
    params.setdefault("deterministic", True)

    # ---- 单调性约束 ----
    if monotone_constraints is not None:
        if len(monotone_constraints) != n_features:
            raise ValueError(
                f"monotone_constraints 长度 {len(monotone_constraints)} != n_features {n_features}"
            )
        if any(c not in (-1, 0, 1) for c in monotone_constraints):
            raise ValueError("monotone_constraints 元素必须在 {-1, 0, 1}")
        params["monotone_constraints"] = list(monotone_constraints)

    # ---- 构造 Dataset ----
    feature_names = [str(c) for c in X.columns]
    train_set = lgb.Dataset(
        X.values,
        label=y.values,
        group=group_sizes,
        feature_name=feature_names,
        free_raw_data=False,
    )

    valid_sets: list[lgb.Dataset] = []
    valid_names: list[str] = []
    if valid_data is not None:
        eval_X, eval_y, eval_groups = valid_data
        if int(np.sum(eval_groups)) != len(eval_X):
            raise ValueError(
                f"sum(eval_groups)={int(np.sum(eval_groups))} != len(eval_X)={len(eval_X)}"
            )
        valid_set = lgb.Dataset(
            eval_X.values,
            label=eval_y.values,
            group=eval_groups,
            feature_name=feature_names,
            reference=train_set,
            free_raw_data=False,
        )
        valid_sets.append(valid_set)
        valid_names.append("valid")

    # ---- 回调：早停 + 静默 ----
    callbacks: list[Any] = []
    if early_stopping_rounds and valid_sets:
        callbacks.append(
            lgb.early_stopping(stopping_rounds=int(early_stopping_rounds), verbose=False)
        )
    callbacks.append(lgb.log_evaluation(period=0))

    booster = lgb.train(
        params=params,
        train_set=train_set,
        num_boost_round=int(num_boost_round),
        valid_sets=valid_sets if valid_sets else None,
        valid_names=valid_names if valid_names else None,
        callbacks=callbacks,
    )
    return booster


__all__ = [
    "DEFAULT_HYPERPARAMS",
    "DEFAULT_NUM_BOOST_ROUND",
    "DEFAULT_EARLY_STOPPING_ROUNDS",
    "train_lambdarank",
]
