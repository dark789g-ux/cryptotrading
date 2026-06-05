"""fix fwd_5d_ret description: 前复权 → 后复权

Revision ID: 20260606_0001
Revises: 20260605_0001
Create Date: 2026-06-06

close_adj 改纯后复权后（spec docs/superpowers/specs/2026-06-06-close-adj-pure-hfq-design.md），
种子标签 fwd_5d_ret 的 description「前复权」口径与实现不符，更正为「后复权」。

仅更新已部署 DB 的 factors.label_definitions 表行；源码种子
20260605_0001 已同步改文案（两处一致），web 标签库页读 DB、随之显示正确口径。
description 是普通 TEXT 列、非 jsonb，无 CAST 参数绑定坑。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "20260606_0001"
down_revision: str | None = "20260605_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = "未来 5 日后复权收益率（连续值，适合 LambdaRank/回归模型）"
_OLD = "未来 5 日前复权收益率（连续值，适合 LambdaRank/回归模型）"
_SQL = (
    "UPDATE factors.label_definitions SET description = :d "
    "WHERE label_id = 'fwd_5d_ret' AND label_version = 'v1'"
)


def upgrade() -> None:
    op.get_bind().execute(text(_SQL), {"d": _NEW})


def downgrade() -> None:  # _SQL 模板与 upgrade 共用，仅 :d 参数换回旧文案
    op.get_bind().execute(text(_SQL), {"d": _OLD})
