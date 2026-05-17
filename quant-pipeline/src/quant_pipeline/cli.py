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
def evaluate_run(
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


# ----------------------------------------------------------------------
# M4 Part L 子命令：tune / seed-avg / monitor / shap-explain
# ----------------------------------------------------------------------

@app.command("tune")
def tune_cli(
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


@app.command("seed-avg")
def seed_avg_cli(
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


@app.command("monitor")
def monitor_cli(
    date: str = typer.Option(..., "--date", help="监控日 YYYYMMDD"),
    model_version: str = typer.Option(
        "", "--model-version", help="model_version；留空自动取当日最近的"
    ),
) -> None:
    """跑每日推理后监控（IC drop / score 分布漂移 / 特征 PSI）。

    与 ``quant quality monitor`` 等价（spec m4 §6 别名）；保留顶层入口以兼容
    早期文档与脚本，新写法推荐使用子命令形式。
    """

    _run_quality_monitor(date=date, model_version=model_version)


def _run_quality_monitor(*, date: str, model_version: str) -> None:
    """quant monitor / quant quality monitor 共用实现。"""

    setup_logging()
    from quant_pipeline.quality.monitor import run_daily_monitor

    mv = model_version.strip() or None
    out = run_daily_monitor(date=date, model_version=mv)
    typer.echo(
        "monitor {d} {mv}: issues={n} features_drifted={fd}/{fc} "
        "rolling_ic={ri} train_ic={ti}".format(
            d=out["date"],
            mv=out.get("model_version", "-"),
            n=len(out.get("issues", [])),
            fd=out.get("n_features_drifted", 0),
            fc=out.get("n_features_checked", 0),
            ri=out.get("rolling_ic"),
            ti=out.get("train_ic"),
        )
    )


@quality_app.command("monitor")
def quality_monitor_cli(
    model_version: str = typer.Option(
        ...,
        "--model-version",
        help="model_version；spec 要求显式指定（避免误监控旧 model）",
    ),
    date: str = typer.Option(..., "--date", help="监控日 YYYYMMDD"),
) -> None:
    """spec m4 §6 入口：``quant quality monitor --model-version V --date YYYYMMDD``。

    与 ``quant monitor`` 同实现，仅参数顺序与 spec 文本一致。
    """

    _run_quality_monitor(date=date, model_version=model_version)


@app.command("shap-explain")
def shap_explain_cli(
    run_id: str = typer.Option(..., "--run-id", help="ml.model_runs.id"),
    n_samples: int = typer.Option(500, "--n-samples"),
    top_k: int = typer.Option(20, "--top-k"),
) -> None:
    """对一条 model_run 跑 SHAP TreeExplainer → 落 shap_top20.json + 写 shap_uri。"""

    setup_logging()
    from quant_pipeline.evaluation.shap_explainer import explain

    shap_uri = explain(run_id, n_samples=n_samples, top_k=top_k)
    typer.echo(f"shap done: shap_uri={shap_uri}")


if __name__ == "__main__":
    app()
