"""quality 子命令（check / pit-audit / gate / monitor）。"""

from __future__ import annotations

import typer

from quant_pipeline.config.logging import setup_logging

quality_app = typer.Typer(
    help=(
        "数据质量门禁子命令（M1 Part E）。"
        "门禁不可被 --force 绕过；strict 模式下 critical 直接 exit 1。"
    )
)


@quality_app.command("check")  # type: ignore[untyped-decorator]  # typer 装饰器在 mypy strict 下判为 untyped，仅类型层屏蔽
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
        f"quality check {date}: critical={report.critical_count} warn={report.warn_count} info={report.info_count} passed={report.passed}"
    )
    for r in report.results:
        if r.passed and r.level != "info":
            continue
        typer.echo(
            f"  - {r.name or r.rule:24s} level={r.level:8s} rule={r.rule:24s} passed={r.passed}"
        )

    if strict and not report.passed:
        raise typer.Exit(code=1)


@quality_app.command("pit-audit")  # type: ignore[untyped-decorator]  # typer 装饰器在 mypy strict 下判为 untyped，仅类型层屏蔽
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
            f"  - {r.name or r.rule:30s} level={r.level:8s} rule={r.rule:20s} date={r.trade_date}"
        )

    if not report.passed:
        raise typer.Exit(code=1)


@quality_app.command("gate")  # type: ignore[untyped-decorator]  # typer 装饰器在 mypy strict 下判为 untyped，仅类型层屏蔽
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
        f"quality gate {mode} {date}: critical={report.critical_count} warn={report.warn_count} info={report.info_count} passed={report.passed}"
    )
    if not report.passed:
        raise typer.Exit(code=1)


# quality monitor 子命令


def run_quality_monitor(*, date: str, model_version: str) -> None:
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


@quality_app.command("monitor")  # type: ignore[untyped-decorator]  # typer 装饰器在 mypy strict 下判为 untyped，仅类型层屏蔽
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

    run_quality_monitor(date=date, model_version=model_version)
