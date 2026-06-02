"""CLI 共享工具。

- console：rich Console 单例（force_terminal=True）。
- make_progress_callback：CLI 终端进度条回调（cli.py / cli_ml.py 共用，问题 7）。
- validate_date_range：YYYYMMDD:YYYYMMDD 格式校验（CLI 与 dispatcher 共用，问题 8）。
"""

from __future__ import annotations

from collections.abc import Callable

from rich.console import Console
from rich.progress import Progress

# CLI 共享 Console 单例（原 cli.py / cli_ml.py 各建一次）
console = Console(force_terminal=True)


def make_progress_callback(
    progress: Progress, task_id: int
) -> Callable[[int, str], None]:
    """创建 CLI 进度回调函数，用于 runner 报告进度。"""

    def callback(pct: int, stage: str) -> None:
        progress.update(task_id, completed=pct, description=f"[cyan]{stage}")

    return callback


def validate_date_range(date_range: str) -> tuple[str, str]:
    """校验并拆分 'YYYYMMDD:YYYYMMDD' 区间字符串。

    与 worker dispatcher 的 _runner_sync / sync.orchestrator._parse_date_range
    保持同一校验规则（问题 8：CLI 直跑路径原先不校验，错误一路下传到
    orchestrator 才报）。校验失败抛 ValueError。

    返回 (start, end) 两个 YYYYMMDD 字符串。
    """

    if not isinstance(date_range, str) or ":" not in date_range:
        raise ValueError(
            f"date_range 必须是 'YYYYMMDD:YYYYMMDD'，got {date_range!r}"
        )
    start, end = date_range.split(":", 1)
    if (
        len(start) != 8
        or len(end) != 8
        or not start.isdigit()
        or not end.isdigit()
    ):
        raise ValueError(f"date_range 必须是 YYYYMMDD 对，got {date_range!r}")
    return start, end
