# 量化模型训练前端视图

本目录承载量化模型训练 spec（`doc/specs/2026-05-17-quant-model-training`）所有 web 视图。

## 视图与路由

| 路由 | 视图文件 | 说明 |
|---|---|---|
| `/quant` | `QuantOverviewView.vue` | 总览：当日 Top-10 + 最近 14 次 OOS 趋势 + Critical 告警条 |
| `/quant/scores` | `QuantScoresView.vue` | 按日 ranked Top-K + 多模型对照 + 单股票评分时间序列 |
| `/quant/runs` | `QuantRunsView.vue` | 训练 run 分页列表；行点击 → `/quant/runs/:id` |
| `/quant/runs/:id` | `QuantRunDetailView.vue` | Run 详情：元数据 / 超参 / Fold / SHAP / 工件下载 |
| `/quant/jobs` | `QuantJobsView.vue` | `ml.jobs` 作业队列；运行中行嵌入 ProgressLine SSE |

`/quant/runs/:id` **不进**侧边栏菜单（由 `QuantRunsView` 行点击进入）；`/quant/jobs` 进侧边栏「量化 > 作业队列」子项。

## 跨页跳转

- **触发训练**：`QuantJobsView` 右上角「触发训练」打开 `QuantTrainTriggerModal`（位于 `components/quant/`）。提交成功后 `router.push({ name: 'quant-jobs', query: { highlight: jobId } })`，列表会高亮新提交的行。
- **看 run 详情**：`QuantRunsView` 行点击 → `router.push({ name: 'quant-run-detail', params: { id } })`。
- **返回**：详情页顶部「返回」按钮优先 `router.back()`，无历史时回退到 `quant-runs`。

## SSE 连接说明

**链路**：浏览器原生 `EventSource` 不带 `Authorization` header，不能直接走全局 `AuthGuard`。

1. 前端调 `POST /api/quant/jobs/:id/sse-token` 拿 5 分钟有效短期 token（受全局 AuthGuard）。
2. 用 `new EventSource('/api/quant/jobs/:id/stream?token=...')` 建连；NestJS `quant-jobs-sse.controller.ts` 用 `SseTokenGuard` 校验 token（spec `03-nestjs-vue.md §1`）。
3. SSE controller 建连瞬间先 `SELECT progress FROM ml.jobs` 推一条快照，避免 `LISTEN` 注册之前的进度被错过。
4. 终态（success / failed / blocked / cancelled）→ 服务端发 `complete` 事件后关流；客户端 `onmessage` 看到 progress 达 100 时回查一次拿 status。

**重连策略**（`components/quant/ProgressLine.vue`）：

- `onerror` 时若不是终态：等待 5 秒，最多重试 3 次；每次重连前先 `GET /quant/jobs/:id` 兜底拉当前 progress。
- **keep-alive**：被 `<keep-alive>` 缓存的父组件 → `onDeactivated` 关流、`onActivated` 重连。直接挂载（无 keep-alive）→ `onBeforeUnmount` 关流。

**伪代码**：

```
onMounted/onActivated/watch(jobId):
  token = await POST /quant/jobs/:id/sse-token
  es = new EventSource(`/quant/jobs/:id/stream?token=${token}`)
  es.onmessage = ev => update(progress, stage)
  es.onerror   = ev => { es.close(); setTimeout(reopen, 5s) }
onDeactivated/onBeforeUnmount: es?.close()
```

## ProgressLine 双模式

`components/quant/ProgressLine.vue` 同时支持：

- **受控模式**：父组件传 `progress` / `stage` / `state` props（兼容 M3 静态展示）。
- **SSE 模式**：父组件传 `jobId` props，组件内部自接管 token + EventSource + 重连 + 终态。

两模式互斥，jobId 优先；不混用，避免状态被覆盖。

## 单文件 ≤ 500 行 CI 校验

- 脚本：`apps/web/scripts/check-quant-vue-line-count.mjs`
- 命令：`pnpm --filter @cryptotrading/web lint:quant-lines`
- 扫描：`src/views/quant/**/*.vue` 与 `src/components/quant/**/*.vue`
- 阈值：单文件 > 500 行 → exit 1（含超标清单）

**接入 husky pre-commit**（手动）：

```sh
# apps/web/.husky/pre-commit （示例，按本仓库 husky 现状调整）
pnpm --filter @cryptotrading/web lint:quant-lines || exit 1
```

## QuantRunDetailView 拆分

`QuantRunDetailView` 拆 5 个子组件（满足 ≤ 500 行）：

| 子组件 | 路径 |
|---|---|
| `RunDetailHeader` | `components/quant/run-detail/RunDetailHeader.vue` |
| `OverallMetricsPanel` | `components/quant/run-detail/OverallMetricsPanel.vue` |
| `HyperparamsPanel` | `components/quant/run-detail/HyperparamsPanel.vue` |
| `FoldMetricsTable` | `components/quant/run-detail/FoldMetricsTable.vue` |
| `DownloadActions` | `components/quant/run-detail/DownloadActions.vue` |
| `ShapBarChart` | `components/quant/ShapBarChart.vue`（共用） |

## QuantTrainTriggerModal 字段

复用 `@/components/common/AppModal`，操作按钮统一放 `#actions` slot。

| run_type | 字段 |
|---|---|
| `train` | `feature_set_id`（必填） / `model`（lgb-lambdarank / linear / gbdt） / `walk_forward`（bool） / `seed`（可选 int） |
| `optuna` | `feature_set_id`（必填） / `n_trials`（默认 50） / `space`（默认 `lgb-4knobs`） |
| `seed_avg` | `model_version_base`（必填） / `seeds`（逗号分隔，默认 `42,43,44,45,46`） |

提交 payload 样例（`POST /api/quant/jobs`）：

```json
{
  "run_type": "train",
  "params": {
    "feature_set_id": "fs-v1-20260517",
    "model": "lgb-lambdarank",
    "walk_forward": true,
    "seed": 42
  },
  "priority": 100
}
```

### 端到端训练模式（train_e2e）—— 已废弃（2026-06-06）

`train_e2e` run_type 已随 spec 2026-06-06 废弃：dispatcher 路由已删、后端 `ALLOWED_RUN_TYPES` 不含它（`create-job.dto.spec.ts` 锁定拒绝新建），**不能再创建**。原"填一张表跑完 labels→features→train"的端到端流程，现拆为 **`prepare`（labels→features 增量串联备料，产出 `feature_set_id`）** + 上文 **`train`/`optuna`/`seed_avg`（消费现成 feature_set）**。

历史 `train_e2e` job（DB `ml.jobs` 里尚存若干条）仍可在作业列表展示、按 `train_e2e` 筛选，故 `JobRunType` 类型与作业筛选下拉**保留**该值（仅供历史展示/筛选，不是可新建项）。
