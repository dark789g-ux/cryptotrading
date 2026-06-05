"""feature_sets_label_ref: factors.feature_sets 加 label_id + label_version 两列

Revision ID: 20260606_0003
Revises: 20260606_0002
Create Date: 2026-06-06

为训练列表显示命名标签名，在 factors.feature_sets 加两列：
  - label_id      TEXT     nullable — 命名标签的 label_id（如 "fwd_5d_ret"）
  - label_version TEXT→INT nullable — 命名标签的版本（如 v1 对应整数 1，存 int）

两列均可空，对存量行零影响；factors.feature_sets 是普通 heap 小表（非分区），
加可空列不锁表重写，廉价。

spec 参考：
  docs/superpowers/specs/2026-06-06-labels-features-incremental-prepare-design/
  05-migration-rollout.md § alembic migration：feature_sets 加列

版本链（已核实，单 head 无脱节）：
  Revises 20260606_0002（strategy_definitions，alembic heads 当前即它）。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260606_0003"
down_revision: str | None = "20260606_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "feature_sets",
        sa.Column("label_id", sa.Text(), nullable=True),
        schema="factors",
    )
    op.add_column(
        "feature_sets",
        sa.Column("label_version", sa.Integer(), nullable=True),
        schema="factors",
    )


def downgrade() -> None:
    op.drop_column("feature_sets", "label_version", schema="factors")
    op.drop_column("feature_sets", "label_id", schema="factors")
