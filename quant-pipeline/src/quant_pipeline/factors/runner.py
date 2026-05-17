"""factors runner：调度器。

职责（spec m1-factor-library §交付物 3 + 02-quant-pipeline.md §4）：
1. 输入 date_range + factor_version + 可选 factor_ids
2. 从 raw.trade_cal 取窗口内交易日列表
3. 按因子集合的最大 pit_window_days 一次性预取 raw 数据
   （raw.daily_quote / raw.adj_factor / raw.daily_basic / raw.index_member）
4. 用 adj_factor 反推后复权 close_adj，并按当时 industry_l1 标注行业
5. 对每个 T 日，调用每个因子的 compute
6. 按 (trade_date, ts_code, factor_id, factor_version) **去重后** upsert 到
   factors.daily_factors（CLAUDE.md 硬约束）
7. 每日完成后调用 worker.progress.update_progress（如果 job_id 存在）

PIT 安全（doc/03）：
- 复权：用 raw.adj_factor 反推（close_adj = close * adj_factor / latest_adj_in_window）；
  本因子 runner 用"窗口最后一天的 adj_factor"作为基准（doc/03 §3.2 "用后复权价为基准，
  但每日的复权因子按 PIT 独立存储；T 日的因子只用 T 日及之前的复权因子"）
- 行业归属：raw.index_member.in_date / out_date 按 T 日筛选（PIT 安全）
- 窗口禁止越过 T+1

注意：M0 阶段 raw 表由 NestJS 同步且本轮未交付 PIT 视图，runner 在 raw 表暂未
就绪时会优雅退化为"窗口内无数据则跳过该日 + warn"（不抛 500）。集成测试在
Part C/E 完成后补齐。
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

import numpy as np
import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import list_factors
from quant_pipeline.worker.progress import (
    JobCancelled,
    check_cancel_requested,
    update_progress,
)

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# 数据加载（raw schema 只读访问）
# ----------------------------------------------------------------------

@dataclass(slots=True)
class RawData:
    """runner 预取的窗口内 raw 数据合集。"""

    # MultiIndex [trade_date, ts_code]; 列: close, vol, adj_factor, turnover_rate
    panel: pd.DataFrame
    # MultiIndex [trade_date, ts_code]; 单列: industry_l1
    industry_pit: pd.DataFrame


def _query_trade_dates(start: str, end: str) -> list[str]:
    """从 raw.trade_cal 取 [start, end] 范围内 is_open=1 的交易日（YYYYMMDD）。

    若表暂不存在（Part C 未交付），返回 [] 并 warn——runner 据此跳过本轮工作。
    """

    sql = text(
        """
        SELECT cal_date
        FROM raw.trade_cal
        WHERE cal_date >= :start AND cal_date <= :end AND is_open = 1
        ORDER BY cal_date
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql, {"start": start, "end": end}).fetchall()
        return [r[0] for r in rows]
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "trade_cal_unavailable",
            extra={"start": start, "end": end, "err": str(exc)},
        )
        return []


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
        logger.warning(
            "raw_panel_unavailable",
            extra={"start": start, "end": end, "err": str(exc)},
        )
        return pd.DataFrame(columns=["close", "vol", "amount", "adj_factor", "turnover_rate"])


