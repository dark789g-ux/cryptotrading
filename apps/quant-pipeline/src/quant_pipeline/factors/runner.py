"""factors runner：调度器。

职责（spec m1-factor-library §交付物 3 + 02-quant-pipeline.md §4）：
1. 输入 date_range + factor_version + 可选 factor_ids
2. 调 `factors.data_access` 预取窗口内 raw 数据（交易日 / panel / 行业归属 /
   后复权 close_adj——数据访问层职责，见 review §12 拆分说明）
3. 对每个 T 日，调用每个因子的 compute
4. 按 (trade_date, ts_code, factor_id, factor_version) **去重后** upsert 到
   factors.daily_factors（CLAUDE.md 硬约束，由 data_access 完成）
5. 每日完成后调用 worker.progress.update_progress（如果 job_id 存在）

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
from uuid import UUID

import numpy as np
import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.constants import RETRY_WINDOW_MULTIPLIER

# 数据加载 / 复权 / upsert 已拆到 factors.data_access（review §12）。
# 此处 re-import 这些符号以保持 `factors.runner.<name>` 的旧引用兼容：
# - 集成测试直接 `from factors.runner import _query_trade_dates / _load_industry_pit`
# - 单测 monkeypatch `runner_mod._query_trade_dates / load_window_data / _upsert_daily_factors`
#   仍能命中本模块命名空间。
from quant_pipeline.factors.data_access import (  # noqa: F401
    RawData,
    _load_industry_pit,
    _query_live_universe,
    _query_trade_dates,
    _upsert_daily_factors,
    count_trade_days_in_window,
    load_window_data,
    shift_calendar_days,
    trade_cal_covers,
)
from quant_pipeline.factors.registry import list_factors
from quant_pipeline.factors.runner_window_guard import (
    _emit_job_warning,
    load_window_increment,
)
from quant_pipeline.worker.progress import (
    JobCancelled,
    check_cancel_requested,
    update_progress,
)

logger = logging.getLogger(__name__)

__all__ = [
    "RawData",
    "run_factors",
    "runner_entrypoint",
    "load_window_data",
]


# ----------------------------------------------------------------------
# Runner
# ----------------------------------------------------------------------

def _slice_window_for_factor(
    panel: pd.DataFrame,
    industry_pit: pd.DataFrame,
    factor: Factor,
    trade_date: str,
) -> pd.DataFrame:
    """为某个因子在 T 日切出 PIT 窗口 DataFrame。

    窗口取「全部 ≤ T 的交易日」切片（因子内部自取 tail）。

    性能（review §6）：panel / industry_pit 在加载时已按 MultiIndex
    [trade_date, ts_code] sort_index；trade_date 为 'YYYYMMDD' 字符串，字典序
    与时间序一致。用 `pd.IndexSlice[:t, :]` 做 O(log n) 二分切片，避免对全 panel
    逐行 `isin` 布尔扫描（M 因子 × N 日 × 全表的平方级开销）。
    """

    if panel.empty:
        return pd.DataFrame()
    # 仅取 T 日及之前的交易日：MultiIndex 二分切片（panel 已 sort_index）
    try:
        sub = panel.loc[pd.IndexSlice[:trade_date, :], :]  # type: ignore[misc]  # str 标签切片，stub 误判
    except KeyError:
        return pd.DataFrame()
    if sub.empty:
        return pd.DataFrame()
    if factor.category in ("industry", "mixed") and not industry_pit.empty:
        try:
            ind_sub = industry_pit.loc[pd.IndexSlice[:trade_date, :], :]  # type: ignore[misc]  # str 标签切片
        except KeyError:
            ind_sub = industry_pit.iloc[0:0]
        sub = sub.join(ind_sub, how="left")
    return sub


def _apply_pit_window_guard(
    *,
    factor: Factor,
    trade_date: str,
    sub: pd.DataFrame,
    raw: RawData,
    job_id: object | None,
) -> pd.DataFrame | None:
    """PIT 窗口护门：实测交易日数不足时扩窗 ×2 重试，仍不足则 skip。

    返回值：
      - DataFrame：可直接喂给 ``factor.compute``（可能是原 sub，也可能是扩窗后的子集）
      - None：本因子当天 skip（已写 warning）

    spec §3.2.2 / §3.2.3 完整伪代码已在 03-runtime-guard.md。
    """

    min_td = getattr(factor, "min_trade_days", 0) or 0
    if min_td <= 0:
        # 未声明 min_trade_days：保留旧行为（factor.compute 内部自有 `if len(close) < N`
        # 守门），护门不生效。Agent B 完成 16 因子回填后此分支不再触发。
        return sub

    window_start = shift_calendar_days(trade_date, -factor.pit_window_days)

    # 前置归因：先确认 trade_cal 真覆盖了这段时间
    if not trade_cal_covers(None, window_start, trade_date):
        logger.warning(
            "trade_cal_not_synced",
            extra={
                "factor_id": factor.factor_id,
                "trade_date": trade_date,
                "window_start": window_start,
                "remedy": "请先同步 raw.trade_cal 到该日期范围，再重跑因子",
            },
        )
        _emit_job_warning(
            job_id if isinstance(job_id, UUID) else None,
            "trade_cal_not_synced",
            factor_id=factor.factor_id,
            factor_version=factor.factor_version,
            trade_date=trade_date,
            window_start=window_start,
        )
        return None

    actual_td = count_trade_days_in_window(None, window_start, trade_date)
    if actual_td >= min_td:
        return sub   # 正常路径

    # 第一次告警
    logger.warning(
        "factor_window_short",
        extra={
            "factor_id": factor.factor_id,
            "factor_version": factor.factor_version,
            "trade_date": trade_date,
            "declared_pit_window": factor.pit_window_days,
            "actual_trade_days": actual_td,
            "min_trade_days": min_td,
        },
    )
    _emit_job_warning(
        job_id if isinstance(job_id, UUID) else None,
        "factor_window_short",
        factor_id=factor.factor_id,
        factor_version=factor.factor_version,
        trade_date=trade_date,
        declared_pit_window=factor.pit_window_days,
        actual_trade_days=actual_td,
        min_trade_days=min_td,
    )

    # 动态扩窗 ×2 重试
    retry_window_days = factor.pit_window_days * RETRY_WINDOW_MULTIPLIER
    retry_start = shift_calendar_days(trade_date, -retry_window_days)
    retry_td = count_trade_days_in_window(None, retry_start, trade_date)

    if retry_td < min_td:
        logger.warning(
            "factor_window_retry_failed",
            extra={
                "factor_id": factor.factor_id,
                "trade_date": trade_date,
                "retry_window_days": retry_window_days,
                "retry_trade_days": retry_td,
                "min_trade_days": min_td,
            },
        )
        _emit_job_warning(
            job_id if isinstance(job_id, UUID) else None,
            "factor_window_retry_failed",
            factor_id=factor.factor_id,
            factor_version=factor.factor_version,
            trade_date=trade_date,
            retry_window_days=retry_window_days,
            retry_trade_days=retry_td,
            min_trade_days=min_td,
        )
        return None

    # 重试成功：增量拉数据并切片到扩窗范围
    return load_window_increment(
        factor=factor,
        retry_start=retry_start,
        trade_date=trade_date,
        base_panel=raw.panel,
        base_industry_pit=raw.industry_pit,
    )


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
    failed_dates: list[str] = []
    for idx, t in enumerate(target_dates):
        if job_id is not None and check_cancel_requested(job_id):
            raise JobCancelled

        # PIT 安全过滤：T 日 raw.daily_quote 实际有报价的 ts_code 集合。
        # 滚动类因子（rsi / volatility / amihud 等）即使 T 日缺报价也能用历史
        # 窗口算出值；若不过滤，停牌 / 退市股会带着"历史平滑值"写进 T 日因子，
        # 构成幸存者偏差（quality.checks.check_survivor_bias 会判 critical）。
        live_universe = _query_live_universe(t)

        # universe 规模：用于检测某因子某日产出过稀（review §7）
        universe_size = len(live_universe)

        rows: list[dict[str, object]] = []
        for f in factors:
            sub = _slice_window_for_factor(raw.panel, raw.industry_pit, f, t)
            if sub.empty:
                # review §7：窗口数据缺失（如年初窗口裕度不足、节假日叠加），
                # 因子整日产出空——显式 warn，不静默 continue。
                logger.warning(
                    "factor_window_empty",
                    extra={
                        "factor_id": f.factor_id,
                        "factor_version": f.factor_version,
                        "trade_date": t,
                    },
                )
                continue

            # === PIT 窗口运行时护门（spec 2026-05-23-pit-window-guard-design §3.2）===
            # min_trade_days==0 视为"未声明"，跳过护门（兼容尚未回填 min_trade_days
            # 的旧因子；CLAUDE.md 暴露权衡：选择"不阻断老因子"而非"全部强制"）。
            sub = _apply_pit_window_guard(
                factor=f, trade_date=t, sub=sub, raw=raw, job_id=job_id,
            )
            if sub is None:
                continue   # 护门判定跳过该因子当天

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
                logger.warning(
                    "factor_output_empty",
                    extra={
                        "factor_id": f.factor_id,
                        "factor_version": f.factor_version,
                        "trade_date": t,
                    },
                )
                continue
            # review §7：某因子某日产出行数远小于 universe（如窗口不足导致大面积
            # 返回 NaN），是「静默返 NaN 污染训练数据」的前兆——显式 warn。
            non_nan = int(series.notna().sum())
            if universe_size > 0 and non_nan < universe_size * 0.5:
                logger.warning(
                    "factor_output_sparse",
                    extra={
                        "factor_id": f.factor_id,
                        "factor_version": f.factor_version,
                        "trade_date": t,
                        "non_nan": non_nan,
                        "universe_size": universe_size,
                    },
                )
            for ts_code, value in series.items():
                # 跳过 NaN（按 long 表惯例，停牌 / 数据不足不入库）
                if value is None or (isinstance(value, float) and np.isnan(value)):
                    continue
                # PIT 安全：T 日无报价的 ts_code 不写因子（见 live_universe 注释）
                if str(ts_code) not in live_universe:
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

        # review §4：单日 upsert 包 try/except——DB 抖动只让当日失败并记 error，
        # 不中断整轮 run_factors；已成功落库到 t-1 的进度不回退。
        try:
            n = _upsert_daily_factors(rows)
            total_upserted += n
        except Exception as exc:  # noqa: BLE001
            failed_dates.append(t)
            logger.error(
                "daily_factors_upsert_failed",
                extra={"trade_date": t, "rows": len(rows), "err": str(exc)},
            )
            n = 0

        # 写 progress
        if job_id is not None:
            pct = int(round((idx + 1) / max(len(target_dates), 1) * 100))
            update_progress(job_id, min(pct, 100), stage=f"factors:{t}")

    if failed_dates:
        # review §4：整轮结束后汇总告警——哪些交易日 upsert 失败需要重跑。
        logger.warning(
            "run_factors_partial_failure",
            extra={"failed_dates": failed_dates, "n_failed": len(failed_dates)},
        )

    return {
        "trade_dates": len(target_dates),
        "factors": len(factors),
        "rows_upserted": total_upserted,
        "failed_dates": len(failed_dates),
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
