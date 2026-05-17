"""progress NOTIFY payload schema 冒烟测试（M0）。

只校验 payload 构造：不连库、不触发 NOTIFY。
"""

from __future__ import annotations

import json
from uuid import UUID

import pytest

from quant_pipeline.worker.progress import _build_notify_payload


def test_payload_schema_fixed() -> None:
    job_id = UUID("11111111-2222-3333-4444-555555555555")
    raw = _build_notify_payload(job_id, 42, "computing_factors")
    obj = json.loads(raw)
    assert obj == {
        "job_id": "11111111-2222-3333-4444-555555555555",
        "progress": 42,
        "stage": "computing_factors",
    }


def test_payload_within_1kb() -> None:
    job_id = UUID("11111111-2222-3333-4444-555555555555")
    raw = _build_notify_payload(job_id, 100, "x" * 800)
    assert len(raw.encode("utf-8")) <= 1024


def test_payload_oversize_rejected() -> None:
    job_id = UUID("11111111-2222-3333-4444-555555555555")
    with pytest.raises(ValueError):
        _build_notify_payload(job_id, 100, "x" * 2048)


def test_progress_range_validated() -> None:
    from quant_pipeline.worker.progress import update_progress

    with pytest.raises(ValueError):
        # 不会触发 DB（在范围校验阶段已抛）
        update_progress(UUID("00000000-0000-0000-0000-000000000000"), 200)
