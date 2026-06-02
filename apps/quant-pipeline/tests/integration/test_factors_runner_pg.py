"""factors.runner PG 集成测。

覆盖 spec doc/specs/2026-05-20-m1-dryrun-bugfix-design.md §7.1 四个用例：
- test_load_industry_pit_returns_l1_code
- test_query_trade_dates_no_duplicates_no_calendar_dep
- test_query_trade_dates_skips_zero_quote_day
- test_run_factors_smoke_2day_window

前置数据假设：raw.daily_quote / raw.adj_factor / raw.daily_basic 已有
2024-06 月数据（dry-run §1.1 sync 第一轮已落）；raw.index_member 已含
2024-06 有效行。
"""

from __future__ import annotations

import re

from sqlalchemy import text
from sqlalchemy.orm import Session

from quant_pipeline.factors.runner import (
    _load_industry_pit,
    _query_trade_dates,
    run_factors,
)

# ---------------------------------------------------------------------------
# §7.1 用例 1：industry_pit 返回 l1_code
# ---------------------------------------------------------------------------

def test_load_industry_pit_returns_l1_code(pg_session: Session) -> None:
    df = _load_industry_pit("20240601", "20240630")

    assert not df.empty, "raw.index_member 2024-06 应有 PIT 行业归属行"
    assert df.index.names == ["trade_date", "ts_code"], df.index.names
    assert list(df.columns) == ["industry_l1"]

    # 抽样：000001.SZ 在 20240603 当日应有 industry_l1 命中
    assert ("20240603", "000001.SZ") in df.index

    # industry_l1 形如 801xxx.SI（申万一级前缀）
    l1_pattern = re.compile(r"^801\d{3}\.SI$")
    sampled = df.head(50)["industry_l1"]
    assert sampled.notna().all(), "industry_l1 不应有 NaN"
    assert all(l1_pattern.match(v) for v in sampled), (
        f"industry_l1 应全部匹配 801xxx.SI；实际样本：{sampled.unique()[:5]}"
    )


# ---------------------------------------------------------------------------
# §7.1 用例 2：_query_trade_dates 不重复、不依赖 trade_cal 覆盖
# ---------------------------------------------------------------------------

def test_query_trade_dates_no_duplicates_no_calendar_dep(
    pg_session: Session,
) -> None:
    # 临时备份 + 清空 raw.trade_cal，验证函数不依赖它
    pg_session.execute(text("CREATE TEMP TABLE _bak_trade_cal AS TABLE raw.trade_cal"))
    pg_session.execute(text("TRUNCATE raw.trade_cal"))
    pg_session.commit()

    try:
        dates = _query_trade_dates("20240601", "20240630")
    finally:
        pg_session.execute(
            text("INSERT INTO raw.trade_cal SELECT * FROM _bak_trade_cal")
        )
        pg_session.execute(text("DROP TABLE _bak_trade_cal"))
        pg_session.commit()

    # 2024-06 实际开市日 = 19（spec §8 验收门槛）
    assert len(dates) == 19, f"2024-06 实际开市日应为 19，得 {len(dates)}"
    assert len(set(dates)) == len(dates), "trade_dates 不应重复"
    assert dates == sorted(dates), "应升序"
    assert all(len(d) == 8 and d.startswith("202406") for d in dates), dates[:3]


# ---------------------------------------------------------------------------
# §7.1 用例 3（self-review 增补）：daily_quote 零成交日自然剔除
# ---------------------------------------------------------------------------

def test_query_trade_dates_skips_zero_quote_day(pg_session: Session) -> None:
    """临时清空 20240605 当日 daily_quote 全部行，断言新逻辑剔除该日。"""

    # 备份 + 删除
    pg_session.execute(
        text(
            "CREATE TEMP TABLE _bak_daily_quote_0605 AS "
            "SELECT * FROM raw.daily_quote WHERE trade_date = '20240605'"
        )
    )
    pg_session.execute(text("DELETE FROM raw.daily_quote WHERE trade_date = '20240605'"))
    pg_session.commit()

    try:
        dates = _query_trade_dates("20240601", "20240630")
    finally:
        pg_session.execute(
            text("INSERT INTO raw.daily_quote SELECT * FROM _bak_daily_quote_0605")
        )
        pg_session.execute(text("DROP TABLE _bak_daily_quote_0605"))
        pg_session.commit()

    assert "20240605" not in dates, "零成交日应被自然剔除"
    assert len(dates) == 18, f"剔除后应剩 18 个交易日，得 {len(dates)}"


# ---------------------------------------------------------------------------
# §7.1 用例 4：run_factors 在 2 日窗口冒烟跑通
# ---------------------------------------------------------------------------

def test_run_factors_smoke_2day_window(pg_session: Session) -> None:
    """对 20240627:20240628 跑 v1 全部因子，断言行数级别符合预期。

    粗算：2 日 × 16 因子 × ~5300 股 ≈ 170K 行；门槛取 5000 × 5 = 25K（spec §7.1）。
    """

    out = run_factors(
        factor_version="v1",
        date_range="20240627:20240628",
        factor_ids=None,
        job_id=None,
    )

    assert out["trade_dates"] == 2, f"预期 2 个目标交易日，得 {out['trade_dates']}"
    assert out["factors"] == 16, f"v1 应有 16 个因子，得 {out['factors']}"
    assert out["rows_upserted"] > 5000 * 5, (
        f"rows_upserted 应 > 25000，实际 {out['rows_upserted']}"
    )

    # 当日 daily_factors 去重 ts_code 数 ≈ daily_quote 当日股票数（±5%）
    res = pg_session.execute(
        text(
            """
            SELECT
              (SELECT count(DISTINCT ts_code) FROM factors.daily_factors
                WHERE trade_date = '20240628' AND factor_version = 'v1') AS fact_n,
              (SELECT count(DISTINCT ts_code) FROM raw.daily_quote
                WHERE trade_date = '20240628') AS raw_n
            """
        )
    ).one()
    fact_n, raw_n = int(res.fact_n), int(res.raw_n)
    assert raw_n > 0
    ratio = fact_n / raw_n
    assert 0.95 <= ratio <= 1.05, (
        f"daily_factors ts_code 覆盖 daily_quote 偏差应 ±5%；fact_n={fact_n} raw_n={raw_n} ratio={ratio:.3f}"
    )
