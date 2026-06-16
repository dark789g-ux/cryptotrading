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
from rich.progress import BarColumn, Progress, SpinnerColumn, TaskProgressColumn, TextColumn

from quant_pipeline import __version__
from quant_pipeline.cli_common import (
    console,
    validate_date_range,
)
from quant_pipeline.cli_common import (
    make_progress_callback as _make_progress_callback,
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

trade_cal_app = typer.Typer(
    help="raw.trade_cal 查询子命令（供 daily 脚本计算交易日偏移用）。"
)
app.add_typer(trade_cal_app, name="trade-cal")

# ML 顶层命令（cli_ml.py）
from quant_pipeline.cli_ml import cmd_evaluate, cmd_infer, cmd_train  # noqa: E402

app.command("train")(cmd_train)
app.command("infer")(cmd_infer)
app.command("evaluate")(cmd_evaluate)

# M4 顶层命令（cli_m4.py）
from quant_pipeline.cli_m4 import (  # noqa: E402
    cmd_monitor,
    cmd_seed_avg,
    cmd_shap_explain,
    cmd_tune,
)

app.command("tune")(cmd_tune)
app.command("seed-avg")(cmd_seed_avg)
app.command("monitor")(cmd_monitor)
app.command("shap-explain")(cmd_shap_explain)


# ----------------------------------------------------------------------
# 基础命令
# ----------------------------------------------------------------------


@app.command()  # type: ignore[untyped-decorator]  # typer 装饰器在 mypy strict 下判为 untyped，仅类型层屏蔽
def version() -> None:
    """打印版本号。"""

    typer.echo(f"quant-pipeline {__version__}")


@worker_app.command("run")  # type: ignore[untyped-decorator]  # typer 装饰器在 mypy strict 下判为 untyped，仅类型层屏蔽
def worker_run() -> None:
    """启动常驻 worker（轮询 ml.jobs）。"""

    setup_logging()
    from quant_pipeline.worker.loop import run_worker_loop

    run_worker_loop()


# ----------------------------------------------------------------------
# sync 子命令（M1 Part A）
# ----------------------------------------------------------------------


@sync_app.command("raw")  # type: ignore[untyped-decorator]  # typer 装饰器在 mypy strict 下判为 untyped，仅类型层屏蔽
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
        f"sync raw {date_range}: rows_total={outcome.rows_total} failed_items={len(outcome.failed_items)} errors={len(outcome.errors)}"
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
# 美股同步子命令（spec 2026-06-16-us-stocks-tab）
# ----------------------------------------------------------------------

us_symbols_app = typer.Typer(help="美股精选清单（raw.us_symbol）子命令。")
app.add_typer(us_symbols_app, name="us-symbols")


@us_symbols_app.command("seed")  # type: ignore[untyped-decorator]
def us_symbols_seed(
    csv_path: str = typer.Option(
        ...,
        "--csv",
        help="精选清单 CSV（列：股票代码/股票名称/行业/类型）。seed 显式置 tracked=true。",
    ),
) -> None:
    """从 CSV 播种 raw.us_symbol（tracked=true）。"""

    setup_logging()
    from quant_pipeline.sync.us_symbol import seed_us_symbols_from_csv

    rep = seed_us_symbols_from_csv(csv_path)
    typer.echo(f"us-symbols seed: rows_upserted={rep.rows_upserted} tickers={len(rep.tickers)}")


@app.command("us-sync")  # type: ignore[untyped-decorator]
def us_sync(
    date_range: str = typer.Option(
        ..., "--date-range", help="同步区间 YYYYMMDD:YYYYMMDD。"
    ),
    tickers: str = typer.Option(
        "", "--tickers", help="逗号分隔 ticker（如 NVDA,MSFT）；留空时配 --tracked 取库内 tracked 全集。"
    ),
    tracked: bool = typer.Option(
        False, "--tracked", help="同步 raw.us_symbol 中 tracked=true 的全部标的。"
    ),
) -> None:
    """AkShare → raw.us_* 美股同步（CLI 直跑，不写 ml.jobs）。

    与 worker dispatcher 的 'us_sync' run_type 走同一 run_us_sync 入口。
    空数据 / 因子缺失计入 failed_items（不静默）；errors 非空时 exit 1。
    """

    setup_logging()
    try:
        validate_date_range(date_range)
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(code=2) from exc

    tk_tuple: tuple[str, ...] | None
    if tickers.strip():
        tk_tuple = tuple(t.strip().upper() for t in tickers.split(",") if t.strip())
    else:
        tk_tuple = None
    if tk_tuple is None and not tracked:
        typer.echo("须指定 --tickers 或 --tracked", err=True)
        raise typer.Exit(code=2)

    from quant_pipeline.sync.us_orchestrator import run_us_sync

    outcome = run_us_sync(job_id=None, date_range=date_range, tickers=tk_tuple)
    typer.echo(
        f"us-sync {date_range}: tickers_done={outcome.tickers_done} "
        f"quote_rows={outcome.quote_rows_total} factor_rows={outcome.factor_rows_total} "
        f"indicator_rows={outcome.indicator_rows_total} "
        f"failed_items={len(outcome.failed_items)} errors={len(outcome.errors)}"
    )
    for fi in outcome.failed_items:
        typer.echo(
            f"  ! failed_item ticker={fi.ticker} api={fi.api_name} reason={fi.reason} rule={fi.rule}"
        )
    for err in outcome.errors:
        typer.echo(f"  ! error: {err}", err=True)
    if outcome.errors:
        raise typer.Exit(code=1)


@app.command("us-index-sync")  # type: ignore[untyped-decorator]
def us_index_sync(
    date_range: str = typer.Option(
        ..., "--date-range", help="同步区间 YYYYMMDD:YYYYMMDD。"
    ),
    symbols: str = typer.Option(
        "", "--symbols", help="逗号分隔指数 symbol（如 .NDX）；留空时缺省 .NDX。"
    ),
) -> None:
    """AkShare → raw.us_index_* 美股指数同步（CLI 直跑，不写 ml.jobs）。

    与 worker dispatcher 的 'us_index_sync' run_type 走同一 run_us_index_sync 入口。
    单次抓取、无 qfq、无 adj_factor（指数无复权概念）。
    空数据 / 0 行计入 failed_items（不静默）；errors 非空时 exit 1。
    """

    setup_logging()
    try:
        validate_date_range(date_range)
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(code=2) from exc

    sym_tuple: tuple[str, ...] | None
    if symbols.strip():
        sym_tuple = tuple(s.strip() for s in symbols.split(",") if s.strip())
    else:
        sym_tuple = None  # 缺省 → orchestrator 用 ('.NDX',)

    from quant_pipeline.sync.us_index_orchestrator import run_us_index_sync

    outcome = run_us_index_sync(job_id=None, date_range=date_range, symbols=sym_tuple)
    typer.echo(
        f"us-index-sync {date_range}: symbols_done={outcome.symbols_done} "
        f"rows={outcome.rows_total} indicator_rows={outcome.indicator_rows_total} "
        f"failed_items={len(outcome.failed_items)} errors={len(outcome.errors)}"
    )
    for fi in outcome.failed_items:
        typer.echo(
            f"  ! failed_item index_code={fi.index_code} api={fi.api_name} "
            f"reason={fi.reason} rule={fi.rule}"
        )
    for err in outcome.errors:
        typer.echo(f"  ! error: {err}", err=True)
    if outcome.errors:
        raise typer.Exit(code=1)


# ----------------------------------------------------------------------
# labels 子命令（M2 Part A）
# ----------------------------------------------------------------------


@labels_app.command("build")  # type: ignore[untyped-decorator]  # typer 装饰器在 mypy strict 下判为 untyped，仅类型层屏蔽
def labels_build(
    scheme: str | None = typer.Option(
        None,
        "--scheme",
        help="标签方案：strategy-aware（推荐主用） | fwd_5d_ret（兜底）。"
             "不传时默认 strategy-aware。"
             "传了 --strategy-id/--strategy-version 时由 codec 自动算出，无需手动指定；"
             "若同时显式指定 --scheme 且与 codec 不一致则 fail-fast 报错。",
    ),
    date_range: str = typer.Option(
        ...,
        "--date-range",
        help="信号日范围 YYYYMMDD:YYYYMMDD",
    ),
    new_listing_min_days: int = typer.Option(
        60,
        "--new-listing-min-days",
        min=0,
        max=250,
        help="新股过滤门槛（交易日，0 表示不过滤；fwd_5d_ret 需 listing 表辅助）",
    ),
    progress: bool = typer.Option(
        False,
        "--progress",
        help="显示终端进度条",
    ),
    strategy_id: str = typer.Option(
        "",
        "--strategy-id",
        help="策略 ID（与 --strategy-version 必须同时给或同时不给）。"
             "给定时由 codec 算 scheme + 从 factors.strategy_definitions 加载 exit_rules，"
             "防止自定义 strategy-aware scheme 静默使用 default 规则错标。",
    ),
    strategy_version: str = typer.Option(
        "",
        "--strategy-version",
        help="策略版本（与 --strategy-id 必须同时给或同时不给）。",
    ),
) -> None:
    """计算 strategy-aware / fwd_5d_ret 标签，upsert 到 factors.labels。

    CLI 直跑，不写 ml.jobs；与 worker dispatcher 的 'labels' run_type 走同一组
    runner（02-quant-pipeline §3）。

    自定义 strategy-aware scheme（形如 strategy-aware__<id>_<ver>）必须配合
    --strategy-id/--strategy-version 使用，否则会静默回退到 default exit_rules 错标。
    """

    setup_logging()
    from quant_pipeline.labels.dir3_scheme import base_scheme_codec
    from quant_pipeline.labels.runner import _load_strategy_definition, compute_labels

    try:
        validate_date_range(date_range)
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(code=2) from exc

    # ---- 参数合法性 fail-fast ----

    # 规范化：空字符串视作"未传"
    sid = strategy_id.strip() or None
    sver = strategy_version.strip() or None
    # scheme=None 表示用户未显式传 --scheme
    explicit_scheme: str | None = scheme  # 保留原始值用于 mismatch 检测

    # 守门 1：两者必须同时给或同时不给
    if bool(sid) != bool(sver):
        typer.echo(
            "错误：--strategy-id 与 --strategy-version 必须同时给或同时不给。"
            f"（当前：strategy-id={strategy_id!r}，strategy-version={strategy_version!r}）",
            err=True,
        )
        raise typer.Exit(code=2)

    exit_rules: list[dict] | None = None
    resolved_scheme: str  # 最终传给 compute_labels 的 scheme

    if sid and sver:
        # 给了 strategy-id+version → 用 codec 算权威 scheme + 加载 exit_rules
        codec_scheme = base_scheme_codec(
            "strategy_aware",
            {"strategy_id": sid, "strategy_version": sver},
        )
        # 守门 2：若用户同时显式传了 --scheme 且与 codec 结果不一致 → fail-fast
        # explicit_scheme=None 表示未显式传，跳过一致性检查；
        # 显式传了且不一致 → 报错（防止用户手误指定错误 scheme 与 codec 冲突）。
        if explicit_scheme is not None and explicit_scheme != codec_scheme:
            typer.echo(
                f"错误：--scheme={explicit_scheme!r} 与 --strategy-id/--strategy-version 通过 codec "
                f"算出的 scheme={codec_scheme!r} 不一致。"
                "请去掉 --scheme 参数，让 codec 自动决定；或检查 strategy-id/version 是否正确。",
                err=True,
            )
            raise typer.Exit(code=2)
        resolved_scheme = codec_scheme
        exit_rules = _load_strategy_definition(sid, sver)
    else:
        # 没给 strategy-id/version，只靠 --scheme（或默认值）
        # 未显式传 --scheme 时回退到默认 "strategy-aware"
        resolved_scheme = explicit_scheme if explicit_scheme is not None else "strategy-aware"

        # 守门 3：自定义 strategy-aware scheme（以 "strategy-aware__" 开头）
        # 若不配 strategy-id/version → 会静默使用 default exit_rules 错标，禁止
        _CUSTOM_STRATEGY_AWARE_PREFIX = "strategy-aware__"
        if resolved_scheme.startswith(_CUSTOM_STRATEGY_AWARE_PREFIX):
            typer.echo(
                f"错误：scheme={resolved_scheme!r} 是自定义 strategy-aware scheme，"
                "必须配合 --strategy-id/--strategy-version 才能正确加载 exit_rules。"
                "若不传，将静默回退到 default 规则（止损-8%/跌破MA5/最大持仓20日）错标，"
                "违反 lint-no-silent-degradation。请补充 --strategy-id 和 --strategy-version。",
                err=True,
            )
            raise typer.Exit(code=2)
        # 恰好等于 "strategy-aware"（default 别名）或其它非 strategy-aware scheme → 维持原行为

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
                scheme=resolved_scheme,
                date_range=date_range,
                new_listing_min_days=new_listing_min_days,
                exit_rules=exit_rules,
                job_id=None,
                progress_callback=callback,
            )
    else:
        n = compute_labels(
            scheme=resolved_scheme,
            date_range=date_range,
            new_listing_min_days=new_listing_min_days,
            exit_rules=exit_rules,
            job_id=None,
        )

    typer.echo(f"labels build scheme={resolved_scheme} {date_range}: rows_upserted={n}")


