"""factor_definitions: 因子清单 DB 单一权威表

Revision ID: 20260524_0001
Revises: 20260523_0001
Create Date: 2026-05-24

对齐 spec docs/superpowers/specs/2026-05-23-factor-registry-frontend-design/
01-db-schema.md。

把 16 个因子元信息（description / category / pit_window_days / pit_anchor
+ enabled / display_order 等运维字段）从 Python 类属性迁到 DB 表
`factors.factor_definitions` 作为单一权威。Python 因子类仅保留 compute 方法。

初始 16 行通过硬编码 INSERT 写入（方案 a，不在 migration 中 import
quant_pipeline 包，保持 migration 是"凝固历史"）。

字段约束（详见 01-db-schema.md §字段约束）：
- (factor_id, factor_version) 复合 PK
- pit_window_days CHECK 1..400
- pit_anchor CHECK ('trade_date','ann_date')
- category CHECK ('price','industry','fundamental','mixed')
- (enabled, category) 复合 index 供前端筛选
- formula / data_source 允许 NULL（拆不出公式的因子直接置 NULL）
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260524_0001"
down_revision: str | None = "20260523_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# 16 行初始值，**人工抄写**自 2026-05-23 仓库内各因子文件的类属性。
# 字段顺序与下方 INSERT 一致：
#   (factor_id, factor_version, description, formula, data_source,
#    category, pit_window_days, pit_anchor, display_order)
# enabled 由 DEFAULT true 提供；updated_at = NOW()；updated_by = NULL。
#
# description 与 formula 拆分策略：当原 description 含明显公式表达，
# 把短中文留 description，公式抽到 formula；拆不出的直接 description 全文，
# formula 置 NULL（由维护者通过前端只读字段对照代码补全）。
_INITIAL_ROWS: list[tuple] = [
    # ---- price 类（11 个） ----
    (
        "amihud_illiq_20d",
        "v1",
        "Amihud 非流动性（20 日均值）",
        "mean(|daily_ret| / amount) over past 20 trading days",
        ["raw.daily_quote", "raw.adj_factor"],
        "price",
        35,
        "trade_date",
        100,
    ),
    (
        "bollinger_position_20d",
        "v1",
        "布林带相对位置（20 日，k=2）",
        "(close - lower_band) / (upper_band - lower_band) over 20d, k=2",
        ["raw.daily_quote", "raw.adj_factor"],
        "price",
        35,
        "trade_date",
        110,
    ),
    (
        "close_to_high_60d",
        "v1",
        "60 日内收盘价相对最高价",
        "close_adj(T) / max(close_adj[T-59..T])",
        ["raw.daily_quote", "raw.adj_factor"],
        "price",
        115,
        "trade_date",
        120,
    ),
    (
        "ma_ratio_20d",
        "v1",
        "20 日均线偏离度",
        "close_adj(T) / MA20(close_adj)",
        ["raw.daily_quote", "raw.adj_factor"],
        "price",
        35,
        "trade_date",
        130,
    ),
    (
        "momentum_20d",
        "v1",
        "20 日动量",
        "close_adj(T) / close_adj(T-20) - 1",
        ["raw.daily_quote", "raw.adj_factor"],
        "price",
        35,
        "trade_date",
        140,
    ),
    (
        "momentum_60d",
        "v1",
        "60 日动量",
        "close_adj(T) / close_adj(T-60) - 1",
        ["raw.daily_quote", "raw.adj_factor"],
        "price",
        115,
        "trade_date",
        150,
    ),
    (
        "price_max_drawdown_60d",
        "v1",
        "60 日最大回撤（负值）",
        "min over T-59..T of (close_adj(t) / cummax(close_adj) - 1)",
        ["raw.daily_quote", "raw.adj_factor"],
        "price",
        115,
        "trade_date",
        160,
    ),
    (
        "rsi_14",
        "v1",
        "相对强弱指标 RSI(14)",
        "RSI(14) with Wilder smoothing",
        ["raw.daily_quote", "raw.adj_factor"],
        "price",
        60,
        "trade_date",
        170,
    ),
    (
        "turnover_mean_20d",
        "v1",
        "20 日换手率均值（含 T 日）",
        "mean(turnover_rate[T-19..T])",
        ["raw.daily_basic"],
        "price",
        35,
        "trade_date",
        180,
    ),
    (
        "volatility_20d",
        "v1",
        "20 日对数收益率标准差",
        "stddev(log_return) over past 20 trading days",
        ["raw.daily_quote", "raw.adj_factor"],
        "price",
        35,
        "trade_date",
        190,
    ),
    (
        "volume_ratio_20d",
        "v1",
        "20 日成交量比",
        "vol(T) / mean(vol[T-20..T-1])",
        ["raw.daily_quote"],
        "price",
        35,
        "trade_date",
        200,
    ),
    # ---- industry 类（5 个） ----
    (
        "industry_momentum_20d",
        "v1",
        "行业 20 日动量（行业内 pct_chg 均值累计，贴回个股）",
        "cumprod(1 + mean_within_industry(pct_chg))[T-19..T] - 1",
        ["raw.daily_quote", "raw.adj_factor", "raw.index_member"],
        "industry",
        35,
        "trade_date",
        300,
    ),
    (
        "momentum_20d_neu",
        "v1",
        "行业中性化的 20 日动量（个股 - 行业均值）",
        "momentum_20d(stock) - mean_within_industry(momentum_20d)",
        ["raw.daily_quote", "raw.adj_factor", "raw.index_member"],
        "industry",
        35,
        "trade_date",
        310,
    ),
    (
        "industry_rank_in_sector_mom20",
        "v1",
        "20 日动量在所属一级行业内的横截面 pct_rank（[0,1]）",
        "pct_rank within industry of momentum_20d",
        ["raw.daily_quote", "raw.adj_factor", "raw.index_member"],
        "industry",
        35,
        "trade_date",
        320,
    ),
    (
        "industry_relative_strength",
        "v1",
        "个股 20 日收益相对行业均值的超额",
        "stock_ret_20d - mean_within_industry(stock_ret_20d)",
        ["raw.daily_quote", "raw.adj_factor", "raw.index_member"],
        "industry",
        35,
        "trade_date",
        330,
    ),
    (
        "sector_volume_concentration",
        "v1",
        "行业内成交量赫芬达尔指数（HHI），贴回个股",
        "sum(share_i^2) where share_i = vol_i / sum(vol within industry)",
        ["raw.daily_quote", "raw.index_member"],
        "industry",
        5,
        "trade_date",
        340,
    ),
]


def upgrade() -> None:
    """A: 建表 + 约束 + 索引；B: 灌 16 行初始数据。"""

    # ---- A. 建表 ----
    op.execute("CREATE SCHEMA IF NOT EXISTS factors")
    op.execute(
        """
        CREATE TABLE factors.factor_definitions (
            factor_id        VARCHAR(64) NOT NULL,
            factor_version   VARCHAR(16) NOT NULL,
            description      TEXT        NOT NULL,
            formula          TEXT,
            data_source      TEXT[],
            category         VARCHAR(32) NOT NULL,
            pit_window_days  INTEGER     NOT NULL,
            pit_anchor       VARCHAR(16) NOT NULL,
            enabled          BOOLEAN     NOT NULL DEFAULT TRUE,
            display_order    INTEGER     NOT NULL DEFAULT 100,
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_by       VARCHAR(64),
            PRIMARY KEY (factor_id, factor_version),
            CONSTRAINT factor_definitions_pit_window_chk
                CHECK (pit_window_days >= 1 AND pit_window_days <= 400),
            CONSTRAINT factor_definitions_pit_anchor_chk
                CHECK (pit_anchor IN ('trade_date', 'ann_date')),
            CONSTRAINT factor_definitions_category_chk
                CHECK (category IN ('price', 'industry', 'fundamental', 'mixed'))
        )
        """
    )
    op.execute(
        "CREATE INDEX factor_definitions_enabled_category_idx "
        "ON factors.factor_definitions (enabled, category)"
    )

    # ---- B. 灌 16 行初始数据 ----
    # 不能直接用 op.bulk_insert（涉及 ARRAY 类型 + schema-qualified table），
    # 改用参数化 INSERT，逐行 execute。
    insert_sql = (
        "INSERT INTO factors.factor_definitions "
        "(factor_id, factor_version, description, formula, data_source, "
        " category, pit_window_days, pit_anchor, display_order) "
        "VALUES "
        "(:factor_id, :factor_version, :description, :formula, :data_source, "
        " :category, :pit_window_days, :pit_anchor, :display_order)"
    )
    conn = op.get_bind()
    from sqlalchemy import text

    for row in _INITIAL_ROWS:
        (
            factor_id,
            factor_version,
            description,
            formula,
            data_source,
            category,
            pit_window_days,
            pit_anchor,
            display_order,
        ) = row
        conn.execute(
            text(insert_sql),
            {
                "factor_id": factor_id,
                "factor_version": factor_version,
                "description": description,
                "formula": formula,
                "data_source": data_source,
                "category": category,
                "pit_window_days": pit_window_days,
                "pit_anchor": pit_anchor,
                "display_order": display_order,
            },
        )


def downgrade() -> None:
    """对称回滚：先删索引再删表。"""

    op.execute(
        "DROP INDEX IF EXISTS factors.factor_definitions_enabled_category_idx"
    )
    op.execute("DROP TABLE IF EXISTS factors.factor_definitions")
