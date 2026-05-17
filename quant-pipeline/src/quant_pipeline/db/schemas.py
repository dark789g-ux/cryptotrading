"""ORM 实体占位。

M0 阶段 worker 直接使用 SQL（NOTIFY / FOR UPDATE SKIP LOCKED 等 PG 特性，
ORM 包装收益低、风险高）。M1 起按需补充 ORM 映射。
"""

from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """所有 quant-pipeline ORM 实体的基类。"""