# ----------------------------------------------------------------------
# features 子命令（M2 Part A）
# ----------------------------------------------------------------------


@features_app.command("build")  # type: ignore[untyped-decorator]  # typer 装饰器在 mypy strict 下判为 untyped，仅类型层屏蔽
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
    new_listing_min_days: int = typer.Option(
        60,
        "--new-listing-min-days",
        min=0,
        max=250,
        help="新股过滤门槛（交易日，0 表示不过滤；与 train_e2e 一致）",
    ),
    progress: bool = typer.Option(
        False,
        "--progress",
        help="显示终端进度条",
    ),
) -> None:
    """构建并 upsert feature_matrix（含 feature_sets 元数据）。"""

    setup_logging()
    from quant_pipeline.factors.registry import ensure_loaded
    from quant_pipeline.features.runner import build_feature_matrix

    # builder 的 `_load_factor_ids` 会用 `list_active(factor_version)`，
    # 缓存未加载会抛 `FactorMetaMissing`。统一在 CLI 入口预热。
    ensure_loaded()

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
                new_listing_min_days=new_listing_min_days,
                job_id=None,
                progress_callback=callback,
            )
    else:
        feature_set_id = build_feature_matrix(
            factor_version=factor_version,
            label_scheme=label_scheme,
            date_range=date_range,
            new_listing_min_days=new_listing_min_days,
            job_id=None,
        )

    typer.echo(
        f"features build factor_version={factor_version} label_scheme={label_scheme} "
        f"{date_range}: feature_set_id={feature_set_id}"
    )


