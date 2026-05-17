"""quant-pipeline CLI 入口。

M0 阶段仅暴露 worker / version 两组命令；其余 sync / quality / factors /
labels / features / train / evaluate / infer 子命令在 M1+ 落实。
"""

from __future__ import annotations

import typer

from quant_pipeline import __version__
from quant_pipeline.config.logging import setup_logging

app = typer.Typer(
    name="quant",
    help="quant-pipeline CLI（M0 仅 worker / version）",
    no_args_is_help=True,
    add_completion=False,
)

worker_app = typer.Typer(help="worker 子命令")
app.add_typer(worker_app, name="worker")


@app.command()
def version() -> None:
    """打印版本号。"""

    typer.echo(f"quant-pipeline {__version__}")


@worker_app.command("run")
def worker_run() -> None:
    """启动常驻 worker（轮询 ml.jobs）。"""

    setup_logging()
    # 延迟 import 以避免 cli --help 时拖入 DB engine
    from quant_pipeline.worker.loop import run_worker_loop

    run_worker_loop()


if __name__ == "__main__":
    app()
