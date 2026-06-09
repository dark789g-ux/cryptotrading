# 01 · 架构与数据流

← 返回 [index.md](./index.md)

## 整体数据流

新增一个 `kelly_sweep` run_type，复用现有 `ml.jobs` 异步执行 + SSE 进度链路。**发起仍走现成 `POST /api/quant/jobs`，SSE 链路（pg_notify→PgListenService→ProgressLine）零改动**。

```text
┌─ 前端操作台 /quant/kelly-sweep ──────────────────────────────┐
│  配置表单(12字段全量 + 出场族开关)  → [发起扫描]            │
└───────────────┬──────────────────────────────────────────────┘
                │ POST /api/quant/jobs
                │ {run_type:'kelly_sweep', params:{<SweepConfig>, exit_families:[...]}}
                ▼
        NestJS QuantJobsController → 校验DTO → 入 ml.jobs(status=pending)
                │
                ▼  worker 轮询 (FOR UPDATE SKIP LOCKED, 单进程串行=天然限一个)
        Python dispatcher._ROUTES['kelly_sweep'] → _runner_kelly_sweep(job)
                │  复刻 _run_sweep_pipeline 调用链, 全程传 on_progress 回调:
                │  enumerate→paths→features→index→run_sweep→pareto→rank_top_k
                │  每阶段/每扫完一个变体 → update_progress(job_id,pct,stage)
                │                              └→ pg_notify('ml_job_progress')
                │  跑完: ResultRow 全表(标 is_frontier/is_topk) 批量写结果表
                ▼
        ml.jobs.progress/stage 更新 ──pg_notify──▶ NestJS PgListenService
                                                          │ SSE
                                                          ▼
                                              前端 ProgressLine.vue (实时进度条)
   ── 扫描完成后 ──
        前端结果页 → GET /api/quant/kelly-sweep/runs/:jobId/{summary,scatter,topk,rows,rows/:id}
                  → NestJS 查 research.kelly_sweep_results (只读) → 分页/排序/详情
```

## job 生命周期（复用现有机制，已核对出处）

| 阶段 | 由谁做 | 出处 |
|---|---|---|
| 发起入表 | NestJS `quant-jobs.service` create → `ml.jobs(status=pending)` | `apps/server/src/modules/quant/controllers/quant-jobs.controller.ts` |
| 取走置 running | Python poller `SELECT … FOR UPDATE SKIP LOCKED` 原子置 running | `apps/quant-pipeline/.../worker/poller.py:34-72` |
| 分发 | `dispatcher._ROUTES[run_type]` → runner | `apps/quant-pipeline/.../worker/dispatcher.py:358-377` |
| 进度回写 | `update_progress(job_id, progress, stage)` 同事务写字段 + `pg_notify('ml_job_progress')` | `apps/quant-pipeline/.../worker/progress.py:134-164` |
| SSE 推送 | NestJS `PgListenService` LISTEN → SSE；前端先取 sse-token 再 query 建连 | `apps/server/.../modules/quant/realtime/pg-listen.service.ts`；`apps/web/src/views/quant/README.md` |
| 终态 | runner 正常返回→success；异常→failed + `ml.jobs.error_text` 写 traceback | 沿用现有 worker 错误处理 |

## 进度粒度

harness 当前**只有 logging、无任何 progress 钩子**（`sweep.py` 等各模块仅 `logger.info`）。本设计给 pipeline 主函数加 `on_progress` 回调（详见 [03-python-runner.md](./03-python-runner.md#on_progress-钩子插点)），runner 把回调桥接到 `update_progress`。五阶段 + 网格长段细推：

```text
阶段                    进度区间   stage 文字示例
─────────────────────  ────────  ──────────────────────────
enumerate 枚举信号       0–15%    "枚举信号 1234 条"
load_forward_paths 路径  15–35%   "加载前向路径 1234/1234"
load_feature_inputs 特征 35–50%   "计算入场特征截面"
load_index_daily 指数RS  50–55%   "加载 RS 基准 hs300,zz500"
run_sweep 网格扫描       55–90%   "网格扫描 75/121 变体"   ← 6min 长段, 按已扫变体细推
pareto+topk+Bootstrap CI 90–100%  "计算 Bootstrap CI 12/30" ← CI 耗时, 按 top-K 推
```

网格扫描是最长段（约 6 分钟），必须按「已扫变体数 / 总变体数」细推，否则进度条会在 55% 卡住 6 分钟。`run_sweep` 外层循环 `for variant in variants`（`sweep.py:661` 附近）每完成一个变体 emit 一次。

## 并发护栏

- **天然限一个**：worker 单进程串行（`loop.py` 主循环 + `dispatcher.dispatch` 同步调用），一次只处理一个 job，处理完才取下一个。无需额外加锁。
- **软提示**：前端发起前查是否已有 `running` 的 kelly_sweep job（`GET /api/quant/jobs?run_type=kelly_sweep&status=running`），有则提示「已有扫描在跑，排队还是取消？」。
- **组合数预估警告**：前端按「变体数 × 勾选出场数」实时估算，超 5000（对齐 harness `_COMBO_WARN_THRESHOLD`，`sweep.py:109`）显示 ⚠ 提示时长会显著拉长。
- **失败透出**：禁止静默吞错。runner 异常逐层上抛，worker 写 `ml.jobs.error_text` + status=failed，SSE 推 failed 关流，前端进度区显示错误。

## 为什么复用 ml.jobs 而非新建任务系统

| 维度 | 复用 ml.jobs（选定） | 新建独立表+worker |
|---|---|---|
| SSE 链路 | 零改动（pg_notify 通道现成） | 整套重写 |
| 并发护栏 | 单进程串行免费 | 自行实现 |
| 改动面 | 6 处接入 + 结果查询栈 | poller/SSE/前端订阅全套 |
| 代价 | research 任务混入 ml（模型训练）域的 jobs 表 | 语义最干净 |

权衡结论：`ml.jobs` 本质是通用异步任务队列，混入一个 research 类型可接受，省下整套 SSE/并发实现，明显更优。**唯结果落库走独立 `research` schema**（见 [02](./02-data-model.md)），把 research 产物与 ml 训练产物在存储层分开，兼顾语义。
