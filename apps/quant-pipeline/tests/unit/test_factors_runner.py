"""factors.runner 调用链 mock 集成测试。

校验：
1. dispatcher 路由 run_type='factors' → runner_entrypoint → run_factors 端到端不写库
2. params 校验：缺 version/date_range 抛错
3. 因子计算被正确触发，upsert 调用拿到去重后的 (trade_date, ts_code, factor_id,
   factor_version, value) 行
4. 进度回写在每日完成后触发（job_id 存在时）

# TODO: 集成测试验证 API 契约 —— Part C/E 完成后用 docker-postgres 起的测试库
# 验证真实 raw.daily_quote / raw.adj_factor / factors.daily_factors 链路。
"""

from __future__ import annotations

from uuid import uuid4

import pandas as pd
import pytest

from quant_pipeline.factors import runner as runner_mod
from quant_pipeline.factors.runner import RawData, run_factors, runner_entrypoint


@pytest.fixture
def small_raw_data(small_panel: pd.DataFrame) -> RawData:
    """把 conftest 的 small_panel 包装成 RawData。

    industry_pit 单独抽出（与 panel 同源），让 runner._slice_window_for_factor
    在 category in ('industry','mixed') 时 join 行业列。
    """

    ind = small_panel[["industry_l1"]].copy()
    panel_no_ind = small_panel.drop(columns=["industry_l1"]).copy()
    return RawData(panel=panel_no_ind, industry_pit=ind)


def test_run_factors_end_to_end_mocked(
    monkeypatch: pytest.MonkeyPatch,
    small_panel: pd.DataFrame,
    small_raw_data: RawData,
) -> None:
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    # 取窗口最后 5 个交易日作为目标
    target_dates = trade_dates[-5:]

    # small_panel 中全部 ts_code 集合，用于 _query_live_universe 桩返回值
    all_ts_codes: set[str] = set(
        small_panel.index.get_level_values("ts_code").unique().tolist()
    )

    # mock 数据库交互
    monkeypatch.setattr(
        runner_mod, "_query_trade_dates", lambda start, end: trade_dates
    )
    monkeypatch.setattr(
        runner_mod,
        "load_window_data",
        lambda start, end, need_industry: small_raw_data,
    )
    # _query_live_universe 查 raw.daily_quote（需要真实 DB），在单测中必须 mock。
    # 返回 small_panel 全量 ts_code，保证 PIT 过滤不会误剔所有行。
    monkeypatch.setattr(
        runner_mod, "_query_live_universe", lambda t: all_ts_codes
    )
    # trade_cal_covers / count_trade_days_in_window 查 raw.trade_cal（需要真实 DB）。
    # mock：trade_cal 视为已覆盖，窗口内交易日数足够（大于最大 min_trade_days=61），
    # 使 _apply_pit_window_guard 走"正常路径"直接返回 sub，不 skip 任何因子。
    monkeypatch.setattr(
        runner_mod, "trade_cal_covers", lambda sess, s, e, exchange="SSE": True
    )
    monkeypatch.setattr(
        runner_mod, "count_trade_days_in_window", lambda sess, s, e, exchange="SSE": 80
    )

    upsert_calls: list[list[dict[str, object]]] = []

    def fake_upsert(rows: list[dict[str, object]]) -> int:
        upsert_calls.append(list(rows))
        return len(rows)

    monkeypatch.setattr(runner_mod, "_upsert_daily_factors", fake_upsert)

    # 取一个 price 因子 + 一个 industry 因子，验证两类都跑通
    result = run_factors(
        factor_version="v1",
        date_range=f"{target_dates[0]}:{target_dates[-1]}",
        factor_ids=["momentum_20d", "industry_relative_strength"],
        job_id=None,
    )

    assert result["trade_dates"] == len(target_dates)
    assert result["factors"] == 2
    assert result["rows_upserted"] > 0
    # 每个目标日触发一次 upsert
    assert len(upsert_calls) == len(target_dates)
    # 主键四元组完整
    for batch in upsert_calls:
        for r in batch:
            assert {"trade_date", "ts_code", "factor_id", "factor_version", "value"} <= set(r)
            assert r["factor_version"] == "v1"
            assert r["factor_id"] in {"momentum_20d", "industry_relative_strength"}


def test_run_factors_progress_called_per_day(
    monkeypatch: pytest.MonkeyPatch,
    small_panel: pd.DataFrame,
    small_raw_data: RawData,
) -> None:
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    target_dates = trade_dates[-3:]

    # small_panel 中全部 ts_code 集合，用于 _query_live_universe 桩返回值
    all_ts_codes: set[str] = set(
        small_panel.index.get_level_values("ts_code").unique().tolist()
    )

    monkeypatch.setattr(
        runner_mod, "_query_trade_dates", lambda start, end: trade_dates
    )
    monkeypatch.setattr(
        runner_mod,
        "load_window_data",
        lambda start, end, need_industry: small_raw_data,
    )
    # _query_live_universe 查 raw.daily_quote（需要真实 DB），在单测中必须 mock。
    # 返回 small_panel 全量 ts_code，保证 PIT 过滤不会误剔所有行。
    monkeypatch.setattr(
        runner_mod, "_query_live_universe", lambda t: all_ts_codes
    )
    monkeypatch.setattr(runner_mod, "_upsert_daily_factors", lambda rows: len(rows))

    progress_calls: list[tuple[int, str | None]] = []

    def fake_update(job_id, pct, stage=None):  # type: ignore[no-untyped-def]
        progress_calls.append((pct, stage))

    monkeypatch.setattr(runner_mod, "update_progress", fake_update)
    monkeypatch.setattr(runner_mod, "check_cancel_requested", lambda jid: False)

    job_id = uuid4()
    run_factors(
        factor_version="v1",
        date_range=f"{target_dates[0]}:{target_dates[-1]}",
        factor_ids=["momentum_20d"],
        job_id=job_id,
    )
    # 每个日都写一次 progress
    assert len(progress_calls) == len(target_dates)
    # 末尾 100
    assert progress_calls[-1][0] == 100
    # stage 包含 trade_date
    assert all(c[1] is not None and c[1].startswith("factors:") for c in progress_calls)


