# 03 Python 编排器（us_one_click_sync runner）

[← index](./index.md)

## 入口与路由

新增 dispatcher runner `_runner_us_one_click_sync`，登记进 `_ROUTES`（`apps/quant-pipeline/.../worker/dispatcher.py:534` ✅已核 `_ROUTES` 位置）：

```python
"us_one_click_sync": _runner_us_one_click_sync,
```

runner 解析 `job.params.date_range`（冒号串 `'YYYYMMDD:YYYYMMDD'`，与 `_runner_us_sync` 同款校验，dispatcher.py:142-149 ✅已核），转调新模块 `sync/us_one_click_orchestrator.py` 的 `run_us_one_click_sync(job_id, date_range)`。

## 三步顺序（固定）

```text
parse [user_start, user_end]
  └ capped_end = cap_to_last_closed_session(user_end)   ← 见 04，丢在长 bar
  └ write_start = user_start ; fetch_start = 美股保留起点 20240102（见 04）

init result_payload：3 步 pending，range/startedAt 写入

step1  run_us_sync(date_range="<fetch_start>:<capped_end>", write_start=user_start, tracked 全集)
         progress 0→33 ；patch step[us-stocks]
step2  run_us_index_sync(date_range="<fetch_start>:<capped_end>", write_start=user_start, symbols=('.NDX',))
         progress 33→66 ；patch step[us-index-daily]
step3  run_us_index_amv_sync(date_range="<fetch_start>:<capped_end>", write_start=user_start, symbols=('.NDX',))
         progress 66→100 ；patch step[us-index-amv]

finalize：finishedAt 写入；dispatcher 据是否有 error 判终态
```

每步把子 outcome 的 `*_rows_total` 累加到该步 `rowsWritten`，`failed_items`/`errors` 映射成该步 `errors[]`（`OneClickErrorItem` 形态，见 [01 schema](./01-architecture-and-dataflow.md#result_payload-步骤态-schema前后端硬契约)）。

## 进度映射（最终决定，无并列方案）

**编排器对三个子调用一律传 `job_id=None`**，由编排器**独占** `update_progress` + `result_payload`：

- `run_us_sync` / `run_us_index_sync` / `run_us_index_amv_sync` 在 `job_id is not None` 时才写 progress / check_cancel（us_orchestrator.py:76,81,85,111,114 ✅已核全部 `if job_id is not None:` 守门）。传 `job_id=None` → 子调用走 CLI 直跑分支：只算数据、返回 outcome、**不碰 ml.jobs 进度**，因此不会把总进度打回子刻度。
- 编排器在**每步开始/结束**各写一次总进度：step_base ∈ {0,33,66}，每步结束写 `base+33`（即 0→33→66→100）。步内细粒度不追求（总进度条 + 步骤表的 running 状态够用）；`stage` 文本写当前步名。

> 不采用「缩放回调 `make_scaled_callback`」方案：现有子 orchestrator 不接受 `progress_cb`、直接调 `update_progress`，引入回调需大改子 orchestrator，得不偿失。`job_id=None` 独占方案零改子 orchestrator。

## result_payload 增量写 helper

dispatcher 现有 `_update_job_result`（dispatcher.py:496 ✅已核）只在成功时写一次。新增**增量写**（编排器每次 patch 步骤态后调用）：

```python
def update_job_result_partial(job_id: UUID, payload: dict) -> None:
    # UPDATE ml.jobs SET result_payload = CAST(:rp AS jsonb) WHERE id = :id
    # 与 _update_job_result 同款，整对象覆盖（payload 由编排器在内存维护后整体写）
```

编排器在内存持有 `result_payload` dict，每个「步骤状态变化 / 追加日志」后整体 `update_job_result_partial` 覆盖写库（节流：可每次 patch 即写，3 步频率低，无需复杂节流）。`logs` 数组保留最近 ≤ 200 条。

## 失败不中断 + 取消

- **失败不中断**：单步 `run_us_*` 内部已逐 ticker/symbol 捕获、记 `failed_items`/`errors` 不抛（us_orchestrator.py:105-109 ✅已核）。编排器对**每步用 try/except 包裹**：子调用抛硬异常 → 该步 status=failed、记 error、**继续下一步**（镜像 A 股 step-runners 的 `failStep`）。
- **终态判定**：任一步 status=failed 或 errors 非空 → dispatcher 仍判 job `success`（与现有 us_sync「completed_with_issues」一致，失败明细在 result_payload.steps[].errors），job 不进 failed 终态。**例外**：编排器自身致命错误（如 date_range 非法）→ 抛异常，dispatcher 置 failed。
- **取消**：每步开始前 `check_cancel_requested(job_id)`（progress.py:177 ✅已核）→ true 抛 `JobCancelled`；dispatcher 捕获置 `cancelled`（dispatcher.py:722-724 ✅已核）。编排器在抛出前把当前 result_payload（cancelled=true、未完成步标 skipped）写库一次，供前端 summary 展示。

## CLI 入口（可选，便于离线验证）

镜像现有 `us-sync` CLI（cli.py:233 ✅已核），加 `us-one-click-sync --date-range`，`job_id=None` 直跑（不写 ml.jobs，仅打印 outcome 摘要）。用于真机前的离线冒烟。

## 与 04 的衔接

`run_us_sync` / `run_us_index_sync` / `run_us_index_amv_sync` 需新增 `write_start` 形参并透传到各自的 `sync_us_*_for_*`——契约与 end-cap helper 见 [04](./04-warmup-endcap-fetch.md)。