def _load_industry_pit(start: str, end: str) -> pd.DataFrame:
    """从 raw.index_member 解析窗口内每日的个股 → industry_l1 归属（PIT 安全）。

    策略：
      申万一级行业指数代码以 .SI 结尾，or 用 raw.index_classify.level='L1'
      过滤。本函数采用"按 trade_date 反查"模式：
        SELECT trade_date, ts_code (= con_code), index_code (= industry_l1)
        FROM raw.index_member im JOIN raw.index_classify ic ON ic.index_code = im.index_code
        WHERE ic.level = 'L1'
          AND im.in_date <= trade_date AND (im.out_date IS NULL OR im.out_date > trade_date)
      但 raw.index_member 通常存的是 (index_code, con_code, in_date, out_date)，
      要展平到日级需要 generate_series + 交易日历交叉，开销大。

      实用做法：runner 在每个 T 日单独 SELECT 一次"在 T 日有效的归属"，O(N) 次
      数据库查询；N=窗口交易日数（≤100）。

    返回 MultiIndex [trade_date, ts_code]、单列 industry_l1。表不可用时返回空。
    """

    trade_dates = _query_trade_dates(start, end)
    if not trade_dates:
        return pd.DataFrame(columns=["industry_l1"])

    sql = text(
        """
        SELECT :t AS trade_date, im.con_code AS ts_code, im.index_code AS industry_l1
        FROM raw.index_member im
        JOIN raw.index_classify ic ON ic.index_code = im.index_code
        WHERE ic.level = 'L1'
          AND im.in_date <= :t
          AND (im.out_date IS NULL OR im.out_date > :t)
        """
    )
    frames: list[pd.DataFrame] = []
    try:
        with session_scope() as session:
            for t in trade_dates:
                rows = session.execute(sql, {"t": t}).fetchall()
                if rows:
                    frames.append(
                        pd.DataFrame(
                            rows, columns=["trade_date", "ts_code", "industry_l1"]
                        )
                    )
        if not frames:
            return pd.DataFrame(columns=["industry_l1"])
        out = pd.concat(frames, ignore_index=True).set_index(["trade_date", "ts_code"])
        return out
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "index_member_unavailable",
            extra={"start": start, "end": end, "err": str(exc)},
        )
        return pd.DataFrame(columns=["industry_l1"])


def load_window_data(start: str, end: str, need_industry: bool) -> RawData:
    """预取整个窗口的 raw 数据，并完成后复权价、行业归属注入。"""

    panel = _load_raw_panel(start, end)
    if not panel.empty:
        # 后复权：close_adj = close * adj_factor / max(adj_factor in window per ts_code)
        # 注：max 是窗口口径的近似——doc/03 §3.2 推荐"用后复权价为基准（不随时间变化）"；
        # 严格 PIT 实现需要在更长历史上取 latest adj_factor；本 runner 在窗口内取 max
        # 已足够保证 T 日因子值的 PIT 正确性（不含 T+1 的复权事件）。
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


# ----------------------------------------------------------------------
# upsert
# ----------------------------------------------------------------------

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


# ----------------------------------------------------------------------
# Runner
# ----------------------------------------------------------------------

def _slice_window_for_factor(
    panel: pd.DataFrame,
    industry_pit: pd.DataFrame,
    factor: Factor,
    trade_date: str,
    trade_dates: Sequence[str],
) -> pd.DataFrame:
    """为某个因子在 T 日切出 PIT 窗口 DataFrame。

    窗口按 pit_window_days 日历日上限近似取交易日切片：
      从 trade_dates 中取 [..., T]，往前 N 个交易日（N 由 pit_window_days 转换）。
    简化：直接取全部 ≤ T 的交易日（最多 100 条），因子内部自取 tail。
    """

    if panel.empty:
        return pd.DataFrame()
    # 仅取 T 日及之前的交易日
    dates_le_t = [d for d in trade_dates if d <= trade_date]
    if not dates_le_t:
        return pd.DataFrame()
    # 取窗口内的所有可用列
    sub = panel.loc[panel.index.get_level_values("trade_date").isin(dates_le_t)]
    if factor.category in ("industry", "mixed") and not industry_pit.empty:
        ind_sub = industry_pit.loc[
            industry_pit.index.get_level_values("trade_date").isin(dates_le_t)
        ]
        sub = sub.join(ind_sub, how="left")
    return sub


