"""ML 命令实现（train / infer / evaluate）。

函数在 cli.py 中通过 app.command() 注册，避免循环引用。
"""

from __future__ import annotations

import typer
from rich.progress import BarColumn, Progress, SpinnerColumn, TaskProgressColumn, TextColumn

from quant_pipeline.cli_common import (
    console,
)
from quant_pipeline.cli_common import (
    make_progress_callback as _make_progress_callback,
)
from quant_pipeline.config.logging import setup_logging


def cmd_train(
    feature_set: str = typer.Option(
        ...,
        "--feature-set",
        help="feature_set_id（factors.feature_sets 主键），如 fs_xxxxxxx",
    ),
    model: str = typer.Option(
        "lgb-lambdarank",
        "--model",
        help="模型类型；M2 仅支持 'lgb-lambdarank'（其它由 M3 接入）",
    ),
    seed: int = typer.Option(
        42,
        "--seed",
        help="复现 seed；同时写入 model_version 后缀",
    ),
    progress: bool = typer.Option(
        False,
        "--progress",
        help="显示终端进度条",
    ),
) -> None:
    """直接调 training.runner（CLI 直跑，不写 ml.jobs）。

    训练前必检由 runner 内部 strict=True 调用，失败抛 QualityGateBlocked → exit 1。
    """

    setup_logging()
    from quant_pipeline.quality.runner import QualityGateBlocked
    from quant_pipeline.training.runner import train_one_fold

    try:
        if progress:
            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                BarColumn(),
                TaskProgressColumn(),
                console=console,
            ) as prog:
                task = prog.add_task("train:loading", total=100)
                callback = _make_progress_callback(prog, task)
                result = train_one_fold(
                    feature_set_id=feature_set,
                    model=model,
                    seed=seed,
                    progress_callback=callback,
                )
        else:
            result = train_one_fold(
                feature_set_id=feature_set,
                model=model,
                seed=seed,
            )
    except QualityGateBlocked as exc:
        typer.echo(f"TRAIN BLOCKED rule={exc.rule} detail={exc.detail}", err=True)
        raise typer.Exit(code=1) from exc

    typer.echo(
        "train ok: model_run_id={rid} model_version={mv} artifact={ar} "
        "ndcg@10={n10:.4f} ndcg@5={n5:.4f} ic={ic:.4f} rank_ic={ric:.4f}".format(
            rid=str(result.model_run_id),
            mv=result.model_version,
            ar=result.artifact_uri,
            n10=float(result.oos_metrics.get("ndcg@10", 0.0) or 0.0),
            n5=float(result.oos_metrics.get("ndcg@5", 0.0) or 0.0),
            ic=float(result.oos_metrics.get("ic", 0.0) or 0.0),
            ric=float(result.oos_metrics.get("rank_ic", 0.0) or 0.0),
        )
    )


def cmd_infer(
    run_id: str = typer.Option(
        "",
        "--run-id",
        help=(
            "ml.model_runs.id；不传时与 --model-version 都缺省则自动选最新"
            " (model_version LIKE 'lgb-%' ORDER BY created_at DESC LIMIT 1)"
        ),
    ),
    model_version: str = typer.Option(
        "",
        "--model-version",
        help=(
            "ml.model_runs.model_version；不传时与 --run-id 都缺省则自动选最新"
        ),
    ),
    date: str = typer.Option(
        ...,
        "--date",
        help="推理交易日 YYYYMMDD",
    ),
    progress: bool = typer.Option(
        False,
        "--progress",
        help="显示终端进度条",
    ),
) -> None:
    """直接调 inference.runner（CLI 直跑，不写 ml.jobs）。

    推理前必检失败 → exit 1；scores_daily 行数严格校验。
    """

    setup_logging()
    from sqlalchemy import text as _text

    from quant_pipeline.db.engine import session_scope
    from quant_pipeline.inference.runner import run_inference
    from quant_pipeline.inference.score_writer import ScoreRowCountMismatch
    from quant_pipeline.quality.runner import QualityGateBlocked

    mv = model_version.strip()
    rid = run_id.strip()
    source = "cli"

    if not mv and not rid:
        # 自动选 prod 模型：max(created_at) where status='prod'。
        # ml.model_runs.status 列 migration 见 20260529_ml_model_runs_status.sql；
        # seed-avg 集成模型上线由运维显式 UPDATE 升 prod，详见
        # scripts/quant-weekly/seed-avg.ps1。
        with session_scope() as session:
            row = session.execute(
                _text(
                    """
                    SELECT model_version FROM ml.model_runs
                     WHERE status = 'prod'
                     ORDER BY created_at DESC
                     LIMIT 1
                    """
                )
            ).first()
        if row is None:
            typer.echo(
                "ml.model_runs 无 status='prod' 模型；请先训练并升 prod，"
                "或显式传 --model-version / --run-id",
                err=True,
            )
            raise typer.Exit(code=2)
        mv = str(row[0])
        source = "auto"

    if not mv and rid:
        # 反查 model_version
        with session_scope() as session:
            row = session.execute(
                _text("SELECT model_version FROM ml.model_runs WHERE id = :id"),
                {"id": rid},
            ).first()
        if row is None:
            typer.echo(f"ml.model_runs 找不到 run_id={rid!r}", err=True)
            raise typer.Exit(code=1)
        mv = str(row[0])

    if len(date) != 8 or not date.isdigit():
        typer.echo(f"--date 必须是 YYYYMMDD，got {date!r}", err=True)
        raise typer.Exit(code=2)

    try:
        if progress:
            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                BarColumn(),
                TaskProgressColumn(),
                console=console,
            ) as prog:
                task = prog.add_task("infer:loading", total=100)
                callback = _make_progress_callback(prog, task)
                n = run_inference(
                    model_version=mv,
                    trade_date=date,
                    progress_callback=callback,
                )
        else:
            n = run_inference(model_version=mv, trade_date=date)
    except QualityGateBlocked as exc:
        typer.echo(f"INFER BLOCKED rule={exc.rule} detail={exc.detail}", err=True)
        raise typer.Exit(code=1) from exc
    except ScoreRowCountMismatch as exc:
        typer.echo(
            f"INFER FAILED row_count_mismatch expected={exc.expected} got={exc.got} "
            f"detail={exc.detail}",
            err=True,
        )
        raise typer.Exit(code=1) from exc

    typer.echo(f"infer ok: model_version={mv} source={source} date={date} written={n}")


