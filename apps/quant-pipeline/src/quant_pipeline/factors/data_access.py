"""factors 数据访问层：raw schema 只读预取 + factors.daily_factors upsert。

从 `factors/runner.py` 拆出（review §12）：runner 原本一身四职（数据加载 /
后复权 / upsert / 调度），文件逼近 500 行硬上限。本模块承接「数据加载 + 复权 +
upsert」三职，runner 仅保留「调度」。

PIT 安全（doc/03）：
- 复权基准：见 `load_window_data` 的 close_adj 注释（窗口内 max(adj_factor)，
  仅供比值 / 收益率类因子）。
- 行业归属：raw.index_member.in_date / out_date 按交易日筛选（PIT 安全）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import session_scope

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class RawData:
    """runner 预取的窗口内 raw 数据合集。"""

    # MultiIndex [trade_date, ts_code]; 列: close, vol, adj_factor, turnover_rate
    panel: pd.DataFrame
    # MultiIndex [trade_date, ts_code]; 单列: industry_l1
    industry_pit: pd.DataFrame


def _query_trade_dates(start: str, end: str) -> list[str]:
    """从 raw.daily_quote 取 [start, end] 范围内的实际有报价日期（PIT 真值）。

    若表暂不存在（Part C 未交付），返回 [] 并 warn——runner 据此跳过本轮工作。

    trade_cal 仅服务于前瞻性查询（次日是否开市）；历史 PIT 计算的真值来自
    `raw.daily_quote.trade_date`——与每日 OHLC 同表，强 PIT 安全。本函数不再依赖
    trade_cal 的同步覆盖范围。若某日全市场零成交，daily_quote 不含该日，本函数
    自然剔除——与 PIT 真值一致。
    """

    sql = text(
        """
        SELECT DISTINCT trade_date FROM raw.daily_quote
        WHERE trade_date >= :start AND trade_date <= :end
        ORDER BY trade_date
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql, {"start": start, "end": end}).fetchall()
        return [r[0] for r in rows]
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "trade_dates_failed",
            extra={"start": start, "end": end, "err": str(exc)},
        )
        raise


def _query_live_universe(trade_date: str) -> set[str]:
    """取 T 日 raw.daily_quote 实际有报价的 ts_code 集合（PIT 真值 universe）。

    用于 run_factors 过滤：T 日无报价的 ts_code（停牌 / 退市）即便被滚动类
    因子用历史窗口算出值，也不应写进 T 日因子表——否则构成幸存者偏差。
    表不可用时返回空集（调用方据此跳过当日，与 _query_trade_dates 退化一致）。
    """

    sql = text(
        "SELECT ts_code FROM raw.daily_quote WHERE trade_date = :t"
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql, {"t": trade_date}).fetchall()
        return {r[0] for r in rows}
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "live_universe_failed",
            extra={"trade_date": trade_date, "err": str(exc)},
        )
        raise


def _load_raw_panel(start: str, end: str) -> pd.DataFrame:
    """预取窗口内 daily_quote + adj_factor + daily_basic 的合表。

    返回 MultiIndex [trade_date, ts_code]，列：
        close, vol, adj_factor, turnover_rate
    若 raw 表不可用，返回空 DataFrame。
    """

    sql = text(
        """
        SELECT q.trade_date,
               q.ts_code,
               q.close,
               q.vol,
               q.amount,
               a.adj_factor,
               b.turnover_rate
        FROM raw.daily_quote q
        LEFT JOIN raw.adj_factor a
               ON a.ts_code = q.ts_code AND a.trade_date = q.trade_date
        LEFT JOIN raw.daily_basic b
               ON b.ts_code = q.ts_code AND b.trade_date = q.trade_date
        WHERE q.trade_date >= :start AND q.trade_date <= :end
        """
    )
    cols = ["trade_date", "ts_code", "close", "vol", "amount", "adj_factor", "turnover_rate"]
    try:
        with session_scope() as session:
            rows = session.execute(sql, {"start": start, "end": end}).fetchall()
        if not rows:
            return pd.DataFrame(columns=cols).set_index(["trade_date", "ts_code"])
        df = pd.DataFrame(rows, columns=cols).set_index(["trade_date", "ts_code"]).sort_index()
        # 类型规整
        for c in ("close", "vol", "amount", "adj_factor", "turnover_rate"):
            df[c] = pd.to_numeric(df[c], errors="coerce")
        return df
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "raw_panel_failed",
            extra={"start": start, "end": end, "err": str(exc)},
        )
        raise


