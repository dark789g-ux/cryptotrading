"""worker 常驻入口（`python -m quant_pipeline.worker` 与 `quant-worker` 共用）。

仅作入口，不改 worker 业务逻辑：复用 `run_worker_loop()`（其内部经 settings
从仓库根 `.env` 读取 DB 配置，本入口不触碰该路径）。

`main()` 与 `quant worker run`（cli.py worker_run）一致，先 `setup_logging()`
再进循环，保证 worker 的 INFO 日志（worker_started / poll 等）可见。
`pyproject` 的 `quant-worker` console script 指向本模块 `main`，使三条入口
（`python -m` / `quant-worker` / `quant worker run`）日志行为一致。

必须保留 `if __name__ == "__main__"` 守卫：否则 import 即执行会阻塞
（run_worker_loop 是常驻轮询循环）；console script 走 `main` 同样不受 import 影响。
"""

from __future__ import annotations

from quant_pipeline.config.logging import setup_logging
from quant_pipeline.worker.loop import run_worker_loop


def main() -> None:
    """配好日志后进入常驻轮询循环。"""
    setup_logging()
    run_worker_loop()


if __name__ == "__main__":
    main()
