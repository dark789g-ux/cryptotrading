"""Schema 契约校验：启动时验证 DB 表/列与代码期望一致。"""

from __future__ import annotations

import logging
from collections import defaultdict

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# quant-pipeline 依赖的表和列（不含 updated_at 元数据列）
REQUIRED: dict[str, set[str]] = {
    "raw.trade_cal": {"exchange", "cal_date", "is_open", "pretrade_date"},
    "raw.index_classify": {"src", "index_code", "industry_code", "industry_name", "parent_code", "level"},
    "raw.index_member": {"ts_code", "l3_code", "in_date", "out_date", "l1_code", "l1_name", "l2_code", "l2_name", "l3_name", "name", "is_new"},
    "raw.daily_quote": {"ts_code", "trade_date", "open", "high", "low", "close", "vol", "amount"},
    "raw.adj_factor": {"ts_code", "trade_date", "adj_factor"},
    "raw.daily_basic": {"ts_code", "trade_date", "turnover_rate", "total_mv"},
    "raw.daily_indicator": {"ts_code", "trade_date"},
    "raw.stk_limit": {"ts_code", "trade_date", "pre_close", "up_limit", "down_limit"},
    "raw.suspend_d": {"ts_code", "trade_date", "suspend_type", "suspend_timing"},
    "raw.fina_indicator": {"ts_code", "end_date", "ann_date", "indicators", "update_flag"},
    "public.a_share_symbols": {"ts_code", "list_date", "delist_date"},
    "factors.daily_factors": {"trade_date", "ts_code", "factor_id", "factor_version", "value"},
    "factors.labels": {"trade_date", "ts_code", "scheme", "value", "exit_reason", "hold_days"},
    "factors.feature_sets": {"feature_set_id", "factor_version", "scheme", "factor_ids"},
    "factors.feature_matrix": {"trade_date", "ts_code", "feature_set_id", "features", "label"},
    "ml.jobs": {"id", "run_type", "params", "status", "progress", "stage", "priority", "attempts", "max_attempts", "cancel_requested", "error_text", "blocked_reason", "parent_job_id", "heartbeat_at", "started_at", "finished_at", "created_at", "created_by"},
    "ml.model_runs": {"id", "job_id", "model_version", "feature_set_id", "hyperparams", "oos_metrics", "artifact_uri", "report_uri", "shap_uri"},
    "ml.scores_daily": {"trade_date", "ts_code", "model_version", "score", "rank_in_day"},
    "ml.quality_reports": {"trade_date", "level", "rule", "detail"},
}


def validate_schema(session: Session) -> None:
    """校验 DB schema 与 REQUIRED 契约一致。失败则 raise RuntimeError。"""
    rows = session.execute(text("""
        SELECT table_schema || '.' || table_name AS tbl, column_name
        FROM information_schema.columns
        WHERE table_schema IN ('raw', 'public', 'factors', 'ml')
    """)).fetchall()

    actual: dict[str, set[str]] = defaultdict(set)
    for tbl, col in rows:
        actual[tbl].add(col)

    missing: list[str] = []
    for table, required_cols in REQUIRED.items():
        if table not in actual:
            missing.append(f"  缺失表: {table}")
            continue
        for col in required_cols:
            if col not in actual[table]:
                missing.append(f"  缺失列: {table}.{col}")

    if missing:
        raise RuntimeError("Schema 契约校验失败:\n" + "\n".join(missing))

    logger.info("schema_contract_ok", extra={"tables": len(REQUIRED)})
