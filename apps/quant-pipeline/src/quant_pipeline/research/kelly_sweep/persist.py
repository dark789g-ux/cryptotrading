"""persist.py — 把扫描结果批量写入 research.kelly_sweep_results。

责任：
  - 接收 rows（全量 ResultRow）、pareto（compute_pareto_frontier 标注）、
    topk（rank_top_k 返回的入选集合），合并 is_frontier/is_topk 后批量 INSERT。
  - 写前 DELETE WHERE job_id=? 防重试残留（幂等）。
  - variant_filters/exit_cfg 用 json.dumps(ensure_ascii=False) → jsonb。
  - 不写 valid_keys（省空间；CI 已由 rank_top_k 算好存进 kelly_ci_low/high）。

风格：SQLAlchemy text() 裸 SQL（与 worker/ 既有写库代码一致）。
"""

from __future__ import annotations

import json
import logging
from typing import Any
from uuid import UUID

from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.research.kelly_sweep.sweep import ResultRow

logger = logging.getLogger(__name__)


def persist_results(
    job_id: UUID,
    rows: list[ResultRow],
    pareto: list[dict],
    topk: dict[str, list[ResultRow]],
) -> None:
    """把全量 ResultRow 批量写入 research.kelly_sweep_results。

    Args:
        job_id: 对应 ml.jobs.id（UUID），用于外键 + 写前删旧行。
        rows:   run_sweep 全量 ResultRow 列表。
        pareto: compute_pareto_frontier 返回的 list[dict]，每项含
                原 ResultRow 字段 + is_frontier(bool)。
        topk:   rank_top_k 返回的 dict[window_group → list[ResultRow]]，
                入选行已填充 kelly_ci_low/high。
    """
    if not rows:
        logger.warning("persist_results: rows 为空，跳过写库（job_id=%s）", job_id)
        return

    # ── 构建 is_frontier 集合（variant_id, exit_id, window_group 三元组作键）──
    frontier_set: set[tuple[str, str, str]] = set()
    for prow in pareto:
        if prow.get("is_frontier"):
            frontier_set.add(
                (str(prow["variant_id"]), str(prow["exit_id"]), str(prow["window_group"]))
            )

    # ── 构建 is_topk 集合 + 从 topk 中取 CI（已填充）──────────────────────────
    topk_set: set[tuple[str, str, str]] = set()
    ci_map: dict[tuple[str, str, str], tuple[float | None, float | None]] = {}
    for _wg, wg_rows in topk.items():
        for r in wg_rows:
            key = (r.variant_id, r.exit_id, r.window_group)
            topk_set.add(key)
            ci_map[key] = (r.kelly_ci_low, r.kelly_ci_high)

    # ── 批量 INSERT ──────────────────────────────────────────────────────────
    insert_sql = text(
        """
        INSERT INTO research.kelly_sweep_results (
            job_id, window_group, variant_id, variant_filters,
            exit_id, exit_cfg,
            n_train, kelly_train, win_rate_train, payoff_b_train, profit_factor_train,
            n_valid, kelly_valid, win_rate_valid, payoff_b_valid, profit_factor_valid,
            below_floor, kelly_ci_low, kelly_ci_high,
            is_frontier, is_topk, same_day_rule
        ) VALUES (
            :job_id, :window_group, :variant_id, CAST(:variant_filters AS jsonb),
            :exit_id, CAST(:exit_cfg AS jsonb),
            :n_train, :kelly_train, :win_rate_train, :payoff_b_train, :profit_factor_train,
            :n_valid, :kelly_valid, :win_rate_valid, :payoff_b_valid, :profit_factor_valid,
            :below_floor, :kelly_ci_low, :kelly_ci_high,
            :is_frontier, :is_topk, :same_day_rule
        )
        """
    )

    batch: list[dict[str, Any]] = []
    for row in rows:
        key = (row.variant_id, row.exit_id, row.window_group)
        is_frontier = key in frontier_set
        is_topk = key in topk_set
        ci_low, ci_high = ci_map.get(key, (None, None))
        # CI 来自 topk 中已填充的行（对 top-K 外的行，kelly_ci_low/high 保持 None）

        batch.append(
            {
                "job_id": job_id,
                "window_group": row.window_group,
                "variant_id": row.variant_id,
                "variant_filters": json.dumps(row.variant_filters, ensure_ascii=False),
                "exit_id": row.exit_id,
                "exit_cfg": json.dumps(row.exit_cfg, ensure_ascii=False),
                "n_train": row.n_train,
                "kelly_train": row.kelly_train,
                "win_rate_train": row.win_rate_train,
                "payoff_b_train": row.payoff_b_train,
                "profit_factor_train": row.profit_factor_train,
                "n_valid": row.n_valid,
                "kelly_valid": row.kelly_valid,
                "win_rate_valid": row.win_rate_valid,
                "payoff_b_valid": row.payoff_b_valid,
                "profit_factor_valid": row.profit_factor_valid,
                "below_floor": row.below_floor,
                "kelly_ci_low": ci_low,
                "kelly_ci_high": ci_high,
                "is_frontier": is_frontier,
                "is_topk": is_topk,
                "same_day_rule": row.same_day_rule,
            }
        )

    # 单事务：先 DELETE 旧行（幂等，防重试残留），再分批 INSERT
    # batch 列表在事务外构建（in-memory，不依赖 DB），事务仅覆盖写操作以缩短持锁时间
    BATCH_SIZE = 500
    with session_scope() as session:
        session.execute(
            text("DELETE FROM research.kelly_sweep_results WHERE job_id = :job_id"),
            {"job_id": job_id},
        )
        logger.info("persist_results: 删除 job_id=%s 旧行", job_id)
        for start in range(0, len(batch), BATCH_SIZE):
            chunk = batch[start : start + BATCH_SIZE]
            session.execute(insert_sql, chunk)

    logger.info(
        "persist_results: 写入 %d 行（job_id=%s，is_frontier=%d，is_topk=%d）",
        len(rows),
        job_id,
        len(frontier_set),
        len(topk_set),
    )


