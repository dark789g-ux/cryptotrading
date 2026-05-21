"""M4 Part L 命令实现：tune / seed-avg / monitor / shap-explain。

函数在 cli.py 中通过 app.command() 注册，避免循环引用。
"""

from __future__ import annotations

import typer

from quant_pipeline.config.logging import setup_logging


def cmd_tune(
    feature_set: str = typer.Option(..., "--feature-set", help="feature_set_id"),
    n_trials: int = typer.Option(50, "--n-trials", help="trial 次数；建议 ≥ 50"),
    space: str = typer.Option("default", "--space", help="搜索空间名（default）"),
    write_model_run: bool = typer.Option(
        True,
        "--write-model-run/--no-write-model-run",
        help="是否把 best trial 落 ml.model_runs（默认开）。",
    ),
) -> None:
    """跑 Optuna 调参（PG RDB storage，中断可恢复；同 study 名重跑接续）。

    spec m4 §6 入口：``uv run quant tune --feature-set fs_v1 --n-trials 50``。
    """

    setup_logging()
    from quant_pipeline.training.tuning import tune

    result = tune(
        feature_set_id=feature_set,
        n_trials=n_trials,
        space=space,
        write_model_run=write_model_run,
    )
    typer.echo(
        "tune done: study={s} completed={c} best_value={bv:.4f} best_trial={bt}".format(
            s=result["study_name"],
            c=result["n_trials_completed"],
            bv=float(result["best_value"]),
            bt=result["best_trial_number"],
        )
    )
    typer.echo(f"  best_params: {result['best_params']}")
    if result.get("model_version"):
        typer.echo(f"  model_version: {result['model_version']}")


def cmd_seed_avg(
    feature_set: str = typer.Option(
        "",
        "--feature-set",
        help="feature_set_id；与 --base 二选一，--base 提供时优先反查",
    ),
    base: str = typer.Option(
        "",
        "--base",
        help=(
            "base model_version（lgb-lambdarank-v1-...）；用于反查 feature_set_id。"
            "spec m4 §6 入口：--base lgb-lambdarank-v1-... --seeds 42,123,456,789,999"
        ),
    ),
    seeds: str = typer.Option(
        "42,123,456,789,1024",
        "--seeds",
        help="逗号分隔 seed 列表（默认 5 个）",
    ),
) -> None:
    """跑 Seed Averaging（5 seed → 1 集成 model_run）。"""

    setup_logging()
    from sqlalchemy import text as _text

    from quant_pipeline.db.engine import session_scope
    from quant_pipeline.training.seed_averaging import train_seed_average

    fs = feature_set.strip()
    bs = base.strip()
    if not fs and not bs:
        typer.echo("必须提供 --feature-set 或 --base 之一", err=True)
        raise typer.Exit(code=2)
    if not fs and bs:
        with session_scope() as session:
            row = session.execute(
                _text("SELECT feature_set_id FROM ml.model_runs WHERE model_version = :mv"),
                {"mv": bs},
            ).first()
        if row is None:
            typer.echo(f"ml.model_runs 找不到 model_version={bs!r}", err=True)
            raise typer.Exit(code=1)
        fs = str(row[0])

    seed_list = [int(s.strip()) for s in seeds.split(",") if s.strip()]
    result = train_seed_average(feature_set_id=fs, seeds=seed_list)
    typer.echo(
        "seed-avg done: ensemble_mv={mv} child_runs={n}".format(
            mv=result["ensemble_model_version"],
            n=len(result["child_model_run_ids"]),
        )
    )


def cmd_monitor(
    date: str = typer.Option(..., "--date", help="监控日 YYYYMMDD"),
    model_version: str = typer.Option(
        "", "--model-version", help="model_version；留空自动取当日最近的"
    ),
) -> None:
    """跑每日推理后监控（IC drop / score 分布漂移 / 特征 PSI）。

    与 ``quant quality monitor`` 等价（spec m4 §6 别名）；保留顶层入口以兼容
    早期文档与脚本，新写法推荐使用子命令形式。
    """

    from quant_pipeline.cli_quality import run_quality_monitor

    run_quality_monitor(date=date, model_version=model_version)


def cmd_shap_explain(
    run_id: str = typer.Option(..., "--run-id", help="ml.model_runs.id"),
    n_samples: int = typer.Option(500, "--n-samples"),
    top_k: int = typer.Option(20, "--top-k"),
) -> None:
    """对一条 model_run 跑 SHAP TreeExplainer → 落 shap_top20.json + 写 shap_uri。"""

    setup_logging()
    from quant_pipeline.evaluation.shap_explainer import explain

    shap_uri = explain(run_id, n_samples=n_samples, top_k=top_k)
    typer.echo(f"shap done: shap_uri={shap_uri}")
