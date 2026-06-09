"""kelly_sweep_runner.py — kelly_sweep run_type 的 worker runner。

复刻 CLI 的 _run_sweep_pipeline（cli.py:289-392）调用链，差别在：
  - 从 job.params 读取 SweepConfig 12 字段 + exit_families
  - 用 build_exit_grid 构造 exit_grid（与 CLI 共用，防口径漂移）
  - 各阶段把 on_progress 桥接到 update_progress(job_id, pct, stage)
  - 跑完调 persist_results 写库 + 返回 summary dict（→ ml.jobs.result_payload）

进度分段（spec 01「进度粒度」）：
  enumerate 0-15 / paths 15-35 / features 35-50 / index 50-55 / sweep 55-90 / ci 90-100
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from quant_pipeline.worker.poller import Job
from quant_pipeline.worker.progress import update_progress

logger = logging.getLogger(__name__)

# ── 进度区间（spec 01）────────────────────────────────────────────────────────
_STAGE_RANGES = {
    "enumerate": (0, 15),
    "paths":     (15, 35),
    "features":  (35, 50),
    "index":     (50, 55),
    "sweep":     (55, 90),
    "ci":        (90, 100),
}



def _make_stage_progress(job_id: UUID, stage_name: str) -> Any:
    """构造缩放到 [lo, hi] 的进度回调，供各阶段函数的 on_progress 参数使用。

    返回值签名：(done: int, total: int) -> None
    内部把 done/total 线性缩放到 [lo, hi]，再调 update_progress。
    """
    lo, hi = _STAGE_RANGES[stage_name]
    span = hi - lo

    def _cb(done: int, total: int) -> None:
        if total <= 0:
            pct = hi
        else:
            # 整除避免浮点漂移，与 make_scaled_callback 一致
            pct = lo + (span * done) // total
        pct = max(lo, min(hi, pct))
        update_progress(job_id, pct, stage=f"{stage_name} {done}/{total}")

    return _cb


def _parse_sweep_config(params: dict[str, Any]):
    """从 job.params 解析 SweepConfig（12 字段）。

    params 结构（spec 02 data-model）：
        base_trigger: {"field": ..., "op": ..., "value": ...}
        universe, max_window, max_entry_filters, min_samples,
        train_range: [start, end], valid_range: [start, end],
        bootstrap_iters, same_day_rule,
        rs_benchmark: [...], rs_lookback, top_k
    """
    from quant_pipeline.research.kelly_sweep.config import SweepConfig
    from quant_pipeline.research.kelly_sweep.types import BaseTrigger

    bt_raw = params.get("base_trigger", {})
    base_trigger = BaseTrigger(
        field=str(bt_raw.get("field", "kdj_j")),
        op=str(bt_raw.get("op", "lt")),
        value=float(bt_raw.get("value", 0.0)),
    )

    train_range_raw = params.get("train_range", ["20230101", "20241231"])
    valid_range_raw = params.get("valid_range", ["20250101", "20260608"])

    return SweepConfig(
        base_trigger=base_trigger,
        universe=params.get("universe", "all"),
        max_window=int(params.get("max_window", 20)),
        max_entry_filters=int(params.get("max_entry_filters", 2)),
        train_range=(str(train_range_raw[0]), str(train_range_raw[1])),
        valid_range=(str(valid_range_raw[0]), str(valid_range_raw[1])),
        min_samples=int(params.get("min_samples", 300)),
        bootstrap_iters=int(params.get("bootstrap_iters", 1000)),
        same_day_rule=str(params.get("same_day_rule", "sl_first")),
        rs_benchmark=list(params.get("rs_benchmark", ["hs300"])),
        rs_lookback=int(params.get("rs_lookback", 5)),
        top_k=int(params.get("top_k", 30)),
    )


def run_kelly_sweep(job: Job) -> dict[str, Any]:
    """kelly_sweep runner 主入口。

    Args:
        job: ml.jobs 行，job.params 包含 SweepConfig 字段 + exit_families。

    Returns:
        summary dict，写入 ml.jobs.result_payload。
    """
    # 延迟 import：避免 worker 加载时拖入 pandas / sqlalchemy 等重库
    from quant_pipeline.research.kelly_sweep.enumerate import enumerate_signals
    from quant_pipeline.research.kelly_sweep.paths import (
        load_feature_inputs,
        load_forward_paths,
        load_index_daily,
    )
    from quant_pipeline.research.kelly_sweep.persist import build_summary_payload, persist_results
    from quant_pipeline.research.kelly_sweep.report import compute_pareto_frontier, rank_top_k
    from quant_pipeline.research.kelly_sweep.sweep import BENCH_CODE_MAP, build_exit_grid, run_sweep

    params = job.params or {}
    job_id = job.id

    # ── 1. 解析配置 ────────────────────────────────────────────────────────
    cfg = _parse_sweep_config(params)

    # exit_families：默认全选四族
    families_raw = params.get("exit_families", ["fixed_n", "tp_sl", "trailing", "atr_stop"])
    if not isinstance(families_raw, list):
        raise ValueError(
            f"kelly_sweep params.exit_families 必须是字符串数组，got {families_raw!r}"
        )
    exit_grid = build_exit_grid([str(f) for f in families_raw])

    logger.info(
        "kelly_sweep runner 启动: job_id=%s, base_trigger=%s, exit_grid 大小=%d",
        job_id,
        cfg.base_trigger,
        len(exit_grid),
    )

    # ── 2. 枚举信号（0-15%）──────────────────────────────────────────────────
    update_progress(job_id, 0, stage="enumerate 开始")
    signals = enumerate_signals(
        cfg,
        on_progress=_make_stage_progress(job_id, "enumerate"),
    )
    logger.info("enumerate_signals 完成：%d 条信号", len(signals))

    if not signals:
        raise ValueError("kelly_sweep enumerate_signals 返回空，无可用信号")

    # ── 3. 加载前向路径（15-35%）──────────────────────────────────────────────
    update_progress(job_id, 15, stage="paths 开始")
    paths = load_forward_paths(
        signals,
        cfg.max_window,
        date_end=cfg.valid_range[1],
        on_progress=_make_stage_progress(job_id, "paths"),
    )
    logger.info("load_forward_paths 完成：%d 条路径", len(paths))

    # ── 4. 加载特征输入（35-50%）──────────────────────────────────────────────
    update_progress(job_id, 35, stage="features 开始")
    cross_section_df, history_map = load_feature_inputs(
        signals,
        on_progress=_make_stage_progress(job_id, "features"),
    )

    # ── 5. 加载指数日线（50-55%）──────────────────────────────────────────────
    update_progress(job_id, 50, stage="index 开始")
    bench_codes = [BENCH_CODE_MAP[b] for b in cfg.rs_benchmark if b in BENCH_CODE_MAP]
    if bench_codes:
        index_daily_df = load_index_daily(
            bench_codes,
            (cfg.train_range[0], cfg.valid_range[1]),
            on_progress=_make_stage_progress(job_id, "index"),
        )
    else:
        import pandas as pd
        index_daily_df = pd.DataFrame(
            columns=["ts_code", "trade_date", "open", "high", "low", "close", "pct_change"]
        )
        update_progress(job_id, 55, stage="index 跳过（无宽基基准）")

    # ── 6. 网格扫描（55-90%）──────────────────────────────────────────────────
    update_progress(job_id, 55, stage="sweep 开始")
    rows = run_sweep(
        config=cfg,
        signals_raw=signals,
        paths=paths,
        cross_section_df=cross_section_df,
        history_map=history_map,
        index_daily_df=index_daily_df,
        exit_grid=exit_grid,
        on_progress=_make_stage_progress(job_id, "sweep"),
    )
    logger.info("run_sweep 完成：%d ResultRow", len(rows))

    if not rows:
        raise ValueError("kelly_sweep run_sweep 返回空结果")

    # ── 7. 帕累托前沿（同步，不独立推进度）────────────────────────────────────
    pareto = compute_pareto_frontier(rows)

    # ── 8. top-K + bootstrap CI（90-100%）────────────────────────────────────
    update_progress(job_id, 90, stage="ci 开始")
    topk = rank_top_k(
        rows,
        cfg,
        paths,
        on_progress=_make_stage_progress(job_id, "ci"),
    )

    # ── 9. 写库 ───────────────────────────────────────────────────────────────
    update_progress(job_id, 99, stage="写库")
    persist_results(job_id, rows, pareto, topk)

    # ── 10. 构造 result_payload ────────────────────────────────────────────────
    summary = build_summary_payload(rows, pareto, topk)
    logger.info(
        "kelly_sweep 完成: job_id=%s, n_rows=%d, n_topk=%d, n_frontier=%d",
        job_id,
        summary["n_rows"],
        summary["n_topk"],
        summary["n_frontier"],
    )

    # 必须 emit progress=100 的 NOTIFY，触发 SSE 终态链：
    # 后端 SSE controller 仅在收到 progress>=100 的 pg_notify 时回查 status、
    # 下发 complete 事件；前端 ProgressLine 据此 emit 'done' → 自动加载结果。
    # dispatcher 在 runner 返回后写 status=success/progress=100 是直接 UPDATE，
    # **不发 pg_notify**——若 runner 自身最后停在 99（写库），SSE 永远收不到
    # >=100 事件，ProgressLine 卡在 99、done 不触发、结果不自动加载（真机 e2e 实测）。
    update_progress(job_id, 100, stage="完成")
    return summary
