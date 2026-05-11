# 行业/概念目录同步：卡片进度展示

日期：2026-05-11
范围：`apps/server` IndexCatalogSyncService + `apps/web` SyncView Card 4

## 问题

`SyncView.vue` Card 4「行业/概念目录与成分股」在同步期间进度条长时间卡住不动：

- 后端 `IndexCatalogSyncService.startSync` 划分了 5 个 stage（20% / 40% / 60% / 80% / 100%）
- Stage 3「同步行业成分股」和 Stage 4「同步概念成分股」内部对每个 `ts_code` 调用一次 `ths_member`，循环可能持续数十秒到数分钟，但**整个循环期间只发了 1 次 start、1 次 end 事件**
- 用户观察到的现象：进度条停在 40% / 60% 不动，无任何文本反馈，看起来像卡死

同时，Card 4 当前 inline 的进度/summary 展示比 `MoneyFlowSyncProgress.vue` 简陋（无 current/total、无失败明细折叠），与同页面其他卡片不一致。

## 方案

A. 后端在 Stage 3/4 的 `ts_code` 循环内**逐条发 progress 事件**；
B. 前端抽出 `IndexCatalogSyncProgress.vue`，结构与 `MoneyFlowSyncProgress.vue` 同构，替换 Card 4 的 inline 进度块。

事件协议（`MoneyFlowSyncEvent` shape）不变，仅事件频率提升。

## 后端改动

文件：`apps/server/src/market-data/index-catalog/index-catalog-sync.service.ts`

### `syncMembers` 增加可选 progress 推送参数

```ts
async syncMembers(
  type: 'I' | 'N',
  opts?: {
    subject: Subject<MoneyFlowSyncEvent>
    phase: string
    percentFrom: number
    percentTo: number
  },
): Promise<MoneyFlowSyncResult>
```

循环每完成一个 `ts_code`（无论成功或失败）后发一次：

```ts
const done = i + 1
const percent = percentFrom + (percentTo - percentFrom) * (done / tsCodes.length)
opts?.subject.next({
  type: 'progress',
  phase: opts.phase,
  current: done,
  total: tsCodes.length,
  percent,
  message: `${tsCode}（成功 ${success} / 失败 ${errors.length}）`,
})
```

不带 `opts` 时行为与现状一致（用于单元测试或未来非 SSE 调用方）。

### `startSync` 调用点

- Stage 3：`syncMembers('I', { subject, phase: '同步行业成分股', percentFrom: 40, percentTo: 60 })`
- Stage 4：`syncMembers('N', { subject, phase: '同步概念成分股', percentFrom: 60, percentTo: 80 })`

调用前的「开始」事件保留（`current: 0, total: 1, percent: 40/60, message: '开始'`），用于在 ts_code 列表为空时仍能切换 phase 标签；调用后的「结束」事件可以删除（最后一轮循环已经把 percent 推到 percentTo）。

Stage 1/2/5 保持现状，不细化。

### 事件频率评估

行业指数约 100 条、概念指数约 300 条 → 单次同步新增约 400 条事件，按当前 SSE 写入策略（每事件 1 行 JSON）不会有性能问题。

## 前端改动

### 新文件 `apps/web/src/components/sync/IndexCatalogSyncProgress.vue`

与 `MoneyFlowSyncProgress.vue` 同构。Props：

```ts
{
  visible: boolean
  sse: ReturnType<typeof useSSE>
  finished: { summary: IndexCatalogSyncSummary; errors: Array<{ phase: string; error: string }> } | null
}
```

布局四块：

1. **head**：左侧 `finished ? '同步完成' : sse.phase.value || '准备中'`，右侧 `${percent}%`
2. **n-progress**：`status` 取 error/success/default
3. **meta**：左侧 `${current} / ${total}`（仅当 total>0），右侧 `sse.message.value`
4. **summary**（仅 finished）：5 个 chip，对应 `industryCatalog / conceptCatalog / industryMembers / conceptMembers / cleanup`，每项展示「写入 X / 失败 Y」（不展示 skipped，目录同步无跳过语义）
5. **errors collapse**（仅 finished.errors.length > 0）：复用 mfsp 的折叠列表样式

CSS class 前缀使用 `icsp-`，复制 mfsp 的样式而非共享，保持两个卡片独立演进。

### `apps/web/src/views/sync/SyncView.vue`

删除 Card 4 内 153-177 行的 inline 进度块和 summary 块，替换为：

```vue
<IndexCatalogSyncProgress
  :visible="indexCatalogProgressVisible"
  :sse="indexCatalogSse"
  :finished="indexCatalogFinished"
/>
```

保留「准备中」提示（`v-if="!indexCatalogProgressVisible && !indexCatalogFinished"` 的 `source-note`）。

`useIndexCatalogSync` 无需调整（已暴露 `sse` / `finished` / `syncProgressVisible`）。

## 测试

### 后端

文件：`apps/server/src/market-data/index-catalog/index-catalog-sync.service.spec.ts`

新增用例：

- mock `tushareClient.query` 让 `ths_index type=I` 返回 N=3 条目录，`ths_member` 每次返回若干条成员
- 订阅 `startSync()` 返回的 Subject，收集所有 `progress` 事件
- 断言：
  1. Stage 3 收到至少 N 条 `phase='同步行业成分股'` 的 progress 事件
  2. 这些事件的 `current` 单调递增到 N，`total === N`
  3. percent 单调递增，首条 ≥ 40，末条 = 60（或在 `[40, 60]` 闭区间内）
  4. Stage 4 同理覆盖 `[60, 80]`

### 前端

`IndexCatalogSyncProgress.vue` 加最小 DOM 快照测试：visible=true & finished=null（同步中态）、finished 有 summary 且 errors=[]（完成态）、finished.errors.length>0（错误展开态）。

## 不做的事

- 不为 Stage 1/2/5 细化进度（每个只有一次 API 调用）
- 不引入心跳事件（按 ts_code 频率已足以保活 SSE）
- 不合并 mfsp / icsp 的 CSS
- 不改 `MoneyFlowSyncEvent` 协议
- 不重命名 `MoneyFlowSyncEvent` 即便它现在被指数目录复用（跨域命名优化不在本次范围）
