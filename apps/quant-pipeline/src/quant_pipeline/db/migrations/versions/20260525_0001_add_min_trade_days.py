"""factor_definitions: 增加 min_trade_days 列 + 跨字段 CHECK

Revision ID: 20260525_0001
Revises: 20260524_0001
Create Date: 2026-05-25

PIT 窗口护门（spec 2026-05-23-pit-window-guard-design §02-data-model.md）：
- 给 factors.factor_definitions 增加 min_trade_days INTEGER NOT NULL DEFAULT 1
  CHECK (between 1 and 250)
- 回填 16 个现有因子的 min_trade_days（值来源：源文件 compute() 内硬检查；
  详见 spec §2.5 现有 16 个因子的回填值）
- 把 pit_window_days 不足 min_trade_days * 2 的行抬高到 min_trade_days * 2
- 加跨字段 CHECK pit_window_covers_min_trade_days：
  pit_window_days >= min_trade_days * 2

注意：
- factor_id 必须照 spec §2.5 表里的 "DB factor_id" 列
  - industry_neutral_momentum 的 DB factor_id = momentum_20d_neu
  - industry_rank_in_sector 的 DB factor_id = industry_rank_in_sector_mom20
  - rsi_14 的 min_trade_days = 15（源码硬检查 len < _N + 1, _N = 14）
- 与 NestJS migration 20260524_factor_definitions_min_trade_days.sql 内容等价
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260525_0001"
down_revision: str | None = "20260524_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# 16 行回填值 (factor_id, min_trade_days)；与 spec §2.5 一一对应
_BACKFILL_ROWS: list[tuple[str, int]] = [
    # ---- 价格类（11 个） ----
    ("momentum_20d", 21),
    ("volatility_20d", 21),
    ("volume_ratio_20d", 21),
    ("amihud_illiq_20d", 21),
    ("ma_ratio_20d", 20),
    ("turnover_mean_20d", 20),
    ("bollinger_position_20d", 20),
    ("rsi_14", 15),  # 注意：rsi_14 硬检查 len < _N + 1, _N = 14
    ("momentum_60d", 61),
    ("close_to_high_60d", 60),
    ("price_max_drawdown_60d", 60),
    # ---- 行业类（5 个） ----
    ("industry_momentum_20d", 21),
    ("momentum_20d_neu", 21),  # 类: IndustryNeutralMomentum
    ("industry_rank_in_sector_mom20", 21),  # 类: IndustryRankInSector
    ("industry_relative_strength", 21),
    ("sector_volume_concentration", 1),
]


def upgrade() -> None:
    """A: 加列 + CHECK；B: 回填 16 行；C: 抬高 pit_window；D: 加跨字段 CHECK。"""

    # ---- A. 新增 min_trade_days 列（先 DEFAULT 1 占位，下面 UPDATE 回填真实值） ----
    op.execute(
        """
        ALTER TABLE factors.factor_definitions
          ADD COLUMN min_trade_days INTEGER NOT NULL DEFAULT 1
          CHECK (min_trade_days BETWEEN 1 AND 250)
        """
    )

    # ---- B. 回填 16 行 ----
    from sqlalchemy import text

    conn = op.get_bind()
    for factor_id, min_trade_days in _BACKFILL_ROWS:
        conn.execute(
            text(
                "UPDATE factors.factor_definitions "
                "SET min_trade_days = :min_trade_days "
                "WHERE factor_id = :factor_id"
            ),
            {"factor_id": factor_id, "min_trade_days": min_trade_days},
        )

    # ---- B'. 回填覆盖校验：期望 16 行命中 ----
    op.execute(
        """
        DO $$
        DECLARE
          expected INTEGER := 16;
          actual   INTEGER;
        BEGIN
          SELECT COUNT(*) INTO actual
          FROM factors.factor_definitions
          WHERE min_trade_days > 1
             OR factor_id = 'sector_volume_concentration';
          IF actual < expected THEN
            RAISE EXCEPTION 'min_trade_days 回填覆盖不足: 期望 %, 实际 %（factor_id 可能拼错）', expected, actual;
          END IF;
        END $$;
        """
    )

    # ---- C. 抬高 pit_window_days 到 min_trade_days * 2（暴露副作用 NOTICE） ----
    op.execute(
        """
        DO $$
        DECLARE r record;
        BEGIN
          FOR r IN
            SELECT factor_id, factor_version, pit_window_days, min_trade_days
            FROM factors.factor_definitions
            WHERE pit_window_days < min_trade_days * 2
          LOOP
            RAISE NOTICE 'Lifting pit_window_days for %/%: % -> %',
              r.factor_id, r.factor_version, r.pit_window_days, r.min_trade_days * 2;
          END LOOP;
        END $$;
        """
    )
    op.execute(
        """
        UPDATE factors.factor_definitions
          SET pit_window_days = min_trade_days * 2
          WHERE pit_window_days < min_trade_days * 2
        """
    )

    # ---- D. 添加跨字段 CHECK 约束 ----
    op.execute(
        """
        ALTER TABLE factors.factor_definitions
          ADD CONSTRAINT pit_window_covers_min_trade_days
          CHECK (pit_window_days >= min_trade_days * 2)
        """
    )


def downgrade() -> None:
    """对称回滚：先删跨字段约束，再删列（含其内嵌 CHECK 一并 DROP）。"""

    op.execute(
        """
        ALTER TABLE factors.factor_definitions
          DROP CONSTRAINT IF EXISTS pit_window_covers_min_trade_days
        """
    )
    op.execute(
        """
        ALTER TABLE factors.factor_definitions
          DROP COLUMN IF EXISTS min_trade_days
        """
    )
