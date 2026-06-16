"""ml_jobs_run_type_check 加入 'us_sync' 与 'us_index_sync'

Revision ID: 20260616_0001
Revises: 20260614_0001
Create Date: 2026-06-16

背景:
美股个股 / 指数同步复用 ml.jobs 异步任务表，分别新增 run_type 'us_sync'
（美股个股，spec 2026-06-16-us-stocks-tab）与 'us_index_sync'（美股指数，
spec 2026-06-16-us-index-subtab）。

历史踩坑：新增 run_type 漏更新 ml_jobs_run_type_check → INSERT 撞 CHECK → HTTP 500、
无 job 落库。us-stocks 当时只更新了 TS 侧 run_type 联合 / create-job DTO 白名单，
**未补本 CHECK 约束** → us-stocks 的 UI「同步」按钮在 DB 层即 500（latent bug；
首灌走 CLI `job_id=None` 不写 ml.jobs，故一直未暴露）。本 migration 在美股指数
真机 e2e 触发 us_index_sync POST /sync 撞约束时发现，一并把两者补回。

CHECK 枚举上次修改于 20260609_0001（加 kelly_sweep）；20260614_0001 改的是
ck_jobs_status（不动 run_type）。截至本 migration 前，run_type 枚举为 13 个：
  noop / sync / quality / factors / labels / features / train / infer /
  optuna / seed_avg / train_e2e / prepare / kelly_sweep
本 migration 在此基础上加 us_sync + us_index_sync（旧约束真超集，扩展不影响合法数据）。
沿用 DROP IF EXISTS + 重建模式（幂等、单一真相源）。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260616_0001"
down_revision: str | None = "20260614_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# 单一真相源：upgrade/downgrade 各自引用，避免字符串漂移。
# 新枚举 = 旧 13 个（CHECK 枚举上次改于 20260609_0001）+ us_sync + us_index_sync
_RUN_TYPES_WITH_US = (
    "'noop','sync','quality','factors','labels','features',"
    "'train','infer','optuna','seed_avg','train_e2e','prepare','kelly_sweep',"
    "'us_sync','us_index_sync'"
)
_RUN_TYPES_LEGACY = (
    "'noop','sync','quality','factors','labels','features',"
    "'train','infer','optuna','seed_avg','train_e2e','prepare','kelly_sweep'"
)


def upgrade() -> None:
    """ml_jobs_run_type_check 加入 us_sync + us_index_sync（DROP IF EXISTS + 重建，幂等）。"""

    op.execute("ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check")
    op.execute(
        "ALTER TABLE ml.jobs "
        "ADD CONSTRAINT ml_jobs_run_type_check CHECK ("
        f"  run_type IN ({_RUN_TYPES_WITH_US})"
        ")"
    )


def downgrade() -> None:
    """对称回滚：恢复不含 us_sync / us_index_sync 的旧 13 值约束。

    注意：若库内已有 run_type IN ('us_sync','us_index_sync') 的历史行，旧约束会因这些行
    校验失败而无法重建 —— 回滚前需先清理（或终结）这些行。
    """

    op.execute("ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check")
    op.execute(
        "ALTER TABLE ml.jobs "
        "ADD CONSTRAINT ml_jobs_run_type_check CHECK ("
        f"  run_type IN ({_RUN_TYPES_LEGACY})"
        ")"
    )