def cmd_evaluate(
    run_id: str = typer.Option(
        ...,
        "--run-id",
        help="ml.model_runs.id；将从 ml.model_runs 反查 feature_set_id / model_version。",
    ),
    ab_baseline: str = typer.Option(
        "linear,gbdt",
        "--ab-baseline",
        help=(
            "逗号分隔的 baseline 名（'linear' / 'gbdt' / 'lgb-lambdarank'）。"
            "ensemble 始终保留。'gbdt' 自动映射为 'gbdt-pointwise'。"
        ),
    ),
    n_folds: int = typer.Option(
        6, "--n-folds", help="Purged Walk-Forward 折数（≥ 6）"
    ),
    embargo_days: int = typer.Option(
        21, "--embargo-days", help="A 股财报披露窗口 embargo（≥ 21）"
    ),
    min_train_days: int = typer.Option(
        252, "--min-train-days", help="单折最少训练日数（≥ 252）"
    ),
    top_k: int = typer.Option(20, "--top-k", help="portfolio 每日选股数"),
    commission_rate: float = typer.Option(
        0.0003, "--commission-rate", help="双边佣金率"
    ),
    slippage_bps: float = typer.Option(5.0, "--slippage-bps", help="滑点 bp"),
    lgb_num_boost_round: int = typer.Option(
        100, "--lgb-num-boost-round",
        help="LightGBM 训练轮数（M3 评估默认 100，与 walk-forward runner 对齐）",
    ),
) -> None:
    """跑 Purged Walk-Forward 三组对照评估并生成 report.md。

    与 `train --walk-forward` 的差别：evaluate 是"事后评估" —— 不写新的
    ml.model_runs / 不落 model.txt；只把 ab_compare 报告写到
    `./artifacts/<run_id>/report.md`（覆盖同名文件），便于复跑对照。
    """

    setup_logging()
    from pathlib import Path

    from sqlalchemy import text as _text

    from quant_pipeline.db.engine import session_scope
    from quant_pipeline.evaluation.ab_compare import run_ab_compare
    from quant_pipeline.utils.paths import artifact_dir

    # 1) 反查 ml.model_runs
    with session_scope() as session:
        row = session.execute(
            _text(
                "SELECT feature_set_id, model_version FROM ml.model_runs WHERE id = :id"
            ),
            {"id": run_id},
        ).first()
    if row is None:
        typer.echo(f"ml.model_runs 找不到 run_id={run_id!r}", err=True)
        raise typer.Exit(code=1)
    feature_set_id, model_version = str(row[0]), str(row[1])

    # 2) 解析 --ab-baseline；CLI 输入 'gbdt' → 内部模型名 'gbdt-pointwise'
    baseline_map = {
        "linear": "linear",
        "gbdt": "gbdt-pointwise",
        "gbdt-pointwise": "gbdt-pointwise",
        "lgb-lambdarank": "lgb-lambdarank",
    }
    raw_baselines = [b.strip() for b in ab_baseline.split(",") if b.strip()]
    baselines: list[str] = []
    for b in raw_baselines:
        if b not in baseline_map:
            typer.echo(
                f"--ab-baseline 不支持 {b!r}，可选: {sorted(baseline_map)}", err=True
            )
            raise typer.Exit(code=2)
        baselines.append(baseline_map[b])

    # 3) 跑评估
    out_dir = artifact_dir(run_id)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    try:
        result = run_ab_compare(
            feature_set_id=feature_set_id,
            baselines=baselines,
            model_run_id=run_id,
            model_version=model_version,
            output_dir=out_dir,
            n_folds=n_folds,
            embargo_days=embargo_days,
            min_train_days=min_train_days,
            top_k=top_k,
            commission_rate=commission_rate,
            slippage_bps=slippage_bps,
            lgb_num_boost_round=lgb_num_boost_round,
            lgb_early_stopping_rounds=None,
        )
    except ValueError as exc:
        typer.echo(f"EVALUATE FAILED: {exc}", err=True)
        raise typer.Exit(code=1) from exc

    summary = result["summary"]
    typer.echo(
        f"evaluate ok: run_id={run_id} feature_set_id={feature_set_id} "
        f"model_version={model_version}"
    )
    for name, m in summary.items():
        typer.echo(
            "  - {n:24s} ndcg@10={n10} ic={ic} rank_ic={ric} "
            "annual_net={ar} folds={f}".format(
                n=name,
                n10=f"{m.get('ndcg_at_10_mean', float('nan')):.4f}",
                ic=f"{m.get('ic_mean', float('nan')):.4f}",
                ric=f"{m.get('rank_ic_mean', float('nan')):.4f}",
                ar=f"{m.get('portfolio_annual_after_cost', float('nan')):.4f}",
                f=m.get("n_folds", "-"),
            )
        )
    rp = result.get("report_path")
    if rp is not None:
        typer.echo(f"  report -> {rp}")
