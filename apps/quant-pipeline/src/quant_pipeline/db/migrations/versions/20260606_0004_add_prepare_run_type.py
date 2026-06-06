"""ml.jobs run_type CHECK 加入 'prepare'(备料/训练解耦遗漏的迁移)

Revision ID: 20260606_0004
Revises: 20260606_0003
Create Date: 2026-06-06

背景:
备料/训练解耦改造(spec 2026-06-06-labels-features-incremental-prepare-design)
新增了 `prepare` run_type —— DTO(create-job.dto)、dispatcher、quant-jobs.service、
worker prepare_runner 全部已加,**唯独漏了更新 `ml.jobs` 的 run_type CHECK 约束**。
现存 `ml_jobs_run_type_check`(20260523 重建)枚举为:
  noop / sync / quality / factors / labels / features / train / infer /
  optuna / seed_avg / train_e2e
不含 `prepare` → 前端「备料」提交时 INSERT run_type='prepare' 撞
`violates check constraint "ml_jobs_run_type_check"` → TypeORM 未捕获 → HTTP 500、
且无 job 行落库。与历史上 train_e2e 被 `ck_jobs_run_type` 卡死(20260604_0001)同一
类病:新增 run_type 漏同步 DB 约束。真机 e2e 暴露。

本 migration 把 `prepare` 加进 `ml_jobs_run_type_check`(DROP + 重建,沿用 20260523
模式)。保留 train_e2e(已废弃但历史行存在、QuantJobsView 仍按它过滤);维持现状不
加 `monitor`(延续 20260523 D-15 的范围决定,monitor 既有遗留另行处理)。
幂等:DROP IF EXISTS;新约束是旧约束的真超集,不影响任何合法历史数据。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260606_0004"
down_revision: str | None = "20260606_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# 新枚举 = 旧 11 个 + 'prepare'(单一真相源,upgrade/downgrade 复用避免漂移)。
_RUN_TYPES_WITH_PREPARE = (
    "'noop','sync','quality','factors','labels','features',"
    "'train','infer','optuna','seed_avg','train_e2e','prepare'"
)
_RUN_TYPES_LEGACY = (
    "'noop','sync','quality','factors','labels','features',"
    "'train','infer','optuna','seed_avg','train_e2e'"
)


def upgrade() -> None:
    """把 'prepare' 加进 ml_jobs_run_type_check(DROP + 重建,幂等)。"""

    op.execute("ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check")
    op.execute(
        "ALTER TABLE ml.jobs "
        "ADD CONSTRAINT ml_jobs_run_type_check CHECK ("
        f"  run_type IN ({_RUN_TYPES_WITH_PREPARE})"
        ")"
    )


def downgrade() -> None:
    """对称回滚:恢复不含 'prepare' 的旧约束。

    注意:回滚后若库内已有 run_type='prepare' 的历史行,旧约束(NOT VALID 默认即
    校验现有行)会因这些行无法重建而失败 —— 这是对称回滚的代价,回滚前需先清理或
    改写这些行。生产实际不建议回滚到此点。
    """

    op.execute("ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check")
    op.execute(
        "ALTER TABLE ml.jobs "
        "ADD CONSTRAINT ml_jobs_run_type_check CHECK ("
        f"  run_type IN ({_RUN_TYPES_LEGACY})"
        ")"
    )
