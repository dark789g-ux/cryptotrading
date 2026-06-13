"""集中读取环境变量。

字段命名使用英文以避开 Windows GBK 终端下中文键名问题（CLAUDE.md 硬约束）。
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# settings.py → config → quant_pipeline → src → quant-pipeline → apps → 仓库根
# = parents[5]
_REPO_ROOT = Path(__file__).resolve().parents[5]
_REPO_ENV = _REPO_ROOT / ".env"


class Settings(BaseSettings):  # type: ignore[misc]  # 缺 pydantic-settings stub，基类解析为 Any
    """全局配置；从仓库根 .env / 环境变量读取。"""

    model_config = SettingsConfigDict(
        env_file=str(_REPO_ENV),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # PostgreSQL 连接（SQLAlchemy URL）
    pg_dsn: str = Field(
        default="postgresql+psycopg2://cryptouser:cryptopass@localhost:5432/cryptodb",
        alias="PG_DSN",
    )

    # TuShare（M1 起 sync 模块用；M0 不读）
    tushare_token: str = Field(default="", alias="TUSHARE_TOKEN")

    # 产物与日志目录（POSIX 风格相对路径）
    artifact_dir: str = Field(default="./artifacts", alias="ARTIFACT_DIR")
    log_dir: str = Field(default="./logs", alias="LOG_DIR")

    # Worker 行为
    worker_poll_interval_seconds: float = Field(
        default=2.0, alias="WORKER_POLL_INTERVAL_SECONDS"
    )
    worker_heartbeat_interval_seconds: float = Field(
        default=30.0, alias="WORKER_HEARTBEAT_INTERVAL_SECONDS"
    )
    worker_reaper_interval_seconds: float = Field(
        default=60.0, alias="WORKER_REAPER_INTERVAL_SECONDS"
    )
    # 孤儿 running job 回收阈值：status='running' 且 heartbeat_at 早于
    # now() - 本阈值 的行视为「worker 崩溃/被杀后卡 running 的孤儿」，由 reaper
    # 回收（attempts < max_attempts → 重 pending 重试；否则 → failed）。
    #
    # 取值远大于心跳周期，确保**绝不误杀活 job**：
    #   - 心跳周期 worker_heartbeat_interval_seconds 默认 30s（后台守护线程每 30s
    #     刷一次 heartbeat_at，长任务不再被误判超时）；
    #   - 默认 600s = 10 分钟 ≈ 心跳周期 20 倍，留足 DB 抖动 / GC 卡顿 / 单次心跳
    #     失败重试的容差（_HeartbeatThread 单次失败仅 warning，不立即重刷）。
    # 单位秒；reaper 内部以 make_interval(secs => ...) 比对 now()（项目 datetime
    # 规范：时间列 timestamptz、SQL 比对用 now()）。
    worker_stale_running_threshold_seconds: float = Field(
        default=600.0, alias="WORKER_STALE_RUNNING_THRESHOLD_SECONDS"
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Settings 单例。lru_cache 保证进程内只构造一次。"""

    return Settings()
