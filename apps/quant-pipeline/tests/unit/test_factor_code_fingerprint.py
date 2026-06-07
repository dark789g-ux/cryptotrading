"""因子计算代码指纹护门单测(Phase3,problem2 系统性修复)。

契约:
  - normalize_source 对注释/空白/docstring 不敏感,对逻辑(算子/常量/结构)敏感。
  - factor_code_fingerprint 只哈希命中因子 + apply_hfq;未注册 factor_id → KeyError。
  - assert_fm_code_fingerprint:存储 NULL→warn 不 raise;不一致→raise;一致→通过。
"""

from __future__ import annotations

from typing import Any

import pytest

from quant_pipeline.features.factor_code_fingerprint import (
    FactorCodeFingerprintMismatch,
    assert_fm_code_fingerprint,
    factor_code_fingerprint,
    fingerprint_from_sources,
    normalize_source,
)

# 一个真实存在的因子(price 类,@register factor_version='v1')
FID = "momentum_20d"
FVER = "v1"


def test_normalize_source_ignores_comments_whitespace_docstring() -> None:
    a = '''
def f(x):
    """原 docstring。"""
    # 注释 A
    y = x + 1
    return y
'''
    b = '''
def f(x):
    """改了的 docstring，多写一行。"""

    y = x + 1      # 行内注释 B
    return y
'''
    assert normalize_source(a) == normalize_source(b)


def test_normalize_source_sensitive_to_logic() -> None:
    a = "def f(x):\n    return x + 1\n"
    b = "def f(x):\n    return x + 2\n"  # 常量变
    c = "def f(x):\n    return x - 1\n"  # 算子变
    assert normalize_source(a) != normalize_source(b)
    assert normalize_source(a) != normalize_source(c)


def test_fingerprint_from_sources_stable_and_name_sensitive() -> None:
    s1 = [("a", "def f():\n    return 1\n"), ("b", "def g():\n    return 2\n")]
    assert fingerprint_from_sources(s1) == fingerprint_from_sources(list(s1))
    assert fingerprint_from_sources(s1).startswith("fcf_")
    # 名字参与哈希:同源码不同名 → 不同指纹
    s2 = [("a", "def f():\n    return 1\n"), ("X", "def g():\n    return 2\n")]
    assert fingerprint_from_sources(s1) != fingerprint_from_sources(s2)


def test_factor_code_fingerprint_real_factor_stable() -> None:
    fp1 = factor_code_fingerprint([FID], FVER)
    fp2 = factor_code_fingerprint([FID], FVER)
    assert fp1 == fp2
    assert fp1.startswith("fcf_")


def test_factor_code_fingerprint_subset_and_order_invariant() -> None:
    # factor_ids 顺序无关(内部 sorted);子集只哈希命中因子
    fp_a = factor_code_fingerprint([FID, "rsi_14"], FVER)
    fp_b = factor_code_fingerprint(["rsi_14", FID], FVER)
    assert fp_a == fp_b
    # 加一个因子 → 指纹变(apply_hfq 之外多了一份 compute)
    assert factor_code_fingerprint([FID], FVER) != fp_a


def test_factor_code_fingerprint_unknown_factor_raises() -> None:
    with pytest.raises(KeyError):
        factor_code_fingerprint(["no_such_factor_xyz"], FVER)


class _StubResult:
    def __init__(self, row: tuple[Any, ...] | None) -> None:
        self._row = row

    def fetchone(self) -> tuple[Any, ...] | None:
        return self._row


class _StubSession:
    """模拟 feature_sets 行查询:返回 (factor_version, factor_ids, factor_code_fp)。"""

    def __init__(self, row: tuple[Any, ...] | None) -> None:
        self._row = row

    def execute(self, _sql: Any, _params: Any) -> _StubResult:
        return _StubResult(self._row)


def test_assert_guard_fs_row_missing_warns_not_raise() -> None:
    assert_fm_code_fingerprint("fs_x", _StubSession(None))


def test_assert_guard_absent_fp_warns_not_raise() -> None:
    # 行存在但 factor_code_fp 为 NULL(旧 fm)→ 只 warn 不抛
    assert_fm_code_fingerprint("fs_x", _StubSession((FVER, [FID], None)))


def test_assert_guard_matching_fp_passes() -> None:
    current = factor_code_fingerprint([FID], FVER)
    assert_fm_code_fingerprint("fs_x", _StubSession((FVER, [FID], current)))


def test_assert_guard_mismatch_raises() -> None:
    s = _StubSession((FVER, [FID], "fcf_deadbeef0000"))
    with pytest.raises(FactorCodeFingerprintMismatch):
        assert_fm_code_fingerprint("fs_x", s)
