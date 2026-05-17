"""quant-pipeline CLI 入口。

M0 暴露 worker / version；M1 Part A 追加 sync 子命令（sync raw），
Part E 追加 quality 子命令（check / pit-audit）。
其余 factors / labels / features / train / evaluate / infer 由其它里程碑落实。
"""

from __future__ import annotations

import typer

from quant_pipeline import __version__
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

quality_app = typer.Typer(
    help=(
        "数据质量门禁子命令（M1 Part E）。"
        "门禁不可被 --force 绕过；strict 模式下 critical 直接 exit 1。"
    )
)
app.add_typer(quality_app, name="quality")

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
# quality 子命令
# ----------------------------------------------------------------------

@quality_app.command("check")
def quality_check(
    date: str = typer.Option(
        ...,
        "--date",
        help="审计交易日 YYYYMMDD（A 股规范）",
    ),
    strict: bool = typer.Option(
        False,
        "--strict",
        help="任一 critical 立即 exit 1（用于训练/推理前必检）。",
    ),
    row_count_drift_threshold: float = typer.Option(
        0.05,
        "--row-count-drift-threshold",
        help=(
            "row_count_drift 阈值；> 0.05 时会同时写一条 level='info' 的"
            "'阈值放宽'留痕事件（spec 04 §2 硬约束）。"
        ),
    ),
    adj_jump_ratio_threshold: float = typer.Option(
        5.0,
        "--adj-jump-ratio-threshold",
        help="adj_factor 单日相对变化倍数阈值。",
    ),
    extreme_sigma: float = typer.Option(
        10.0,
        "--extreme-sigma",
        help="extreme_value 的 N σ 阈值。",
    ),
) -> None:
    """跑 8 项数据质量检验；strict 下 critical → exit 1。"""

    setup_logging()
    from quant_pipeline.quality.runner import QualityGateBlocked, run_checks

    params = {
        "row_count_drift_threshold": row_count_drift_threshold,
        "adj_jump_ratio_threshold": adj_jump_ratio_threshold,
        "extreme_sigma": extreme_sigma,
    }

    try:
        report = run_checks(date, strict=strict, params=params)
    except QualityGateBlocked as exc:
        typer.echo(f"BLOCKED rule={exc.rule} detail={exc.detail}", err=True)
        raise typer.Exit(code=1) from exc

    typer.echo(
        "quality check {d}: critical={c} warn={w} info={i} passed={p}".format(
            d=date,
            c=report.critical_count,
            w=report.warn_count,
            i=report.info_count,
            p=report.passed,
        )
    )
    for r in report.results:
        if r.passed and r.level != "info":
            continue
        typer.echo(
            "  - {name:24s} level={lvl:8s} rule={rule:24s} passed={p}".format(
                name=r.name or r.rule,
                lvl=r.level,
                rule=r.rule,
                p=r.passed,
            )
        )

    if strict and not report.passed:
        raise typer.Exit(code=1)


@quality_app.command("pit-audit")
def quality_pit_audit(
    dates: str = typer.Option(
        "",
        "--dates",
        help=(
            "逗号分隔的抽样交易日 YYYYMMDD，例如 20240630,20241231。"
            "为空时跑最近 5 个交易日的 raw.daily_quote。"
        ),
    ),
    ghost2_codes: int = typer.Option(10, "--ghost2-codes"),
    ghost2_dates: int = typer.Option(5, "--ghost2-dates"),
    ghost3_size: int = typer.Option(10, "--ghost3-size"),
) -> None:
    """跑 PIT 三铁律 + 三幽灵 Bug 自动审计。"""

    setup_logging()
    from sqlalchemy import text

    from quant_pipeline.db.engine import session_scope
    from quant_pipeline.quality.runner import run_pit_audit

    sample_dates: list[str]
    if dates.strip():
        sample_dates = [s.strip() for s in dates.split(",") if s.strip()]
    else:
        with session_scope() as session:
            rows = (
                session.execute(
                    text(
                        "SELECT DISTINCT trade_date FROM raw.daily_quote "
                        "ORDER BY trade_date DESC LIMIT 5"
                    )
                )
                .scalars()
                .all()
            )
        sample_dates = [str(d) for d in rows]
        if not sample_dates:
            typer.echo(
                "raw.daily_quote 为空，pit-audit 需通过 --dates 指定抽样交易日",
                err=True,
            )
            raise typer.Exit(code=1)

    report = run_pit_audit(
        sample_dates,
        ghost2_sample_codes=ghost2_codes,
        ghost2_sample_dates=ghost2_dates,
        ghost3_sample_size=ghost3_size,
    )

    typer.echo(
        "pit-audit dates={ds}: critical={c} warn={w} info={i} passed={p}".format(
            ds=",".join(sample_dates),
            c=report.critical_count,
            w=report.warn_count,
            i=report.info_count,
            p=report.passed,
        )
    )
    for r in report.results:
        typer.echo(
            "  - {name:30s} level={lvl:8s} rule={rule:20s} date={d}".format(
                name=r.name or r.rule,
                lvl=r.level,
                rule=r.rule,
                d=r.trade_date,
            )
        )

    if not report.passed:
        raise typer.Exit(code=1)


