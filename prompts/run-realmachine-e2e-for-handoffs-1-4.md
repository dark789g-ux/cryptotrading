# 对 4 个已实现交接(枚举守门/孤儿回收/kelly cancel/worker 文档)补真机 e2e 收口

> 本文自包含，可整段贴给全新会话接手。

## 一句话目标
4 个交接(原 `add-exit-mode-enum-render-guard-test` / `add-orphaned-running-job-reclaim` / `fix-kelly-sweep-cancel-granularity` / `fix-worker-startup-docs`，均已实现+单测/构建级验证+提交，现归档于 `prompts/archive/`)，唯独**有状态/串行的真机 e2e** 未做——本任务补做收口。

## 现状(已实现并合入本地 main，未推 origin)
- `a66b074` feat(web) #1 枚举守门：type-check/vitest(237)/vite build 全绿，注入故障实测穷尽校验生效。
- `223b03d` feat(quant) #2 孤儿回收：阈值进 config + 孤儿 error_text；**PG 集成测已真 DB 验过"过期回收/新鲜不误杀"两场景**，现存孤儿 `5b1e0d90` 已被新 reaper 自动回收为 failed。
- `3ce5654` feat(quant) #3 kelly cancel：exit_cfg 级 cancel + 细化进度，纯旁路零碰计算；单测 322 passed。
- `dc8c123` feat(quant) #4 worker 入口：`__main__.py:main`(setup_logging+run_worker_loop) + console script `quant-worker` 指向它，三入口日志对齐；import/entry-point/ruff/mypy 全过。
- 未做真机 e2e 的原因：单 worker 串行队列，易被 stale running / 前序会话 worker 占用干扰(参 memory `project_phase_lock_exit` kelly/labels e2e 跳过同因)。

## 待做 e2e(逐任务，file:line 见 archive/ 下对应交接)
1. ✅ **#4 worker 启动 —— 2026-06-14 已验通过**(`apps/server/src/modules/quant/realtime/README.md:76`)：
   - `uv run quant-worker` 起 worker → 插 `run_type='noop'` → 被置 running→success(progress=100)；
   - `uv run python -m quant_pipeline.worker` 等价启动验证：同样消费 noop→success、同套 INFO 日志(两命令走同一 `__main__:main`)；
   - **运维坑已验修复**：两入口日志均含 INFO `worker_started` / `dispatch`(修前 `quant-worker` 直指 `run_worker_loop` 不调 `setup_logging` 会静默)。
   - 收尾：worker 进程已 kill(按命令行精确过滤,无误伤/无残留)、2 条测试 noop 已删、DB 复原(`running/pending=0`)。
2. **#2 孤儿回收**：起一个长 job(如 kelly_sweep) → 杀 worker → 重启 worker → 阈值(默认 600s，e2e 可临时把 `WORKER_STALE_RUNNING_THRESHOLD_SECONDS` 调小加速)后被回收(attempts<max 应重 pending 被领走重跑、结果幂等)；另验一个心跳正常(每 30s)的活 job 在 reaper 周期触发时**不被**误回收。
3. **#3 kelly cancel**：起一个大 kelly job(默认网格 + `bootstrap_iters=1000`) 运行中 `UPDATE ml.jobs SET cancel_requested=true …` → **数秒内** status 转 cancelled；观察 sweep 段(55–90%) progress **持续递增**(非整段不动)；再跑一个改前已有结果的 job，确认 `research.kelly_sweep_results` 与改前**逐字一致**(零漂移)。
4. ✅ **#1 前端 —— 2026-06-14 已验通过**：preview(:5173,登录态 admin,路由 `/signal-stats`)。四渲染点全过——列表出场方式列(exitModeTag:临时造 phase_lock 方案验得「两阶段锁定止损」)/导入下拉(exitModeShortLabel:phase_lock→两阶段锁定止损)/结果摘要(exitModeSummary:波段跟踪止损)/配置面板(exitModeText:出场模式=波段跟踪止损)均正确中文含参、零 fallback、控制台零 error;临时 phase_lock 方案已删、DB 复原。

## 硬约束 / 项目规范
- worker **非热加载**，改 worker 代码后须重启 worker 进程才生效。
- 单 worker 串行：开跑前先确认无 stale running job、无前序会话 worker 占用。
- cancel/进度仅旁路，**不得影响量化 kelly/ret/bootstrap 结果**。
- 时间列 timestamptz、SQL 比对用 `now()`；源文件 UTF-8。

## 验证标准
各任务交接原"验证标准"的真机部分(见 `prompts/archive/` 下对应 4 个交接文档)。

## 前序进度 / 待续
实现已提交本地 main(`a66b074`/`223b03d`/`3ce5654`/`dc8c123`，未推 origin)，单测/集成测/构建全绿。
- **2026-06-14：#4 worker 启动 e2e 已验通过**(两命令 + INFO 日志 + noop success，DB 已复原)。
- **2026-06-14：#1 前端 signal-stats 渲染 e2e 已验通过**(四渲染点全过，phase_lock 标签正确，DB 已复原)。
- **待续：#2 杀 worker 验回收 / #3 大 kelly job cancel** 两项真机 e2e 仍未做。
