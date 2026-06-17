"""ml_jobs_run_type_check 加入 'us_one_click_sync'

Revision ID: 20260617_0001
Revises: 20260616_0002
Create Date: 2026-06-17

背景:
美股一键同步复用 ml.jobs 异步任务表：一条 job 在 worker 内顺序跑三步
（us_sync → us_index_sync → us_index_amv_sync），新增 run_type
'us_one_click_sync'（Python worker dispatcher 路由，spec 2026-06-17-us-sync-tab-design）。

历史踩坑：新增 run_type 漏更新 ml_jobs_run_type_check → INSERT 撞 CHECK → HTTP 500、
无 job 落库（reference_run_type_check_constraint 教训）。新增 run_type 必须同时改三处：
alembic（本文件，权威）+ NestJS SQL 镜像 + TS 类型 / DTO 白名单。

CHECK 枚举上次修改于 20260616_0002（加 us_index_amv_sync，共 16 个）。本 migration
在此基础上加 us_one_click_sync（旧约束真超集，扩展不影响合法数据），共 17 个：
  noop / sync / quality / factors / labels / features / train / infer /
  optuna / seed_avg / train_e2e / prepare / kelly_sweep /
  us_sync / us_index_sync / us_index_amv_sync / us_one_click_sync
沿用 DROP IF EXISTS + 重建模式（幂等、单一真相源）。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260617_0001"
down_revision: str | None = "20260616_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# 单一真相源：upgrade/downgrade 各自引用，避免字符串漂移。
# 新枚举 = 20260616_0002 的 16 个 + us_one_click_sync
_RUN_TYPES_WITH_US_ONE_CLICK = (
    "'noop','sync','quality','factors','labels','features',"
    "'train','infer','optuna','seed_avg','train_e2e','prepare','kelly_sweep',"
    "'us_sync','us_index_sync','us_index_amv_sync','us_one_click_sync'"
)
_RUN_TYPES_LEGACY = (
    "'noop','sync','quality','factors','labels','features',"
    "'train','infer','optuna','seed_avg','train_e2e','prepare','kelly_sweep',"
    "'us_sync','us_index_sync','us_index_amv_sync'"
)


def upgrade() -> None:
    """ml_jobs_run_type_check 加入 us_one_click_sync（DROP IF EXISTS + 重建，幂等）。"""

    op.execute("ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check")
    op.execute(
        "ALTER TABLE ml.jobs "
        "ADD CONSTRAINT ml_jobs_run_type_check CHECK ("
        f"  run_type IN ({_RUN_TYPES_WITH_US_ONE_CLICK})"
        ")"
    )


def downgrade() -> None:
    """对称回滚：恢复不含 us_one_click_sync 的 16 值约束。

    注意：若库内已有 run_type = 'us_one_click_sync' 的历史行，旧约束会因这些行校验失败而无法
    重建 —— 回滚前需先清理（或终结）这些行。
    """

    op.execute("ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check")
    op.execute(
        "ALTER TABLE ml.jobs "
        "ADD CONSTRAINT ml_jobs_run_type_check CHECK ("
        f"  run_type IN ({_RUN_TYPES_LEGACY})"
        ")"
    )