@quality_app.command("gate")
def quality_gate(
    date: str = typer.Option(
        ...,
        "--date",
        help="审计交易日 YYYYMMDD（A 股规范）",
    ),
    mode: str = typer.Option(
        ...,
        "--mode",
        help="门禁模式：training_pregate | inference_pregate（spec 04 §2）",
    ),
) -> None:
    """人工触发训练前 / 推理前必检门禁（spec 04 §2）。

    任一 critical → exit 1；CLI 不暴露 --no-strict 选项（门禁不可绕过）。
    """

    setup_logging()
    from quant_pipeline.quality.report import gate_check
    from quant_pipeline.quality.runner import QualityGateBlocked

    if mode not in ("training_pregate", "inference_pregate"):
        typer.echo(
            f"--mode must be training_pregate | inference_pregate, got {mode!r}",
            err=True,
        )
        raise typer.Exit(code=2)

    try:
        report = gate_check(date, mode=mode, strict=True)  # type: ignore[arg-type]
    except QualityGateBlocked as exc:
        typer.echo(f"GATE BLOCKED rule={exc.rule} detail={exc.detail}", err=True)
        raise typer.Exit(code=1) from exc

    typer.echo(
        "quality gate {m} {d}: critical={c} warn={w} info={i} passed={p}".format(
            m=mode,
            d=date,
            c=report.critical_count,
            w=report.warn_count,
            i=report.info_count,
            p=report.passed,
        )
    )
    if not report.passed:
        raise typer.Exit(code=1)


# ----------------------------------------------------------------------
# 训练 / 推理 / 评估子命令（M2 Part B）
# ----------------------------------------------------------------------

train_app = typer.Typer(
    help=(
        "训练入口（M2 Part B）。"
        "训练前必检（gate_check mode='training_pregate', strict=True）失败 → exit 1，"
        "门禁不可绕过（CLI 不提供 --force）。"
    )
)
infer_app = typer.Typer(
    help=(
        "推理入口（M2 Part B）。"
        "推理前必检失败 → exit 1；scores_daily 行数严格等于 raw.daily_quote 当日股票数。"
    )
)
evaluate_app = typer.Typer(
    help="评估入口（M2 留 stub；完整三组对照 / Walk-Forward 评估由 M3 实现）。"
)


@app.command("train")
def train_one(
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
) -> None:
    """直接调 training.runner（CLI 直跑，不写 ml.jobs）。

    训练前必检由 runner 内部 strict=True 调用，失败抛 QualityGateBlocked → exit 1。
    """

    setup_logging()
    from quant_pipeline.quality.runner import QualityGateBlocked
    from quant_pipeline.training.runner import train_one_fold

    try:
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


@app.command("infer")
def infer_one(
    run_id: str = typer.Option(
        "",
        "--run-id",
        help="ml.model_runs.id（与 --model-version 二选一）",
    ),
    model_version: str = typer.Option(
        "",
        "--model-version",
        help="ml.model_runs.model_version（与 --run-id 二选一）",
    ),
    date: str = typer.Option(
        ...,
        "--date",
        help="推理交易日 YYYYMMDD",
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
    if not mv and not rid:
        typer.echo("必须提供 --run-id 或 --model-version 之一", err=True)
        raise typer.Exit(code=2)

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

    typer.echo(f"infer ok: model_version={mv} date={date} written={n}")


@app.command("evaluate")
def evaluate_stub(
    run_id: str = typer.Option(
        ...,
        "--run-id",
        help="ml.model_runs.id；M3 实现完整评估（三组对照 / Walk-Forward）",
    ),
) -> None:
    """评估入口 stub —— M2 仅返回提示，完整实现在 M3。"""

    setup_logging()
    typer.echo(
        f"evaluate stub: run_id={run_id} —— 完整评估（三组对照 / Walk-Forward）由 M3 实现。"
    )
    raise typer.Exit(code=0)


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
) -> None:
    """计算 strategy-aware / fwd_5d_ret 标签，upsert 到 factors.labels。

    CLI 直跑，不写 ml.jobs；与 worker dispatcher 的 'labels' run_type 走同一组
    runner（02-quant-pipeline §3）。
    """

    setup_logging()
    from quant_pipeline.labels.runner import compute_labels

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
) -> None:
    """构建并 upsert feature_matrix（含 feature_sets 元数据）。"""

    setup_logging()
    from quant_pipeline.features.runner import build_feature_matrix

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


if __name__ == "__main__":
    app()
