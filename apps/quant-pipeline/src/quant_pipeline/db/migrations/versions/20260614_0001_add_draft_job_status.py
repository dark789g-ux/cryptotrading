"""ck_jobs_status CHECK 加入 'draft' 草稿态

Revision ID: 20260614_0001
Revises: 20260609_0001
Create Date: 2026-06-14

背景:
ml.jobs 草稿态 + 手动 dispatch（spec 2026-06-14-signaltest-minibacktest-and-job-drafts-design
§6 Part B）。触发弹窗改为「保存草稿」→ POST /quant/jobs (as_draft) 落 status='draft'，
worker 只捞 status='pending' 故草稿不被立即执行；列表「运行」→ dispatch 把 draft→pending。

ml.jobs.status 为 text + CHECK `ck_jobs_status`，当前 6 值（已 docker exec + 实体核实）:
  pending / running / success / failed / blocked / cancelled
此约束自 20260517_0001 初始 migration 建立后未被任何后续 migration 改动（已核 grep）。
非 PG enum，故走 DROP + ADD CHECK（不是 ALTER TYPE）。

本 migration 在原 6 值基础上加 'draft'，是旧约束的真超集，扩展不影响任何合法数据。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260614_0001"
down_revision: str | None = "20260609_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# 单一真相源：upgrade/downgrade 各自引用，避免字符串漂移。
# 新枚举 = 旧 6 值 + 'draft'
_STATUS_WITH_DRAFT = (
    "'pending','running','success','failed','blocked','cancelled','draft'"
)
_STATUS_LEGACY = "'pending','running','success','failed','blocked','cancelled'"


def upgrade() -> None:
    """ck_jobs_status 加入 'draft'（DROP + 重建，新约束为旧约束真超集）。"""

    op.execute("ALTER TABLE ml.jobs DROP CONSTRAINT ck_jobs_status")
    op.execute(
        "ALTER TABLE ml.jobs "
        "ADD CONSTRAINT ck_jobs_status CHECK ("
        f"  status = ANY (ARRAY[{_STATUS_WITH_DRAFT}])"
        ")"
    )


def downgrade() -> None:
    """对称回滚：恢复不含 'draft' 的旧 6 值约束。

    注意：若库内已有 status='draft' 的历史行，旧约束会因这些行校验失败而无法重建
    —— 回滚前需先清理（或终结）这些草稿行。
    """

    op.execute("ALTER TABLE ml.jobs DROP CONSTRAINT ck_jobs_status")
    op.execute(
        "ALTER TABLE ml.jobs "
        "ADD CONSTRAINT ck_jobs_status CHECK ("
        f"  status = ANY (ARRAY[{_STATUS_LEGACY}])"
        ")"
    )
