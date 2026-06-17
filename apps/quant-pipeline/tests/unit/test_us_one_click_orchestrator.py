"""W2 美股一键同步编排器单测（spec 03 + spec 01 result_payload 硬契约）。

覆盖：
- 三步顺序调用 run_us_sync → run_us_index_sync → run_us_index_amv_sync。
- 每步对子调用一律传 job_id=None（编排器独占 update_progress）。
- result_payload schema 严格对齐 spec 01：顶层字段 / steps[] / logs[] 形态、step key、
  rowsWritten 取各 outcome 真实字段、failed_items+errors 映射成 errors[]。
- 时间戳一律 epoch ms 整数。
- 进度 step_base ∈ {0,33,66}，每步结束写 base+33（0→33→66→100），stage 写步名。
- capped_end 经 cap_to_last_closed_session。
- 失败不中断：某步抛硬异常 → 该步 failed + 记 error + 后续步仍执行。
- 取消：step2 前 check_cancel True → 抛 JobCancelled + result_payload cancelled=true、
  未完成步 skipped（抛前写库一次）。
- logs ≤200 截断。
- 致命错误（date_range 非法）→ 抛异常（让 dispatcher 置 failed）。

全部 mock 三个 run_us_* + update_progress + update_job_result_partial +
check_cancel_requested + cap_to_last_closed_session，不碰真 DB / 真网 / 真时钟。
"""

from __future__ import annotations

from unittest import mock
from uuid import uuid4

from quant_pipeline.sync import us_one_click_orchestrator as orch
from quant_pipeline.sync.us_index_amv_orchestrator import (
    UsIndexAmvFailedItem,
    UsIndexAmvOutcome,
)
from quant_pipeline.sync.us_index_orchestrator import (
    UsIndexFailedItem,
    UsIndexSyncOutcome,
)
from quant_pipeline.sync.us_one_click_orchestrator import (
    US_RETENTION_START,
    run_us_one_click_sync,
)
from quant_pipeline.sync.us_orchestrator import UsFailedItem, UsSyncOutcome
from quant_pipeline.worker.progress import JobCancelled


# ---------------------------------------------------------------------------
# Harness：mock 三 run_us_* + update_progress + update_job_result_partial +
# check_cancel + cap。返回最后一次写库的 result_payload（编排器整对象覆盖写）。
# ---------------------------------------------------------------------------
def _default_outcomes():
    return (
        UsSyncOutcome(quote_rows_total=36806, factor_rows_total=36800,
                      indicator_rows_total=36000, tickers_done=62),
        UsIndexSyncOutcome(rows_total=3099, indicator_rows_total=3099, symbols_done=1),
        UsIndexAmvOutcome(rows_total=300000, amv_rows_total=113, constituents_done=101),
    )


def _run(
    *,
    job_id=None,
    date_range="20260101:20260616",
    us_outcome=None,
    idx_outcome=None,
    amv_outcome=None,
    us_side_effect=None,
    idx_side_effect=None,
    amv_side_effect=None,
    capped_end="20260615",
    cancel_results=None,
):
    """跑编排器并捕获所有写库快照 + 进度调用 + 三 run mock。

    cancel_results：传给 check_cancel_requested 的 side_effect（list/可调用）；
    默认全 False。
    """
    job_id = job_id or uuid4()
    us_o, idx_o, amv_o = _default_outcomes()
    us_outcome = us_outcome or us_o
    idx_outcome = idx_outcome or idx_o
    amv_outcome = amv_outcome or amv_o

    snapshots: list[dict] = []
    progress_calls: list[tuple] = []

    def _capture_result(job_id_arg, payload):  # noqa: ARG001
        import copy
        snapshots.append(copy.deepcopy(payload))

    def _capture_progress(job_id_arg, progress, stage=None):  # noqa: ARG001
        progress_calls.append((progress, stage))

    us_mock = mock.Mock(side_effect=us_side_effect, return_value=us_outcome)
    idx_mock = mock.Mock(side_effect=idx_side_effect, return_value=idx_outcome)
    amv_mock = mock.Mock(side_effect=amv_side_effect, return_value=amv_outcome)

    cancel_mock = mock.Mock(
        side_effect=cancel_results if cancel_results is not None else None,
        return_value=False,
    )

    with mock.patch.object(orch, "run_us_sync", us_mock), \
         mock.patch.object(orch, "run_us_index_sync", idx_mock), \
         mock.patch.object(orch, "run_us_index_amv_sync", amv_mock), \
         mock.patch.object(orch, "update_progress", _capture_progress), \
         mock.patch.object(orch, "update_job_result_partial", _capture_result), \
         mock.patch.object(orch, "check_cancel_requested", cancel_mock), \
         mock.patch.object(orch, "cap_to_last_closed_session", return_value=capped_end):
        exc = None
        try:
            run_us_one_click_sync(job_id=job_id, date_range=date_range)
        except Exception as e:  # noqa: BLE001
            exc = e

    return {
        "snapshots": snapshots,
        "final": snapshots[-1] if snapshots else None,
        "progress_calls": progress_calls,
        "us_mock": us_mock,
        "idx_mock": idx_mock,
        "amv_mock": amv_mock,
        "cancel_mock": cancel_mock,
        "exc": exc,
    }


