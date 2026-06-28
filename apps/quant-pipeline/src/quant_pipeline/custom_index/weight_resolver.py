"""PIT 权重版本解析（custom_index_weight_versions + members）。"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from quant_pipeline.custom_index.types import MemberWeight, WeightVersion


def load_weight_versions(session: Session, custom_index_id: str) -> list[WeightVersion]:
    """加载某指数的权重版本链（按 effective_date 升序）。"""

    version_rows = session.execute(
        text(
            """
            SELECT id, effective_date, expire_date, weight_method
            FROM custom_index_weight_versions
            WHERE custom_index_id = :cid
            ORDER BY effective_date ASC
            """
        ),
        {"cid": custom_index_id},
    ).mappings().all()

    if not version_rows:
        return []

    version_ids = [int(r["id"]) for r in version_rows]
    member_rows = session.execute(
        text(
            """
            SELECT version_id, con_code, weight
            FROM custom_index_members
            WHERE version_id = ANY(:vids)
            ORDER BY version_id, con_code
            """
        ),
        {"vids": version_ids},
    ).mappings().all()

    members_by_version: dict[int, list[MemberWeight]] = {}
    for row in member_rows:
        vid = int(row["version_id"])
        members_by_version.setdefault(vid, []).append(
            MemberWeight(con_code=str(row["con_code"]), weight=float(row["weight"]))
        )

    versions: list[WeightVersion] = []
    for row in version_rows:
        vid = int(row["id"])
        versions.append(
            WeightVersion(
                id=vid,
                effective_date=str(row["effective_date"]),
                expire_date=str(row["expire_date"]) if row["expire_date"] else None,
                weight_method=str(row["weight_method"]),
                members=tuple(members_by_version.get(vid, ())),
            )
        )
    return versions


def resolve_pit_members(
    versions: list[WeightVersion],
    trade_date: str,
) -> tuple[MemberWeight, ...]:
    """按 trade_date 取 PIT active 版本的成分权重。

    规则（对齐 index_weight / money_flow PIT）：
      effective_date <= trade_date
      AND (expire_date IS NULL OR expire_date >= trade_date)
    """

    active: WeightVersion | None = None
    for version in versions:
        if version.effective_date > trade_date:
            break
        if version.expire_date is not None and version.expire_date < trade_date:
            continue
        active = version
    if active is None:
        return ()
    return active.members


def build_effective_date_index(versions: list[WeightVersion]) -> dict[str, tuple[MemberWeight, ...]]:
    """预构建 effective_date → members 映射（供版本切换日检测）。"""

    return {v.effective_date: v.members for v in versions}


def all_member_codes(versions: list[WeightVersion]) -> set[str]:
    codes: set[str] = set()
    for version in versions:
        for member in version.members:
            codes.add(member.con_code)
    return codes


def validate_versions(versions: list[WeightVersion]) -> None:
    if not versions:
        raise ValueError("custom_index 无权重版本链")
    for version in versions:
        if len(version.members) < 2:
            raise ValueError(
                f"权重版本 {version.effective_date} 成分不足 2 个（got {len(version.members)}）"
            )
        total = sum(m.weight for m in version.members)
        if abs(total - 1.0) > 1e-4:
            raise ValueError(
                f"权重版本 {version.effective_date} 权重总和 {total} != 1"
            )


def pit_members_for_dates(
    versions: list[WeightVersion],
    trade_dates: list[str],
) -> dict[str, tuple[MemberWeight, ...]]:
    """批量解析 PIT 成员（trade_date → members）。"""

    return {d: resolve_pit_members(versions, d) for d in trade_dates}


def member_weights_as_dict(members: tuple[MemberWeight, ...]) -> dict[str, float]:
    return {m.con_code: m.weight for m in members}


def normalize_weights(weights: dict[str, float]) -> dict[str, float]:
    total = sum(weights.values())
    if total <= 0:
        return {}
    return {code: w / total for code, w in weights.items()}


def emit_pit_debug(version: WeightVersion | None, trade_date: str) -> dict[str, Any]:
    """测试辅助：返回 PIT 命中信息。"""

    if version is None:
        return {"trade_date": trade_date, "version_id": None}
    return {
        "trade_date": trade_date,
        "version_id": version.id,
        "effective_date": version.effective_date,
        "expire_date": version.expire_date,
        "member_count": len(version.members),
    }
