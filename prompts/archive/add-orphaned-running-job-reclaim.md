# 加孤儿 running job 回收（worker 崩溃/被杀后卡 running 的 ml.jobs）

> 本文自包含，可整段贴给全新会话接手。

## 一句话目标
让被中断（worker 崩溃 / 被杀）而卡在 `status='running'` 的 `ml.jobs` 行能被**自动回收**（heartbeat 超时 → 重 pending 或 failed），避免永久占位、误判"在跑"、阻塞队列。

## 现状摸底（file:line 为证，已核实——当前**无任何回收机制**）
- `apps/quant-pipeline/src/quant_pipeline/worker/poller.py` `poll_one()`（:34）只 `SELECT ... FROM ml.jobs WHERE status='pending'`（:44），**完全不碰 running 行**；无 heartbeat 超时回收逻辑。
- `apps/quant-pipeline/src/quant_pipeline/worker/loop.py` `run_worker_loop()`（:35）= poll → dispatch 循环，也未见 reclaim 步骤（请新会话再通读 loop.py 确认无遗漏）。
- 结论：worker 被杀后，其 running job **永久卡 running**，下次起 worker **不会**自动回收。
- 现存实例：旧 job `5b1e0d90`（kelly_sweep）因 2026-06-13 e2e 杀 worker 留成孤儿 running，需手动复位：
  `docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "UPDATE ml.jobs SET status='failed', error_text='orphaned' WHERE id::text LIKE '5b1e0d90%' AND status='running';"`
- 可用字段：`ml.jobs.heartbeat_at`（worker 运行时更新，见 poller.py:55、quant-jobs.service.ts 心跳）、`attempts`/`max_attempts`、`cancel_requested`、`started_at`。
- 轮询间隔配置：`apps/quant-pipeline/src/quant_pipeline/config/settings.py:44` `worker_poll_interval_seconds`。

## 已定方向（待敲定）
- 在 worker 轮询循环（`worker/loop.py`）或 `poll_one` 之前加 reclaim 步：`status='running' 且 heartbeat_at < now() - 阈值` 的行 → `attempts < max_attempts` 则重置 `pending`，否则置 `failed`（error_text 标 stale/orphaned）。阈值取 `worker_poll_interval_seconds` 的若干倍（须远大于心跳周期，避免误杀活 job）。

### 开放问题
1. 重 pending 重试 vs 直接 failed？kelly_sweep 半成品重跑是否幂等/安全（结果写库是否有部分写、需先清理 research 表残留）？labels 同问。
2. 阈值取值（心跳周期 × 几）。
3. reclaim 放 worker 启动跑一次 + 每轮跑，还是独立定时任务？多 worker 并发时用 `FOR UPDATE SKIP LOCKED` 同款保证并发安全。

## 硬约束 / 项目规范
- 回收必须并发安全（多 worker）；**绝不误回收正在跑的活 job**（阈值足够大）；源文件 UTF-8；改后重启 worker。
- 时间列用 `timestamptz`、SQL 比对用 `now()`（项目 datetime 规范）。

## 验证标准
1. 起 job → 杀 worker → 重启 worker → 该 job 在阈值后被回收（重 pending 被重新处理 或 failed）；
2. 一个心跳正常的活 job 在 reclaim 跑时**不被**误回收；
3. 顺手把现存孤儿 `5b1e0d90` 复位（或被新机制自动回收）。

## 前序进度 / 待续
全新任务，未动手。2026-06-13 phase_lock e2e 杀 worker 后旧 job 卡 running 暴露此缺口（当时误以为有 heartbeat 回收，已证伪）。相关：`fix-worker-startup-docs.md`、`fix-kelly-sweep-cancel-granularity.md`。
