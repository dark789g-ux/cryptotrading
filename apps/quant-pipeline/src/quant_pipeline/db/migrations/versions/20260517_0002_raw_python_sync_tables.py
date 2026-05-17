"""raw schema · Python sync 拥有的 6 张新表

Revision ID: 20260517_0002
Revises: 20260517_0001
Create Date: 2026-05-17

严格对齐 01-pg-schema.md §5 所有权划分与 doc/量化/06 TuShare 字段。
本 migration 只建 Python 拥有的 6 张表：
- raw.trade_cal              交易日历（trade_cal 接口）
- raw.stk_limit              每日涨跌停价（stk_limit 接口）
- raw.suspend_d              每日停复牌（suspend_d 接口）
- raw.index_classify         申万行业分类（index_classify 接口）
- raw.index_member           申万行业成份历史快照（index_member_all 接口；PIT 关键）
- raw.fina_indicator         财务指标（fina_indicator 接口；强制 ann_date PIT）

不触碰 M0 已建 factors / ml 表，也不触碰 NestJS 拥有的 5 张 raw 表。

所有时间列一律 timestamptz（CLAUDE.md 时间规范）；
A 股 trade_date 一律 char(8) YYYYMMDD（CLAUDE.md A 股日期规范）。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260517_0002"
down_revision: str | None = "20260517_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 0. raw schema 存在性兜底
    # ------------------------------------------------------------------
    op.execute("CREATE SCHEMA IF NOT EXISTS raw")

    # ==================================================================
    # raw.trade_cal —— 交易日历
    # TuShare 接口：trade_cal
    # 字段：exchange / cal_date / is_open / pretrade_date
    # PK：(exchange, cal_date)
    # ==================================================================
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS raw.trade_cal (
            exchange       varchar(8)   NOT NULL,
            cal_date       char(8)      NOT NULL,
            is_open        smallint     NOT NULL,
            pretrade_date  char(8),
            updated_at     timestamptz  NOT NULL DEFAULT now(),
            PRIMARY KEY (exchange, cal_date)
        )
        """
    )
    op.execute(
        "COMMENT ON TABLE raw.trade_cal IS "
        "'TuShare trade_cal 接口落库；A 股 exchange ∈ {SSE, SZSE}；is_open 0=休市 1=交易'"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_raw_trade_cal_date "
        "ON raw.trade_cal (cal_date) WHERE is_open = 1"
    )

    # ==================================================================
    # raw.stk_limit —— 每日涨跌停价格
    # TuShare 接口：stk_limit
    # 字段：trade_date / ts_code / pre_close / up_limit / down_limit
    # PK：(ts_code, trade_date)
    # ==================================================================
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS raw.stk_limit (
            ts_code     varchar(16)  NOT NULL,
            trade_date  char(8)      NOT NULL,
            pre_close   numeric(30, 10),
            up_limit    numeric(30, 10),
            down_limit  numeric(30, 10),
            updated_at  timestamptz  NOT NULL DEFAULT now(),
            PRIMARY KEY (ts_code, trade_date)
        )
        """
    )
    op.execute(
        "COMMENT ON TABLE raw.stk_limit IS "
        "'TuShare stk_limit 接口落库；当日 8:40 左右更新；up/down_limit 单位：元'"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_raw_stk_limit_date "
        "ON raw.stk_limit (trade_date)"
    )

    # ==================================================================
    # raw.suspend_d —— 每日停复牌
    # TuShare 接口：suspend_d
    # 字段：ts_code / trade_date / suspend_timing / suspend_type
    # PK：(ts_code, trade_date, suspend_type)  —— 同一日 S/R 各一行可能并存
    # ==================================================================
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS raw.suspend_d (
            ts_code         varchar(16)  NOT NULL,
            trade_date      char(8)      NOT NULL,
            suspend_type    char(1)      NOT NULL,
            suspend_timing  text,
            updated_at      timestamptz  NOT NULL DEFAULT now(),
            PRIMARY KEY (ts_code, trade_date, suspend_type),
            CONSTRAINT ck_raw_suspend_d_type CHECK (suspend_type IN ('S', 'R'))
        )
        """
    )
    op.execute(
        "COMMENT ON TABLE raw.suspend_d IS "
        "'TuShare suspend_d 接口落库；suspend_type S=停牌 R=复牌；"
        "suspend_timing 形如 09:30-10:00（全天停牌时为 NULL）'"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_raw_suspend_d_date "
        "ON raw.suspend_d (trade_date)"
    )

    # ==================================================================
    # raw.index_classify —— 申万行业分类
    # TuShare 接口：index_classify
    # 字段：index_code / industry_name / parent_code / level / industry_code / src
    # PK：(src, index_code)  —— 同一 index_code 在 SW2014 / SW2021 都可能出现
    # ==================================================================
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS raw.index_classify (
            src            varchar(16)  NOT NULL,
            index_code     varchar(16)  NOT NULL,
            industry_code  varchar(16),
            industry_name  text         NOT NULL,
            parent_code    varchar(16),
            level          varchar(4),
            updated_at     timestamptz  NOT NULL DEFAULT now(),
            PRIMARY KEY (src, index_code)
        )
        """
    )
    op.execute(
        "COMMENT ON TABLE raw.index_classify IS "
        "'TuShare index_classify 接口落库；src ∈ {SW2014, SW2021}；level ∈ {L1, L2, L3}'"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_raw_index_classify_level "
        "ON raw.index_classify (src, level)"
    )

    # ==================================================================
    # raw.index_member —— 申万行业成份历史快照（PIT 关键）
    # TuShare 接口：index_member_all
    # 字段：l1_code / l1_name / l2_code / l2_name / l3_code / l3_name /
    #       ts_code / name / in_date / out_date / is_new
    # PK：(l3_code, ts_code, in_date)
    #   —— 同一支股票可能在不同时段进出同一三级行业（多段成员关系），用 in_date 拉开
    # ==================================================================
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS raw.index_member (
            l3_code     varchar(16)  NOT NULL,
            ts_code     varchar(16)  NOT NULL,
            in_date     char(8)      NOT NULL,
            out_date    char(8),
            l1_code     varchar(16),
            l1_name     text,
            l2_code     varchar(16),
            l2_name     text,
            l3_name     text,
            name        text,
            is_new      char(1),
            updated_at  timestamptz  NOT NULL DEFAULT now(),
            PRIMARY KEY (l3_code, ts_code, in_date),
            CONSTRAINT ck_raw_index_member_is_new CHECK (is_new IS NULL OR is_new IN ('Y', 'N'))
        )
        """
    )
    op.execute(
        "COMMENT ON TABLE raw.index_member IS "
        "'TuShare index_member_all 接口落库（申万行业成份历史快照，PIT 关键）；"
        "in_date/out_date 为 YYYYMMDD；out_date 为空表示仍在该行业'"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_raw_index_member_ts_code "
        "ON raw.index_member (ts_code, in_date)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_raw_index_member_l1 "
        "ON raw.index_member (l1_code) WHERE l1_code IS NOT NULL"
    )

    # ==================================================================
    # raw.fina_indicator —— 财务指标（强制 ann_date PIT）
    # TuShare 接口：fina_indicator
    # 字段：80+，按文档全量落库（用 jsonb 存全量指标，主键含 ann_date 保证 PIT）
    # PK：(ts_code, end_date, ann_date)
    #   —— ann_date 必含进 PK：同一报告期可能多次公告（修正 / 重述）
    #     ann_date 是 PIT 关键字段（CLAUDE.md M1 硬约束 + spec 验收门槛）
    # ==================================================================
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS raw.fina_indicator (
            ts_code     varchar(16)  NOT NULL,
            end_date    char(8)      NOT NULL,
            ann_date    char(8)      NOT NULL,
            indicators  jsonb        NOT NULL DEFAULT '{}'::jsonb,
            update_flag char(1),
            updated_at  timestamptz  NOT NULL DEFAULT now(),
            PRIMARY KEY (ts_code, end_date, ann_date)
        )
        """
    )
    op.execute(
        "COMMENT ON TABLE raw.fina_indicator IS "
        "'TuShare fina_indicator 接口落库（80+ 财务指标，jsonb 全量保留）；"
        "ann_date 是 PIT 关键字段，禁止以 end_date 作为入库 key'"
    )
    op.execute(
        "COMMENT ON COLUMN raw.fina_indicator.ann_date IS "
        "'公告日期 YYYYMMDD —— PIT 关键，因子计算必须按 ann_date 过滤'"
    )
    op.execute(
        "COMMENT ON COLUMN raw.fina_indicator.end_date IS "
        "'报告期 YYYYMMDD（每个季度最后一天）—— 仅作维度，禁止单独用于 PIT'"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_raw_fina_indicator_ann "
        "ON raw.fina_indicator (ann_date, ts_code)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_raw_fina_indicator_end "
        "ON raw.fina_indicator (end_date)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS raw.fina_indicator")
    op.execute("DROP TABLE IF EXISTS raw.index_member")
    op.execute("DROP TABLE IF EXISTS raw.index_classify")
    op.execute("DROP TABLE IF EXISTS raw.suspend_d")
    op.execute("DROP TABLE IF EXISTS raw.stk_limit")
    op.execute("DROP TABLE IF EXISTS raw.trade_cal")
