"""ml.model_runs: 增加 status TEXT 列（prod / shadow / archived）

Revision ID: 20260529_0001
Revises: 20260525_0002
Create Date: 2026-05-29

spec 2026-05-29 P2.1：infer CLI 自动选模型从 max(created_at) 切换到
WHERE status='prod' ORDER BY created_at DESC LIMIT 1。新增列默认 'shadow'，
seed-avg 集成模型上线后由运维显式 UPDATE 升 prod。

与 NestJS migration `apps/server/migrations/20260529_ml_model_runs_status.sql`
内容等价。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260529_0001"
down_revision: str | None = "20260525_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE ml.model_runs
          ADD COLUMN status TEXT NOT NULL DEFAULT 'shadow'
        """
    )
    op.execute(
        """
        ALTER TABLE ml.model_runs
          ADD CONSTRAINT chk_model_runs_status
            CHECK (status IN ('prod', 'shadow', 'archived'))
        """
    )
    op.execute(
        """
        CREATE INDEX idx_model_runs_status_created
          ON ml.model_runs (status, created_at DESC)
        """
    )
    op.execute(
        """
        UPDATE ml.model_runs
           SET status = 'prod'
         WHERE model_version = 'lgb-lambdarank-v1-20260521-seed42'
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ml.idx_model_runs_status_created")
    op.execute(
        """
        ALTER TABLE ml.model_runs
          DROP CONSTRAINT IF EXISTS chk_model_runs_status
        """
    )
    op.execute(
        """
        ALTER TABLE ml.model_runs
          DROP COLUMN IF EXISTS status
        """
    )
