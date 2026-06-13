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
2. ✅ **#2 孤儿回收 —— 2026-06-14 已验通过**：用合成孤儿(running + 陈旧 heartbeat)穿过真实 `uv run quant-worker` 的 startup reaper（回收代码路径与真实 crash 孤儿完全一致，且真实孤儿 `5b1e0d90` 此前已被新 reaper 回收过一次）。worker 启动日志 `reaper_reaped reaped=2 stale_seconds=600`：
   - A(heartbeat 20min 陈旧 / attempts0<max3 / noop) → 回收为 pending → **被 worker 重新领走重跑 noop → success**(attempts=1)；
   - B(同陈旧 / attempts2≥max2) → 回收为 **failed + `orphaned: stale heartbeat…`**；
   - C(heartbeat=now() 新鲜) → **未被误回收**(仍 running、err 空，reaped=2 非 3)。
   3 条 e2e 孤儿已删、DB 复原。
3. ✅ **#3 kelly cancel —— 2026-06-14 已验通过**（合成 job 直插 ml.jobs，复制历史成功 job 5782f4d6 的 params）：
   - **取消响应**：4 出场族 job（更长 sweep）跑到 sweep 段(progress=58)置 `cancel_requested=true` → **2s 内** status=cancelled，stage `sweep 6/53→36/53`（per-exit_cfg 检查命中 JobCancelled→dispatcher 写 cancelled 正规路径）；
   - **进度持续递增**：0→35→42→55(sweep开始)→58，exit_cfg 计数递增（#3 的 per-exit_cfg 细化，修前单变体整段只跳一次）；
   - **零漂移**：用 5782f4d6 完全相同 params 重跑，valid 窗口数据未变(n_valid 297=297)→ `kelly_valid` 5 cfg 逐位相同；唯一差异 n_train 603→602 是 2026-06-09 以来 K 线数据演化、非代码漂移（代码级零漂移由单测 test_no_cancel_result_unchanged 权威保证）；happy path 完好(3b/4族 job 均 success)；
   - **无半成品**：cancelled job 结果行=0（取消早于 persist）。e2e job 已删、DB 复原。
   - **坑（已记）**：kelly job 仅 ~12s，比"插入 job 与启动轮询器两次工具调用之间的墙钟延迟"还短，首试编排器启动时 job 已 success；改用"插入+轮询+取消合一的单后台脚本"(零间隙)才截住 sweep。
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
- **2026-06-14：#2 孤儿回收 e2e 已验通过**(真实 worker startup reaper 回收 2 陈旧孤儿[retry→重跑 success / giveup→failed]、新鲜活 job 不误回收，DB 已复原)。
- **2026-06-14：#3 kelly cancel e2e 已验通过**(sweep 段置 cancel→2s 内 cancelled / 进度 per-exit_cfg 递增 / valid 窗口零漂移 / cancelled 无半成品持久化，DB 已复原)。
- **✅ #1-#4 四项真机 e2e 全部完成**——本交接已无待办，归档。
