# Code Review：`worker/` + `cli` + `db/config/utils`

> 评审对象：`worker/`、`cli.py` `cli_m4.py` `cli_ml.py` `cli_quality.py`、`db/`、`config/`、`utils/`
> 评审重点：worker 任务状态机、失败重试、数据完整性、并发与资源、代码质量。
> 使用方式：新会话打开本文。问题 1-4 共同构成 worker 重试与并发回收的不可靠点，应优先修。

## 🔴 严重

### 1. 失败任务永不重试，`max_attempts` 形同虚设 —— `worker/dispatcher.py:378-384` + `poller.py`
普通异常路径 `_finalize_job(job.id, status="failed", ...)` 把 job 直接置 `failed` 终态。poller 只查 `status='pending'`，reaper 只回收 `status='running'`。一个 runner 抛异常失败的 job **永远不会**重新进入 `pending`，即使 `attempts < max_attempts`。`max_attempts` 唯一生效的场景是 heartbeat 超时（reaper），而 runner 主动失败（最常见的失败方式）完全不享受重试。
**修复**：`_finalize_job` 失败分支判断 `job.attempts < job.max_attempts`，成立则置回 `pending`（清 `started_at`/`heartbeat_at`），否则才置 `failed`。

### 2. reaper 重试不自增 `attempts`，语义脆弱可造成无限重试 —— `worker/dispatcher.py:393-431`
docstring 写「reaper 自加 attempts 由下一次 poll 完成」。但 poller 的 `attempts = attempts + 1` 对任何 pending→running 转换都自增，包括首次领取。`attempts` 同时表达「已领取次数」与「已重试次数」，reaper 的 `s.attempts < s.max_attempts` 判断读的是重置前的旧值，而 poll 又加一遍。两处都不增/都假设对方增，边界极易错。
**修复**：明确 `attempts` 单一语义。建议 reaper 重置 pending 时不动 attempts，由 poll 统一自增；或反过来。二选一并写死注释。

### 3. `cancel_requested` 取消后未清标志，job 可能「卡死取消」—— `worker/dispatcher.py:353-355` + `progress.py:92`
job 被取消时 `_finalize_job(status="cancelled")` 不清 `cancel_requested`。若该 job 后续重新被领取（手工改回 pending、或将来支持重试），`check_cancel_requested` 立刻返回 True，runner 一启动就被取消，无法摆脱。
**修复**：`_finalize_job` 写终态时一并 `cancel_requested = false`（至少 cancelled 分支必须清）。

## 🟡 中等

### 4. heartbeat 线程不存在 → 长任务会被 reaper 误杀并发跑两遍 —— `worker/loop.py:7-8` + `dispatcher.py:393`
`loop.py` docstring 自承「M0 dispatcher 周期短，暂未单独起 heartbeat 线程」。但 dispatcher 现已路由 `sync/train/optuna` 等长任务。`heartbeat_at` 仅由 `update_progress` 顺带刷新。若某 runner 在两次 `update_progress` 之间耗时 > `reaper_interval`（60s）+ `stale_minutes`（3min），reaper 会把仍在运行的 job 判为超时回收并重置 pending，**同一 job 可能被并发跑两遍**（原进程仍在跑，新进程领走重置后的 pending 行），造成 upsert 竞争/重复写。`worker_heartbeat_interval_seconds` 配置项目前完全没有被任何代码读取。
**修复**：实现 docstring 承诺的后台 heartbeat 线程，或要求每个长 runner 保证 `update_progress` 间隔 < stale 阈值并在测试中验证。

### 5. `validate_schema` 漏校验 `*_at` 列的时间类型 —— `db/schema_contract.py:37-61`
契约只校验列是否存在，不校验类型。CLAUDE.md 硬约束「时间列一律 timestamptz」。`heartbeat_at`/`started_at`/`finished_at`/`created_at`/`cal_date` 若被误建为 `timestamp`（无 TZ），schema 校验仍通过，而 worker 的 `heartbeat_at < now() - interval` 比对会按错误 TZ 漂移。
**修复**：对关键时间列追加 `data_type = 'timestamp with time zone'` 校验（查 `information_schema.columns.data_type`）。

### 6. `worker/dispatcher.py:401-407` — reaper SQL 用 f-string 拼 interval
`interval '{int(stale_minutes)} min'` 直接 f-string 拼入。`int()` 强转挡住了注入（安全），但与项目其它地方一律参数化绑定的风格不一致，且若将来 `stale_minutes` 变浮点会破。
**修复**：改 `now() - make_interval(mins => :stale)` 并绑定参数。

### 7. `_make_progress_callback` 在 cli.py 与 cli_ml.py 重复定义 —— `cli.py:27-33` + `cli_ml.py:17-23`
两处逐字重复（cli_ml 版还缺类型注解），`Console(force_terminal=True)` 也各建一次。
**修复**：提到共享模块（如 `cli_common.py`）统一导出。

### 8. CLI `--date-range` 等无格式校验即下传 —— `cli.py:122-199`、`cli_ml.py:26`
`sync raw` 的 `date_range` 不在 CLI 层校验 `YYYYMMDD:YYYYMMDD`（对比 dispatcher 的 `_runner_sync` 有显式校验）。同一参数走 worker 路径会被拦，走 CLI 直跑则一路传到 orchestrator 才报错。
**修复**：把 `date_range` 校验抽成共享函数，CLI 与 dispatcher 共用。

## 🟢 建议

- **9.** `worker/dispatcher.py` 443 行接近 500 行上限。11 个 `_runner_*` 函数大多是 3-5 行延迟 import 转发样板，建议把路由表与 runner 适配器抽到 `worker/routes.py`。
- **10.** `worker/dispatcher.py:43-44` `_runner_not_implemented` 已成死代码（所有 run_type 都有真实 runner），`except NotImplementedError` 分支也基本不可达。M0 残留，建议删除。
- **11.** `config/logging.py:39-44` `JsonFormatter` 透传 extra 时 `json.dumps` 不防不可序列化对象（numpy 标量、Path），`warn_with_quality_report` 的 `detail` 直接进 extra，风险真实。修复：`json.dumps(payload, default=str)`。
- **12.** `worker/loop.py:77` reaper 触发精度受 `poll_interval`（默认 2s）限制，可接受，无需改。
- **13.** `dispatcher.py:181-191` 的 `_runner_quality` 透传 7 个阈值键，`cli_quality.py:53-57` 的 `check` 只暴露 3 个，两条路径能力不对等。非 bug，建议文档注明或对齐。

## 总评

worker 子系统的「快乐路径」（poll → dispatch → finalize → NOTIFY）实现干净，SQL 用了 `FOR UPDATE SKIP LOCKED`、`pg_notify` 参数化、payload 长度上限，`session_scope` 的 commit/rollback/close 正确无连接泄漏。**但任务状态机的失败与重试路径有真实缺陷**：runner 主动失败的 job 永不重试（#1）、`attempts` 自增语义在 poll 与 reaper 之间含糊（#2）、长任务缺 heartbeat 线程会被 reaper 误杀并重复执行（#4）、取消标志取消后不清理（#3）——这四条共同构成「重试与并发回收」这一关键子系统的不可靠点，应优先修复。CLI / config / db 层整体规范，主要是重复代码与校验不一致的小问题。