@features_app.command("build-inference")
def features_build_inference(
    factor_version: str = typer.Option(
        ...,
        "--factor-version",
        help="所选因子版本（factors.daily_factors.factor_version）",
    ),
    label_scheme: str = typer.Option(
        "strategy-aware",
        "--label-scheme",
        help="标签方案：仅参与 feature_set_id 哈希，与训练共享同一 fsid；不读 labels 表",
    ),
    date_range: str = typer.Option(
        ...,
        "--date-range",
        help="构建窗口 YYYYMMDD:YYYYMMDD（通常用于最新交易日 labels 未闭合的情形）",
    ),
    new_listing_min_days: int = typer.Option(
        60,
        "--new-listing-min-days",
        min=0,
        max=250,
        help="新股过滤门槛（交易日，0 表示不过滤；与 train_e2e 一致）",
    ),
    progress: bool = typer.Option(
        False,
        "--progress",
        help="显示终端进度条",
    ),
) -> None:
    """labels-optional 构建 feature_matrix：跳过 ``_load_labels``，写入行的 label
    列保持 NULL。专用于"给最新交易日 / labels 未闭合日出推理评分"。

    产物落到与训练相同 ``feature_set_id`` 下（共享 fs 元数据）；inference 仅
    SELECT features 列，与训练写入的 label 行可并存。
    """

    setup_logging()
    from quant_pipeline.factors.registry import ensure_loaded
    from quant_pipeline.features.runner import build_feature_matrix_inference

    # `_load_factor_ids` 经 `list_active`；缓存未加载会抛 `FactorMetaMissing`。
    ensure_loaded()

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
            feature_set_id = build_feature_matrix_inference(
                factor_version=factor_version,
                label_scheme=label_scheme,
                date_range=date_range,
                new_listing_min_days=new_listing_min_days,
                job_id=None,
                progress_callback=callback,
            )
    else:
        feature_set_id = build_feature_matrix_inference(
            factor_version=factor_version,
            label_scheme=label_scheme,
            date_range=date_range,
            new_listing_min_days=new_listing_min_days,
            job_id=None,
        )

    typer.echo(
        f"features build-inference factor_version={factor_version} "
        f"label_scheme={label_scheme} {date_range}: feature_set_id={feature_set_id}"
    )


