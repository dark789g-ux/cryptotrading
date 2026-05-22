"""sync 模块共享的 upsert / 去重工具。

CLAUDE.md 硬约束：upsert 前必须按 PK 去重；去重条数差异 logger.warn，
注明 raw_count vs deduped_count 用于核查 TuShare 数据语义。
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence
from typing import Any

import pandas as pd
from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def to_str_or_none(v: Any) -> str | None:
    """把单个值归一为 str | None。

    pandas `to_dict(orient="records")` 后缺失值是 `float('nan')` 而非 `None`，
    `nan is not None` 为 `True`，直接 `str(nan)` 会得到字符串 `"nan"` 写进库。
    本工具统一用 `v != v` 检测 NaN（NaN 是唯一不等于自身的值）。
    """

    if v is None:
        return None
    if isinstance(v, float) and v != v:  # NaN
        return None
    return str(v)


def dedupe_by_pk(
    df: pd.DataFrame,
    pk_cols: Sequence[str],
    *,
    api_name: str,
) -> pd.DataFrame:
    """按 PK 去重（保留最后一条 = TuShare 同步语义里"最新覆盖旧"）。

    去重条数差异时 logger.warn，符合 CLAUDE.md 关于 TuShare 重复行的硬约束。
    """

    raw_count = len(df)
    if raw_count == 0:
        return df

    # 任一 PK 列缺失则报错（绝不能 silently drop）
    missing = [c for c in pk_cols if c not in df.columns]
    if missing:
        raise ValueError(
            f"dedupe_by_pk: api={api_name} 缺失 PK 列 {missing!r}；df 列：{list(df.columns)}"
        )

    deduped = df.drop_duplicates(subset=list(pk_cols), keep="last")
    deduped_count = len(deduped)
    if deduped_count < raw_count:
        logger.warning(
            "tushare_duplicate_rows",
            extra={
                "api_name": api_name,
                "pk_cols": list(pk_cols),
                "raw_count": raw_count,
                "deduped_count": deduped_count,
                "dropped": raw_count - deduped_count,
            },
        )
    return deduped


def upsert_rows(
    session: Session,
    *,
    table: str,
    rows: Iterable[dict[str, Any]],
    pk_cols: Sequence[str],
    update_cols: Sequence[str],
    jsonb_cols: Sequence[str] | None = None,
) -> int:
    """PG ON CONFLICT 批量 upsert。

    参数：
      table: 形如 'raw.trade_cal'（含 schema）
      rows: 已去重的字典列表
      pk_cols: 冲突键列
      update_cols: 冲突时要更新的列（updated_at 自动加）
      jsonb_cols: 需要 `CAST(:col AS jsonb)` 的列（值应为 json 文本字符串），
        避免 driver 把 jsonb 当 text 绑定
    """

    rows = list(rows)
    if not rows:
        return 0

    jsonb_set = set(jsonb_cols or ())
    all_cols = list(rows[0].keys())
    # 校验隐式契约：所有 row 的 key 集合必须与首行一致。
    # 否则 SQLAlchemy executemany 会因缺绑定参数报错或静默错位。
    expected = set(all_cols)
    for i, r in enumerate(rows):
        if set(r.keys()) != expected:
            raise ValueError(
                f"upsert_rows: table={table} 第 {i} 行列集合与首行不一致；"
                f"首行 {sorted(expected)}，本行 {sorted(r.keys())}"
            )
    col_list = ", ".join(all_cols)
    placeholder_list = ", ".join(
        f"CAST(:{c} AS jsonb)" if c in jsonb_set else f":{c}" for c in all_cols
    )
    conflict_target = ", ".join(pk_cols)
    set_clause_parts = [f"{c} = EXCLUDED.{c}" for c in update_cols]
    set_clause_parts.append("updated_at = now()")
    set_clause = ", ".join(set_clause_parts)

    sql = text(
        f"""
        INSERT INTO {table} ({col_list})
        VALUES ({placeholder_list})
        ON CONFLICT ({conflict_target}) DO UPDATE SET {set_clause}
        """
    )
    session.execute(sql, rows)
    return len(rows)
