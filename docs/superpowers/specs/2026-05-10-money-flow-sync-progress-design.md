# 资金流向同步进度可视化 设计文档

- 日期：2026-05-10
- 模块：`apps/web/src/components/sync/*`、`apps/server/src/market-data/money-flow/*`
- 目标：在「同步资金流向数据」Modal 中实时展示同步进度，替代当前点击后只显示按钮 loading 的体验。

## 1. 背景与现状

- 入口：`SyncView.vue` → `DataSyncModal.vue`（通用） → `useMoneyFlowSync.ts`（业务逻辑）。
- 现状：`confirmSync()` 通过 `Promise.all` 并行调用 4 个 REST 接口（`POST /money-flow/sync/{stocks,industries,sectors,market}`），整个流程对用户表现为按钮 loading + Modal 关闭后 toast，无中间反馈。
- 后端每个接口循环多个 `tradeDate` 调用 Tushare，30 天范围会产生 100+ 次外部调用，可能耗时数十秒到数分钟。
- 项目中已有 SSE 进度可视化范式：`apps/server/src/market-data/a-shares/a-shares.controller.ts` + `apps/web/src/components/symbols/a-shares/ASharesSyncModal.vue`（`text/event-stream` + `EventSource` + `n-progress`）。
- `DataSyncModal.vue` 已预留 `<slot name="extra" />`，可挂载进度面板而无需改动通用 Modal 主体。

## 2. 范围

**包含**：
- 后端：删除 4 个 POST 同步接口，新增 1 个 SSE 端点；4 个 service 方法接受可选 `onProgress` 回调；新增 tradeDate 级重试。
- 前端：`useMoneyFlowSync.ts` 改为 EventSource 驱动；新建 `MoneyFlowSyncProgress.vue` 进度面板；`DataSyncModal.vue` 新增 `finished` prop 控制按钮文案。

**不包含**：
- `members` 同步接口（与本次需求无关，保留不动）。
- A 股同步、加密货币同步等其他模块（已有自己的进度方案）。
- 取消同步功能（用户中途无法取消，因 `mask-closable` 已禁用）。

## 3. 决策摘要

| 决策点 | 选择 | 备选与理由 |
|---|---|---|
| 进度粒度 | 交易日级 SSE | 维度级跳跃式无法反映真实进度；30 天 × 4 维需要细粒度。 |
| 维度编排 | 单 SSE 端点 + 串行 4 维 | 并行会触发 Tushare 限频；串行 UI 最简洁。 |
| 旧接口处理 | 删除 4 个 POST | 唯一调用方是本 Modal，无外部依赖。 |
| 错误处理 | 单日失败重试 2 次后累加到 errors，继续下一天 | 大部分错误为 Tushare 限频/网络抖动，单点失败不应中断整体。 |
| 重试策略 | 单 tradeDate 重试 2 次，退避 1s/2s | Tushare 限频经验值；继续放大收益递减。 |
| 重试可见性 | SSE 推送 `retry` 事件，前端展示灰色小字 | 让用户感知系统在工作而非卡死。 |
| 完成行为 | Modal 不自动关闭，展示汇总+错误列表，按钮变「关闭」 | SSE 进度刚跑完立即关闭体验割裂。 |

## 4. 架构

```
[Modal]
  ├─ DataSyncModal.vue (通用)
  │    └─ <slot name="extra"/>
  │         └─ MoneyFlowSyncProgress.vue (新增)
  │              ├─ n-progress (overall percent)
  │              ├─ phase 文字
  │              ├─ retry 灰色小字
  │              └─ 完成后：汇总 + 折叠错误列表
  │
  └─ useMoneyFlowSync.ts
       └─ EventSource(GET /money-flow/sync/stream?...)
            │
            └─> MoneyFlowSyncController.streamSync()
                 │  Observable<MessageEvent>
                 └─> MoneyFlowSyncService.runStream(dto)
                      │
                      └─ for dim of [stocks, industries, sectors, market]:
                           └─ syncDim(dto, onProgress)
                                └─ for date of tradeDates:
                                     ├─ retryWithBackoff(() => fetchAndUpsert(date), 2, [1000, 2000])
                                     │    └─ on attempt fail: onProgress({type:'retry'})
                                     ├─ on final success: onProgress({type:'progress'})
                                     └─ on retries exhausted: 累积 errors + onProgress({type:'error'})
```

## 5. SSE 事件协议