def _step(payload, key):
    return next(s for s in payload["steps"] if s["step"] == key)


# ===========================================================================
# 三步顺序 + job_id=None + date_range 透传
# ===========================================================================
def test_three_steps_called_in_order_with_job_id_none() -> None:
    r = _run()
    assert r["exc"] is None
    # 三个子调用都被调一次
    r["us_mock"].assert_called_once()
    r["idx_mock"].assert_called_once()
    r["amv_mock"].assert_called_once()
    # 每步对子调用一律传 job_id=None
    assert r["us_mock"].call_args.kwargs["job_id"] is None
    assert r["idx_mock"].call_args.kwargs["job_id"] is None
    assert r["amv_mock"].call_args.kwargs["job_id"] is None


def test_subcall_date_range_uses_retention_start_and_capped_end() -> None:
    r = _run(date_range="20260101:20260616", capped_end="20260615")
    expected_range = f"{US_RETENTION_START}:20260615"
    assert r["us_mock"].call_args.kwargs["date_range"] == expected_range
    assert r["idx_mock"].call_args.kwargs["date_range"] == expected_range
    assert r["amv_mock"].call_args.kwargs["date_range"] == expected_range


def test_subcall_write_start_is_user_start() -> None:
    r = _run(date_range="20260101:20260616")
    assert r["us_mock"].call_args.kwargs["write_start"] == "20260101"
    assert r["idx_mock"].call_args.kwargs["write_start"] == "20260101"
    assert r["amv_mock"].call_args.kwargs["write_start"] == "20260101"


def test_retention_start_constant_value() -> None:
    assert US_RETENTION_START == "20240102"


def test_us_tickers_and_index_symbols_default_none() -> None:
    r = _run()
    assert r["us_mock"].call_args.kwargs["tickers"] is None
    assert r["idx_mock"].call_args.kwargs["symbols"] is None
    assert r["amv_mock"].call_args.kwargs["symbols"] is None


# ===========================================================================
# capped_end 经 cap_to_last_closed_session
# ===========================================================================
def test_capped_end_via_cap_helper() -> None:
    r = _run(date_range="20260101:20260616", capped_end="20260614")
    final = r["final"]
    assert final["range"]["start"] == "20260101"
    assert final["range"]["end"] == "20260616"
    assert final["range"]["cappedEnd"] == "20260614"


# ===========================================================================
# result_payload schema（spec 01 硬契约）
# ===========================================================================
def test_result_payload_toplevel_schema() -> None:
    final = _run()["final"]
    assert final["version"] == 1
    assert set(final["range"].keys()) == {"start", "end", "cappedEnd"}
    assert isinstance(final["startedAt"], int)
    assert isinstance(final["finishedAt"], int)
    assert final["cancelled"] is False
    assert isinstance(final["steps"], list) and len(final["steps"]) == 3
    assert isinstance(final["logs"], list)


def test_step_keys_and_order() -> None:
    final = _run()["final"]
    assert [s["step"] for s in final["steps"]] == [
        "us-stocks", "us-index-daily", "us-index-amv",
    ]


def test_all_steps_success_status() -> None:
    final = _run()["final"]
    for s in final["steps"]:
        assert s["status"] == "success", s


def test_step_field_shape() -> None:
    final = _run()["final"]
    s = _step(final, "us-stocks")
    assert set(s.keys()) >= {
        "step", "status", "percent", "rowsWritten", "phase", "message",
        "errors", "startedAt", "finishedAt",
    }
    assert s["percent"] == 100
    assert isinstance(s["rowsWritten"], int)
    assert isinstance(s["errors"], list)


