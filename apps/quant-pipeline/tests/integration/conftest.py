"""PG 集成测共享 fixture。

require 环境：本机 docker `crypto-postgres` 容器健康，且 raw.* 已有
2024-06 月数据（dry-run §1.1 第一轮已落）。无法连通时全部 skip。
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from quant_pipeline.db.engine import get_engine, session_scope


@pytest.fixture(scope="session", autouse=True)
def _require_pg() -> None:
    """整 session 入口：连不上 docker postgres 直接 skip 全部用例。"""

    try:
        with get_engine().connect() as conn:
            conn.execute(text("SELECT 1"))
    except OperationalError as exc:
        pytest.skip(f"requires docker crypto-postgres: {exc}")


@pytest.fixture()
def pg_session() -> Iterator[Session]:
    """每个用例独立 session。"""

    with session_scope() as session:
        yield session
