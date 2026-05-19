"""factors 月度分区 migration PG 集成测。

覆盖 spec doc/specs/2026-05-20-m1-dryrun-bugfix-design.md §7.2 三个用例：
- test_migration_creates_468_partitions
- test_partition_bounds_consistent
- test_idempotent_rerun

前置：alembic upgrade head 已跑（c5 step 1 之后），即 20260520_0001 已落地。
"""

from __future__ import annotations

import re

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session


_PARENT_TABLES: tuple[str, ...] = ("daily_factors", "labels", "feature_matrix")
_PARTITIONS_PER_PARENT: int = 156  # 2018-01 ~ 2030-12
_PART_NAME_RE = re.compile(r"^(daily_factors|labels|feature_matrix)_y\d{4}m\d{2}$")


def _list_partitions(session: Session, parent: str) -> list[str]:
    rows = session.execute(
        text(
            """
            SELECT c.relname
            FROM pg_inherits i
            JOIN pg_class p ON p.oid = i.inhparent
            JOIN pg_class c ON c.oid = i.inhrelid
            JOIN pg_namespace np ON np.oid = p.relnamespace
            WHERE np.nspname = 'factors' AND p.relname = :parent
            ORDER BY c.relname
            """
        ),
        {"parent": parent},
    ).all()
    return [r[0] for r in rows]


# ---------------------------------------------------------------------------
# §7.2 用例 1：严格 156 个子分区
# ---------------------------------------------------------------------------

def test_migration_creates_468_partitions(pg_session: Session) -> None:
    """daily_factors / labels / feature_matrix 各严格 156 个子分区。

    注：后续 migration 追加分区时必须同步更新本断言常量
    `_PARTITIONS_PER_PARENT`（spec §7.2 注释）。
    """

    for parent in _PARENT_TABLES:
        parts = _list_partitions(pg_session, parent)
        assert len(parts) == _PARTITIONS_PER_PARENT, (
            f"factors.{parent} 应严格 {_PARTITIONS_PER_PARENT} 个子分区，得 {len(parts)}"
        )
        for name in parts:
            assert _PART_NAME_RE.match(name), f"分区命名异常：{name}"


# ---------------------------------------------------------------------------
# §7.2 用例 2：分区边界一致（月初 → 下月初）
# ---------------------------------------------------------------------------

def test_partition_bounds_consistent(pg_session: Session) -> None:
    """抽样 5 个分区（含 daily_factors_y2024m06）→ pg_get_expr 输出月初到下月初。"""

    samples = [
        ("daily_factors_y2018m01", "FOR VALUES FROM ('20180101') TO ('20180201')"),
        ("daily_factors_y2018m12", "FOR VALUES FROM ('20181201') TO ('20190101')"),
        ("daily_factors_y2024m06", "FOR VALUES FROM ('20240601') TO ('20240701')"),
        ("labels_y2026m05", "FOR VALUES FROM ('20260501') TO ('20260601')"),
        ("feature_matrix_y2030m12", "FOR VALUES FROM ('20301201') TO ('20310101')"),
    ]

    for name, expected in samples:
        row = pg_session.execute(
            text(
                """
                SELECT pg_get_expr(c.relpartbound, c.oid) AS bound
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'factors' AND c.relname = :name
                """
            ),
            {"name": name},
        ).one_or_none()
        assert row is not None, f"分区 factors.{name} 缺失"
        assert row.bound == expected, (
            f"factors.{name} 边界异常：期望 {expected}，得 {row.bound}"
        )


# ---------------------------------------------------------------------------
# §7.2 用例 3：migration 幂等（手工再 op.execute 主体 → 不抛错）
# ---------------------------------------------------------------------------

def test_idempotent_rerun(pg_session: Session) -> None:
    """直接重跑 upgrade() 主体 SQL（含 IF NOT EXISTS）→ 不抛错；行数不变。"""

    before = sum(
        len(_list_partitions(pg_session, p)) for p in _PARENT_TABLES
    )

    # 复用 migration 的边界生成逻辑（文件名以数字开头，用 importlib）
    import importlib

    mod = importlib.import_module(
        "quant_pipeline.db.migrations.versions."
        "20260520_0001_factors_monthly_partitions"
    )
    bounds = mod._iter_month_bounds()
    # 只抽 3 月做幂等校验（156 月全跑慢且对断言无增益）
    sample = [bounds[0], bounds[77], bounds[-1]]
    for parent in _PARENT_TABLES:
        for year, month, lo, hi in sample:
            part = f"{parent}_y{year:04d}m{month:02d}"
            # 用与 migration 完全相同的 DDL；IF NOT EXISTS 保证幂等
            pg_session.execute(
                text(
                    f"CREATE TABLE IF NOT EXISTS factors.{part} "
                    f"PARTITION OF factors.{parent} "
                    f"FOR VALUES FROM ('{lo}') TO ('{hi}')"
                )
            )
    pg_session.commit()

    after = sum(
        len(_list_partitions(pg_session, p)) for p in _PARENT_TABLES
    )
    assert after == before, f"幂等重跑应不改分区总数；before={before} after={after}"