def test_rows_written_maps_per_outcome_field() -> None:
    """us-stocks 用 quote_rows_total；us-index-daily 用 rows_total；amv 用 amv_rows_total。"""
    us = UsSyncOutcome(quote_rows_total=111, factor_rows_total=999, indicator_rows_total=888)
    idx = UsIndexSyncOutcome(rows_total=222, indicator_rows_total=777)
    amv = UsIndexAmvOutcome(rows_total=99999, amv_rows_total=333)
    final = _run(us_outcome=us, idx_outcome=idx, amv_outcome=amv)["final"]
    assert _step(final, "us-stocks")["rowsWritten"] == 111
    assert _step(final, "us-index-daily")["rowsWritten"] == 222
    assert _step(final, "us-index-amv")["rowsWritten"] == 333


def test_timestamps_are_epoch_ms_integers() -> None:
    final = _run()["final"]
    assert isinstance(final["startedAt"], int)
    assert isinstance(final["finishedAt"], int)
    # epoch ms 量级（13 位）
    assert final["startedAt"] > 1_000_000_000_000
    for s in final["steps"]:
        assert isinstance(s["startedAt"], int)
        assert isinstance(s["finishedAt"], int)
    for log in final["logs"]:
        assert isinstance(log["ts"], int)


def test_logs_entry_shape() -> None:
    final = _run()["final"]
    assert final["logs"], "应至少有日志"
    log = final["logs"][0]
    assert set(log.keys()) == {"ts", "step", "level", "text"}
    assert log["level"] in ("info", "warn", "error")


# ===========================================================================
# failed_items / errors → step.errors[] 映射
# ===========================================================================
def test_failed_items_mapped_to_step_errors() -> None:
    us = UsSyncOutcome(
        quote_rows_total=10,
        failed_items=[UsFailedItem(ticker="NVDA", api_name="yahoo_chart",
                                   reason="no_data", rule="us_daily_empty")],
        errors=["MSFT: RuntimeError('boom')"],
    )
    final = _run(us_outcome=us)["final"]
    s = _step(final, "us-stocks")
    # 该步仍 success（失败明细在 errors[]，job 不进 failed 终态）
    assert s["status"] == "success"
    errs = s["errors"]
    assert len(errs) == 2
    # failed_item → level warn，apiName 取 rule
    fi = next(e for e in errs if e["apiName"] == "us_daily_empty")
    assert fi["step"] == "us-stocks"
    assert fi["level"] == "warn"
    assert "NVDA" in fi["message"]
    # ticker-level error string → level error
    es = next(e for e in errs if e["level"] == "error")
    assert es["step"] == "us-stocks"
    assert "MSFT" in es["message"]


def test_error_item_shape_only_contract_keys() -> None:
    us = UsSyncOutcome(
        failed_items=[UsFailedItem(ticker="X", api_name="a", reason="r",
                                   rule="us_factor_empty")],
    )
    final = _run(us_outcome=us)["final"]
    e = _step(final, "us-stocks")["errors"][0]
    assert set(e.keys()) == {"step", "level", "apiName", "message"}


def test_index_amv_failed_item_with_ticker_mapped() -> None:
    amv = UsIndexAmvOutcome(
        amv_rows_total=5,
        failed_items=[UsIndexAmvFailedItem(index_code=".NDX", ticker="AAPL",
                                           api_name="yahoo_chart", reason="no_data",
                                           rule="us_daily_empty")],
        errors=[".NDX: AmvComputeError('no sigma')"],
    )
    final = _run(amv_outcome=amv)["final"]
    s = _step(final, "us-index-amv")
    assert len(s["errors"]) == 2
    fi = next(e for e in s["errors"] if e["level"] == "warn")
    assert fi["apiName"] == "us_daily_empty"
    assert "AAPL" in fi["message"]


def test_index_daily_failed_item_mapped() -> None:
    idx = UsIndexSyncOutcome(
        rows_total=1,
        failed_items=[UsIndexFailedItem(index_code=".NDX", api_name="yahoo_chart(index)",
                                        reason="no_data", rule="us_index_empty")],
    )
    final = _run(idx_outcome=idx)["final"]
    e = _step(final, "us-index-daily")["errors"][0]
    assert e["step"] == "us-index-daily"
    assert e["apiName"] == "us_index_empty"
    assert e["level"] == "warn"