# ----------------------------------------------------------------------
# factors 子命令（M1 Part C）
# ----------------------------------------------------------------------


@factors_app.command("compute")  # type: ignore[untyped-decorator]  # typer 装饰器在 mypy strict 下判为 untyped，仅类型层屏蔽
def factors_compute(
    version: str    = typer.Option(..., "--version",    help="factor_version，如 v1"),
    date_range: str = typer.Option(..., "--date-range", help="YYYYMMDD:YYYYMMDD"),
    factor_ids: str = typer.Option("",  "--factor-ids", help="逗号分隔；留空 = 全部 v1 因子"),
) -> None:
    """对 factor_version 在 date_range 内每个交易日计算因子并 upsert 到 factors.daily_factors。

    CLI 直跑（不写 ml.jobs）；worker dispatcher 走 `worker run` 的 factors 路径。
    """

    setup_logging()
    from quant_pipeline.factors.registry import ensure_loaded, list_factors
    from quant_pipeline.factors.runner import run_factors
    from quant_pipeline.quality.pit_audit import (
        audit_pit_window_covers_min_trade_days,
    )

    try:
        validate_date_range(date_range)
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(code=2) from exc

    # 启动期 PIT 窗口护门校验（spec 2026-05-23-pit-window-guard-design §6.4）：
    # pit_window_days 必须 >= ceil(min_trade_days × PIT_WINDOW_COEFFICIENT)，
    # 不通过则拒启动；info 级"未声明"不阻断。
    ensure_loaded()
    all_factors = list_factors(factor_version=version)
    audit_results = audit_pit_window_covers_min_trade_days(all_factors)
    failed = [r for r in audit_results if not r.passed]
    if failed:
        typer.echo(
            f"启动期 PIT 窗口护门失败：{len(failed)} 个因子的 pit_window_days "
            f"不满足 ceil(min_trade_days × 系数) 下限，拒启动。",
            err=True,
        )
        for r in failed:
            d = r.detail
            typer.echo(
                f"  ! factor_id={d.get('factor_id')} version={d.get('factor_version')} "
                f"declared={d.get('declared')} required={d.get('required')} "
                f"(min_trade_days={d.get('min_trade_days')} × coef={d.get('coefficient')})",
                err=True,
            )
        raise typer.Exit(code=3)

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


