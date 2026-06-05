"""label_definitions: 标签定义 DB 单一权威表

Revision ID: 20260605_0001
Revises: 20260604_0001
Create Date: 2026-06-05

对齐 spec docs/superpowers/specs/2026-06-05-quant-label-management-design/
01-overview-and-data-model.md § 新表 factors.label_definitions。

把 4 个命名标签的元信息（base_type / base_params / classify_mode /
classify_params + enabled / display_order 等运维字段）写入 DB 表
`factors.label_definitions` 作为单一权威。

初始 4 行通过硬编码 INSERT 写入（不在 migration 中 import quant_pipeline 包，
保持 migration 是"凝固历史"）。

种子值来源核对（必须落源头，不得凭规格直接抄）：
  eps=0.005     ← labels/dir3_scheme.py::LEGACY_EPS = 0.005
  horizon=5     ← labels/fallback.py::FWD_HORIZON_DAYS = 5
  max_hold_days=20 ← strategy/exit_rules.py::MAX_HOLD_DAYS = 20

字段约束（详见 01-overview-and-data-model.md § 新表 factors.label_definitions）：
  - (label_id, label_version) 复合 PK
  - base_type / classify_mode 不加 CHECK 枚举（单一真相源在 Python labels 模块）
  - (enabled, base_type) 复合 index 供前端筛选
  - created_at 用 timestamptz（项目规则：时间列一律 timestamptz）
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260605_0001"
down_revision: str | None = "20260604_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# 4 行初始种子标签，覆盖原 4 个 scheme 的典型用法，开箱即用平滑过渡。
#
# 字段顺序与下方 INSERT 一致：
#   (label_id, label_version, name, base_type, base_params,
#    classify_mode, classify_params, description, display_order)
# enabled 由 DEFAULT true 提供；created_at 由 DEFAULT now() 提供。
#
# 种子值已逐一 grep 源码核对（见模块 docstring）：
#   max_hold_days=20 → strategy/exit_rules.py::MAX_HOLD_DAYS = 20
#   horizon=5        → labels/fallback.py::FWD_HORIZON_DAYS = 5
#   eps=0.005        → labels/dir3_scheme.py::LEGACY_EPS = 0.005
_SEED_ROWS: list[tuple[Any, ...]] = [
    (
        "strategy_aware_default",  # label_id
        "v1",                      # label_version
        "固定策略收益",             # name
        "strategy_aware",          # base_type
        {"max_hold_days": 20},     # base_params  (MAX_HOLD_DAYS=20 核对通过)
        None,                      # classify_mode  NULL = 连续/回归
        {},                        # classify_params
        "固定策略（T+1 入场、规则出场）的持仓收益，最大持仓 20 日",  # description
        10,                        # display_order
    ),
    (
        "fwd_5d_ret",              # label_id
        "v1",                      # label_version
        "5日涨跌幅",               # name
        "fwd_ret",                 # base_type
        {"horizon": 5},            # base_params  (FWD_HORIZON_DAYS=5 核对通过)
        None,                      # classify_mode  NULL = 连续/回归
        {},                        # classify_params
        "未来 5 日后复权收益率（连续值，适合 LambdaRank/回归模型）",  # description
        20,                        # display_order
    ),
    (
        "next_day_band05",         # label_id
        "v1",                      # label_version
        "次日涨跌·横盘±0.5%",     # name
        "fwd_ret",                 # base_type
        {"horizon": 1},            # base_params
        "band",                    # classify_mode
        {"eps": 0.005},            # classify_params  (LEGACY_EPS=0.005 核对通过)
        "次日涨跌幅三分类：横盘 |r|≤0.5%、上涨、下跌",  # description
        30,                        # display_order
    ),
    (
        "next_day_tercile",        # label_id
        "v1",                      # label_version
        "次日涨跌·截面三分位",     # name
        "fwd_ret",                 # base_type
        {"horizon": 1},            # base_params
        "tercile",                 # classify_mode
        {},                        # classify_params
        "次日涨跌幅截面三分位分类（低 / 中 / 高）",  # description
        40,                        # display_order
    ),
]


def upgrade() -> None:
    """A: 建表 + 索引；B: 灌 4 行种子标签。"""

    # ---- A. 建表 ----
    op.execute(
        """
        CREATE TABLE factors.label_definitions (
            label_id        VARCHAR(64)  NOT NULL,
            label_version   VARCHAR(16)  NOT NULL,
            name            TEXT         NOT NULL,
            base_type       TEXT         NOT NULL,
            base_params     JSONB        NOT NULL DEFAULT '{}',
            classify_mode   TEXT,
            classify_params JSONB        NOT NULL DEFAULT '{}',
            description     TEXT,
            enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
            display_order   INTEGER      NOT NULL DEFAULT 0,
            created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            PRIMARY KEY (label_id, label_version)
        )
        """
    )
    op.execute(
        "CREATE INDEX ix_label_definitions_enabled_base "
        "ON factors.label_definitions (enabled, base_type)"
    )

    # ---- B. 灌 4 行种子标签 ----
    # 不 import quant_pipeline 包；用参数化 INSERT 逐行 execute。
    insert_sql = (
        "INSERT INTO factors.label_definitions "
        "(label_id, label_version, name, base_type, base_params, "
        " classify_mode, classify_params, description, display_order) "
        "VALUES "
        "(:label_id, :label_version, :name, :base_type, CAST(:base_params AS jsonb), "
        " :classify_mode, CAST(:classify_params AS jsonb), :description, :display_order)"
    )
    conn = op.get_bind()
    from sqlalchemy import text

    for row in _SEED_ROWS:
        (
            label_id,
            label_version,
            name,
            base_type,
            base_params,
            classify_mode,
            classify_params,
            description,
            display_order,
        ) = row
        conn.execute(
            text(insert_sql),
            {
                "label_id": label_id,
                "label_version": label_version,
                "name": name,
                "base_type": base_type,
                "base_params": json.dumps(base_params, ensure_ascii=False),
                "classify_mode": classify_mode,
                "classify_params": json.dumps(classify_params, ensure_ascii=False),
                "description": description,
                "display_order": display_order,
            },
        )


def downgrade() -> None:
    """对称回滚：删索引 + 删表（含种子行）。"""

    op.execute(
        "DROP INDEX IF EXISTS factors.ix_label_definitions_enabled_base"
    )
    op.execute("DROP TABLE IF EXISTS factors.label_definitions")
