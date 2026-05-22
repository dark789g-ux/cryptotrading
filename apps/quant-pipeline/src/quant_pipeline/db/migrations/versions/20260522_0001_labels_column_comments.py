"""factors.labels 列注释：声明 trade_date / value 的两 scheme 口径差异

Revision ID: 20260522_0001
Revises: 20260520_0001
Create Date: 2026-05-22

对齐 spec docs/superpowers/specs/2026-05-22-labels-review-remediation-design/
02-entry-t1-and-schemes.md §3。

背景：
- strategy-aware 切真 T+1 入场后，trade_date 明确为信号日 T；
- 项目决策：两 scheme（strategy-aware / fwd_5d_ret）的 value 口径统一为**毛收益**
  （不扣交易成本，成本由 portfolio 评估层扣减）—— 评审第 4 条「静默不一致」的处置。
- 本 migration 给 factors.labels 的 trade_date / value 列加 COMMENT，把口径
  显式落到 schema 上：value 统一毛收益，trade_date 的入场时点两 scheme 不同。

约束：
- factors.labels 是 PARTITION BY RANGE (trade_date) 的分区表，COMMENT ON COLUMN
  对分区表父表有效，无需逐分区处理。
- upgrade() 加注释，downgrade() 置空注释（COMMENT ... IS NULL）。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260522_0001"
down_revision: str | None = "20260520_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_COMMENT_TRADE_DATE: str = (
    "信号日（YYYYMMDD）。strategy-aware：T+1 入场；fwd_5d_ret：T 日起算。"
)
_COMMENT_VALUE: str = (
    "标签收益率（毛收益，不扣交易成本）。strategy-aware 与 fwd_5d_ret 口径统一为"
    "毛收益，交易成本由 portfolio 评估层统一扣减。"
)


def upgrade() -> None:
    """对 factors.labels.trade_date / value 加列注释。"""

    op.execute(
        f"COMMENT ON COLUMN factors.labels.trade_date IS '{_COMMENT_TRADE_DATE}'"
    )
    op.execute(
        f"COMMENT ON COLUMN factors.labels.value IS '{_COMMENT_VALUE}'"
    )


def downgrade() -> None:
    """清空 factors.labels.trade_date / value 列注释。"""

    op.execute("COMMENT ON COLUMN factors.labels.trade_date IS NULL")
    op.execute("COMMENT ON COLUMN factors.labels.value IS NULL")
