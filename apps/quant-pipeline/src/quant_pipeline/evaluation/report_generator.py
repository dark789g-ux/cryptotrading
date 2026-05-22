"""自动报告生成（M3 评估层）。

> spec m3 §6：
>   入口：generate_report(model_run_id, output_path) -> str (markdown content)
>   落到 ./artifacts/<model_run_id>/report.md + daily_returns.csv
>   写 ml.model_runs.report_uri
>   M3 不渲染 PNG

内容：
  1) 元数据（model_version / feature_set_id / hyperparams / walk_forward 参数）
  2) 三组对照表（Markdown table）
  3) 每折指标表（每个模型一段）
  4) 简单 portfolio 曲线（指引读 daily_returns.csv）
  5) 排查建议（哪些指标偏离 doc/05 期望区间）
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import pandas as pd

from quant_pipeline.utils.paths import artifact_dir, artifact_uri

logger = logging.getLogger(__name__)


# doc/量化/05-LightGBM训练体系.md §5.7 三层评估指标的期望区间（A 股基准）
# 注：portfolio_annual_after_cost 字段在止血后承载的是"单笔净收益中位数"（非年化），
# 期望区间相应调整为 > 0（详见 evaluation/portfolio.py 文件头）。
_EXPECTED_RANGES = {
    "rank_ic": (0.04, None, "因子层 RankIC mean > 0.04"),
    "ndcg@10": (0.50, None, "NDCG@10 通常应 > 0.50"),
    "portfolio_annual_after_cost": (0.0, None, "单笔净收益中位数应 > 0"),
}

# Sharpe 可靠性阈值：单折 portfolio trade 笔数低于此值时 Sharpe 极不稳定（评审 05-#9）
_MIN_RELIABLE_SHARPE_TRADES = 20


def _format_metric(v: Any) -> str:
    if v is None:
        return "-"
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    if pd.isna(f):
        return "nan"
    return f"{f:.4f}"


def _compare_table(summary: dict[str, dict[str, Any]]) -> str:
    """生成三组对照 + 集成的 Markdown 表。"""

    cols = [
        ("ndcg_at_5_mean", "NDCG@5"),
        ("ndcg_at_10_mean", "NDCG@10"),
        ("ic_mean", "IC"),
        ("rank_ic_mean", "RankIC"),
        ("portfolio_annual_after_cost", "NetRet(med)"),
        ("sharpe_mean", "Sharpe"),
        ("n_folds", "Folds"),
    ]
    header = "| Model | " + " | ".join(label for _, label in cols) + " |"
    sep = "|---" * (len(cols) + 1) + "|"
    rows = [header, sep]
    for model, m in summary.items():
        cells = [model]
        for key, _ in cols:
            cells.append(_format_metric(m.get(key)))
        rows.append("| " + " | ".join(cells) + " |")
    return "\n".join(rows)


def _per_model_fold_tables(summary: dict[str, dict[str, Any]]) -> str:
    """每个模型一段 fold 明细表。"""

    sections: list[str] = []
    for model, m in summary.items():
        folds: list[dict[str, Any]] = m.get("fold_metrics", [])
        if not folds:
            continue
        lines = [
            f"#### {model}",
            "",
            "| Fold | NDCG@5 | NDCG@10 | IC | RankIC | NetRet(med) | Sharpe |",
            "|---|---|---|---|---|---|---|",
        ]
        for f in folds:
            lines.append(
                "| "
                + " | ".join(
                    [
                        str(f.get("fold", "")),
                        _format_metric(f.get("ndcg@5")),
                        _format_metric(f.get("ndcg@10")),
                        _format_metric(f.get("ic")),
                        _format_metric(f.get("rank_ic")),
                        _format_metric(f.get("portfolio_annual_after_cost")),
                        _format_metric(f.get("sharpe")),
                    ]
                )
                + " |"
            )
        sections.append("\n".join(lines))
    return "\n\n".join(sections)


def _troubleshooting(summary: dict[str, dict[str, Any]]) -> str:
    """简单的排查建议。"""

    notes: list[str] = []
    # GBDT vs Linear 提升门槛
    linear = summary.get("linear", {})
    lambdarank = summary.get("lgb-lambdarank", {})
    if linear and lambdarank:
        gap = (lambdarank.get("ndcg_at_10_mean") or 0) - (linear.get("ndcg_at_10_mean") or 0)
        if gap < 0.015:
            notes.append(
                f"- ⚠️ **GBDT(LambdaRank) vs Linear NDCG@10 提升 {gap:+.4f} < 0.015**"
                "（spec m3 §验收门槛）。可能原因：标签噪音过大 / 因子覆盖不全 / 中性化缺失。"
            )
        else:
            notes.append(f"- ✅ LambdaRank vs Linear NDCG@10 提升 {gap:+.4f} ≥ 0.015。")

    # 各项期望区间
    for model, m in summary.items():
        for key, (lower, _upper, msg) in _EXPECTED_RANGES.items():
            map_key = {
                "rank_ic": "rank_ic_mean",
                "ndcg@10": "ndcg_at_10_mean",
                "portfolio_annual_after_cost": "portfolio_annual_after_cost",
            }[key]
            v = m.get(map_key)
            if v is None or (isinstance(v, float) and pd.isna(v)):
                continue
            if lower is not None and v < lower:
                notes.append(f"- ⚠️ [{model}] {msg}（实测 {v:.4f}）")

    # 小样本 Sharpe 不可靠（评审 05-#9）：任一折 portfolio trade 笔数 < 20 时标注。
    # walk-forward 单折测试集可能只有几笔 trade，Sharpe 极不稳定。
    small_sample_models: set[str] = set()
    for model, m in summary.items():
        for f in m.get("fold_metrics", []):
            n_tr = f.get("portfolio_n_trades")
            if isinstance(n_tr, (int, float)) and n_tr < _MIN_RELIABLE_SHARPE_TRADES:
                small_sample_models.add(model)
    if small_sample_models:
        notes.append(
            f"- ⚠️ Sharpe 小样本不可靠：模型 {sorted(small_sample_models)} 存在 "
            f"trade 笔数 < {_MIN_RELIABLE_SHARPE_TRADES} 的折，其 Sharpe 数值波动极大，"
            "不应据此做模型决策。"
        )

    if not notes:
        notes.append("- ✅ 所有指标在 doc/05 §5.7 期望区间内。")
    return "\n".join(notes)


def generate_report(
    *,
    model_run_id: str,
    model_version: str,
    feature_set_id: str,
    hyperparams: dict[str, Any],
    walk_forward_params: dict[str, Any],
    compare_summary: dict[str, dict[str, Any]],
    ensemble_daily_returns: pd.Series | None = None,
    output_dir: Path | None = None,
) -> tuple[str, str]:
    """落地 report.md + daily_returns.csv，返回 (markdown_content, report_uri)。

    Args:
        model_run_id: 写在元数据
        model_version, feature_set_id, hyperparams, walk_forward_params:
            元数据
        compare_summary: ab_compare.compare_three 的返回
        ensemble_daily_returns: 可选 ensemble 模型的逐笔 trade 净收益（Series, idx=入场日；
            值为多日持仓净收益率，非日收益）
        output_dir: 默认 artifact_dir(model_run_id)

    Returns:
        (markdown_content, report_uri)
        report_uri 为 POSIX 相对路径（./artifacts/<id>/report.md）
    """

    if output_dir is None:
        output_dir = artifact_dir(model_run_id)
    output_dir.mkdir(parents=True, exist_ok=True)

    sections: list[str] = []

    sections.append(f"# 量化模型训练报告 — `{model_version}`\n")
    sections.append("## 元数据\n")
    sections.append(
        f"- model_run_id: `{model_run_id}`\n"
        f"- model_version: `{model_version}`\n"
        f"- feature_set_id: `{feature_set_id}`\n"
        f"- walk_forward: `{walk_forward_params}`\n"
    )
    sections.append("### hyperparams（LightGBM 共用配置）\n")
    sections.append("```json")
    import json as _json

    sections.append(_json.dumps(hyperparams, ensure_ascii=False, indent=2))
    sections.append("```\n")

    sections.append("## 三组对照（NDCG / IC / RankIC / 单笔净收益中位数）\n")
    sections.append(_compare_table(compare_summary))
    sections.append("")

    sections.append("## 每折指标明细\n")
    sections.append(_per_model_fold_tables(compare_summary))
    sections.append("")

    sections.append("## Portfolio 曲线\n")
    daily_csv_path = output_dir / "daily_returns.csv"
    if ensemble_daily_returns is not None and not ensemble_daily_returns.empty:
        ensemble_daily_returns.to_csv(daily_csv_path, header=True, encoding="utf-8")
        sections.append(
            f"- ensemble 逐笔 trade 净收益已写入 `daily_returns.csv`"
            f"（{len(ensemble_daily_returns)} 笔；index 为入场日，值为多日持仓净收益率）"
        )
        sections.append("- 建议读者用 pandas / Excel 打开 csv 自行绘图")
    else:
        sections.append("- ensemble 逐笔 trade 净收益缺失（fold 数为 0 或评估失败）")
    sections.append("")

    sections.append("## 排查建议\n")
    sections.append(_troubleshooting(compare_summary))
    sections.append("")

    content = "\n".join(sections)

    report_path = output_dir / "report.md"
    report_path.write_text(content, encoding="utf-8")
    return content, artifact_uri(model_run_id, "report.md")


__all__ = ["generate_report"]
