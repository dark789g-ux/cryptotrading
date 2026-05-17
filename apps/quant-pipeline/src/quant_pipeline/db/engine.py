"""SQLAlchemy engine 单例与 session 上下文。"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from quant_pipeline.config.settings import get_settings


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    """进程级 Engine 单例。"""

    settings = get_settings()
    return create_engine(
        settings.pg_dsn,
        pool_size=5,
        max_overflow=10,
        pool_pre_ping=True,
        future=True,
    )


@lru_cache(maxsize=1)
def _get_session_factory() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), expire_on_commit=False, future=True)


@contextmanager
def session_scope() -> Iterator[Session]:
    """事务级 session 上下文：自动 commit / 异常 rollback。"""

    session = _get_session_factory()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
