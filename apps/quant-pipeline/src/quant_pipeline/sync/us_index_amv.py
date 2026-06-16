"""美股指数 AMV 取数 + Σ 聚合 + 套公式 + 写 raw.us_index_amv_daily。

逐字镜像 A 股行业 AMV（``industry-amv.service.ts`` 的 syncOneIndex / aggregateAmount /
resolveWarmupStart / persist），把价侧换成 raw.us_index_daily(.NDX)、量侧换成
raw.us_daily_quote 成分裸 Σ(close×volume)。

⚠️ 美股口径差异（vs A 股行业 AMV）：US 的 ``Σ(close×volume)`` **已经是美元**，调用方
**不得**再 ×1000（A 股行业侧的 ×1000 是 amount「千元→元」换算，美股 amount 本就是美元，
勿照抄那一步，见 spec 03「美股口径差异」）。

落库口径（镜像 industry）：
- 先按交易行裁热身段（``trade_date < start`` 不落库，只为递归种子）；
- 再丢弃异常日（``invalid[i]`` / ``amv_close<=0`` / NaN，continue-skip 不落库）；
- 覆盖度不足（某日有效成分 < 当前名单总数）→ logger.warning（不阻断）；
- upsert raw.us_index_amv_daily（ON CONFLICT index_code,trade_date，去重保留最后一条）；
- 裁热身 + 过滤异常后无可落库行 → raise（禁伪装成功，由 orchestrator 记 errors）。
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.sync._upsert import upsert_rows
from quant_pipeline.sync.us_index_amv_formula import (
    calc_amv_series,
    calc_macd,
    calc_signal,
    calc_zdf,
)

logger = logging.getLogger(__name__)

AMV_TABLE = "raw.us_index_amv_daily"
AMV_PK = ("index_code", "trade_date")
AMV_UPDATE = (
    "amv_open", "amv_high", "amv_low", "amv_close",
    "amv_dif", "amv_dea", "amv_macd", "amv_zdf",
    "signal", "member_count",
)

# 热身交易行数（spec 04 §3）：取 150，覆盖 td_sma(10) 与 MACD 慢线 td_ema(26)，
# 全列收敛到 <1e-5（90 行只到 ~1e-3）。按 .NDX 交易行取、非自然日。
WARMUP_ROWS = 150


class AmvComputeError(Exception):
    """某指数裁热身 + 过滤异常后无可落库行（禁伪装成功，由 orchestrator 记 errors）。"""


@dataclass
class AmvComputeReport:
    index_code: str
    amv_rows: int = 0
    price_rows: int = 0
    # 覆盖度不足首次告警的样本（covered/expected），供日志/排查
    coverage_warned: bool = False
    notes: list[str] = field(default_factory=list)


def resolve_warmup_start(index_code: str, start: str) -> str:
    """按交易行确定热身起始日（逐字镜像 industry-amv.service.ts:520 resolveWarmupStart）。

    在 raw.us_index_daily 里取 ``trade_date < start`` 的第 WARMUP_ROWS 早的交易日，
    多取 WARMUP_ROWS 行供递归指标（td_sma/td_ema）预热。无更早行则返回 start（首次全量
    自然 clamp）。.NDX 指数表本身即美股交易日历，故按它定 warmup 起点确定、无自然日浮动。
    """
    with session_scope() as session:
        rows = session.execute(
            text(
                """
                SELECT trade_date FROM raw.us_index_daily
                 WHERE index_code = :idx AND trade_date < :start
                 ORDER BY trade_date DESC
                 LIMIT :lim
                """
            ),
            {"idx": index_code, "start": start, "lim": WARMUP_ROWS},
        ).all()
    if not rows:
        return start
    # rows 已 DESC，最后一条最早，作 fetch_start
    return str(rows[-1][0])


def _aggregate_amount(
    tickers: list[str], fetch_start: str, end: str
) -> dict[str, dict[str, float]]:
    """裸 SQL 聚合成分股当日 Σ(close×volume) 与有效成分数 member_count。

    镜像 industry-amv.service.ts:489-503（那里 SUM(amount)/COUNT(amount)）。这里量侧是
    Σ(close×volume)，COUNT(*) 即当日有效成分数（WHERE 已过滤 null close/volume）。
    close/volume 均 numeric(30,10)，乘积 numeric 无浮点误差；Python 侧转 float。

    ⚠️ 美股 amt 已是美元，**不 ×1000**（与 A 股行业 amount×1000 的千元换算不同，spec 03）。
    数组参强转 ::text[]（database-sql 规则）。
    返回 map：trade_date → {"amt": float, "member_count": float}。
    """
    sql = text(
        """
        SELECT trade_date,
               SUM(close * volume) AS amt,
               COUNT(*)            AS member_count
        FROM raw.us_daily_quote
        WHERE ticker = ANY(:tickers ::text[])
          AND trade_date >= :fetch_start
          AND trade_date <= :end_date
          AND close IS NOT NULL AND volume IS NOT NULL
        GROUP BY trade_date
        """
    )
    with session_scope() as session:
        rows = session.execute(
            sql,
            {"tickers": list(tickers), "fetch_start": fetch_start, "end_date": end},
        ).all()

    out: dict[str, dict[str, float]] = {}
    for r in rows:
        td = str(r[0])
        amt = float(r[1]) if r[1] is not None else 0.0
        mc = float(r[2]) if r[2] is not None else 0.0
        out[td] = {"amt": amt, "member_count": mc}
    return out


def _fetch_index_price(
    index_code: str, fetch_start: str, end: str
) -> list[dict[str, Any]]:
    """读 .NDX 点位 OHLC（升序），价侧主轴。"""
    sql = text(
        """
        SELECT trade_date, open, high, low, close
        FROM raw.us_index_daily
        WHERE index_code = :idx
          AND trade_date >= :fetch_start
          AND trade_date <= :end_date
        ORDER BY trade_date
        """
    )
    with session_scope() as session:
        rows = session.execute(
            sql, {"idx": index_code, "fetch_start": fetch_start, "end_date": end}
        ).all()
    return [
        {
            "trade_date": str(r[0]),
            "open": float(r[1]) if r[1] is not None else math.nan,
            "high": float(r[2]) if r[2] is not None else math.nan,
            "low": float(r[3]) if r[3] is not None else math.nan,
            "close": float(r[4]) if r[4] is not None else math.nan,
        }
        for r in rows
    ]


def compute_and_write_amv(
    *,
    index_code: str,
    start: str,
    end: str,
    fetch_start: str,
    tickers: list[str],
) -> AmvComputeReport:
    """读 Σ聚合 + .NDX 点位 + 套公式 → 裁热身 / 丢异常 → upsert raw.us_index_amv_daily。

    入参 fetch_start 已由 resolve_warmup_start 按交易行算出（含 WARMUP_ROWS 预热）。
    计算全序列后只 upsert ``trade_date >= start`` 的非异常行。
    """
    report = AmvComputeReport(index_code=index_code)
    expected_members = len(tickers)

    # 价侧主轴（以 .NDX 行情日期为对齐键，只算两侧都有的日 → 内连接由价主轴驱动）
    price_rows = _fetch_index_price(index_code, fetch_start, end)
    report.price_rows = len(price_rows)
    if not price_rows:
        msg = (
            f"us_index_amv_empty:{index_code}: raw.us_index_daily 当窗口无行情 "
            f"(fetch_start={fetch_start} end={end})"
        )
        logger.warning(msg)
        raise AmvComputeError(msg)

    # 量侧裸 Σ（不 ×1000）
    amt_map = _aggregate_amount(tickers, fetch_start, end)
    if len(amt_map) == 0:
        # 双路径空数据 warn（data-integrity 规则）：data=null 与 items=0 两条独立路径。
        # 这里 amt_map 空 = 聚合 0 行 = items=0 路径（成分股当窗口无任何成交额）。
        logger.warning(
            "us_index_amv_amount_empty",
            extra={
                "index_code": index_code,
                "api_name": "us_daily_quote_sum",
                "expected_members": expected_members,
                "fetch_start": fetch_start,
                "end": end,
                "reason": "items_empty(聚合0行)",
            },
        )

    # 按 trade_date 升序对齐量与价（价为主轴）
    trade_dates = [p["trade_date"] for p in price_rows]
    volume: list[float] = []
    open_: list[float] = []
    high: list[float] = []
    low: list[float] = []
    close: list[float] = []
    member_counts: list[float] = []

    for p in price_rows:
        agg = amt_map.get(p["trade_date"])
        # 指数有行情但成分股当日 Σ 为空 → 量按 0，公式里 AMVc<=0 自然 invalid。
        amt = agg["amt"] if agg else 0.0
        # ⚠️ 不 ×1000：US Σ(close×volume) 已是美元（A 股那步 amount×1000 是千元换算，勿照抄）。
        volume.append(amt)
        open_.append(p["open"])
        high.append(p["high"])
        low.append(p["low"])
        close.append(p["close"])
        member_counts.append(agg["member_count"] if agg else 0.0)

    # 套公式：calc_amv_series → calc_macd(amv_close) → calc_signal / calc_zdf
    amv = calc_amv_series(volume=volume, open=open_, high=high, low=low, close=close)
    macd = calc_macd(amv["amv_close"], 12, 26, 9)
    zdf = calc_zdf(amv["amv_close"])

    # 裁热身段（< start）+ 丢异常日（invalid / amv_close<=0 / NaN）→ upsert 行
    rows: list[dict[str, Any]] = []
    for i, td in enumerate(trade_dates):
        if td < start:
            continue  # 热身行，不落库
        if amv["invalid"][i]:
            continue
        c = amv["amv_close"][i]
        if not (c > 0) or (isinstance(c, float) and math.isnan(c)):
            continue

        mc = int(member_counts[i])
        # 覆盖度 warn：当日有效成分 < 当前名单总数（历史成分近似，仅 warn 不阻断）
        if mc < expected_members and not report.coverage_warned:
            logger.warning(
                "us_index_amv_coverage_gap",
                extra={
                    "index_code": index_code,
                    "trade_date": td,
                    "covered": mc,
                    "expected": expected_members,
                },
            )
            report.coverage_warned = True

        amv_zdf = zdf[i]
        rows.append(
            {
                "index_code": index_code,
                "trade_date": td,
                "amv_open": _none_if_nan(amv["amv_open"][i]),
                "amv_high": _none_if_nan(amv["amv_high"][i]),
                "amv_low": _none_if_nan(amv["amv_low"][i]),
                "amv_close": c,
                "amv_dif": _none_if_nan(macd["dif"][i]),
                "amv_dea": _none_if_nan(macd["dea"][i]),
                "amv_macd": _none_if_nan(macd["macd"][i]),
                "amv_zdf": amv_zdf if amv_zdf is not None else None,
                "signal": calc_signal(macd["dif"][i], macd["macd"][i]),
                "member_count": mc,
            }
        )

    if not rows:
        msg = f"us_index_amv_empty:{index_code}: 裁热身/过滤异常后无可落库行"
        logger.warning(msg)
        raise AmvComputeError(msg)

    # upsert 前按 (index_code, trade_date) 去重，保留最后一条（database-sql 规则）。
    # 价主轴升序 + drop_duplicates 语义：用 dict 覆盖等价（同键后写覆盖前写）。
    dedup: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        dedup[(r["index_code"], r["trade_date"])] = r
    final_rows = list(dedup.values())
    if len(final_rows) != len(rows):
        logger.warning(
            "us_index_amv_upsert_dedup",
            extra={
                "index_code": index_code,
                "raw_count": len(rows),
                "deduped_count": len(final_rows),
            },
        )

    with session_scope() as session:
        report.amv_rows = upsert_rows(
            session,
            table=AMV_TABLE,
            rows=final_rows,
            pk_cols=AMV_PK,
            update_cols=AMV_UPDATE,
        )

    logger.info(
        "us_index_amv_written",
        extra={"index_code": index_code, "rows": report.amv_rows},
    )
    return report


def _none_if_nan(x: float | None) -> float | None:
    """NaN / None → None；否则 float（落库列可空，异常日已被整行丢弃故 amv_close 恒非空）。"""
    if x is None:
        return None
    if isinstance(x, float) and math.isnan(x):
        return None
    return float(x)
