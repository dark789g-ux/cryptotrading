"""factors.feature_sets 加 factor_code_fp 列(因子计算代码口径指纹护门)

Revision ID: 20260607_0001
Revises: 20260606_0004
Create Date: 2026-06-07

背景:
followup「close_adj train/serve 特征错配」problem2 系统性修复(Phase3)。
`feature_set_id` 哈希只绑 factor_version/scheme/factor_ids/new_listing_min_days/
neutralize_cols/robust_z,**不绑因子计算代码口径**。83aeda0(2026-06-06)把 close_adj
改纯后复权后,同一 fs id 下 12+ 个 close 派生因子值全变、但 fs 哈希不变 → prod 被喂
没训过的特征、live 排名漂移 ~85%,而 fail-fast 护门拦不住。

本列存"物化该 fm 时的因子计算代码指纹"(fcf_<sha12>,见
features/factor_code_fingerprint.py);训练/推理入口比对当前代码指纹 vs 本列,不一致
即 raise。NULL = 指纹机制前的旧 fm(护门只 warn 不阻塞,向后兼容)。

设计:docs/superpowers/specs/2026-06-07-factor-code-fingerprint-guard-design.md
幂等:ADD/DROP COLUMN IF [NOT] EXISTS;不进唯一索引/逻辑键,不改 fs id 复用语义。
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260607_0001"
down_revision: str | None = "20260606_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """加 nullable factor_code_fp 列(旧行为 NULL,护门只 warn)。"""

    op.execute(
        "ALTER TABLE factors.feature_sets ADD COLUMN IF NOT EXISTS factor_code_fp text"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE factors.feature_sets DROP COLUMN IF EXISTS factor_code_fp"
    )