def _load_industry_pit(start: str, end: str) -> pd.DataFrame:
    """从 raw.index_member 解析窗口内每日的个股 → industry_l1 归属（PIT 安全）。

    实现：sync/index_member.py 已经把 (l1_code, l1_name, l2_code, l2_name, l3_code, l3_name)
    同行落库，l1_code 即"申万一级行业代码"（形如 801xxx.SI）。本函数按 trade_date
    在 raw.index_member 上反查 in_date / out_date 区间命中 T 日的行，直接取 l1_code，
    无需 JOIN raw.index_classify。

    单条 SQL 一次性解析窗口内全部交易日的 PIT 归属（review §11）：以
    raw.daily_quote 的 distinct trade_date 为日历，与 raw.index_member 按
    in_date <= cal AND (out_date IS NULL OR out_date > cal) JOIN——与
    features/runner._load_industry_map 同口径，避免 O(N) 次数据库往返。

    返回 MultiIndex [trade_date, ts_code]、单列 industry_l1。表不可用时返回空。
    """

    sql = text(
        """
        SELECT cal.cal_date AS trade_date,
               im.ts_code,
               im.l1_code AS industry_l1
        FROM (
            SELECT DISTINCT trade_date AS cal_date
            FROM raw.daily_quote
            WHERE trade_date >= :start AND trade_date <= :end
        ) cal
        JOIN raw.index_member im
          ON im.in_date <= cal.cal_date
         AND (im.out_date IS NULL OR im.out_date > cal.cal_date)
        WHERE im.l1_code IS NOT NULL
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql, {"start": start, "end": end}).fetchall()
        if not rows:
            return pd.DataFrame(columns=["industry_l1"])
        out = pd.DataFrame(
            rows, columns=["trade_date", "ts_code", "industry_l1"]
        ).set_index(["trade_date", "ts_code"])
        return out
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "index_member_failed",
            extra={"start": start, "end": end, "err": str(exc)},
        )
        raise


def load_window_data(start: str, end: str, need_industry: bool) -> RawData:
    """预取整个窗口的 raw 数据，并完成后复权价、行业归属注入。"""

    panel = _load_raw_panel(start, end)
    if not panel.empty:
        # 后复权：close_adj = close * adj_factor / max(adj_factor in window per ts_code)
        #
        # ⚠ 注意（review §5）：基准是「窗口内 max(adj_factor)」，**随 date_range 变化**。
        # 两次不同 date_range 的 run 对同一 (ts_code, trade_date) 会算出**不同的
        # close_adj 绝对值**——因此 close_adj **只可用于比值 / 收益率 / 差分类因子**
        # （基准在分子分母约掉，结果与窗口无关），**不可作绝对价格使用**。
        # 这不构成前视偏差：窗口内 max 不含 T+1 的复权事件，T 日因子值 PIT 安全；
        # doc/03 §3.2 推荐的「全历史 latest adj_factor 基准」会得到稳定绝对值，
        # 但本 runner 全部因子均为比值口径，窗口 max 已足够。
        af = panel["adj_factor"]
        max_af = af.groupby(level="ts_code").transform("max")
        panel["close_adj"] = panel["close"] * af / max_af
    else:
        panel = pd.DataFrame(
            columns=["close", "vol", "amount", "adj_factor", "turnover_rate", "close_adj"]
        )

    industry = _load_industry_pit(start, end) if need_industry else pd.DataFrame(
        columns=["industry_l1"]
    )
    return RawData(panel=panel, industry_pit=industry)


def _upsert_daily_factors(rows: list[dict[str, object]]) -> int:
    """长格式 upsert 到 factors.daily_factors。

    去重规则（CLAUDE.md 硬约束）：按 PK
    (trade_date, ts_code, factor_id, factor_version) 去重，保留最后一条。
    """

    if not rows:
        return 0
    # 按 PK 去重
    seen: dict[tuple[str, str, str, str], dict[str, object]] = {}
    for r in rows:
        key = (
            str(r["trade_date"]),
            str(r["ts_code"]),
            str(r["factor_id"]),
            str(r["factor_version"]),
        )
        seen[key] = r
    deduped = list(seen.values())
    if len(deduped) != len(rows):
        logger.warning(
            "daily_factors_dedup",
            extra={"raw": len(rows), "deduped": len(deduped)},
        )

    sql = text(
        """
        INSERT INTO factors.daily_factors
            (trade_date, ts_code, factor_id, factor_version, value)
        VALUES
            (:trade_date, :ts_code, :factor_id, :factor_version, :value)
        ON CONFLICT (trade_date, ts_code, factor_id, factor_version)
        DO UPDATE SET value = EXCLUDED.value
        """
    )
    with session_scope() as session:
        # SQLAlchemy executemany
        session.execute(sql, deduped)
    return len(deduped)


__all__ = [
    "RawData",
    "_query_trade_dates",
    "_query_live_universe",
    "_load_raw_panel",
    "_load_industry_pit",
    "load_window_data",
    "_upsert_daily_factors",
]