**端点**：`GET /money-flow/sync/stream?start_date=YYYYMMDD&end_date=YYYYMMDD&syncMode=incremental|overwrite`

**响应**：`text/event-stream`，每条 `data: <json>\n\n`，事件类型由 JSON `type` 字段标识。

```ts
type SyncEvent =
  | {
      type: 'phase';
      dimension: 'stocks' | 'industries' | 'sectors' | 'market';
      totalInDim: number;          // 该维度需处理的 tradeDate 数（含已跳过的不计入）
    }
  | {
      type: 'progress';
      dimension: 'stocks' | 'industries' | 'sectors' | 'market';
      date: string;                // YYYYMMDD
      currentInDim: number;        // 该维度内已完成（含 skipped 与 success）
      totalInDim: number;
      overallPct: number;          // 0~100，由后端计算
    }
  | {
      type: 'retry';
      dimension; date: string;
      attempt: 1 | 2;              // 第几次重试
      error: string;
    }
  | {
      type: 'error';               // 重试耗尽后才推送
      dimension; date: string;
      error: string;
    }
  | {
      type: 'done';
      summary: {
        stocks: MoneyFlowSyncResult;
        industries: MoneyFlowSyncResult;
        sectors: MoneyFlowSyncResult;
        market: MoneyFlowSyncResult;
      };
    };
```

**`overallPct` 计算公式**：
```
overallPct = ((已完成维度的 totalInDim 累加 + 当前维度内 currentInDim) / 4 维 totalInDim 累加) * 100
```
若某维度 `incremental` 模式下全部 `skipped`，仍计入总数（避免分母变化导致进度回退）。

## 6. 后端改动详情

### 6.1 `money-flow-sync.controller.ts`

- **删除** 4 个 `@Post('stocks'|'industries'|'sectors'|'market')` 处理器及对应方法。
- **保留** `@Post('members')`。
- **新增**：
  ```ts
  @Sse('stream')
  @AdminOnly()
  streamSync(@Query() dto: SyncFlowDto): Observable<MessageEvent> {
    return this.syncService.runStream(dto);
  }
  ```

> 注：`@nestjs/common` 的 `@Sse()` 装饰器自动设置 `Content-Type: text/event-stream`，无需手写 `@Header(...)`；`a-shares.controller.ts` 是裸 `@Header` + `Response.write` 写法，本设计采用 `@Sse + Observable` 更符合 Nest 范式。

### 6.2 `money-flow-sync.service.ts`

**6.2.1 重试工具（私有方法）**
```ts
private async retryWithBackoff<T>(
  fn: () => Promise<T>,
  ctx: { dimension; date: string },
  onProgress?: (e: SyncEvent) => void,
): Promise<T> {
  const backoffs = [1000, 2000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (attempt < backoffs.length) {
        onProgress?.({ type: 'retry', ...ctx, attempt: attempt + 1, error: String(e) });
        await new Promise(r => setTimeout(r, backoffs[attempt]));
      }
    }
  }
  throw lastErr;
}
```

**6.2.2 4 个 sync 方法签名扩展**
```ts
async syncStocks(dto: SyncFlowDto, onProgress?: (e: SyncEvent) => void): Promise<MoneyFlowSyncResult>
// industries / sectors / market 同理
```
- 内层 `for (const date of tradeDates)` 循环里：
  - 用 `retryWithBackoff` 包裹原本的 fetch+upsert 逻辑；
  - 成功后 emit 「内部 progress 事件」（不含 `overallPct`）：`onProgress?.({type:'progress', dimension, date, currentInDim: i+1, totalInDim})`；
  - 重试耗尽后 `errors.push(...)` + `onProgress?.({type:'error', ...})`，**不抛出**。
- `overallPct` 字段由 `runStream` 在 wrapper 中拦截 `progress` 事件后注入（参见 6.2.3）。inner 方法签名上 `onProgress` 接受的 `progress` 事件**不含** `overallPct`，对外暴露的 `SyncEvent`（第 5 节）才是带 `overallPct` 的最终形态。
- 为避免 `computeTotalsPerDim` 与各 sync 方法内部 `filterMissingDates` 重复查询，可将 totals 计算与 dates 列表透传到 sync 方法：sync 方法新增可选参数 `precomputedDates?: string[]`，存在时跳过内部 `filterMissingDates`。具体由实施 plan 决定。

