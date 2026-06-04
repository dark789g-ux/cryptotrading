"""drop 遗留的 ck_jobs_run_type 约束(被 ml_jobs_run_type_check 取代)

Revision ID: 20260604_0001
Revises: 20260529_0001
Create Date: 2026-06-04

背景:
ml.jobs 上历史存在两个 run_type CHECK 约束并存:
- `ck_jobs_run_type`        (20260517 初始 migration 建,枚举不含 train_e2e)
- `ml_jobs_run_type_check`  (20260523 migration 重建,枚举含 train_e2e)

20260523 那次只 DROP/重建了 `ml_jobs_run_type_check`,漏删旧的
`ck_jobs_run_type`。两者是 AND 关系,旧约束把 train_e2e 卡死 —— 前端触发
train_e2e 训练时 INSERT 报 `violates check constraint "ck_jobs_run_type"`
→ HTTP 500。这也解释了为何 ml.jobs 历史上只跑过 noop(noop 在两个枚举里都有)。

本 migration 删除冗余的旧约束。它是 `ml_jobs_run_type_check` 的真子集
(相同 10 个值,后者多一个 train_e2e),删除不影响任何合法数据。

注:生产 DB 已于 2026-06-04 手动执行
`ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ck_jobs_run_type`
解除阻塞;本文件用 IF EXISTS 保证对该库重跑为 no-op,对尚未应用的环境为真正
修复(幂等)。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260604_0001"
down_revision: str | None = "20260529_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """删除冗余旧约束(幂等)。"""

    op.execute(
        "ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ck_jobs_run_type"
    )


def downgrade() -> None:
    """对称回滚:重建旧约束(恢复到本 migration 之前的 schema 状态)。

    注意:重建后 `ck_jobs_run_type` 与 `ml_jobs_run_type_check` 再次共存,
    旧约束枚举不含 train_e2e —— 即恢复 train_e2e 被卡死的已知冲突状态。
    这是对称回滚的代价,符合 alembic 惯例;实际不建议回滚到此点。
    """

    op.execute(
        "ALTER TABLE ml.jobs "
        "ADD CONSTRAINT ck_jobs_run_type CHECK ("
        "  run_type IN ("
        "    'noop','sync','quality','factors','labels','features',"
        "    'train','infer','optuna','seed_avg'"
        "  )"
        ")"
    )
