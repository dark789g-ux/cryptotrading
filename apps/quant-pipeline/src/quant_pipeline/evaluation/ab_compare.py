"""三组对照（M3 评估层）。

> doc/量化/05-LightGBM训练体系.md §5.8 三组对照实验 + spec m3 §2：
> 在同一 Purged Walk-Forward 切分上跑：
>   1) linear（Ridge baseline）
>   2) gbdt-pointwise（LightGBM regression）
>   3) lightgbm-lambdarank（M2 已就位）
> 加 1 个衍生：
>   4) ensemble（前三者横截面 z-score + 等权平均）

输出对照表：
  {
    model_name: {
      ndcg_at_5_mean, ndcg_at_10_mean,
      ic_mean, rank_ic_mean,
      portfolio_annual_after_cost,
      fold_metrics: [{fold, ndcg@5, ndcg@10, ic, rank_ic, portfolio_annual_after_cost}, ...]
    }
  }

注意：本模块只做"已加载的 feature matrix → 模型对照"的纯函数，DB 写入由 runner 层负责。
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from typing import Any

import numpy as np
import pandas as pd

from quant_pipeline.evaluation.portfolio import (
    compute_portfolio_metrics,
    resolve_avg_hold_days,
)
from quant_pipeline.evaluation.ranking_metrics import (
    ic_pearson,
    ndcg_at_k,
    rank_ic_spearman,
)
from quant_pipeline.training.ensemble import ensemble_average
from quant_pipeline.training.gbdt_pointwise import (
    predict_gbdt_pointwise,
    train_gbdt_pointwise,
)
from quant_pipeline.training.lightgbm_lambdarank import train_lambdarank
from quant_pipeline.training.linear_baseline import (
    predict_linear,
    train_linear,
)

logger = logging.getLogger(__name__)


MODEL_NAMES = ["linear", "gbdt-pointwise", "lgb-lambdarank", "ensemble"]


def _build_groups(df: pd.DataFrame) -> np.ndarray:
    """以 trade_date 为 query group；返回每日样本数数组。"""

    return df.groupby("trade_date", sort=False).size().to_numpy().astype(np.int64)


def _label_to_cross_sectional_rank(
    df_meta: pd.DataFrame, y: pd.Series
) -> pd.Series:
    """LightGBM LambdaRank 要求 label 为非负整数 gain。

    把连续 label 按 trade_date 截面转为整数 rank（0..n-1，越大越好）。
    """

    df = pd.DataFrame({"td": df_meta["trade_date"].astype(str).to_numpy(), "y": y.to_numpy()})
    # 同日内按 y 升序 rank → 整数 0..n-1
    ranks = df.groupby("td", sort=False)["y"].rank(method="first").astype(int) - 1
    ranks.index = y.index
    return ranks


def _fold_predict_three(
    X_train: pd.DataFrame,
    y_train: pd.Series,
    y_train_rank: pd.Series,
    groups_train: np.ndarray,
    X_test: pd.DataFrame,
    y_test: pd.Series,
    groups_test: np.ndarray,
    *,
    seed: int,
    lgb_hyperparams: dict[str, Any] | None = None,
    lgb_num_boost_round: int = 100,
    lgb_early_stopping_rounds: int | None = None,
) -> dict[str, np.ndarray]:
    """对同一折数据训三个模型，返回 {model_name: test_predictions}。"""

    # 1) Linear
    linear_pred = train_linear(X_train, y_train, seed=seed)
    scores_linear = predict_linear(linear_pred, X_test)

    # 2) GBDT pointwise
    gbdt_booster = train_gbdt_pointwise(
        X_train,
        y_train,
        hyperparams=lgb_hyperparams,
        num_boost_round=lgb_num_boost_round,
        early_stopping_rounds=lgb_early_stopping_rounds,
        seed=seed,
    )
    scores_gbdt = predict_gbdt_pointwise(gbdt_booster, X_test)

    # 3) LightGBM LambdaRank（要求 label 为整数 gain → 用同日截面 rank）
    lambdarank_booster = train_lambdarank(
        X_train,
        y_train_rank,
        groups_train,
        hyperparams=lgb_hyperparams,
        num_boost_round=lgb_num_boost_round,
        early_stopping_rounds=lgb_early_stopping_rounds,
        seed=seed,
    )
    # 评审 05-#6：传 DataFrame 而非 .values，让 LightGBM 按列名校验顺序，
    # 与 inference 的列顺序契约一致（用 ndarray 时 LightGBM 不校验列序）。
    scores_lambdarank = np.asarray(lambdarank_booster.predict(X_test), dtype=np.float64)

    return {
        "linear": scores_linear,
        "gbdt-pointwise": scores_gbdt,
        "lgb-lambdarank": scores_lambdarank,
    }


def _evaluate_one_model(
    *,
    scores: np.ndarray,
    test_df: pd.DataFrame,
    y_test: pd.Series,
    groups_test: np.ndarray,
    top_k: int = 20,
    commission_rate: float = 0.0003,
    slippage_bps: float = 5.0,
    avg_hold_days: float | None = None,
) -> tuple[dict[str, float], pd.Series]:
    """单模单折评估：NDCG@5/10 + IC + RankIC + portfolio 单笔净收益中位数。

    Args:
        avg_hold_days: 透传给 compute_portfolio_metrics 的 Sharpe 年化持仓天数；
            None 表示沿用 portfolio 默认（10.0），保持向后兼容。

    Returns:
        (metrics_dict, portfolio_daily_returns)
        第二项是该折 portfolio 的逐笔 trade 净收益序列（评审 04-#6：供
        compare_three 直接拼出 ensemble daily returns，免去重训）。
    """

    labels = y_test.to_numpy(dtype=np.float64)
    ndcg5 = ndcg_at_k(scores, labels, groups_test, k=5)
    ndcg10 = ndcg_at_k(scores, labels, groups_test, k=10)
    ic = ic_pearson(scores, labels)
    rank_ic = rank_ic_spearman(scores, labels)

    # portfolio：scores → 同 trade_date 选 top_k → 用 label 结算
    scores_df = pd.DataFrame(
        {
            "trade_date": test_df["trade_date"].astype(str).to_numpy(),
            "ts_code": test_df["ts_code"].to_numpy(),
            "score": scores,
        }
    )
    label_df = pd.DataFrame(
        {
            "trade_date": test_df["trade_date"].astype(str).to_numpy(),
            "ts_code": test_df["ts_code"].to_numpy(),
            "label": labels,
        }
    )
    # avg_hold_days=None 时不传给 portfolio，沿用其默认 10.0（向后兼容）。
    portfolio_kwargs: dict[str, Any] = {
        "top_k": top_k,
        "commission_rate": commission_rate,
        "slippage_bps": slippage_bps,
    }
    if avg_hold_days is not None:
        portfolio_kwargs["avg_hold_days"] = avg_hold_days
    portfolio = compute_portfolio_metrics(scores_df, label_df, **portfolio_kwargs)

    metrics = {
        "ndcg@5": ndcg5,
        "ndcg@10": ndcg10,
        "ic": ic,
        "rank_ic": rank_ic,
        # 字段名 `portfolio_annual_after_cost` 暂留不改（避免 DB/server/前端连锁改动），
        # 其值现在是"逐笔多日 trade 净收益的中位数"（见 portfolio.py 文件头口径修正）。
        # 彻底重命名留待事件驱动持仓回测任务。
        "portfolio_annual_after_cost": float(portfolio["net_return_median"]),
        "sharpe": float(portfolio["sharpe"]) if not np.isnan(portfolio["sharpe"]) else float("nan"),
        # portfolio trade 笔数：report_generator 据此标注小样本 Sharpe 不可靠（评审 05-#9）
        "portfolio_n_trades": int(portfolio["n_days"]),
    }
    daily_returns = portfolio.get("daily_returns", pd.Series(dtype=float))
    if not isinstance(daily_returns, pd.Series):
        daily_returns = pd.Series(dtype=float)
    return metrics, daily_returns


def compare_three(
    df_features: pd.DataFrame,
    X_all: pd.DataFrame,
    y_all: pd.Series,
    splits: Iterator[tuple[np.ndarray, np.ndarray]],
    *,
    seed: int = 42,
    top_k: int = 20,
    commission_rate: float = 0.0003,
    slippage_bps: float = 5.0,
    label_scheme: str | None = None,
    lgb_hyperparams: dict[str, Any] | None = None,
    lgb_num_boost_round: int = 100,
    lgb_early_stopping_rounds: int | None = None,
    progress_callback: Any = None,
) -> dict[str, dict[str, Any]]:
    """跑三组对照 + 集成。

    Args:
        df_features: 含 [trade_date, ts_code] 用于 group / portfolio
        X_all:       特征矩阵（已展平 + 与 df_features 同序）
        y_all:       label Series
        splits:      Iterator of (train_idx, test_idx)（PurgedWalkForwardSplit.split 输出）
        seed:        随机种子
        top_k / commission_rate / slippage_bps: 转给 portfolio
        label_scheme: 当前 label 方案串（factors.labels.scheme，如 'strategy-aware'/
            'fwd_5d_ret'/'dir3_band'）。据此经 resolve_avg_hold_days 解析持仓视界，
            供 portfolio Sharpe 按实际持仓天数年化。**上游应按 label_scheme 传入**
            （walk_forward_runner 的 hyperparams 含 label_scheme）；None 时回退默认
            avg_hold_days=10.0，与改动前行为完全一致（100% 向后兼容）。
        progress_callback: 可选 (fold_idx, total_folds) → None；每折结束调一次

    Returns:
        {model_name: {ndcg_at_5_mean, ..., fold_metrics: [...]}, ...}

        其中 `summary["ensemble"]["daily_returns_combined"]` 额外携带 ensemble 在所有
        OOS 折上的逐笔 trade 净收益序列（pd.Series）。评审 04-#6：报告生成直接读它，
        不必再调 build_ensemble_daily_returns 重训三组模型。
    """

    if not {"trade_date", "ts_code"}.issubset(df_features.columns):
        raise ValueError("df_features 需含 trade_date / ts_code 列")
    if len(df_features) != len(X_all) or len(df_features) != len(y_all):
        raise ValueError("df_features / X_all / y_all 行数必须一致")

    # label_scheme → 平均持仓天数（Sharpe 年化）；None 回退默认 10.0（向后兼容）。
    avg_hold_days = resolve_avg_hold_days(label_scheme) if label_scheme is not None else None

    fold_results: dict[str, list[dict[str, float]]] = {name: [] for name in MODEL_NAMES}
    # 评审 04-#6：累积 ensemble 每折的 portfolio daily returns，免去事后重训
    ensemble_daily_chunks: list[pd.Series] = []
    splits_list = list(splits)
    total_folds = len(splits_list)
    if total_folds == 0:
        raise ValueError("splits 为空，无可评估的 fold")

    for fold_i, (train_idx, test_idx) in enumerate(splits_list):
        X_train = X_all.iloc[train_idx].reset_index(drop=True)
        y_train = y_all.iloc[train_idx].reset_index(drop=True)
        df_train_part = df_features.iloc[train_idx].reset_index(drop=True)
        groups_train = _build_groups(df_train_part)
        # LambdaRank 需要整数 gain label：按当日截面排名
        y_train_rank = _label_to_cross_sectional_rank(df_train_part, y_train)

        X_test = X_all.iloc[test_idx].reset_index(drop=True)
        y_test = y_all.iloc[test_idx].reset_index(drop=True)
        df_test_part = df_features.iloc[test_idx].reset_index(drop=True)
        groups_test = _build_groups(df_test_part)

        preds = _fold_predict_three(
            X_train, y_train, y_train_rank, groups_train,
            X_test, y_test, groups_test,
            seed=seed,
            lgb_hyperparams=lgb_hyperparams,
            lgb_num_boost_round=lgb_num_boost_round,
            lgb_early_stopping_rounds=lgb_early_stopping_rounds,
        )

        # Ensemble: 横截面 z-score + 等权
        test_trade_dates = df_test_part["trade_date"].astype(str).to_numpy()
        ensemble_scores = ensemble_average(preds, test_trade_dates)
        all_preds = dict(preds)
        all_preds["ensemble"] = ensemble_scores

        for name in MODEL_NAMES:
            metrics, daily_returns = _evaluate_one_model(
                scores=all_preds[name],
                test_df=df_test_part,
                y_test=y_test,
                groups_test=groups_test,
                top_k=top_k,
                commission_rate=commission_rate,
                slippage_bps=slippage_bps,
                avg_hold_days=avg_hold_days,
            )
            metrics["fold"] = fold_i
            fold_results[name].append(metrics)
            if name == "ensemble" and not daily_returns.empty:
                ensemble_daily_chunks.append(daily_returns)

        if progress_callback is not None:
            try:
                progress_callback(fold_i + 1, total_folds)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "progress_callback_failed", extra={"fold": fold_i, "error": str(exc)}
                )

    # 汇总：每个模型的均值
    summary: dict[str, dict[str, Any]] = {}
    for name, folds in fold_results.items():
        if not folds:
            continue
        summary[name] = {
            "ndcg_at_5_mean": _safe_mean([f["ndcg@5"] for f in folds]),
            "ndcg_at_10_mean": _safe_mean([f["ndcg@10"] for f in folds]),
            "ic_mean": _safe_mean([f["ic"] for f in folds]),
            "rank_ic_mean": _safe_mean([f["rank_ic"] for f in folds]),
            "portfolio_annual_after_cost": _safe_mean(
                [f["portfolio_annual_after_cost"] for f in folds]
            ),
            "sharpe_mean": _safe_mean([f["sharpe"] for f in folds]),
            "fold_metrics": folds,
            "n_folds": len(folds),
        }

    # 评审 04-#6：ensemble 在所有 OOS 折上的逐笔 trade 净收益（已合并、按入场日排序）。
    # 报告生成直接读此字段，免去 build_ensemble_daily_returns 重训三组模型。
    if "ensemble" in summary:
        if ensemble_daily_chunks:
            combined = pd.concat(ensemble_daily_chunks).sort_index()
        else:
            combined = pd.Series(dtype=float)
        summary["ensemble"]["daily_returns_combined"] = combined
    return summary


def _safe_mean(xs: list[float]) -> float:
    arr = np.asarray([x for x in xs if x is not None], dtype=np.float64)
    arr = arr[~np.isnan(arr)]
    if arr.size == 0:
        return float("nan")
    return float(arr.mean())


# ---------------------------------------------------------------------------
# run_ab_compare（CLI / runner 端到端入口）
# ---------------------------------------------------------------------------


def _filter_summary_to_baselines(
    summary: dict[str, dict[str, Any]],
    baselines: list[str],
) -> dict[str, dict[str, Any]]:
    """按调用方给的 baseline 名单 + ensemble 过滤 summary，输出新字典。

    任何不存在的 baseline 跳过（不抛 —— ab_compare 是评估通路，宁少勿错）；
    ensemble 始终保留（衍生模型，恒可计算）。
    """

    keep = set(baselines) | {"ensemble"}
    return {name: m for name, m in summary.items() if name in keep}


def run_ab_compare(
    feature_set_id: str,
    *,
    baselines: list[str] | tuple[str, ...] = ("linear", "gbdt-pointwise", "lgb-lambdarank"),
    model_run_id: str | None = None,
    model_version: str | None = None,
    output_dir: Any = None,
    n_folds: int = 6,
    embargo_days: int = 21,
    min_train_days: int = 252,
    top_k: int = 20,
    commission_rate: float = 0.0003,
    slippage_bps: float = 5.0,
    label_scheme: str | None = None,
    seed: int = 42,
    lgb_hyperparams: dict[str, Any] | None = None,
    lgb_num_boost_round: int = 100,
    lgb_early_stopping_rounds: int | None = None,
) -> dict[str, Any]:
    """三组对照 + 集成端到端：DB → Walk-Forward → 报告。

    使用场景：
      1) CLI `quant evaluate --run-id <uuid> --ab-baseline linear,gbdt`
      2) training.runner 内部走 walk_forward 时由 compare_three 直接调用（绕过 DB 加载）

    Args:
        feature_set_id: factors.feature_matrix.feature_set_id
        baselines: 输出报告时保留的 baseline 名（compare_three 总是跑全 3 + ensemble）
        model_run_id / model_version: 仅写入报告元数据；CLI evaluate 应传 run-id
        output_dir: 报告落地目录；默认 ./artifacts/<run_id>/（必须包含 model_run_id）
        label_scheme: 当前 label 方案串，透传给 compare_three 决定 Sharpe 年化的
            平均持仓天数；None 回退默认 10.0（向后兼容）。
        其它参数：透传给 PurgedWalkForwardSplit / compare_three / portfolio

    Returns:
        {
            "summary": {model_name: {ndcg_at_5_mean, ..., fold_metrics}, ...},
            "report_path": Path | None,
            "report_content": str | None,
        }

    Raises:
        ValueError: feature_set_id 不存在 / 数据不足以做 Purged Walk-Forward
    """

    # 延迟 import 防循环
    from quant_pipeline.evaluation.report_generator import generate_report
    from quant_pipeline.training.runner import _flatten_features, _load_feature_matrix
    from quant_pipeline.training.walk_forward import PurgedWalkForwardSplit

    df = _load_feature_matrix(feature_set_id)
    df = df.sort_values(["trade_date", "ts_code"]).reset_index(drop=True)
    X_all, _feature_cols = _flatten_features(df)
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

    summary = compare_three(
        df_clean,
        X_clean,
        y_clean,
        iter(splits),
        seed=seed,
        top_k=top_k,
        commission_rate=commission_rate,
        slippage_bps=slippage_bps,
        label_scheme=label_scheme,
        lgb_hyperparams=lgb_hyperparams,
        lgb_num_boost_round=lgb_num_boost_round,
        lgb_early_stopping_rounds=lgb_early_stopping_rounds,
    )

    # 按调用方要求过滤 baselines（ensemble 总保留）
    filtered_summary = _filter_summary_to_baselines(summary, list(baselines))

    report_path = None
    report_content: str | None = None
    if output_dir is None and model_run_id is not None:
        from quant_pipeline.utils.paths import artifact_dir as _adir

        output_dir = _adir(model_run_id)

    if output_dir is not None:
        report_run_id = model_run_id or "ab-compare"
        report_version = model_version or f"ab-compare-{feature_set_id}"
        from pathlib import Path as _Path

        out_path = _Path(output_dir)
        out_path.mkdir(parents=True, exist_ok=True)

        report_content, _uri = generate_report(
            model_run_id=report_run_id,
            model_version=report_version,
            feature_set_id=feature_set_id,
            hyperparams=lgb_hyperparams or {},
            walk_forward_params={
                "n_folds": n_folds,
                "embargo_days": embargo_days,
                "min_train_days": min_train_days,
            },
            compare_summary=filtered_summary,
            ensemble_daily_returns=None,
            output_dir=out_path,
        )
        report_path = out_path / "report.md"

    return {
        "summary": filtered_summary,
        "report_path": report_path,
        "report_content": report_content,
    }


__all__ = [
    "MODEL_NAMES",
    "compare_three",
    "run_ab_compare",
]
