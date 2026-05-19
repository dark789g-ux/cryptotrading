"""factors 三表月度分区预建（2018-01 → 2030-12）

Revision ID: 20260520_0001
Revises: 20260517_0002
Create Date: 2026-05-20

对齐 doc/specs/2026-05-20-m1-dryrun-bugfix-design.md §4。

背景：
- `20260517_0001` 已声明 factors.daily_factors / labels / feature_matrix 三张父表
  为 `PARTITION BY RANGE (trade_date)`，但未建任何子分区
- M1 dry-run 首次 INSERT 触发 `CheckViolation: no partition of relation found`
- 本 migration 预建 2018-01 ~ 2030-12 共 156 个月 × 3 表 = 468 个子分区

约束：
- 分区命名 `<parent>_y<YYYY>m<MM>`（与 dry-run 第一轮手工建的
  daily_factors_y2024m06 同名，确保 IF NOT EXISTS 幂等）
- 范围 `FOR VALUES FROM ('YYYYMM01') TO ('下月YYYYMM01')`，char(8) 字典序成立
- 父表不动；TRUNCATE 不在 migration 内（交给 c5 step 0）

SQL 红线豁免：
- f-string 拼接的标识符与日界字面量均由 migration 内常量
  `range(2018, 2031) × range(1, 13)` 生成，无任何外部输入，
  不触发 CLAUDE.md "动态 SQL 构建禁止直接拼接前端字段名"红线
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260520_0001"
down_revision: str | None = "20260517_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# 父表列表（顺序仅用于可读性；分区操作互不依赖）
_PARENT_TABLES: tuple[str, ...] = ("daily_factors", "labels", "feature_matrix")

# 预建窗口：2018-01 ~ 2030-12，共 156 月
_YEAR_START: int = 2018
_YEAR_END_EXCLUSIVE: int = 2031  # range 右开


def _iter_month_bounds() -> list[tuple[int, int, str, str]]:
    """生成 (year, month, lo, hi) 元组列表。

    lo / hi 为 char(8) 形式 'YYYYMM01'，hi = 下月 1 日。
    跨年时月份回到 01、年份 +1。
    """
    bounds: list[tuple[int, int, str, str]] = []
    for year in range(_YEAR_START, _YEAR_END_EXCLUSIVE):
        for month in range(1, 13):
            lo = f"{year:04d}{month:02d}01"
            if month < 12:
                nxt_y, nxt_m = year, month + 1
            else:
                nxt_y, nxt_m = year + 1, 1
            hi = f"{nxt_y:04d}{nxt_m:02d}01"
            bounds.append((year, month, lo, hi))
    return bounds


def upgrade() -> None:
    """对 factors.daily_factors / labels / feature_matrix 三张父表
    预建 2018-01 ~ 2030-12 共 156 月 × 3 表 = 468 个子分区。

    使用 CREATE TABLE IF NOT EXISTS 保证幂等：
    - dry-run 第一轮手工建的 daily_factors_y2024m06 不冲突
    - migration 自身可重复执行
    """
    bounds = _iter_month_bounds()
    for parent in _PARENT_TABLES:
        for year, month, lo, hi in bounds:
            part = f"{parent}_y{year:04d}m{month:02d}"
            op.execute(
                f"CREATE TABLE IF NOT EXISTS factors.{part} "
                f"PARTITION OF factors.{parent} "
                f"FOR VALUES FROM ('{lo}') TO ('{hi}')"
            )


def downgrade() -> None:
    """反向 DROP 全部 468 个子分区。父表由 20260517_0001 管理，本 migration 不动。"""
    bounds = _iter_month_bounds()
    for parent in _PARENT_TABLES:
        for year, month, _lo, _hi in bounds:
            part = f"{parent}_y{year:04d}m{month:02d}"
            op.execute(f"DROP TABLE IF EXISTS factors.{part}")
