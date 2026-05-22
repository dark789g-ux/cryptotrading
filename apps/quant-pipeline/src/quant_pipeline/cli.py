"""quant-pipeline CLI 入口。

M0 暴露 worker / version；M1 Part A 追加 sync 子命令（sync raw），
Part E 追加 quality 子命令（check / pit-audit）。
其余 factors / labels / features / train / evaluate / infer 由其它里程碑落实。

模块拆分：
  - cli_quality.py — quality 子命令（check / pit-audit / gate / monitor）
  - cli_ml.py      — ML 命令函数（train / infer / evaluate）
  - cli_m4.py      — M4 命令函数（tune / seed-avg / monitor / shap-explain）
"""

from __future__ import annotations

import typer
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn

from quant_pipeline import __version__
from quant_pipeline.cli_common import (
    console,
    make_progress_callback as _make_progress_callback,
    validate_date_range,
)
from quant_pipeline.config.logging import setup_logging

app = typer.Typer(
    name="quant",
    help="quant-pipeline CLI（M1：worker / version / sync / quality）",
    no_args_is_help=True,
    add_completion=False,
)

worker_app = typer.Typer(help="worker 子命令")
app.add_typer(worker_app, name="worker")

sync_app = typer.Typer(
    help=(
        "TuShare → raw.* 同步子命令（M1 Part A）。"
        "仅同步 01-pg-schema §5 划归 Python 拥有的 6 张表："
        "trade_cal / stk_limit / suspend_d / index_classify / index_member / fina_indicator。"
    )
)
app.add_typer(sync_app, name="sync")

# quality 子命令（cli_quality.py）
from quant_pipeline.cli_quality import quality_app  # noqa: E402

app.add_typer(quality_app, name="quality")

# labels / features / factors 子命令（保留在本文件）
labels_app = typer.Typer(
    help=(
        "标签生成子命令（M2 Part A）。"
        "scheme=strategy-aware 调 exit_rules 模拟出场；scheme=fwd_5d_ret 走 5 日兜底。"
    )
)
app.add_typer(labels_app, name="labels")

features_app = typer.Typer(
    help=(
        "特征矩阵构建子命令（M2 Part A）。"
        "因子+标签 → feature_matrix：行业+市值中性化、截面 z-score、±3σ 截尾、label ±50% 截尾。"
    )
)
app.add_typer(features_app, name="features")

factors_app = typer.Typer(help="因子计算子命令（M1 Part C）。读 raw.* → 写 factors.daily_factors。")
app.add_typer(factors_app, name="factors")

# ML 顶层命令（cli_ml.py）
from quant_pipeline.cli_ml import cmd_evaluate, cmd_infer, cmd_train  # noqa: E402

app.command("train")(cmd_train)
app.command("infer")(cmd_infer)
app.command("evaluate")(cmd_evaluate)

# M4 顶层命令（cli_m4.py）
from quant_pipeline.cli_m4 import cmd_monitor, cmd_seed_avg, cmd_shap_explain, cmd_tune  # noqa: E402

app.command("tune")(cmd_tune)
app.command("seed-avg")(cmd_seed_avg)
app.command("monitor")(cmd_monitor)
app.command("shap-explain")(cmd_shap_explain)


# ----------------------------------------------------------------------
# 基础命令
# ----------------------------------------------------------------------


@app.command()
def version() -> None:
    """打印版本号。"""

    typer.echo(f"quant-pipeline {__version__}")


@worker_app.command("run")
def worker_run() -> None:
    """启动常驻 worker（轮询 ml.jobs）。"""

    setup_logging()
    from quant_pipeline.worker.loop import run_worker_loop

    run_worker_loop()


# ----------------------------------------------------------------------
# sync 子命令（M1 Part A）
# ----------------------------------------------------------------------


@sync_app.command("raw")
def sync_raw(
    date_range: str = typer.Option(
        ...,
        "--date-range",
        help="同步区间 YYYYMMDD:YYYYMMDD（A 股 trade_date 规范）。",
    ),
    tables: str = typer.Option(
        "",
        "--tables",
        help=(
            "逗号分隔的表名，留空 = 全部 6 张；可选值："
            "trade_cal,stk_limit,suspend_d,index_classify,index_member,fina_indicator。"
            "trade_cal 必须最先（其它表的按日循环依赖它）。"
        ),
    ),
    fina_indicator_ts_codes: str = typer.Option(
        "",
        "--fina-indicator-ts-codes",
        help=(
            "fina_indicator 接口仅支持单股调用，需逗号分隔的 ts_code 列表，"
            "如 '600000.SH,000001.SZ'；留空时跳过 fina_indicator 并写一条 failed_item。"
        ),
    ),
) -> None:
    """直接调用 sync.orchestrator 执行同步（CLI 直跑，不写 ml.jobs）。

    与 worker dispatcher 的 'sync' run_type 走同一组 runner（02-quant-pipeline §3）。
    任一 fetcher 0 行 / 三种空数据情形已在 tushare_client 内部 warn 双写
    （日志 + ml.quality_reports），同时由 orchestrator 计入 failed_items，
    符合 CLAUDE.md "fetcher 0 行必须显式 failedItems" 规则。
    """

    setup_logging()
    from quant_pipeline.sync.orchestrator import DEFAULT_TABLES, run_sync

    # 问题 8：CLI 层先校验 date_range，与 worker dispatcher 路径一致，
    # 不把格式错误一路下传到 orchestrator 才报。
    try:
        validate_date_range(date_range)
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(code=2) from exc

    tables_tuple: tuple[str, ...]
    if tables.strip():
        tables_tuple = tuple(t.strip() for t in tables.split(",") if t.strip())
    else:
        tables_tuple = DEFAULT_TABLES

    ts_codes_tuple: tuple[str, ...] | None
    if fina_indicator_ts_codes.strip():
        ts_codes_tuple = tuple(
            t.strip() for t in fina_indicator_ts_codes.split(",") if t.strip()
        )
    else:
        ts_codes_tuple = None

    outcome = run_sync(
        job_id=None,
        date_range=date_range,
        tables=tables_tuple,
        fina_indicator_ts_codes=ts_codes_tuple,
    )

    typer.echo(
        "sync raw {dr}: rows_total={rt} failed_items={fi} errors={er}".format(
            dr=date_range,
            rt=outcome.rows_total,
            fi=len(outcome.failed_items),
            er=len(outcome.errors),
        )
    )
    for tbl, n in outcome.per_table_rows.items():
        typer.echo(f"  - {tbl:20s} rows_upserted={n}")
    for fi in outcome.failed_items:
        typer.echo(
            f"  ! failed_item table={fi.table:20s} api={fi.api_name:20s} "
            f"reason={fi.reason} rule={fi.rule}"
        )
    for err in outcome.errors:
        typer.echo(f"  ! error: {err}", err=True)

    # CLI 不提供 --force：errors 非空时 exit 1（spec 04 §2 门禁不可绕过）
    if outcome.errors:
        raise typer.Exit(code=1)


