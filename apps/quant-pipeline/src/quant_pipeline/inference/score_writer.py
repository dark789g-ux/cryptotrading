"""把推理结果 upsert 到 ml.scores_daily（M2 Part B）。

spec m2-training-mvp.md 验收门槛：
    一次 train → infer 必须让 ml.scores_daily 当日"所有出现在 raw.daily_quote
    的股票"均有评分（行数严格相等，不允许少 1 行；多则报错）。

为此 write_scores 前必做：
    1. 校验 df 与 raw.daily_quote 当日股票数严格相等（spec 验收硬约束）
    2. 按 trade_date / model_version 计算 rank_in_day（score desc）
    3. upsert 到 ml.scores_daily（PK: trade_date, ts_code, model_version）

签名形态（spec Part B 明确）：
    `write_scores(df, model_version, trade_date, session)`
    df 必含列 [ts_code, score]；rank_in_day 由本模块计算（避免重复实现）。
    session 由调用方（inference.runner）传入，避免嵌套 commit。
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
import pandas as pd
from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


class ScoreRowCountMismatch(ValueError):
    """评分行数与 raw.daily_quote 当日股票数不一致 —— spec 验收硬约束。

    属性 detail 含 expected / got / sample 便于 dispatcher 把 error_text 写出。
    """

    def __init__(self, expected: int, got: int, detail: dict[str, Any]) -> None:
        super().__init__(
            f"scores_daily row count mismatch: expected={expected} (raw.daily_quote), got={got}"
        )
        self.expected = expected
        self.got = got
        self.detail = detail


def _count_daily_quote(session: Session, trade_date: str) -> int:
    sql = text(
        """
        SELECT count(DISTINCT ts_code) AS n
        FROM raw.daily_quote
        WHERE trade_date = :d
        """
    )
    row = session.execute(sql, {"d": trade_date}).first()
    return int(row[0]) if row else 0


def compute_rank_in_day(df: pd.DataFrame) -> pd.DataFrame:
    """按 score 降序计算 rank_in_day（同分 method='first'，保证整数 1..N 唯一）。

    入参 df 必须含列 [ts_code, score]；不修改原 df，返回拷贝增加 rank_in_day 列。

    NaN score 处理（评审 05-#11）：特征覆盖不足的股票 score 为 NaN。
    `Series.rank` 默认把 NaN 排成 NaN rank，`int(...)` 会抛 ValueError；
    这里先 `fillna(-inf)` 让 NaN 股票统一排到末尾（最大 rank），与
    inference.runner._attach_rank_in_day 口径一致。
    """

    if df.empty:
        out = df.copy()
        out["rank_in_day"] = pd.Series([], dtype=int)
        return out
    out = df.copy()
    n = len(out)
    # NaN score → 排末尾：fillna(-inf) 后做升序 rank
    filled = out["score"].fillna(-np.inf)
    asc_rank = filled.rank(method="first", ascending=True).astype(int)
    out["rank_in_day"] = (n + 1 - asc_rank).astype(int)
    return out


def write_scores(
    df: pd.DataFrame,
    model_version: str,
    trade_date: str,
    session: Session,
    *,
    enforce_row_count: bool = True,
) -> int:
    """upsert ml.scores_daily；按 score desc 计算 rank_in_day。

    Args:
        df: 列 [ts_code, score]（可选 rank_in_day —— 提供则覆盖重算）
        model_version: 必填
        trade_date:    必填，YYYYMMDD
        session:       SQLAlchemy Session（外部事务上下文，避免嵌套 commit）
        enforce_row_count:
            True 时校验 df 行数严格 == raw.daily_quote 当日股票数；失败抛
            ScoreRowCountMismatch（spec M2 验收硬约束："不允许少 1 行；多则报错"）。
            仅 unit test / 灰度调试可设为 False。

    Returns:
        upserted 行数

    Raises:
        ValueError: df 缺少必要列 / trade_date 格式错误
        ScoreRowCountMismatch: 行数严格校验失败
    """

    if len(trade_date) != 8 or not trade_date.isdigit():
        raise ValueError(f"trade_date must be YYYYMMDD, got {trade_date!r}")
    if not model_version:
        raise ValueError("model_version 必填且非空")
    if df is None or "ts_code" not in df.columns or "score" not in df.columns:
        raise ValueError(
            f"df must contain columns ['ts_code', 'score'], "
            f"got {list(df.columns) if df is not None else None}"
        )

    # 去重（按 ts_code 保留最后一条；CLAUDE.md：upsert 前去重防 ON CONFLICT 单批多次冲突）。
    # 评审 05-#13：keep="last" 与上游 concat 顺序耦合 —— predict_one_day 把缺失股票的
    # NaN 行 concat 在真实评分行之后，故重复键时 keep="last" 不会用 NaN 行覆盖真实评分；
    # 上游 `missing` 列表构造保证缺失股票与已评分股票不相交，当前安全。
    if df["ts_code"].duplicated().any():
        before = len(df)
        df = df.drop_duplicates(subset=["ts_code"], keep="last").reset_index(drop=True)
        logger.warning(
            "scores_daily_dedup",
            extra={
                "trade_date": trade_date,
                "model_version": model_version,
                "raw_rows": before,
                "deduped_rows": len(df),
            },
        )

    if enforce_row_count:
        expected = _count_daily_quote(session, trade_date)
        if expected == 0:
            raise ScoreRowCountMismatch(
                expected=expected,
                got=len(df),
                detail={
                    "trade_date": trade_date,
                    "model_version": model_version,
                    "reason": "raw.daily_quote_empty_for_date",
                },
            )
        if len(df) != expected:
            sample = df["ts_code"].head(5).tolist()
            raise ScoreRowCountMismatch(
                expected=expected,
                got=len(df),
                detail={
                    "trade_date": trade_date,
                    "model_version": model_version,
                    "sample_ts_codes": sample,
                    "reason": "row_count_mismatch_with_raw_daily_quote",
                },
            )

    df = compute_rank_in_day(df) if "rank_in_day" not in df.columns else df

    rows = [
        {
            "trade_date": trade_date,
            "ts_code": str(r["ts_code"]),
            "model_version": model_version,
            "score": float(r["score"]),
            "rank_in_day": int(r["rank_in_day"]),
        }
        for _, r in df.iterrows()
    ]

    sql = text(
        """
        INSERT INTO ml.scores_daily
            (trade_date, ts_code, model_version, score, rank_in_day)
        VALUES
            (:trade_date, :ts_code, :model_version, :score, :rank_in_day)
        ON CONFLICT (trade_date, ts_code, model_version)
        DO UPDATE SET score = EXCLUDED.score,
                      rank_in_day = EXCLUDED.rank_in_day
        """
    )
    session.execute(sql, rows)
    return len(rows)


__all__ = [
    "ScoreRowCountMismatch",
    "compute_rank_in_day",
    "write_scores",
]