**6.2.3 新增 `runStream(dto): Observable<MessageEvent>`**
```ts
runStream(dto: SyncFlowDto): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    (async () => {
      const summary = {} as Record<string, MoneyFlowSyncResult>;
      const dims = ['stocks','industries','sectors','market'] as const;
      const totals = await this.computeTotalsPerDim(dto, dims); // 预计算 4 维 totalInDim
      const grandTotal = totals.reduce((a,b) => a+b, 0) || 1;
      let completed = 0;

      for (const [i, dim] of dims.entries()) {
        subscriber.next({ data: JSON.stringify({ type:'phase', dimension: dim, totalInDim: totals[i] }) });
        const onProgress = (e: SyncEvent) => {
          if (e.type === 'progress') {
            const overallPct = Math.round(((completed + e.currentInDim) / grandTotal) * 100);
            subscriber.next({ data: JSON.stringify({ ...e, overallPct }) });
          } else {
            subscriber.next({ data: JSON.stringify(e) });
          }
        };
        summary[dim] = await this[`sync${capitalize(dim)}`](dto, onProgress);
        completed += totals[i];
      }
      subscriber.next({ data: JSON.stringify({ type:'done', summary }) });
      subscriber.complete();
    })().catch((e) => subscriber.error(e));
  });
}
```

**6.2.4 `computeTotalsPerDim`**：在不实际拉取数据的前提下，复用现有 `filterMissingDates` 逻辑算出每个维度的 `tradeDates.length`。`overwrite` 模式下 = 全部交易日数；`incremental` 模式下 = 缺失日数。

### 6.3 现有 `industries`/`sectors` 内部 `memberResult` 逻辑保留不动；`logger.log` 保留。

## 7. 前端改动详情

### 7.1 `apps/web/src/api/modules/moneyFlow.ts`

- **删除** `syncStocks/syncIndustries/syncSectors/syncMarket` 4 个方法。
- **新增**：
  ```ts
  buildSyncStreamUrl: (params: MoneyFlowSyncParams) =>
    `${API_BASE}/money-flow/sync/stream?${new URLSearchParams({
      start_date: params.start_date,
      end_date: params.end_date,
      syncMode: params.syncMode,
    })}`,
  ```
- 导出 `SyncEvent` 类型：前端在 `apps/web/src/api/modules/moneyFlow.ts` 中就地定义（项目当前无 shared types 包），后端在 `money-flow-sync.service.ts` 中独立定义同名类型，两边手动保持一致；如未来 PR 引入 shared types 包再统一收敛。

### 7.2 `apps/web/src/components/sync/useMoneyFlowSync.ts`

```ts
const progress = ref({ percent: 0, phase: '', subText: '' })
const finished = ref<null | { summary: MoneyFlowSyncSummary; errors: ErrorItem[] }>(null)
const errors = ref<ErrorItem[]>([])
let es: EventSource | null = null

async function confirmSync() {
  if (!syncDateRange.value) return
  syncing.value = true
  finished.value = null
  errors.value = []
  progress.value = { percent: 0, phase: '准备中', subText: '' }

  const url = moneyFlowApi.buildSyncStreamUrl({...})
  es = new EventSource(url, { withCredentials: true })

  es.onmessage = (ev) => {
    const e: SyncEvent = JSON.parse(ev.data)
    handleEvent(e)
  }
  es.onerror = () => {
    message.error('同步连接中断')
    syncing.value = false
    es?.close()
  }
}

function handleEvent(e: SyncEvent) {
  switch (e.type) {
    case 'phase':
      progress.value.phase = phaseLabel(e.dimension)
      progress.value.subText = ''
      break
    case 'progress':
      progress.value.percent = e.overallPct
      progress.value.subText = `${e.dimension} ${e.date} (${e.currentInDim}/${e.totalInDim})`
      break
    case 'retry':
      progress.value.subText = `重试中：${e.dimension} ${e.date}（第 ${e.attempt}/2 次）`
      break
    case 'error':
      errors.value.push({ dimension: e.dimension, date: e.date, error: e.error })
      break
    case 'done':
      progress.value.percent = 100
      progress.value.phase = '完成'
      finished.value = { summary: e.summary, errors: errors.value }
      syncing.value = false
      es?.close()
      void loadDateRange()
      break
  }
}

function closeModal() {
  show.value = false
  es?.close()
  es = null
  finished.value = null
}
```

- 移除原本的 `Promise.all` + `lastResult` 实现。
- `closeModal` 暴露给 `DataSyncModal` 的 `update:show=false` 路径。

