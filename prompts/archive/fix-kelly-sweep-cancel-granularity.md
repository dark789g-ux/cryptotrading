# 修 kelly_sweep 作业的 cancel 粒度 + 进度上报粒度

> 本文自包含，可整段贴给全新会话接手。2026-06-13 phase_lock e2e 时直接撞到，独立于 phase_lock。

## 一句话目标
让运行中的 `kelly_sweep` job 能在数秒内响应取消（`cancel_requested`），并在 sweep 阶段**持续**上报进度，而非整段 sweep 只在最后跳一次。

## 现状摸底（file:line 为证，已核实）
- `apps/quant-pipeline/src/quant_pipeline/research/kelly_sweep/sweep.py` `run_sweep()`（:942）：
  - 外层 `for _variant_i ...` 遍历 entry-filter 变体；内层 `for exit_cfg in exit_grid:`（:1073）遍历出场配置。
  - `on_progress(done, total)` **只在每个变体跑完后 emit**（:1129-1131，注释 :966-967 明说"外层 for variant 每完成一个变体 emit"）。
  - `run_sweep` 内 **全程不调 `check_cancel_requested`**（在 sweep.py 对该函数 grep 零命中）。
- 后果（2026-06-13 真机实测）：`max_entry_filters=0` 时只有 1 个变体 → progress 整段 sweep 只在最末 emit 一次；一个 ~5650 路径 + `bootstrap_iters=1000` 的 job 进度卡固定值数分钟、置 `cancel_requested=true` 被忽略数分钟不中止，阻塞单 worker 队列。
- cancel 机制本身正常：`ml.jobs.cancel_requested` 列 + worker 在 stage 边界检查（`apps/server/src/modules/quant/services/quant-jobs.service.ts:210` 注释："worker 在下一次心跳 / 阶段切换时读到后中止"）。问题在 `run_sweep` 这个长 stage 内部不检查。
- 链路：worker dispatcher → `apps/quant-pipeline/src/quant_pipeline/worker/kelly_sweep_runner.py` → `run_sweep(on_progress=回调写 ml.jobs.progress + NOTIFY)`。取消信号读 `cancel_requested`，中止走 `JobCancelled`（`worker/progress.py` 有 `check_cancel_requested` / `JobCancelled`）。

## 已定方向（细节待新会话敲定）
- 给 `run_sweep` 传入 cancel 检查回调（或可中断 token），在内层 `for exit_cfg`（:1073）每个配置后（或每 N 条 path）检查 `cancel_requested`，命中抛 `JobCancelled`（与现有取消路径一致、落 status）。
- 同步把 progress 细化到 exit_cfg 级（或变体内分段），让单变体 job 也持续推进度。

### 待敲定的开放问题
1. cancel 检查放 exit_cfg 粒度够不够？单个 cfg 内的 `bootstrap_kelly_ci` 也可能很久，是否要进 bootstrap 内层？
2. progress 的 `done/total` 口径如何重定义（变体 × cfg）且保持单调递增（前端步骤条依赖单调，见 memory signal_forward_stats 的进度坑）。
3. 多 worker 并发时取消语义。

## 硬约束 / 项目规范
- **量化结果/对拍不得变**：cancel 与进度只是旁路，不能影响 kelly/ret/bootstrap 计算。
- 禁静默吞错：中止必须走 `JobCancelled` 正规路径并落 `status`/`error_text`。
- 源文件 UTF-8；改后端 worker 须**重启 worker 进程**才生效（worker 非热加载）。

## 验证标准
1. 起一个大 kelly job，运行中置 `cancel_requested=true` → 数秒内 status 转中止；
2. 运行中 progress 持续增长（非整段不动）；
3. 既有 kelly 单测零回归（`apps/quant-pipeline/tests/unit/test_kelly_*`、`test_*sweep*`）+ 一次真机 job 正常完成、结果与改前一致。

## 前序进度 / 待续
全新任务，未动手。背景见 memory `project_phase_lock_exit`（kelly worker 段）。worker 启动方式见同目录 `fix-worker-startup-docs.md`（README 旧命令已失效）。
