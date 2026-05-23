"""make_scaled_callback 单测（spec 04 + 06）。

仅校验进度缩放数学；不连库、不触 NOTIFY。
"""

from __future__ import annotations

import pytest

from quant_pipeline.worker.progress import make_scaled_callback


@pytest.mark.parametrize(
    "pct,expected",
    [
        (0, 0),
        (50, 15),
        (100, 30),
    ],
)
def test_scaled_callback_labels_window(pct: int, expected: int) -> None:
    """[0,30] 窗口下，子 0/50/100 应映射到 父 0/15/30。"""

    calls: list[tuple[int, str]] = []
    cb = make_scaled_callback(lambda p, m: calls.append((p, m)), 0, 30)
    cb(pct, "labels")
    assert calls[-1] == (expected, "labels")


def test_scaled_callback_clamps_out_of_range() -> None:
    """子 runner 误传 <0 / >100 时应 clamp 到窗口边界。"""

    calls: list[tuple[int, str]] = []
    cb = make_scaled_callback(lambda p, m: calls.append((p, m)), 30, 60)
    cb(-10, "x")
    cb(150, "y")
    assert [c[0] for c in calls] == [30, 60]


def test_scaled_callback_invalid_window_raises() -> None:
    """hi < lo / lo < 0 / hi > 100 都该在构造时即拒绝。"""

    with pytest.raises(ValueError):
        make_scaled_callback(lambda p, m: None, 60, 30)
    with pytest.raises(ValueError):
        make_scaled_callback(lambda p, m: None, -1, 30)
    with pytest.raises(ValueError):
        make_scaled_callback(lambda p, m: None, 0, 101)


def test_scaled_callback_none_parent_is_noop() -> None:
    """parent_cb=None 时不应抛错，调用是 no-op。"""

    cb = make_scaled_callback(None, 0, 30)
    cb(50, "msg")  # 不抛异常即通过


def test_scaled_callback_train_window_full_range() -> None:
    """[60,100] 窗口的边界行为，确保整除不偏移。"""

    calls: list[tuple[int, str]] = []
    cb = make_scaled_callback(lambda p, m: calls.append((p, m)), 60, 100)
    for pct in (0, 25, 50, 75, 100):
        cb(pct, "t")
    # 60 + 40*pct//100 = 60, 70, 80, 90, 100
    assert [c[0] for c in calls] == [60, 70, 80, 90, 100]
