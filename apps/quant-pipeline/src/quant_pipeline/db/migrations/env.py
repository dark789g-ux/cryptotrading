"""Alembic env：从 quant_pipeline.config.settings 注入 PG_DSN。

仅管理 factors / ml schema；raw schema 由 NestJS 手写 SQL 管理（参见 01-pg-schema.md §6）。
"""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from quant_pipeline.config.settings import get_settings
from quant_pipeline.db.schemas import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# 用 settings 覆盖 alembic.ini 中空的 sqlalchemy.url
settings = get_settings()
config.set_main_option("sqlalchemy.url", settings.pg_dsn)

target_metadata = Base.metadata


def include_object(object, name, type_, reflected, compare_to):  # noqa: ANN001, A002
    """只关心 factors / ml schema 的对象；其它 schema 一律忽略。"""

    if type_ == "table":
        return object.schema in ("factors", "ml")
    if type_ == "schema":
        return name in ("factors", "ml")
    return True


def run_migrations_offline() -> None:
    """离线模式：直接生成 SQL，不连库。"""

    context.configure(
        url=settings.pg_dsn,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_schemas=True,
        include_object=include_object,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """在线模式：连库执行。"""

    connectable = engine_from_config(
        config.get_section(config.config_ini_section) or {},
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_schemas=True,
            include_object=include_object,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
