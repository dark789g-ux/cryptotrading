"""集中读取环境变量。

字段命名使用英文以避开 Windows GBK 终端下中文键名问题（CLAUDE.md 硬约束）。
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """全局配置；从 .env / 环境变量读取。"""

    model_config = SettingsConfigDict(
        env_file=".env",
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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Settings 单例。lru_cache 保证进程内只构造一次。"""

    return Settings()
