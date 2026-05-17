"""factors / ml schema 初始化

Revision ID: 20260517_0001
Revises:
Create Date: 2026-05-17

严格对齐 doc/specs/2026-05-17-quant-model-training/01-pg-schema.md §3-§4。

注意：
- raw schema 由 NestJS 手写 SQL 管理，本 migration 不涉及
- factors schema 表按月分区（PARTITION BY RANGE (trade_date)）
- ml.scores_daily 列名为 rank_in_day（避开 PG 关键字 rank）
- ml.jobs 含完整扩展字段：heartbeat_at / attempts / max_attempts /
  cancel_requested / parent_job_id / priority
- 所有时间列一律 timestamptz（CLAUDE.md 时间规范）
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260517_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 0. 三 schema 存在性兜底（生产环境应由前置 docker exec 脚本创建；
    #    此处 IF NOT EXISTS 保证测试库自动可重建）
    # ------------------------------------------------------------------
    op.execute("CREATE SCHEMA IF NOT EXISTS factors")
    op.execute("CREATE SCHEMA IF NOT EXISTS ml")

    # ==================================================================
    # factors schema（§3）
    # ==================================================================

    # ------------------------------------------------------------------
    # factors.daily_factors —— 长格式因子值，按月分区
    # ------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE factors.daily_factors (
            trade_date      char(8)          NOT NULL,
            ts_code         varchar(16)      NOT NULL,
            factor_id       text             NOT NULL,
            factor_version  text             NOT NULL,
            value           double precision,
            PRIMARY KEY (trade_date, ts_code, factor_id, factor_version)
        ) PARTITION BY RANGE (trade_date)
        """
    )
    op.execute(
        "COMMENT ON TABLE factors.daily_factors IS "
        "'因子原值长表（trade_date, ts_code, factor_id, factor_version → value）；按月分区'"
    )
    op.execute(
        "CREATE INDEX ix_factors_daily_factors_factor_date "
        "ON factors.daily_factors (factor_id, factor_version, trade_date)"
    )

    # ------------------------------------------------------------------
    # factors.labels —— 标签表（strategy-aware / fwd_5d_ret 等）
    # ------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE factors.labels (
            trade_date    char(8)          NOT NULL,
            ts_code       varchar(16)      NOT NULL,
            scheme        text             NOT NULL,
            value         double precision,
            exit_reason   text,
            hold_days     smallint,
            PRIMARY KEY (trade_date, ts_code, scheme)
        ) PARTITION BY RANGE (trade_date)
        """
    )
    op.execute(
        "COMMENT ON TABLE factors.labels IS "
        "'标签表：strategy-aware（推荐）/ fwd_5d_ret（兜底）；按月分区'"
    )
    op.execute(
        "CREATE INDEX ix_factors_labels_scheme_date "
        "ON factors.labels (scheme, trade_date)"
    )

    # ------------------------------------------------------------------
    # factors.feature_sets —— 特征集元数据
    # ------------------------------------------------------------------
    op.create_table(
        "feature_sets",
        sa.Column("feature_set_id", sa.Text(), primary_key=True),
        sa.Column("factor_version", sa.Text(), nullable=False),
        sa.Column("scheme", sa.Text(), nullable=False),
        sa.Column(
            "factor_ids",
            sa.ARRAY(sa.Text()),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        schema="factors",
    )
    op.execute(
        "COMMENT ON TABLE factors.feature_sets IS "
        "'特征集元数据：feature_set_id × factor_version × scheme → factor_ids[]'"
    )

    # ------------------------------------------------------------------
    # factors.feature_matrix —— 宽格式训练矩阵，按月分区
    # ------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE factors.feature_matrix (
            trade_date      char(8)          NOT NULL,
            ts_code         varchar(16)      NOT NULL,
            feature_set_id  text             NOT NULL,
            features        jsonb            NOT NULL,
            label           double precision,
            PRIMARY KEY (trade_date, ts_code, feature_set_id)
        ) PARTITION BY RANGE (trade_date)
        """
    )
    op.execute(
        "COMMENT ON TABLE factors.feature_matrix IS "
        "'宽格式训练矩阵（按 feature_set 分区）；features 列为 jsonb 暂存（M2 视容量再决定是否拍平）'"
    )
    op.execute(
        "CREATE INDEX ix_factors_feature_matrix_set_date "
        "ON factors.feature_matrix (feature_set_id, trade_date)"
    )

    # ==================================================================
    # ml schema（§4）
    # ==================================================================

    # ------------------------------------------------------------------
    # ml.jobs —— 作业队列（NestJS 写 pending，Python worker 取行执行）
    # ------------------------------------------------------------------
    op.create_table(
        "jobs",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("run_type", sa.Text(), nullable=False),
        sa.Column(
            "params",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column(
            "progress",
            sa.SmallInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("stage", sa.Text(), nullable=True),
        sa.Column(
            "priority",
            sa.SmallInteger(),
            nullable=False,
            server_default=sa.text("100"),
        ),
        sa.Column(
            "attempts",
            sa.SmallInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "max_attempts",
            sa.SmallInteger(),
            nullable=False,
            server_default=sa.text("1"),
        ),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "cancel_requested",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "parent_job_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ml.jobs.id"),
            nullable=True,
        ),
        sa.Column("log_url", sa.Text(), nullable=True),
        sa.Column("error_text", sa.Text(), nullable=True),
        sa.Column("blocked_reason", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "run_type IN ('noop','sync','quality','factors','labels','features',"
            "'train','infer','optuna','seed_avg')",
            name="ck_jobs_run_type",
        ),
        sa.CheckConstraint(
            "status IN ('pending','running','success','failed','blocked','cancelled')",
            name="ck_jobs_status",
        ),
        sa.CheckConstraint(
            "progress >= 0 AND progress <= 100",
            name="ck_jobs_progress_range",
        ),
        schema="ml",
    )
    # 确保 gen_random_uuid 可用
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")

    op.execute(
        "COMMENT ON TABLE ml.jobs IS "
        "'作业队列：NestJS 写 pending，Python worker FOR UPDATE SKIP LOCKED 取行执行'"
    )

    # 三条索引（严格对齐 spec §4）
    op.create_index(
        "ix_jobs_status_priority_created",
        "jobs",
        ["status", "priority", "created_at"],
        schema="ml",
    )
    op.execute(
        "CREATE INDEX ix_jobs_status_heartbeat ON ml.jobs (status, heartbeat_at) "
        "WHERE status = 'running'"
    )
    op.execute(
        "CREATE INDEX ix_jobs_parent ON ml.jobs (parent_job_id) "
        "WHERE parent_job_id IS NOT NULL"
    )

    # ------------------------------------------------------------------
    # ml.model_runs —— 模型 run 元数据 + artifact 索引
    # ------------------------------------------------------------------
    op.create_table(
        "model_runs",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "job_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ml.jobs.id"),
            nullable=True,
        ),
        sa.Column("model_version", sa.Text(), nullable=False),
        sa.Column("feature_set_id", sa.Text(), nullable=False),
        sa.Column(
            "hyperparams",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
        ),
        sa.Column(
            "oos_metrics",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
        ),
        sa.Column("artifact_uri", sa.Text(), nullable=False),
        sa.Column("report_uri", sa.Text(), nullable=True),
        sa.Column("shap_uri", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        schema="ml",
    )
    op.execute(
        "COMMENT ON TABLE ml.model_runs IS "
        "'模型 run 元数据：超参 / OOS 指标 / 产物路径'"
    )
    op.create_index(
        "uq_model_runs_version",
        "model_runs",
        ["model_version"],
        unique=True,
        schema="ml",
    )

    # ------------------------------------------------------------------
    # ml.scores_daily —— 每日评分（列名 rank_in_day，避开 PG 关键字）
    # ------------------------------------------------------------------
    op.create_table(
        "scores_daily",
        sa.Column("trade_date", sa.CHAR(length=8), nullable=False),
        sa.Column("ts_code", sa.String(length=16), nullable=False),
        sa.Column("model_version", sa.Text(), nullable=False),
        sa.Column("score", sa.Float(), nullable=False),
        sa.Column("rank_in_day", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint(
            "trade_date", "ts_code", "model_version", name="pk_scores_daily"
        ),
        schema="ml",
    )
    op.execute(
        "COMMENT ON TABLE ml.scores_daily IS "
        "'每日评分：(trade_date, ts_code, model_version) → score + rank_in_day'"
    )
    op.execute(
        "COMMENT ON COLUMN ml.scores_daily.rank_in_day IS "
        "'PARTITION BY trade_date, model_version ORDER BY score DESC；避开 PG 关键字 rank'"
    )
    op.create_index(
        "ix_scores_daily_date_model_rank",
        "scores_daily",
        ["trade_date", "model_version", "rank_in_day"],
        schema="ml",
    )

    # ------------------------------------------------------------------
    # ml.quality_reports —— 数据质量门禁报告
    # ------------------------------------------------------------------
    op.create_table(
        "quality_reports",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("trade_date", sa.CHAR(length=8), nullable=False),
        sa.Column("level", sa.Text(), nullable=False),
        sa.Column("rule", sa.Text(), nullable=False),
        sa.Column(
            "detail",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "level IN ('info','warn','critical')",
            name="ck_quality_reports_level",
        ),
        schema="ml",
    )
    op.execute(
        "COMMENT ON TABLE ml.quality_reports IS "
        "'数据质量门禁报告：rule + detail (jsonb)；level ∈ {info, warn, critical}'"
    )
    op.create_index(
        "ix_quality_reports_date_level",
        "quality_reports",
        ["trade_date", "level"],
        schema="ml",
    )


def downgrade() -> None:
    # ml schema
    op.drop_index("ix_quality_reports_date_level", table_name="quality_reports", schema="ml")
    op.drop_table("quality_reports", schema="ml")

    op.drop_index("ix_scores_daily_date_model_rank", table_name="scores_daily", schema="ml")
    op.drop_table("scores_daily", schema="ml")

    op.drop_index("uq_model_runs_version", table_name="model_runs", schema="ml")
    op.drop_table("model_runs", schema="ml")

    op.execute("DROP INDEX IF EXISTS ml.ix_jobs_parent")
    op.execute("DROP INDEX IF EXISTS ml.ix_jobs_status_heartbeat")
    op.drop_index("ix_jobs_status_priority_created", table_name="jobs", schema="ml")
    op.drop_table("jobs", schema="ml")

    # factors schema
    op.execute("DROP INDEX IF EXISTS factors.ix_factors_feature_matrix_set_date")
    op.execute("DROP TABLE IF EXISTS factors.feature_matrix")

    op.drop_table("feature_sets", schema="factors")

    op.execute("DROP INDEX IF EXISTS factors.ix_factors_labels_scheme_date")
    op.execute("DROP TABLE IF EXISTS factors.labels")

    op.execute("DROP INDEX IF EXISTS factors.ix_factors_daily_factors_factor_date")
    op.execute("DROP TABLE IF EXISTS factors.daily_factors")
