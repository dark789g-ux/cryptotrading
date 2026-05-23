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

### 端到端训练模式（train_e2e）

新建训练作业时，默认走"端到端"模式 —— 填一张表后，worker 自动按顺序跑：
1. **labels build**（进度 0-30%）
2. **features build**（进度 30-60%）→ 产出 `feature_set_id`
3. **train**（进度 60-100%）

切换到"使用现有 feature_set"可走老路径（直接指定 `feature_set_id`）。

字段表（端到端模式）：

| 字段 | 控件 | 说明 |
|---|---|---|
| `factor_version` | `n-input` | 纯文本，必填（D-10，仓库无 `GET /factor-versions` 接口） |
| `label_scheme` | `n-select` | `strategy-aware` / `fwd_5d_ret`（D-1：fwd_5d_ret 也加新股过滤） |
| `new_listing_min_days` | `n-input-number` | 0-250，clearable；留空 = 走后端默认 60 |
| `date_range` | `n-date-picker daterange` | 本地午夜 ms；提取 YYYYMMDD 用 `getFullYear/getMonth/getDate`（CLAUDE.md 硬约束） |
| `model` | `n-select` | `lgb-lambdarank` / `linear` / `gbdt` |
| `walk_forward` | `n-switch` | 默认 true |
| `seed` | `n-input-number` | clearable；留空 → 默认 42 |

子组件位于 `components/quant/train-modal/TrainE2EFields.vue`（D-19 预拆，便于隔离测试）；
参数装配工具位于 `components/quant/train-modal/buildParams.ts`，单测 `__tests__/QuantTrainTriggerModal.spec.ts` 覆盖：默认端到端、mode 切换、必填校验、buildParams 输出、`formatDateRange` 本地午夜不漂移。

注意：
- 端到端模式预计 20-40 分钟，期间其他 pending 作业会排队（D-5、D-20 toast 提示）
- `new_listing_min_days` 默认 60（交易日），0 等价不过滤
- 元信息（`factor_version` / `label_scheme` / `new_listing_min_days`）写入 `ml.model_runs.hyperparams` 便于审计（D-14）
- `HyperparamsPanel` 零修改（D-21），自动遍历 `hyperparams` 对象渲染所有 key，新跑的 train_e2e 自然多出三行

提交 payload 样例（端到端）：

```json
{
  "run_type": "train_e2e",
  "params": {
    "factor_version": "v1",
    "label_scheme": "strategy-aware",
    "new_listing_min_days": 60,
    "date_range": "20260509:20260511",
    "model": "lgb-lambdarank",
    "walk_forward": true,
    "seed": 42
  },
  "priority": 100
}
```
