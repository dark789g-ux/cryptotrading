"""strategy_definitions: 策略定义 DB 单一权威表 + 标签种子改强引用

Revision ID: 20260606_0002
Revises: 20260606_0001
Create Date: 2026-06-06

对齐 spec docs/superpowers/specs/2026-06-06-quant-strategy-management-design/
02-data-model-and-migration.md § 1 表结构 / § 2 exit_rules / § 5 迁移 / § 6 数据连续性。

镜像 factors.label_definitions（出处 20260606_0001_label_definitions.py）的结构与
版本模型，把出场策略（exit_rules）的元信息写入 DB 表 factors.strategy_definitions
作为单一权威，并将既有标签种子 strategy_aware_default@v1 的 base_params 从内联参数
{"max_hold_days":20} 改写为对该策略的强引用 {"strategy_id":..,"strategy_version":..}。

初始种子（default_exit@v1）通过硬编码参数化 INSERT 写入（不在 migration 中 import
quant_pipeline 包，保持 migration 是"凝固历史"，与 label 迁移同风格）。

种子值来源核对（必须落源头，不得凭规格直接抄）：
  pct=0.08    ← strategy/exit_rules.py::STOP_LOSS_THRESHOLD = -0.08（存正数，符号见 spec §2.1）
  period=5    ← strategy/exit_rules.py::MA_WINDOW = 5
  days=20     ← strategy/exit_rules.py::MAX_HOLD_DAYS = 20

字段约束（详见 02-data-model-and-migration.md § 1）：
  - (strategy_id, strategy_version) 复合 PK，同 id 多版本并存（不可变版本模型）
  - exit_rules 不加 CHECK 约束（单一真相源在 Python build_exit_rules + NestJS DTO，
    与 label_definitions 同理，避免三处真相源）
  - enabled 单列 index 供前端筛选（前端选择器只列 enabled）
  - created_at 用 timestamptz（项目规则：时间列一律 timestamptz）

版本链（已核实，单 head 无脱节）：
  Revises 20260606_0001（label_definitions 种子修复，alembic heads/current 均为它）。

标签种子改写（C 段）带幂等护栏：仅当 base_params 仍是旧内联值 {"max_hold_days":20}
时才改写为强引用；downgrade 对称仅当当前是强引用时才还原，避免重复跑/换序时误伤。
"""

from __future__ import annotations

import json
from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260606_0002"
down_revision: str | None = "20260606_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# default_exit@v1 出场策略种子，值 = 现写死规则（已逐一 grep 源码核对，见 docstring）。
# first-match 顺序与 strategy/exit_rules.py::default_rules() 一致：止损 > MA 跌破 > 最大持有。
_DEFAULT_EXIT_RULES = [
    {"type": "stop_loss", "params": {"pct": 0.08}},   # STOP_LOSS_THRESHOLD=-0.08 → 存正数
    {"type": "ma_break", "params": {"period": 5}},    # MA_WINDOW=5
    {"type": "max_hold", "params": {"days": 20}},     # MAX_HOLD_DAYS=20
]

# C/downgrade 段用到的两个 base_params 形态（强引用 ↔ 旧内联值）。
_STRATEGY_REF = {"strategy_id": "default_exit", "strategy_version": "v1"}
_LEGACY_PARAMS = {"max_hold_days": 20}


def upgrade() -> None:
    """A: 建表 + 索引；B: 灌 default_exit@v1 种子；C: 标签种子 base_params 改强引用。"""

    from sqlalchemy import text

    conn = op.get_bind()

    # ---- A. 建表 + 索引 ----
    op.execute(
        """
        CREATE TABLE factors.strategy_definitions (
            strategy_id      VARCHAR(64)  NOT NULL,
            strategy_version VARCHAR(16)  NOT NULL,
            name             TEXT         NOT NULL,
            exit_rules       JSONB        NOT NULL DEFAULT '[]',
            description      TEXT,
            enabled          BOOLEAN      NOT NULL DEFAULT TRUE,
            display_order    INTEGER      NOT NULL DEFAULT 0,
            created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            PRIMARY KEY (strategy_id, strategy_version)
        )
        """
    )
    op.execute(
        "CREATE INDEX ix_strategy_definitions_enabled "
        "ON factors.strategy_definitions (enabled)"
    )

    # ---- B. 灌 default_exit@v1 种子 ----
    # 不 import quant_pipeline 包；参数化 INSERT + CAST(:exit_rules AS jsonb)。
    insert_sql = (
        "INSERT INTO factors.strategy_definitions "
        "(strategy_id, strategy_version, name, exit_rules, description, display_order) "
        "VALUES "
        "(:strategy_id, :strategy_version, :name, CAST(:exit_rules AS jsonb), "
        " :description, :display_order)"
    )
    conn.execute(
        text(insert_sql),
        {
            "strategy_id": "default_exit",
            "strategy_version": "v1",
            "name": "默认出场策略",
            "exit_rules": json.dumps(_DEFAULT_EXIT_RULES, ensure_ascii=False),
            "description": "T+1 入场、规则出场（止损-8% / 跌破MA5 / 最大持仓20日）",
            "display_order": 10,
        },
    )

    # ---- C. 标签种子 strategy_aware_default@v1 base_params 改强引用 ----
    # 幂等护栏：只改未迁移的行（base_params 仍是旧内联值时才改）。
    conn.execute(
        text(
            "UPDATE factors.label_definitions "
            "SET base_params = CAST(:new_params AS jsonb) "
            "WHERE label_id = 'strategy_aware_default' AND label_version = 'v1' "
            "  AND base_params = CAST(:old_params AS jsonb)"
        ),
        {
            "new_params": json.dumps(_STRATEGY_REF, ensure_ascii=False),
            "old_params": json.dumps(_LEGACY_PARAMS, ensure_ascii=False),
        },
    )


def downgrade() -> None:
    """对称回滚：C→还原标签种子；A→删索引 + 删表（含种子行）。"""

    from sqlalchemy import text

    conn = op.get_bind()

    # ---- 还原标签种子 base_params（幂等护栏：仅当当前是强引用时才还原） ----
    conn.execute(
        text(
            "UPDATE factors.label_definitions "
            "SET base_params = CAST(:old_params AS jsonb) "
            "WHERE label_id = 'strategy_aware_default' AND label_version = 'v1' "
            "  AND base_params = CAST(:new_params AS jsonb)"
        ),
        {
            "old_params": json.dumps(_LEGACY_PARAMS, ensure_ascii=False),
            "new_params": json.dumps(_STRATEGY_REF, ensure_ascii=False),
        },
    )

    # ---- 删索引 + 删表 ----
    op.execute("DROP INDEX IF EXISTS factors.ix_strategy_definitions_enabled")
    op.execute("DROP TABLE IF EXISTS factors.strategy_definitions")
