"""孤儿回收阈值贯通的纯单测（不连库）。

覆盖 prompts/add-orphaned-running-job-reclaim.md 决策 2「阈值进 config」：
  - reap_stale_running_jobs 把 settings.worker_stale_running_threshold_seconds
    原样作为 make_interval(secs => ...) 的绑定参数传进 SQL；
  - worker 主循环（启动一次 + 周期）调 reaper 时透传**配置阈值**，而非裸默认。

行为场景 (a)/(b)（过期回收 / 新鲜不误杀）由 DB 执行 reaper SQL 才能真实验证，
放 tests/integration/test_reaper_orphaned_running_pg.py（事务隔离、秒级）。本文件
只验证 Python 层的参数贯通，保证无 docker 的 CI 也能锁住「阈值可配 + 正确透传」。
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock

import pytest

import quant_pipeline.worker.dispatcher as dispatcher_mod
import quant_pipeline.worker.loop as loop_mod
from quant_pipeline.config.settings import Settings


def test_reaper_passes_threshold_seconds_into_sql(monkeypatch: Any) -> None:
    """reap_stale_running_jobs(stale_seconds) 应把秒数原样绑进 SQL 参数 stale_secs。

    mock session_scope 截获 execute 的绑定参数，确认 stale_secs == 传入秒数、
    orphan_text == _ORPHAN_ERROR_TEXT（不依赖 DB）。
    """

    captured: dict[str, Any] = {}

    class _FakeResult:
        def first(self) -> tuple[int]:
            return (0,)

    class _FakeSession:
        def execute(self, _sql: Any, params: dict[str, Any]) -> _FakeResult:
            captured.update(params)
            return _FakeResult()

    @contextmanager
    def _fake_scope() -> Any:
        yield _FakeSession()

    monkeypatch.setattr(dispatcher_mod, "session_scope", _fake_scope)

    count = dispatcher_mod.reap_stale_running_jobs(123.5)

    assert count == 0  # _FakeResult.first 回 (0,)
    assert captured["stale_secs"] == 123.5, "秒数应原样绑进 SQL（不再 ×60）"
    assert captured["orphan_text"] == dispatcher_mod._ORPHAN_ERROR_TEXT


def test_reaper_default_threshold_matches_settings_default() -> None:
    """reaper 函数签名默认值应与 settings 默认阈值一致（防两处默认漂移）。"""

    func_defaults = dispatcher_mod.reap_stale_running_jobs.__defaults__
    assert func_defaults is not None
    assert func_defaults[0] == Settings().worker_stale_running_threshold_seconds == 600.0


class _StopLoop(Exception):
    """测试用：从 mock 的 time.sleep 抛出，干净打断 run_worker_loop 的常驻循环。"""


def test_worker_loop_passes_configured_threshold_to_reaper(monkeypatch: Any) -> None:
    """run_worker_loop 启动 + 周期两处 reaper 调用都应透传**配置阈值**。

    把 settings 阈值设成独特值（4242.0）、reaper_interval 设 -1（每轮 poll 后立即触发
    周期 reaper），跑到第二轮 sleep 时抛 _StopLoop 干净退出。断言：reaper 被调 >=2 次
    （启动一次 + 至少一次周期），且每次入参都是 4242.0。schema 校验 / 信号注册 / sleep
    全部 mock，不连库、不真睡、不注册信号。
    """

    sentinel_threshold = 4242.0

    # ── 1. settings：阈值设独特值、reaper_interval=-1（每轮都触发周期 reaper）──
    fake_settings = Settings(WORKER_STALE_RUNNING_THRESHOLD_SECONDS=sentinel_threshold)
    object.__setattr__(fake_settings, "worker_reaper_interval_seconds", -1.0)
    monkeypatch.setattr(loop_mod, "get_settings", lambda: fake_settings)

    # ── 2. schema 契约校验：mock session_scope + validate_schema 不连库 ──
    @contextmanager
    def _noop_scope() -> Any:
        yield MagicMock()

    import quant_pipeline.db as db_mod
    import quant_pipeline.db.schema_contract as schema_mod

    monkeypatch.setattr(db_mod, "session_scope", _noop_scope, raising=False)
    monkeypatch.setattr(schema_mod, "validate_schema", lambda _s: None)

    # ── 3. Dispatcher 构造即可（dispatch 不会被调到，poll 恒 None）──
    monkeypatch.setattr(loop_mod, "Dispatcher", lambda: MagicMock())

    # ── 4. poll_one 恒返回 None → 进 sleep 分支 + 周期 reaper 分支 ──
    monkeypatch.setattr(loop_mod, "poll_one", lambda: None)

    # ── 5. reaper：记录每次入参 ──
    reaper_calls: list[float] = []

    def _fake_reaper(stale_seconds: float = -1.0) -> int:
        reaper_calls.append(stale_seconds)
        return 0

    monkeypatch.setattr(loop_mod, "reap_stale_running_jobs", _fake_reaper)

    # ── 6. signal.signal：测试线程注册 handler 会抛 ValueError，直接 no-op ──
    monkeypatch.setattr(loop_mod.signal, "signal", lambda *_a, **_k: None)

    # ── 7. time.sleep：第 2 次调用抛 _StopLoop 干净退出（只跑两轮）──
    #   loop 每轮顺序：poll(None) → sleep → 周期 reaper 检查。
    #   sleep#1 返回 → reaper(周期, call#2) → 第二轮 poll(None) → sleep#2 抛 _StopLoop。
    sleep_calls = {"n": 0}

    def _fake_sleep(_secs: float) -> None:
        sleep_calls["n"] += 1
        if sleep_calls["n"] >= 2:
            raise _StopLoop

    monkeypatch.setattr(loop_mod.time, "sleep", _fake_sleep)

    with pytest.raises(_StopLoop):
        loop_mod.run_worker_loop()

    # 启动一次 + 至少一次周期 = >=2 次调用；每次都用配置阈值，无裸默认泄漏。
    assert len(reaper_calls) >= 2, f"应至少调 reaper 2 次（启动+周期），实际 {reaper_calls}"
    assert all(c == sentinel_threshold for c in reaper_calls), (
        f"每次 reaper 都应透传配置阈值 {sentinel_threshold}，实际 {reaper_calls}"
    )