def test_run_factors_cancel_respected(
    monkeypatch: pytest.MonkeyPatch,
    small_panel: pd.DataFrame,
    small_raw_data: RawData,
) -> None:
    from quant_pipeline.worker.progress import JobCancelled

    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    target_dates = trade_dates[-3:]

    monkeypatch.setattr(
        runner_mod, "_query_trade_dates", lambda start, end: trade_dates
    )
    monkeypatch.setattr(
        runner_mod,
        "load_window_data",
        lambda start, end, need_industry: small_raw_data,
    )
    monkeypatch.setattr(runner_mod, "_upsert_daily_factors", lambda rows: 0)
    monkeypatch.setattr(runner_mod, "update_progress", lambda *a, **k: None)
    # 第一次轮询就返回 cancel
    monkeypatch.setattr(runner_mod, "check_cancel_requested", lambda jid: True)

    with pytest.raises(JobCancelled):
        run_factors(
            factor_version="v1",
            date_range=f"{target_dates[0]}:{target_dates[-1]}",
            factor_ids=["momentum_20d"],
            job_id=uuid4(),
        )


def test_runner_entrypoint_validates_required_params() -> None:
    """缺 version 或 date_range 时立即抛 ValueError（避免误把 noop 当成功）。"""

    class _FakeJob:
        id = uuid4()
        params: dict[str, object] = {"date_range": "20240101:20240131"}  # 缺 version

    with pytest.raises(ValueError, match="version/date_range"):
        runner_entrypoint(_FakeJob())

    class _FakeJob2:
        id = uuid4()
        params = {"version": "v1"}  # 缺 date_range

    with pytest.raises(ValueError, match="version/date_range"):
        runner_entrypoint(_FakeJob2())


def test_runner_entrypoint_routes_to_run_factors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """params 完整时正确调用 run_factors。"""

    captured: dict[str, object] = {}

    def fake_run(*, factor_version, date_range, factor_ids, job_id):  # type: ignore[no-untyped-def]
        captured.update(
            {
                "factor_version": factor_version,
                "date_range": date_range,
                "factor_ids": factor_ids,
                "job_id": job_id,
            }
        )

    monkeypatch.setattr(runner_mod, "run_factors", fake_run)

    class _Job:
        id = uuid4()
        params = {
            "version": "v1",
            "date_range": "20240101:20240131",
            "factor_ids": ["momentum_20d"],
        }

    runner_entrypoint(_Job())

    assert captured["factor_version"] == "v1"
    assert captured["date_range"] == "20240101:20240131"
    assert captured["factor_ids"] == ["momentum_20d"]


def test_runner_entrypoint_preheats_registry_before_run_factors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """worker 的 factors 入口必须先 ``ensure_loaded()`` 预热注册表，再 ``run_factors``。

    真机 e2e（2026-06-07）暴露：「定向更新」是 ``run_type=factors`` 的首个真实调用方，
    全新 worker 进程未预热 ``_meta_cache`` → ``Factor.__init__`` 抛
    ``factor meta missing in cache``（FactorMetaMissing）。CLI ``quant factors`` 入口
    早已调 ``ensure_loaded()``，worker entrypoint 此前漏了这一步。
    """

    order: list[str] = []
    monkeypatch.setattr(runner_mod, "ensure_loaded", lambda: order.append("ensure_loaded"))
    monkeypatch.setattr(
        runner_mod, "run_factors", lambda **kw: order.append("run_factors")
    )

    class _Job:
        id = uuid4()
        params = {
            "version": "v1",
            "date_range": "20240101:20240131",
            "factor_ids": ["momentum_20d"],
        }

    runner_entrypoint(_Job())

    # 必须先预热再算，且预热确实被调用一次
    assert order == ["ensure_loaded", "run_factors"]


def test_dispatcher_routes_factors_to_runner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """run_type='factors' 在 dispatcher 路由表里且会触发 runner_entrypoint。"""

    from quant_pipeline.worker import dispatcher as disp

    routes = disp.get_routes()
    assert "factors" in routes

    called: dict[str, object] = {}

    def fake_entry(job):  # type: ignore[no-untyped-def]
        called["job_id"] = job.id

    monkeypatch.setattr(runner_mod, "runner_entrypoint", fake_entry)

    class _Job:
        id = uuid4()
        run_type = "factors"
        params: dict[str, object] = {"version": "v1", "date_range": "20240101:20240131"}
        attempts = 0

    # 直接拿 runner 函数（绕过 _finalize_job 走的 session_scope）
    # _runner_factors 内部会从 dispatcher 模块里 import runner_entrypoint
    disp._runner_factors(_Job())
    assert called["job_id"] == _Job.id
