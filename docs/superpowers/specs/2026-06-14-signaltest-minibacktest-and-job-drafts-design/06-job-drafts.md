# 06 · Part B：ml.jobs 草稿态 + 手动 dispatch（全栈）

[← 返回总入口](./index.md)

> Part B 与 Part A 无共享文件，可独立实现/验证/合并。

## 6.1 目标

```text
【改前】触发弹窗[提交] → POST /quant/jobs (status=pending) → worker 立即捞 → running
【改后】触发弹窗[保存草稿] → POST /quant/jobs (as_draft → status=draft) → worker 不捞(只捞 pending)
        jobs 列表·草稿行[运行] → POST /quant/jobs/:id/dispatch (draft→pending) → worker 捞 → running
```

## 6.2 核实基线（真 DB + 实体）

- `ml.jobs.status` 为 `text` + CHECK `ck_jobs_status`，当前 6 值：`pending|running|success|failed|blocked|cancelled`（已 `docker exec` 核实）。**非 PG enum**。
- `MlJobStatus` 类型别名：`entities/ml/ml-job.entity.ts:10-16`。
- 创建：`quant-jobs.controller.ts:37` `@Post() create()` → `quant-jobs.service.ts:90` `create()`，第 154 行硬编码 `status:'pending'`。
- worker 拾取：`apps/quant-pipeline/src/quant_pipeline/worker/poller.py:34` `poll_one()`（`WHERE status='pending'` 在 :44，`FOR UPDATE SKIP LOCKED`）。
- cancel：`quant-jobs.controller.ts:69` → `quant-jobs.service.ts:216` `cancel()`，对 pending/running 设 `cancel_requested=true`。
- `ml` schema 由 **Python alembic** 管理（非 NestJS migration）。

## 6.3 后端改动

### 6.3.1 Migration（alembic，注意脱节）

新建 alembic migration：扩展 `ck_jobs_status` CHECK 加 `'draft'`：

```sql
ALTER TABLE ml.jobs DROP CONSTRAINT ck_jobs_status;
ALTER TABLE ml.jobs ADD CONSTRAINT ck_jobs_status
  CHECK (status = ANY (ARRAY['pending','running','success','failed','blocked','cancelled','draft']));
```

> **alembic 脱节注意**（memory 教训）：apply 前先 `alembic current` 确认与 head 对齐；若落后须先 `alembic stamp` 对齐再 `upgrade`，否则重跑撞「已存在」。

`MlJobStatus` 类型别名（`entities/ml/ml-job.entity.ts:10-16`）加 `'draft'`。

### 6.3.2 create() 参数化

`quant-jobs.service.ts:154` `status:'pending'` 改为按入参：新增可选 `asDraft?: boolean`，`asDraft===true` → `status:'draft'`，否则 `'pending'`（**默认 false，向后兼容**）。`CreateJobDto`（`create-job.dto.ts`）增 `as_draft?: boolean`；controller `create()` 透传。

> kelly_sweep 走通用 `POST /quant/jobs`（仅 DTO 层多一层 `validateKellySweepParams`），`as_draft` 同样适用，无需 kelly 专属改动。

### 6.3.3 新增 dispatch endpoint

```text
POST /quant/jobs/:id/dispatch
  controller: 新增 @Post(':id/dispatch') dispatch(@Param('id') id)
  service dispatch(id):
    job = findOne(id) ; 不存在 → 404
    job.status !== 'draft' → 409 ConflictException(中文「仅草稿任务可发起运行」)
    UPDATE ml.jobs SET status='pending' WHERE id=:id AND status='draft'
    return { jobId: id }
  worker 无需改动(poller 只捞 pending,draft→pending 后自然被捞)
```

### 6.3.4 草稿取消（D2 决策：直接置 cancelled）

`cancel()` 对 `status='draft'` 走**直连终态**：`UPDATE status='cancelled'`（不写 `cancel_requested`、不等 worker——草稿从未进 worker）。pending/running 仍走原 `cancel_requested` 路径。

### 6.3.5 不改的部分

SSE token / stream（`issueSseToken` 只校验 job 存在，draft 可正常颁 token/建连，快照 `progress=0 status=draft` 前端处理）；reaper（只扫 running 超时）；TERMINAL_STATUSES。

## 6.4 前端改动

### 6.4.1 三触发入口默认建草稿

```text
QuantTrainTriggerModal.vue  提交按钮文案「提交」→「保存草稿」;onSubmit 调 createJob 传 as_draft:true
PrepareModal.vue            「开始备料」→「保存草稿」;onSubmit 传 as_draft:true
KellySweepView.vue          「发起扫描」→「保存草稿」;createSweepJob 透传 as_draft:true
```

三者均 `quantApi.createJob`（`quant.ts:532`）；建议新增 `as_draft` 形参透传（kellySweep.ts 包装层同步透传）。提交后仍 `router.push({name:'quant-jobs', query:{highlight: job.id}})`（用户落到列表即见草稿行 + 运行按钮）。

> 三入口未共用 store action。可选优化：抽 `useQuantJobSubmit()` composable 收敛「createJob + 跳转」，但非必须，本期可各自透传 `as_draft`（改动更小）。

### 6.4.2 jobs 列表运行按钮

`QuantJobsView.vue` 操作列（columns render，约 :228-244）：

```text
status==='draft' 行  → 渲染「运行」按钮 → quantApi.dispatchJob(row.id) → 刷新列表
                       + 「取消」按钮对 draft 仍可用(走 6.3.4 直连 cancelled)
前端 JobStatus 枚举 + statusOptions(筛选) + statusTagMap(标签) 增 'draft'(标签「草稿」,中性色)
api/modules/quant.ts  增 dispatchJob(id) → POST /quant/jobs/:id/dispatch
JobRow 类型           增 'draft' 到 status 联合
```

## 6.5 验证要点（详见 [07](./07-phasing-verification.md)）

- 后端单测：create(as_draft) 落 draft 不被 worker 捞；dispatch draft→pending；dispatch 非 draft→409；cancel draft→cancelled。
- migration 真 DB：CHECK 扩展后插入 draft 行成功；旧 6 值不受影响。
- e2e：三入口各建一草稿 → jobs 列表见草稿行 → 点运行 → 转 running → 正常完成；草稿点取消 → cancelled。