def build_summary_payload(
    rows: list[ResultRow],
    pareto: list[dict],
    topk: dict[str, list[ResultRow]],
) -> dict[str, Any]:
    """构造 ml.jobs.result_payload 的轻量摘要（列表/历史下拉快速展示用）。

    结构（spec 02）：
        {"n_rows": 848, "n_topk": 60, "n_frontier": 14,
         "best": {"window_group": ..., "variant_id": ..., "exit_id": ...,
                  "kelly_valid": ..., "kelly_ci_low": ..., "kelly_ci_high": ..., "n_valid": ...}}
    """
    n_rows = len(rows)
    n_frontier = sum(1 for p in pareto if p.get("is_frontier"))
    n_topk = sum(len(wg_rows) for wg_rows in topk.values())

    # 找 kelly_valid 最高的 top-K 行作为 "best"
    best_row: ResultRow | None = None
    for wg_rows in topk.values():
        for r in wg_rows:
            if r.kelly_valid is not None:
                if best_row is None or (
                    best_row.kelly_valid is None or r.kelly_valid > best_row.kelly_valid
                ):
                    best_row = r

    best: dict[str, Any] | None = None
    if best_row is not None:
        best = {
            "window_group": best_row.window_group,
            "variant_id": best_row.variant_id,
            "exit_id": best_row.exit_id,
            "kelly_valid": best_row.kelly_valid,
            "kelly_ci_low": best_row.kelly_ci_low,
            "kelly_ci_high": best_row.kelly_ci_high,
            "n_valid": best_row.n_valid,
        }

    return {
        "n_rows": n_rows,
        "n_topk": n_topk,
        "n_frontier": n_frontier,
        "best": best,
    }
