"""research.kelly_sweep_results 结果表 + ml_jobs_run_type_check 加入 'kelly_sweep'

Revision ID: 20260609_0001
Revises: 20260607_0001
Create Date: 2026-06-09

背景:
凯利网格搜索 Web 操作台（spec 2026-06-09-kelly-sweep-web-console-design）
复用现有 ml.jobs 异步任务表，新增 kelly_sweep run_type；扫描结果落专用表。

本 migration 完成两件事：

1. ml_jobs_run_type_check 加入 'kelly_sweep'
   历史踩坑：新增 run_type 漏更新 CHECK 约束 → INSERT 撞约束 → HTTP 500、无 job 落库。
   沿用 DROP+重建模式（幂等、单一真相源、新约束是旧约束真超集）。
   CHECK 枚举上次修改于 20260606_0004（加 prepare）；20260607_0001 是当前 head，
   本身不改 CHECK。截至本 migration 前，约束枚举为：
     noop / sync / quality / factors / labels / features / train / infer /
     optuna / seed_avg / train_e2e / prepare
   本 migration 在此基础上加 kelly_sweep。

2. 建 research schema + kelly_sweep_results 结果表 + 两个索引
   全量 ResultRow（sweep.py:135-212）落独立 research schema 专表。
   字段、类型、可空性严格按 spec 02-data-model.md 的「结果表 DDL」。
   不落 valid_keys（每行可能上千对，省大量空间；CI 已由 rank_top_k 算好存入 kelly_ci_low/high）。
   所有语句用 IF NOT EXISTS 保证幂等。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260609_0001"
down_revision: str | None = "20260607_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# 单一真相源：upgrade/downgrade 各自引用，避免字符串漂移。
# 新枚举 = 旧 12 个（CHECK 枚举上次改于 20260606_0004）+ 'kelly_sweep'
_RUN_TYPES_WITH_KELLY = (
    "'noop','sync','quality','factors','labels','features',"
    "'train','infer','optuna','seed_avg','train_e2e','prepare','kelly_sweep'"
)
_RUN_TYPES_LEGACY = (
    "'noop','sync','quality','factors','labels','features',"
    "'train','infer','optuna','seed_avg','train_e2e','prepare'"
)


def upgrade() -> None:
    """
    1. ml_jobs_run_type_check 加入 kelly_sweep（DROP IF EXISTS + 重建，幂等）。
    2. 建 research schema + kelly_sweep_results 表 + 两个索引（全部 IF NOT EXISTS）。
    """

    # ── 动作 1：CHECK 约束 ──────────────────────────────────────────────────
    op.execute("ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check")
    op.execute(
        "ALTER TABLE ml.jobs "
        "ADD CONSTRAINT ml_jobs_run_type_check CHECK ("
        f"  run_type IN ({_RUN_TYPES_WITH_KELLY})"
        ")"
    )

    # ── 动作 2：research schema + 结果表 + 索引 ──────────────────────────────
    op.execute("CREATE SCHEMA IF NOT EXISTS research")

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS research.kelly_sweep_results (
          id                  BIGSERIAL PRIMARY KEY,
          job_id              UUID NOT NULL REFERENCES ml.jobs(id) ON DELETE CASCADE,
          window_group        TEXT NOT NULL,
          variant_id          TEXT NOT NULL,
          variant_filters     JSONB NOT NULL,
          exit_id             TEXT NOT NULL,
          exit_cfg            JSONB NOT NULL,
          n_train             INTEGER NOT NULL,
          kelly_train         DOUBLE PRECISION,
          win_rate_train      DOUBLE PRECISION,
          payoff_b_train      DOUBLE PRECISION,
          profit_factor_train DOUBLE PRECISION,
          n_valid             INTEGER NOT NULL,
          kelly_valid         DOUBLE PRECISION,
          win_rate_valid      DOUBLE PRECISION,
          payoff_b_valid      DOUBLE PRECISION,
          profit_factor_valid DOUBLE PRECISION,
          below_floor         BOOLEAN NOT NULL,
          kelly_ci_low        DOUBLE PRECISION,
          kelly_ci_high       DOUBLE PRECISION,
          is_frontier         BOOLEAN NOT NULL DEFAULT FALSE,
          is_topk             BOOLEAN NOT NULL DEFAULT FALSE,
          same_day_rule       TEXT NOT NULL,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )

    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_ksr_job_group "
        "ON research.kelly_sweep_results (job_id, window_group)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_ksr_job_topk "
        "ON research.kelly_sweep_results (job_id, is_topk, kelly_valid DESC)"
    )


def downgrade() -> None:
    """对称回滚：删索引 + 删表 + 删 schema + 恢复不含 kelly_sweep 的旧约束。

    注意：
    - 回滚 CHECK 约束时，若库内已有 run_type='kelly_sweep' 的历史行，旧约束会因这些行
      校验失败而无法重建 —— 回滚前需先清理这些行。生产实际不建议回滚到此点。
    - DROP TABLE 会级联删除数据；仅在确认数据已备份后执行 downgrade。
    - research schema 内若还有其他对象，DROP SCHEMA 会失败（RESTRICT 默认行为）。
    """

    # ── 回滚动作 2：删索引 + 删表（schema 若空则删）──────────────────────────
    op.execute("DROP INDEX IF EXISTS research.idx_ksr_job_topk")
    op.execute("DROP INDEX IF EXISTS research.idx_ksr_job_group")
    op.execute("DROP TABLE IF EXISTS research.kelly_sweep_results")
    op.execute("DROP SCHEMA IF EXISTS research")

    # ── 回滚动作 1：CHECK 约束恢复旧枚举 ────────────────────────────────────
    op.execute("ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check")
    op.execute(
        "ALTER TABLE ml.jobs "
        "ADD CONSTRAINT ml_jobs_run_type_check CHECK ("
        f"  run_type IN ({_RUN_TYPES_LEGACY})"
        ")"
    )