### 7.3 新建 `apps/web/src/components/sync/MoneyFlowSyncProgress.vue`（约 80 行）

- props：`progress: { percent, phase, subText }`、`finished: { summary, errors } | null`
- 模板结构：
  - 进行中：`n-progress` + `.progress-head`（phase + percent）+ `.progress-sub`（subText）
  - 完成后：进度条变绿；显示「写入 X / 跳过 Y / 失败 Z」；如 `errors.length > 0`，`n-collapse` 折叠展示前 10 条
- 样式参考 `ASharesSyncModal.vue` 的 `.sync-progress-panel`。

### 7.4 `DataSyncModal.vue`

- 新增 prop：`finished: boolean`（默认 `false`）。
- 当 `finished=true`：
  - 「确认同步」按钮文案改为「关闭」，`type="default"`；
  - 点击改为 emit `update:show=false` 而非 `confirm`；
  - 「取消」按钮隐藏；
  - `mask-closable=true`，`closable=true`。
- `:disabled="syncing"` 等现有逻辑不动。

### 7.5 `SyncView.vue`

- 在 `<DataSyncModal>` 内插入：
  ```vue
  <template #extra>
    <MoneyFlowSyncProgress
      v-if="moneyFlowSyncing || moneyFlowFinished"
      :progress="moneyFlowProgress"
      :finished="moneyFlowFinished"
    />
  </template>
  ```
- 把 `useMoneyFlowSync` 暴露的 `progress`、`finished` 解构出来传入。

## 8. 测试

### 8.1 后端单测（`money-flow-sync.service.spec.ts`）

- **重试成功**：mock Tushare 失败 1 次后成功，断言 `onProgress` 被推送 1 个 `retry` + 1 个 `progress` 事件，最终 `errors` 为空。
- **重试耗尽**：mock Tushare 连续失败 3 次，断言累积到 `errors` 且 `onProgress` 推送 2 个 `retry` + 1 个 `error` 事件，**方法不抛异常**。
- **runStream 串行**：mock 4 个维度各 2 个 tradeDate，断言 SSE 事件序列为 `phase(stocks) → progress×2 → phase(industries) → progress×2 → ... → done`。

### 8.2 前端

- 暂不写单测（EventSource mock 复杂度高，对齐 ASharesSyncModal 现状）。

### 8.3 手动验收清单

1. 30 天范围 `incremental` 模式同步：进度条平滑增长 0→100%，phase 依次切换 4 个维度。
2. 30 天范围 `overwrite` 模式同步：同上，且总耗时显著长于 `incremental`。
3. 模拟 Tushare 限流（暂时改写 service mock 抛错）：能看到「重试中：xxx 第 1/2 次」灰色小字，最终成功。
4. 模拟单日彻底失败：完成后错误列表展开能看到该日条目，`success/skipped/failed` 计数正确。
5. 完成后 Modal 不自动关闭；点击「关闭」按钮正常关闭；再次打开 Modal 进度面板不残留旧状态。
6. 同步进行中点击 Modal 遮罩与右上角 X：均无响应（`mask-closable=false`、`closable=false`）。

## 9. 删除清单

- 后端 `money-flow-sync.controller.ts` 的 `syncStocks/syncIndustries/syncSectors/syncMarket` 4 个 `@Post` 处理器。
- 前端 `apps/web/src/api/modules/moneyFlow.ts` 的 4 个 `sync*` 方法。
- `useMoneyFlowSync.ts` 中 `Promise.all` 实现及 `lastResult` 字段（被 `finished` 取代）。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| EventSource 在反向代理（Nginx）下被缓冲，进度不实时 | 现有 a-shares SSE 已在生产验证；保留 `Cache-Control: no-cache` 与 `X-Accel-Buffering: no` header（`@Sse` 默认包含） |
| 长连接超时（如反代默认 60s 空闲断开） | 每个 `progress` 事件即心跳；30 天范围下事件密度足够（每天 1 事件 × 4 维 ≥ 120 事件，间隔 < 1s） |
| 同步过程中浏览器 Tab 切到后台，EventSource 继续工作但 UI 不更新 | Naive UI/Vue 响应式自动恢复；无需特殊处理 |
| 旧 POST 接口删除后，若有未发现的外部脚本依赖 → 404 | 已 grep 确认仅本 Modal 调用；如需进一步保险可保留旧接口标 `@Deprecated` 一个版本 → **本设计采用 D2 直接删除**，由 PR review 兜底 |
