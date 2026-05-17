# NestJS / Vue 改动表面

> 本文档是 [00-index.md](00-index.md) 的子文档。M2（jobs controller）/ M3（读 controller + UI v1）/ M4（UI v2）的 agent 都需要本文档。

## 1 NestJS：`apps/server/src/modules/quant/`

```
modules/quant/
├─ quant.module.ts
├─ entities/
│   ├─ ml-job.entity.ts           @Entity({ schema: 'ml', name: 'jobs' })
│   ├─ ml-model-run.entity.ts     @Entity({ schema: 'ml', name: 'model_runs' })
│   ├─ ml-score-daily.entity.ts   @Entity({ schema: 'ml', name: 'scores_daily' })
│   └─ ml-quality-report.entity.ts
├─ dto/
│   ├─ create-job.dto.ts          run_type + params (class-validator)
│   ├─ score-query.dto.ts         trade_date / model_version / top_k
│   └─ run-query.dto.ts           pagination / model_version filter
├─ services/
│   ├─ quant-jobs.service.ts      insert job · query status · cancel
│   ├─ quant-scores.service.ts    scores_daily 只读
│   ├─ quant-runs.service.ts      model_runs 只读 + OOS metrics
│   └─ quant-quality.service.ts   quality_reports 只读
├─ controllers/
│   ├─ quant-jobs.controller.ts       POST /quant/jobs · GET /quant/jobs · GET /quant/jobs/:id
│   ├─ quant-scores.controller.ts     GET /quant/scores
│   ├─ quant-runs.controller.ts       GET /quant/runs · GET /quant/runs/:id
│   └─ quant-quality.controller.ts    GET /quant/quality/:date
└─ realtime/
    └─ quant-jobs.sse.ts          Server-Sent Events: 订阅 job 进度
```

**NestJS 规范遵循**（来自 CLAUDE.md）：
- `AuthGuard` 已全局注册，本 module controller **禁止**再加 `@UseGuards(AuthGuard)`
- 时间列一律 `timestamptz`；`scores_daily.trade_date` 用 `char(8)` 与 A 股规范一致
- `synchronize: false`；本 module 引入新表也走手写 SQL migration（与 [01-pg-schema.md](01-pg-schema.md) §6 同批）
- 动态 SQL 构建禁止把前端字段名拼入：scores / runs 的 filter / sort 必须经过 `FIELD_COL_MAP` 翻译，未命中 `logger.warn` + skip

**进度推送方案**：
- Python worker 在更新 `ml.jobs.progress` 后立即 `NOTIFY ml_job_progress, '<00-index §3 通信契约里的 payload>'`
- NestJS `quant-jobs.sse.ts` 用一个常驻 PG 连接 `LISTEN ml_job_progress`，把 NOTIFY payload 转发给当前订阅的 SSE 客户端
- SSE 建立连接的瞬间**先 SELECT 一次**当前 `ml.jobs.progress` 推给客户端（避免 LISTEN 之前的进度被错过）
- 不引入 WebSocket / 不引入消息队列，零额外组件

**SSE 鉴权方案**：浏览器原生 `EventSource` 不带 `Authorization` header，所以 `quant-jobs.sse.ts` 不能依赖全局 `AuthGuard`。方案：客户端先调 `POST /quant/jobs/:id/sse-token` 拿一个 5 分钟有效的短期 token（继承当前用户会话），再用 `EventSource('/quant/jobs/:id/stream?token=...')` 建连；SSE controller 单独的 `@SseTokenGuard` 校验该 token，不挂全局 `AuthGuard`。这是 CLAUDE.md "AuthGuard 全局注册" 的合法例外，需在 controller 上明确注释说明。

## 2 Vue：`apps/web/src/views/quant/`

```
views/quant/
├─ QuantOverviewView.vue       /quant         总览
├─ QuantScoresView.vue         /quant/scores  按日 ranked 列表
├─ QuantRunsView.vue           /quant/runs    训练 run 列表
├─ QuantRunDetailView.vue      /quant/runs/:id  含 SHAP / 下载 model.txt
├─ QuantJobsView.vue           /quant/jobs    作业队列
├─ QuantTrainTriggerModal.vue  触发训练弹窗 (复用 AppModal)
└─ components/
    ├─ ScoreTable.vue
    ├─ MetricBadge.vue
    ├─ ProgressLine.vue        订阅 SSE
    └─ ShapBarChart.vue
```

**Vue 规范遵循**（来自 CLAUDE.md）：
- Modal 统一复用 `AppModal`；按钮放 `#actions` slot，子组件不自带按钮
- 任何"切换回来需重拉数据"的逻辑放 `onActivated`，不放 `onMounted`（keep-alive 陷阱）
- 自定义 select option 接口 `extends SelectOption`，不重新声明 `label/value`
- 单文件 ≤ 500 行；`QuantRunDetailView` 必须拆 4-6 个子组件
- 日期选择器值（本地 ms）用 `getFullYear/getMonth/getDate` 提取，禁止 `getUTCxxx`

**Router**：`/quant` 加入 router 表，菜单一项「量化」。

## 3 各里程碑的 NestJS / Vue 切分

| 里程碑 | NestJS | Vue |
|---|---|---|
| M2 | jobs controller + SSE token endpoint；**不上** scores / runs / quality | — |
| M3 | scores / runs / quality 三只读 controller + service + FIELD_COL_MAP | Overview + Scores + Runs 三页 + ScoreTable / MetricBadge |
| M4 | （无新增 controller，仅完善 SSE 链路） | RunDetail + Jobs + TrainTriggerModal + ProgressLine + ShapBarChart |