# ----------------------------------------------------------------------
# labels 子命令（M2 Part A）
# ----------------------------------------------------------------------


@labels_app.command("build")
def labels_build(
    scheme: str = typer.Option(
        "strategy-aware",
        "--scheme",
        help="标签方案：strategy-aware（推荐主用） | fwd_5d_ret（兜底）",
    ),
    date_range: str = typer.Option(
        ...,
        "--date-range",
        help="信号日范围 YYYYMMDD:YYYYMMDD",
    ),
    progress: bool = typer.Option(
        False,
        "--progress",
        help="显示终端进度条",
    ),
) -> None:
    """计算 strategy-aware / fwd_5d_ret 标签，upsert 到 factors.labels。

    CLI 直跑，不写 ml.jobs；与 worker dispatcher 的 'labels' run_type 走同一组
    runner（02-quant-pipeline §3）。
    """

    setup_logging()
    from quant_pipeline.labels.runner import compute_labels

    try:
        validate_date_range(date_range)
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(code=2) from exc

    if progress:
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            console=console,
        ) as prog:
            task = prog.add_task("labels:loading", total=100)
            callback = _make_progress_callback(prog, task)
            n = compute_labels(
                scheme=scheme,
                date_range=date_range,
                job_id=None,
                progress_callback=callback,
            )
    else:
        n = compute_labels(scheme=scheme, date_range=date_range, job_id=None)

    typer.echo(f"labels build scheme={scheme} {date_range}: rows_upserted={n}")


# ----------------------------------------------------------------------
# features 子命令（M2 Part A）
# ----------------------------------------------------------------------


@features_app.command("build")
def features_build(
    factor_version: str = typer.Option(
        ...,
        "--factor-version",
        help="所选因子版本（factors.daily_factors.factor_version）",
    ),
    label_scheme: str = typer.Option(
        "strategy-aware",
        "--label-scheme",
        help="标签方案（factors.labels.scheme）",
    ),
    date_range: str = typer.Option(
        ...,
        "--date-range",
        help="构建窗口 YYYYMMDD:YYYYMMDD",
    ),
    progress: bool = typer.Option(
        False,
        "--progress",
        help="显示终端进度条",
    ),
) -> None:
    """构建并 upsert feature_matrix（含 feature_sets 元数据）。"""

    setup_logging()
    from quant_pipeline.features.runner import build_feature_matrix

    try:
        validate_date_range(date_range)
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(code=2) from exc

    if progress:
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            console=console,
        ) as prog:
            task = prog.add_task("features:loading", total=100)
            callback = _make_progress_callback(prog, task)
            feature_set_id = build_feature_matrix(
                factor_version=factor_version,
                label_scheme=label_scheme,
                date_range=date_range,
                job_id=None,
                progress_callback=callback,
            )
    else:
        feature_set_id = build_feature_matrix(
            factor_version=factor_version,
            label_scheme=label_scheme,
            date_range=date_range,
            job_id=None,
        )

    typer.echo(
        f"features build factor_version={factor_version} label_scheme={label_scheme} "
        f"{date_range}: feature_set_id={feature_set_id}"
    )


# ----------------------------------------------------------------------
# factors 子命令（M1 Part C）
# ----------------------------------------------------------------------


@factors_app.command("compute")
def factors_compute(
    version: str    = typer.Option(..., "--version",    help="factor_version，如 v1"),
    date_range: str = typer.Option(..., "--date-range", help="YYYYMMDD:YYYYMMDD"),
    factor_ids: str = typer.Option("",  "--factor-ids", help="逗号分隔；留空 = 全部 v1 因子"),
) -> None:
    """对 factor_version 在 date_range 内每个交易日计算因子并 upsert 到 factors.daily_factors。

    CLI 直跑（不写 ml.jobs）；worker dispatcher 走 `worker run` 的 factors 路径。
    """

    setup_logging()
    from quant_pipeline.factors.runner import run_factors

    try:
        validate_date_range(date_range)
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(code=2) from exc

    ids = tuple(s.strip() for s in factor_ids.split(",") if s.strip()) or None
    out = run_factors(
        factor_version=version,
        date_range=date_range,
        factor_ids=ids,
        job_id=None,
    )
    typer.echo(
        f"factors compute v={version} {date_range}: "
        f"trade_dates={out['trade_dates']} factors={out['factors']} "
        f"rows_upserted={out['rows_upserted']}"
    )


if __name__ == "__main__":
    app()
