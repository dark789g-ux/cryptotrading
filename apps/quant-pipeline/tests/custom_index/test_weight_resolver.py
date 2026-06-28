"""PIT 权重版本解析单元测试。"""

from __future__ import annotations

import pytest

from quant_pipeline.custom_index.types import MemberWeight, WeightVersion
from quant_pipeline.custom_index.weight_resolver import (
    normalize_weights,
    resolve_pit_members,
    validate_versions,
)


def _version(
    vid: int,
    effective: str,
    expire: str | None,
    members: tuple[MemberWeight, ...],
) -> WeightVersion:
    return WeightVersion(
        id=vid,
        effective_date=effective,
        expire_date=expire,
        weight_method="equal",
        members=members,
    )


_MEMBERS = (
    MemberWeight("600000.SH", 0.5),
    MemberWeight("600001.SH", 0.5),
)


def test_resolve_pit_members_active_version() -> None:
    versions = [
        _version(1, "20240101", "20240110", _MEMBERS),
        _version(2, "20240111", None, _MEMBERS),
    ]

    v1 = resolve_pit_members(versions, "20240110")
    assert len(v1) == 2
    assert v1[0].con_code == "600000.SH"

    v2 = resolve_pit_members(versions, "20240111")
    assert len(v2) == 2

    empty = resolve_pit_members(versions, "20231231")
    assert empty == ()


def test_resolve_pit_members_expire_boundary() -> None:
    """expire_date 当天仍算 active（>= trade_date）。"""

    versions = [_version(1, "20240101", "20240105", _MEMBERS)]
    assert resolve_pit_members(versions, "20240105")
    assert resolve_pit_members(versions, "20240106") == ()


def test_normalize_weights_renormalizes_subset() -> None:
    weights = {"A": 0.3, "B": 0.3}
    norm = normalize_weights(weights)
    assert abs(sum(norm.values()) - 1.0) < 1e-9
    assert abs(norm["A"] - 0.5) < 1e-9


def test_validate_versions_rejects_bad_total() -> None:
    bad = [
        WeightVersion(
            id=1,
            effective_date="20240101",
            expire_date=None,
            weight_method="custom",
            members=(MemberWeight("A", 0.6), MemberWeight("B", 0.3)),
        )
    ]
    with pytest.raises(ValueError, match="权重总和"):
        validate_versions(bad)
