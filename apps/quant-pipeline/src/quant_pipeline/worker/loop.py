"""常驻 worker 主循环。

行为（02-quant-pipeline.md §4）：
1. 启动时先跑一次 reaper
2. 之后循环：poll → 若有 job 则 dispatch；无 job 则 sleep poll_interval
3. 每 reaper_interval_seconds 跑一次 reaper
4. heartbeat：Dispatcher.dispatch 在 runner 执行期间起后台守护线程
   （_HeartbeatThread），按 worker_heartbeat_interval_seconds 周期刷
   heartbeat_at，长任务不再被 reaper 误杀。update_progress 仍会顺带刷。
"""

from __future__ import annotations

import logging
import signal
import time
from types import FrameType

from quant_pipeline.config.settings import get_settings
from quant_pipeline.worker.dispatcher import Dispatcher, reap_stale_running_jobs
from quant_pipeline.worker.poller import poll_one

logger = logging.getLogger(__name__)


class _StopFlag:
    def __init__(self) -> None:
        self.stopped = False

    def request_stop(self, signum: int, frame: FrameType | None) -> None:
        logger.info("stop_requested", extra={"signal": signum})
        self.stopped = True


def run_worker_loop() -> None:
    """常驻循环。Ctrl+C / SIGTERM 优雅退出。"""

    settings = get_settings()

    # ── schema 契约校验 ──
    from quant_pipeline.db import session_scope
    from quant_pipeline.db.schema_contract import validate_schema
    with session_scope() as session:
        validate_schema(session)

    dispatcher = Dispatcher()
    stop = _StopFlag()

    signal.signal(signal.SIGINT, stop.request_stop)
    # Windows 不支持 SIGTERM 给本进程注册 handler，try 一下不致命
    try:
        signal.signal(signal.SIGTERM, stop.request_stop)
    except (AttributeError, ValueError):
        pass

    logger.info("worker_started")
    # 孤儿回收阈值：worker 崩溃/被杀后卡 running 的行，heartbeat_at 超此阈值即回收。
    # 远大于心跳周期，绝不误杀活 job（见 settings.worker_stale_running_threshold_seconds）。
    stale_threshold = settings.worker_stale_running_threshold_seconds
    # 启动时回收一次（worker 上一轮被杀留下的孤儿）。
    try:
        reap_stale_running_jobs(stale_threshold)
    except Exception as exc:  # noqa: BLE001
        logger.error("reaper_startup_failed", extra={"err": str(exc)})

    last_reap = time.monotonic()
    while not stop.stopped:
        try:
            job = poll_one()
        except Exception as exc:  # noqa: BLE001
            logger.error("poll_failed", extra={"err": str(exc)})
            time.sleep(settings.worker_poll_interval_seconds)
            continue

        if job is None:
            time.sleep(settings.worker_poll_interval_seconds)
        else:
            dispatcher.dispatch(job)

        # reaper 周期触发（每 worker_reaper_interval_seconds 一次，集成进循环、
        # 非独立 cron 守护进程）。staleness 阈值远大于此 cadence，故按 cadence 周期
        # 回收与「每轮 poll 前回收」在功能上等价（孤儿只在超阈值后才可回收），但 DB
        # 开销低一个量级，故沿用既有周期触发而非每轮 poll 都跑。
        if time.monotonic() - last_reap > settings.worker_reaper_interval_seconds:
            try:
                reap_stale_running_jobs(stale_threshold)
            except Exception as exc:  # noqa: BLE001
                logger.error("reaper_failed", extra={"err": str(exc)})
            last_reap = time.monotonic()

    logger.info("worker_stopped")