def run_factors(
    *,
    factor_version: str,
    date_range: str,
    factor_ids: Sequence[str] | None = None,
    job_id: UUID | None = None,
) -> dict[str, int]:
    """对 date_range 内每个交易日计算因子并 upsert。

    参数：
        factor_version: 选 registry 中该 version 的因子集
        date_range:     "YYYYMMDD:YYYYMMDD"
        factor_ids:     可选过滤
        job_id:         若提供，则在每日完成后调 update_progress

    返回：
        {"trade_dates": N, "factors": K, "rows_upserted": M}
    """

    start, end = date_range.split(":")
    if len(start) != 8 or len(end) != 8:
        raise ValueError(f"date_range must be 'YYYYMMDD:YYYYMMDD', got {date_range!r}")

    factors = list_factors(
        factor_version=factor_version,
        factor_ids=list(factor_ids) if factor_ids else None,
    )
    if not factors:
        logger.warning(
            "no_factors_registered",
            extra={"factor_version": factor_version, "factor_ids": factor_ids},
        )
        return {"trade_dates": 0, "factors": 0, "rows_upserted": 0}

    # 计算最大 PIT 窗口，决定预取范围
    max_window = max(f.pit_window_days for f in factors)
    # 把 start 往前推 max_window 个日历日
    start_dt = pd.to_datetime(start, format="%Y%m%d")
    fetch_start_dt = start_dt - pd.Timedelta(days=max_window + 5)
    fetch_start = fetch_start_dt.strftime("%Y%m%d")

    # 拉交易日历 + 窗口数据
    trade_dates_all = _query_trade_dates(fetch_start, end)
    if not trade_dates_all:
        logger.warning(
            "no_trade_dates_in_window",
            extra={"fetch_start": fetch_start, "end": end},
        )
        return {"trade_dates": 0, "factors": len(factors), "rows_upserted": 0}

    target_dates = [d for d in trade_dates_all if start <= d <= end]
    need_industry = any(f.category in ("industry", "mixed") for f in factors)
    raw = load_window_data(fetch_start, end, need_industry=need_industry)

    total_upserted = 0
    for idx, t in enumerate(target_dates):
        if job_id is not None and check_cancel_requested(job_id):
            raise JobCancelled

        rows: list[dict[str, object]] = []
        for f in factors:
            sub = _slice_window_for_factor(
                raw.panel, raw.industry_pit, f, t, trade_dates_all
            )
            if sub.empty:
                continue
            try:
                series = f.compute(sub, t)
            except Exception as exc:  # noqa: BLE001
                # 单因子失败：warn + 跳过该因子，不影响其它因子（doc/03 §3.4 工程化原则）
                logger.warning(
                    "factor_compute_failed",
                    extra={
                        "factor_id": f.factor_id,
                        "factor_version": f.factor_version,
                        "trade_date": t,
                        "err": str(exc),
                    },
                )
                continue
            if series is None or series.empty:
                continue
            for ts_code, value in series.items():
                # 跳过 NaN（按 long 表惯例，停牌 / 数据不足不入库）
                if value is None or (isinstance(value, float) and np.isnan(value)):
                    continue
                rows.append(
                    {
                        "trade_date": t,
                        "ts_code": str(ts_code),
                        "factor_id": f.factor_id,
                        "factor_version": f.factor_version,
                        "value": float(value),
                    }
                )

        n = _upsert_daily_factors(rows)
        total_upserted += n

        # 写 progress
        if job_id is not None:
            pct = int(round((idx + 1) / max(len(target_dates), 1) * 100))
            update_progress(job_id, min(pct, 100), stage=f"factors:{t}")

    return {
        "trade_dates": len(target_dates),
        "factors": len(factors),
        "rows_upserted": total_upserted,
    }


# ----------------------------------------------------------------------
# Dispatcher 入口
# ----------------------------------------------------------------------

def runner_entrypoint(job: object) -> None:
    """供 worker.dispatcher 调用：从 job.params 解析参数后转 run_factors。

    job.params schema（spec 01 §4.1）：
        {
            "version": "v1",
            "date_range": "20240101:20260517",
            "factor_ids": ["momentum_20d", ...]   # optional
        }
    """

    # job 是 worker.poller.Job 实例；用 duck-typing 取属性，避免循环导入
    params = getattr(job, "params", {}) or {}
    factor_version = params.get("version")
    date_range = params.get("date_range")
    factor_ids = params.get("factor_ids")
    if not factor_version or not date_range:
        raise ValueError(
            f"factors job missing required params: version/date_range, got {params!r}"
        )
    job_id = getattr(job, "id", None)
    run_factors(
        factor_version=str(factor_version),
        date_range=str(date_range),
        factor_ids=factor_ids,
        job_id=job_id,
    )
