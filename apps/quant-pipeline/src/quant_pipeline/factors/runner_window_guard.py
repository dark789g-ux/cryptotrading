"""PIT 窗口运行时护门辅助（spec 2026-05-23-pit-window-guard-design §3.2）。

从 ``factors.runner`` 拆出（CLAUDE.md 500 行硬约束）。本模块承担：

1. ``_emit_job_warning``：把 runner 期间的 warning 追加到 ``ml.jobs.warnings``
   JSONB 数组（spec 06 §6.1.2）；progress.update_progress 下次推送时会带
   warnings_summary（spec 06 §6.2）。
2. ``load_window_increment``：扩窗 ×2 重试时，**增量补拉**而非"重拉全量"——
   - 若 base_df 已覆盖到 retry_start：复用切片
   - 否则补拉 [retry_start, base_min) 这段并 concat 到新 DataFrame（不污染入参）

为何拆这个文件：runner.py 已 ~300 行；加上护门主体、_emit_job_warning、
增量拉数据后必然破 500 行硬约束。增量拉的实现细节自成一体，与 runner 的
"调度主循环"职责正交，可以独立单测。
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.factors.data_access import _load_raw_panel

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# warnings 写入 ml.jobs.warnings（spec 06 §6.1.2）
# ----------------------------------------------------------------------

def _emit_job_warning(
    job_id: UUID | None,
    warning_type: str,
    **detail: Any,
) -> None:
    """追加一条 warning 到 ``ml.jobs.warnings`` JSONB 数组。

    progress.update_progress 下次推送时会聚合 warnings_summary（spec 06 §6.2）。

    Args:
        job_id:       目标 job；None 时 CLI 直跑路径直接 noop（不可写库也不报错）
        warning_type: 'factor_window_short' / 'factor_window_retry_failed' /
                      'trade_cal_not_synced' 等（spec §3.2.2）
        **detail:     任意可 JSON 序列化字段，会与 type/ts 合并写入 JSONB item

    用 JSONB ``||`` 操作符 append 单元素数组；非 upsert 路径，
    CLAUDE.md "upsert 前去重" 约束不适用。
    """

    if job_id is None:
        # CLI 直跑场景：仍然记一条 log，便于追溯；只是不写 ml.jobs
        logger.warning(
            "factor_runtime_warning_no_job",
            extra={"warning_type": warning_type, "detail": detail},
        )
        return

    item: dict[str, Any] = {
        "type": warning_type,
        # 显式 UTC（CLAUDE.md：DB 时间一律 UTC 瞬时；本字段虽落 JSONB 但语义保持一致）
        "ts": datetime.now(UTC).isoformat(),
    }
    item.update(detail)

    try:
        with session_scope() as session:
            session.execute(
                text(
                    """
                    UPDATE ml.jobs
                    SET warnings = COALESCE(warnings, '[]'::jsonb) || CAST(:w AS jsonb)
                    WHERE id = :id
                    """
                ),
                {"w": json.dumps([item], ensure_ascii=False), "id": job_id},
            )
    except Exception as exc:  # noqa: BLE001
        # warnings 写入失败不能拖累 runner；记 error 但继续跑。
        # ml.jobs.warnings 列若 migration 未落地（Agent A 工作域），会 ProgrammingError；
        # 此处 warn 让用户能在日志看到，避免静默吞错（CLAUDE.md）。
        logger.error(
            "emit_job_warning_failed",
            extra={
                "job_id": str(job_id),
                "warning_type": warning_type,
                "err": str(exc),
            },
        )


# ----------------------------------------------------------------------
# 扩窗增量拉取（spec §3.2.3）
# ----------------------------------------------------------------------

def load_window_increment(
    factor: Any,  # quant_pipeline.factors.base.Factor，避免循环 import
    retry_start: str,
    trade_date: str,
    base_panel: pd.DataFrame,
    base_industry_pit: pd.DataFrame,
) -> pd.DataFrame:
    """扩窗 ×2 重试用：返回独立 DataFrame，**不修改入参 base_panel**。

    实现策略（spec §3.2.3）：
      1. 若 base_panel 的最早 trade_date 已 <= retry_start：直接 ``base_panel.loc``
         切片复用（pandas IndexSlice 是视图，但 runner 下游只读不写，安全）。
      2. 否则补拉 [retry_start, base_min) 这段，concat 到 base_panel.copy() 上
         并 sort_index 后返回——base_panel.copy() 保证原对象不被 sort_index 副作用
         污染（其它 factor 还要继续按各自的窗口切 base_panel）。

    返回的 DataFrame 已按 [trade_date, ts_code] sort_index，调用方可继续
    用 pd.IndexSlice 切片。

    Args:
        factor:            当前因子实例（取 ``category`` 决定是否 join industry_pit）
        retry_start:       扩窗后起点 'YYYYMMDD'
        trade_date:        T 日 'YYYYMMDD'
        base_panel:        已预取的 panel（**入参，不修改**）
        base_industry_pit: 已预取的行业归属 PIT（**入参，不修改**）

    Returns:
        切到 [retry_start, trade_date] 范围内的 DataFrame，索引同 base_panel。
        若 join industry 必要，已 left join 进 industry_l1 列。
    """

    if base_panel.empty:
        return base_panel

    base_dates = base_panel.index.get_level_values("trade_date")
    base_min = base_dates.min()

    if base_min <= retry_start:
        # 已覆盖，切片复用
        try:
            sub = base_panel.loc[pd.IndexSlice[retry_start:trade_date, :], :]  # type: ignore[misc]  # str 标签切片
        except KeyError:
            sub = base_panel.iloc[0:0]
    else:
        # 补拉 [retry_start, base_min)；注意 base_min 闭右开避免重复行 + ON CONFLICT 风险
        # SQL 层 BETWEEN 是闭区间，故 end_excl 取 base_min - 1 日（按字符串字典序）
        # 但 daily_quote 用 'YYYYMMDD'，字典序与时间序一致，直接传 base_min 再过滤更稳。
        extra = _load_raw_panel(retry_start, base_min)
        if not extra.empty:
            # 剔除 base_min 当日避免重复
            extra = extra[extra.index.get_level_values("trade_date") < base_min]
        # base_panel.copy() 防 sort_index 副作用回污原对象
        merged = pd.concat([extra, base_panel.copy()]).sort_index()
        try:
            sub = merged.loc[pd.IndexSlice[retry_start:trade_date, :], :]  # type: ignore[misc]  # str 标签切片
        except KeyError:
            sub = merged.iloc[0:0]

    if sub.empty:
        return sub

    # close_adj 计算：扩窗后的 panel 不再走 load_window_data 的 max(adj_factor) 路径，
    # 需要在切片上独立重算（基准是切片内 max，PIT 安全）。
    if "adj_factor" in sub.columns and "close" in sub.columns:
        sub = sub.copy()
        af = sub["adj_factor"]
        max_af = af.groupby(level="ts_code").transform("max")
        sub["close_adj"] = sub["close"] * af / max_af

    if factor.category in ("industry", "mixed") and not base_industry_pit.empty:
        try:
            ind_sub = base_industry_pit.loc[pd.IndexSlice[:trade_date, :], :]  # type: ignore[misc]  # str 标签切片
        except KeyError:
            ind_sub = base_industry_pit.iloc[0:0]
        sub = sub.join(ind_sub, how="left")

    return sub


__all__ = [
    "_emit_job_warning",
    "load_window_increment",
]