# ===========================================================================
# 进度映射：step_base ∈ {0,33,66}，每步结束写 base+33
# ===========================================================================
def test_progress_milestones() -> None:
    progress = [p for p, _ in _run()["progress_calls"]]
    # 至少含三步结束里程碑 33 / 66 / 100
    assert 33 in progress
    assert 66 in progress
    assert 100 in progress
    # 末值 100
    assert progress[-1] == 100


def test_progress_stage_carries_step_names() -> None:
    stages = [s for _, s in _run()["progress_calls"] if s]
    joined = " ".join(stages)
    assert "us-stocks" in joined
    assert "us-index-daily" in joined
    assert "us-index-amv" in joined


# ===========================================================================
# 失败不中断：某步抛硬异常 → 该步 failed + 记 error + 后续步仍执行
# ===========================================================================
def test_step_hard_exception_fails_step_but_continues() -> None:
    r = _run(us_side_effect=RuntimeError("yahoo down"))
    assert r["exc"] is None, "硬异常不应冒泡（失败不中断）"
    final = r["final"]
    s1 = _step(final, "us-stocks")
    assert s1["status"] == "failed"
    assert any("yahoo down" in e["message"] for e in s1["errors"])
    assert any(e["level"] == "error" for e in s1["errors"])
    # 后续两步仍执行成功
    assert _step(final, "us-index-daily")["status"] == "success"
    assert _step(final, "us-index-amv")["status"] == "success"
    r["idx_mock"].assert_called_once()
    r["amv_mock"].assert_called_once()
    # 进度仍到 100
    assert r["progress_calls"][-1][0] == 100


def test_middle_step_exception_does_not_block_third() -> None:
    r = _run(idx_side_effect=ValueError("index boom"))
    assert r["exc"] is None
    final = r["final"]
    assert _step(final, "us-stocks")["status"] == "success"
    assert _step(final, "us-index-daily")["status"] == "failed"
    assert _step(final, "us-index-amv")["status"] == "success"


# ===========================================================================
# 取消：step2 前 check_cancel True → 抛 JobCancelled + cancelled=true + skipped
# ===========================================================================
def test_cancel_before_step2_raises_and_marks_skipped() -> None:
    # check_cancel 调用序列：step1 前 False，step2 前 True
    r = _run(cancel_results=[False, True])
    assert isinstance(r["exc"], JobCancelled)
    final = r["final"]
    assert final["cancelled"] is True
    # step1 已成功
    assert _step(final, "us-stocks")["status"] == "success"
    # step2 / step3 未完成 → skipped
    assert _step(final, "us-index-daily")["status"] == "skipped"
    assert _step(final, "us-index-amv")["status"] == "skipped"
    # step3 子调用未发生
    r["amv_mock"].assert_not_called()
    r["idx_mock"].assert_not_called()


def test_cancel_writes_payload_before_raising() -> None:
    """抛 JobCancelled 前把 result_payload 写一次（cancelled=true）。"""
    r = _run(cancel_results=[False, True])
    # 最后一次写库快照即 cancelled 态
    assert r["final"]["cancelled"] is True
    assert any(snap["cancelled"] for snap in r["snapshots"])


def test_cancel_before_step1_marks_all_skipped() -> None:
    r = _run(cancel_results=[True])
    assert isinstance(r["exc"], JobCancelled)
    final = r["final"]
    assert final["cancelled"] is True
    for s in final["steps"]:
        assert s["status"] == "skipped"
    r["us_mock"].assert_not_called()


# ===========================================================================
# logs ≤ 200 截断
# ===========================================================================
def test_logs_truncated_to_200() -> None:
    """大量 failed_items 产生大量日志时，logs 保留最近 ≤200 条。"""
    many = [
        UsFailedItem(ticker=f"T{i}", api_name="yahoo_chart",
                     reason="no_data", rule="us_daily_empty")
        for i in range(500)
    ]
    us = UsSyncOutcome(quote_rows_total=1, failed_items=many)
    final = _run(us_outcome=us)["final"]
    assert len(final["logs"]) <= 200


# ===========================================================================
# 致命错误：date_range 非法 → 抛异常（dispatcher 置 failed）
# ===========================================================================
def test_invalid_date_range_raises() -> None:
    r = _run(date_range="20260101-20260616")  # 无冒号
    assert r["exc"] is not None
    assert isinstance(r["exc"], ValueError)


def test_invalid_date_range_bad_format_raises() -> None:
    r = _run(date_range="2026:20260616")  # start 非 8 位
    assert isinstance(r["exc"], ValueError)
