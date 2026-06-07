"""因子计算代码指纹护门（problem2 系统性修复）。

把"影响特征值的因子计算代码口径"哈希成稳定指纹,物化 fm 时存入
`factors.feature_sets.factor_code_fp`;训练/推理入口比对**当前代码指纹 vs fm 存储
指纹**,不一致即 raise——把"同一 feature_set_id 下特征定义被悄悄替换"(如
`83aeda0` close_adj 改纯后复权后,12+ 个 close 派生因子值全变、但 fs 哈希不变)的
**静默 train/serve 错配**变成响亮报错。

为何自动派生而非手动版本号:bump factor_version / 手动常量与当初出 bug 同款失败模式
(改了没人记得 bump)。指纹从代码 AST 自动算,改逻辑必变、改注释/格式/docstring 不变。

覆盖范围(口径承载面):
  - 各 factor_ids 命中因子的 `compute` 方法源码(registry.get_factor_class)。
  - `apply_hfq` 源码(labels/_common,close_adj/low_adj/high_adj 唯一真理源,problem2 肇因)。
扩展候选(本期不纳入,见 spec):data_access 取窗/PIT 装配、builder 中性化实现代码。

设计:docs/superpowers/specs/2026-06-07-factor-code-fingerprint-guard-design.md
"""

from __future__ import annotations

import ast
import hashlib
import inspect
import logging
import textwrap
from collections.abc import Sequence
from typing import Any

logger = logging.getLogger(__name__)


class FactorCodeFingerprintMismatch(RuntimeError):
    """fm 存储的因子代码指纹与当前代码指纹不一致——计算口径已变更,需重物化 fm。"""


def _strip_docstrings(tree: ast.AST) -> None:
    """就地剔除 module/class/function 体的首条 docstring 表达式。

    docstring 是文档非逻辑,改它不应触发护门。注释/空白由 ast 解析天然丢弃。
    """

    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if not isinstance(body, list) or not body:
            continue
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        first = body[0]
        if (
            isinstance(first, ast.Expr)
            and isinstance(first.value, ast.Constant)
            and isinstance(first.value.value, str)
        ):
            node.body = body[1:]


def normalize_source(src: str) -> str:
    """源码 → 归一化结构串。改逻辑(名字/算子/常量/结构)必变,改注释/格式/docstring 不变。

    用 AST:解析后剥 docstring 再 `ast.dump`(确定性结构 repr,天然忽略注释与空白)。
    """

    tree = ast.parse(textwrap.dedent(src))
    _strip_docstrings(tree)
    return ast.dump(tree)


def fingerprint_from_sources(named_sources: list[tuple[str, str]]) -> str:
    """对 (名字, 源码) 列表做归一化拼接哈希。纯函数,便于单测。

    名字参与哈希(防不同因子源码偶同导致漏检);按传入顺序拼接,调用方负责定序。
    """

    parts = [f"{name}\n{normalize_source(src)}" for name, src in named_sources]
    payload = "\n\x00\n".join(parts)
    sha = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]
    return f"fcf_{sha}"


def factor_code_fingerprint(factor_ids: Sequence[str], factor_version: str) -> str:
    """对 factor_ids 命中因子的 compute 源码 + apply_hfq 源码算稳定指纹('fcf_<sha12>')。

    只哈希**传入 factor_ids 命中**的因子(与 fm 的 factor_ids 对齐),保证物化/训练/
    推理三侧对同一 fm 算出同一指纹。factor_id 在 registry 未注册 → KeyError(fail-fast)。
    """

    from quant_pipeline.factors import registry  # 触发 import_all_factors 登记全部因子类
    from quant_pipeline.labels._common import apply_hfq

    named: list[tuple[str, str]] = []
    for fid in sorted(set(factor_ids)):
        cls = registry.get_factor_class(fid, factor_version)
        named.append((f"factor:{fid}", inspect.getsource(cls.compute)))
    named.append(("apply_hfq", inspect.getsource(apply_hfq)))
    return fingerprint_from_sources(named)


def assert_fm_code_fingerprint(feature_set_id: str, session: Any) -> None:
    """护门:比对当前因子代码指纹 vs fm 存储指纹。

    从 `factors.feature_sets` 行读该 fm 的 factor_ids / factor_version / factor_code_fp,
    用行内 factor_ids+version 算**当前代码**指纹,与存储指纹比对:

    - 行不存在 → logger.warn 不阻塞(让下游既有"fm 找不到"护门去报更具体的错)。
    - 存储为 NULL(指纹机制前的旧 fm)→ logger.warn,**不阻塞**(向后兼容,不打断在跑系统)。
    - 存储 != 当前 → raise FactorCodeFingerprintMismatch(口径已变,需重物化)。
    - 相等 → 通过。

    Args:
        feature_set_id: factors.feature_sets 主键。
        session: SQLAlchemy session(只读一行)。
    """

    from sqlalchemy import text

    row = session.execute(
        text(
            "SELECT factor_version, factor_ids, factor_code_fp "
            "FROM factors.feature_sets WHERE feature_set_id = :fs"
        ),
        {"fs": feature_set_id},
    ).fetchone()

    if row is None:
        logger.warning(
            "factor_code_fp_fs_row_missing", extra={"feature_set_id": feature_set_id}
        )
        return

    factor_version, factor_ids, stored = row[0], list(row[1] or []), row[2]

    if stored is None:
        logger.warning(
            "factor_code_fp_absent",
            extra={
                "feature_set_id": feature_set_id,
                "hint": "旧 fm 无因子代码指纹;建议重物化该 feature_set 以纳入口径护门",
            },
        )
        return

    current = factor_code_fingerprint(factor_ids, factor_version)
    if stored != current:
        raise FactorCodeFingerprintMismatch(
            f"feature_set_id={feature_set_id!r} 因子计算代码口径已变更:"
            f"fm 物化时指纹={stored!r},当前代码指纹={current!r}。"
            "同一 fs id 下特征定义已不一致(如 close_adj 口径变更),"
            "请重物化该 feature_set 后再训练/推理,避免 train/serve 特征错配。"
        )


__all__ = [
    "FactorCodeFingerprintMismatch",
    "assert_fm_code_fingerprint",
    "factor_code_fingerprint",
    "fingerprint_from_sources",
    "normalize_source",
]