# ----------------------------------------------------------------------
# trade-cal 子命令（M4 daily 脚本配套）
# ----------------------------------------------------------------------


@trade_cal_app.command("offset")
def trade_cal_offset(
    base: str = typer.Option(
        ..., "--base", help="基准交易日 YYYYMMDD"
    ),
    days: int = typer.Option(
        ..., "--days",
        help="偏移开市日数；负数往前、正数往后；0 直接回显 base（不校验是否开市）",
    ),
    exchange: str = typer.Option(
        "SSE", "--exchange", help="交易所代码（默认 SSE）"
    ),
) -> None:
    """按 raw.trade_cal 计算交易日偏移；stdout 单行输出 YYYYMMDD。

    语义（**严格**，base 不计入偏移）：
      - days=-30 → cal_date < base 中第 30 个开市日（从近到远第 30 个）
      - days=+5  → cal_date > base 中第 5  个开市日
      - days=0   → 回显 base（不查询 trade_cal）

    适用场景：daily 脚本算 labels 阶段的回填日期 T-30（strategy-aware 标签需
    MAX_HOLD_DAYS=20+T+1≈30 个未来交易日才能闭合 exit 窗）。

    退出码：
      0 = 成功 + stdout 输出目标日期
      2 = 参数校验失败
      3 = raw.trade_cal 数据不足，无法计算 |days| 个开市日偏移
    """

    setup_logging()
    if len(base) != 8 or not base.isdigit():
        typer.echo(f"--base 必须 YYYYMMDD，got {base!r}", err=True)
        raise typer.Exit(code=2)

    if days == 0:
        typer.echo(base)
        return

    from sqlalchemy import text as _text

    from quant_pipeline.db.engine import session_scope

    if days < 0:
        sql = _text(
            """
            SELECT cal_date FROM raw.trade_cal
             WHERE exchange = :ex AND is_open = 1 AND cal_date < :base
             ORDER BY cal_date DESC
             LIMIT :n
            """
        )
        n = abs(days)
    else:
        sql = _text(
            """
            SELECT cal_date FROM raw.trade_cal
             WHERE exchange = :ex AND is_open = 1 AND cal_date > :base
             ORDER BY cal_date ASC
             LIMIT :n
            """
        )
        n = days

    with session_scope() as session:
        rows = session.execute(
            sql, {"ex": exchange, "base": base, "n": n}
        ).fetchall()

    if len(rows) < n:
        typer.echo(
            f"raw.trade_cal 数据不足；need ≥ {n} 个开市日 (exchange={exchange} "
            f"side={'before' if days < 0 else 'after'} base={base})，"
            f"got {len(rows)}",
            err=True,
        )
        raise typer.Exit(code=3)

    # 第 n 个（list 末尾）就是 |days| 个开市日偏移后的目标
    typer.echo(str(rows[n - 1][0]).strip())


if __name__ == "__main__":
    app()
