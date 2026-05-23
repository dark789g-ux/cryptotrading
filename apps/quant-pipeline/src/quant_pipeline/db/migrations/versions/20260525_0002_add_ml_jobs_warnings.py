"""ml.jobs: 增加 warnings JSONB 列

Revision ID: 20260525_0002
Revises: 20260525_0001
Create Date: 2026-05-25

PIT 窗口护门（spec 2026-05-23-pit-window-guard-design §06.1）：
- 给 ml.jobs 增加 warnings JSONB NOT NULL DEFAULT '[]'::jsonb
- runner 通过 JSONB || 操作符 append 单元素数组，progress.update_progress
  推送 SSE 时携带 warnings_summary 聚合计数

与 NestJS migration 20260524_ml_jobs_warnings.sql 内容等价。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260525_0002"
down_revision: str | None = "20260525_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE ml.jobs
          ADD COLUMN warnings JSONB NOT NULL DEFAULT '[]'::jsonb
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE ml.jobs
          DROP COLUMN IF EXISTS warnings
        """
    )
