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

**端点**：`GET /money-flow/sync/run?start_date=YYYYMMDD&end_date=YYYYMMDD&syncMode=incremental|overwrite`（路径与 a-shares 对齐：`/sync/run`）

**响应**：`text/event-stream`，每条 `data: <json>\n\n`，事件类型由 JSON `type` 字段标识。

为复用前端已有的 `apps/web/src/composables/hooks/useSSE.ts` 基础设施（已识别 `progress`/`done`/`error` 三种事件），事件协议合并多余维度，直接对齐其字段：

```ts
export type MoneyFlowSyncEvent =
  | {
      type: 'progress';
      percent: number;        // 整体 0-100，后端计算
      phase: string;          // 如 "同步个股资金流" / "同步行业资金流" / "同步板块资金流" / "同步大盘资金流"
      current: number;        // 当前 phase 内已完成（含 skipped）
      total: number;          // 当前 phase 总数（filterMissingDates 后的 tradeDates 长度，全跳过仍计入）
      message: string;        // 当前 tradeDate 或 "重试中：YYYYMMDD（第 N/2 次）"
    }
  | {
      type: 'done';
      message: string;        // "同步完成" 或 "同步完成，N 个交易日失败"
      summary: MoneyFlowSyncSummary;
    }
  | {
      type: 'error';
      message: string;        // 流级错误（如鉴权失败、获取交易日列表失败）
    };

export interface MoneyFlowSyncSummary {
  stocks: MoneyFlowSyncResult;
  industries: MoneyFlowSyncResult;
  sectors: MoneyFlowSyncResult;
  market: MoneyFlowSyncResult;
}
```

**`percent` 计算公式**：
```
percent = ((已完成维度的 total 累加 + 当前维度内 current) / 4 维 total 累加) * 100
```
若某维度 `incremental` 模式下全部 `skipped`，仍计入分母（避免维度间切换导致进度跳动）；若全部 4 维均无待处理 tradeDate（4 维全跳过），分母兜底为 1，`percent` 直接置 100。

**重试与失败的表达**：
- 单 tradeDate 重试中：发 `progress` 事件，`current/total/percent` 不变，`message` 为「重试中：YYYYMMDD（第 N/2 次）」。
- 重试耗尽后视为该 tradeDate 失败：累加到该维度 `MoneyFlowSyncResult.errors`，`current` 推进 1（继续下一天）。
- 所有维度跑完后 `done.summary` 汇总 4 维 `errors`，前端按需渲染折叠列表。

## 6. 后端改动详情

### 6.1 `money-flow-sync.controller.ts`

- **删除** 4 个 `@Post('stocks'|'industries'|'sectors'|'market')` 处理器及对应方法。
- **保留** `@Post('members')`。
- **新增** `GET /money-flow/sync/run` SSE 端点（与 `a-shares.controller.ts:76-96` 同形）：
  ```ts
  @Get('run')
  @AdminOnly()
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  runSync(@Query() query: SyncFlowDto, @Res() res: Response) {
    res.flushHeaders();
    const subject = this.syncService.startSync(query);
    const subscription = subject.subscribe({
      next: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
      complete: () => res.end(),
      error: () => res.end(),
    });
    res.on('close', () => subscription.unsubscribe());
  }
  ```

> 选择沿用 a-shares 的 `Subject + res.write` 模式而非 `@Sse + Observable`，目的是与项目内现有 SSE 范式（a-shares、crypto sync）保持一致，便于运维与故障排查。

### 6.2 `money-flow-sync.service.ts`

**6.2.1 类型与重试工具**

在文件顶部声明事件类型（与 `packages/shared-types/src/money-flow.ts` 中导出的 `MoneyFlowSyncEvent` / `MoneyFlowSyncSummary` 保持字段一致；后端就地 import shared-types 即可）。

新增私有方法 `runWithRetry`（仅捕获异常并按 `[1000, 2000]` 退避重试，重试中通过 `emit` 推送 `progress` 事件携带「重试中…」message，但不变更 `current/total/percent`）：

```ts
private async runWithRetry<T>(
  fn: () => Promise<T>,
  onRetry: (attempt: number, err: unknown) => void,
): Promise<T> {
  const backoffs = [1000, 2000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (attempt < backoffs.length) {
        onRetry(attempt + 1, e);
        await new Promise(r => setTimeout(r, backoffs[attempt]));
      }
    }
  }
  throw lastErr;
}
```

**6.2.2 4 个 sync 方法签名扩展**

```ts
async syncStocks(
  dto: SyncFlowDto,
  ctx?: { phase: string; baseCurrent: number; total: number; grandTotal: number; emit: (e: MoneyFlowSyncEvent) => void },
): Promise<MoneyFlowSyncResult>
// industries / sectors / market 同理
```
- `ctx` 为可选，**不传则保持原有行为**（向后兼容，便于单测独立调用）。
- 内层 `for (const date of tradeDates)` 循环改为：
  ```ts
  for (let i = 0; i < tradeDates.length; i++) {
    const date = tradeDates[i];
    try {
      const rows = await this.runWithRetry(
        () => this.tushareClient.query(API_NAME, { start_date: date, end_date: date }, FIELDS),
        (attempt, err) => ctx?.emit({
          type: 'progress',
          phase: ctx.phase,
          current: ctx.baseCurrent + i,
          total: ctx.total,
          percent: pctOf(ctx.baseCurrent + i, ctx.grandTotal),
          message: `重试中：${date}（第 ${attempt}/2 次） ${truncate(String(err), 60)}`,
        }),
      );
      // ... 原有 rows → entities 累加逻辑保持不变 ...
    } catch (e) {
      errors.push(`[${date}] ${String(e)}`);
    }
    ctx?.emit({
      type: 'progress',
      phase: ctx.phase,
      current: ctx.baseCurrent + i + 1,
      total: ctx.total,
      percent: pctOf(ctx.baseCurrent + i + 1, ctx.grandTotal),
      message: date,
    });
  }
  ```
- 移除原本散落在 `tushareClient.query(...).catch(...)` 里的吞错逻辑（已由 `runWithRetry` 重试 + `try/catch` 累加 errors 替代）。
- `pctOf(c, g) = Math.round((c / Math.max(g, 1)) * 100)`。

**6.2.3 新增 `startSync(dto): Subject<MoneyFlowSyncEvent>`**

```ts
startSync(dto: SyncFlowDto): Subject<MoneyFlowSyncEvent> {
  const subject = new Subject<MoneyFlowSyncEvent>();
  setTimeout(async () => {
    try {
      const allTradeDates = await this.getTradeDates(dto);
      if (!allTradeDates.length) {
        subject.next({ type: 'error', message: '未获取到交易日列表' });
        subject.complete();
        return;
      }
      const dims = [
        { key: 'stocks',     label: '同步个股资金流', repo: this.stockRepo,    method: 'syncStocks' },
        { key: 'industries', label: '同步行业资金流', repo: this.industryRepo, method: 'syncIndustries' },
        { key: 'sectors',    label: '同步板块资金流', repo: this.sectorRepo,   method: 'syncSectors' },
        { key: 'market',     label: '同步大盘资金流', repo: this.marketRepo,   method: 'syncMarket' },
      ] as const;
      // 预计算每维 total
      const totals: number[] = [];
      for (const d of dims) {
        if (dto.syncMode === 'overwrite') totals.push(allTradeDates.length);
        else {
          const f = await this.filterExistingDates(d.repo as Repository<{ tradeDate: string }>, allTradeDates);
          totals.push(allTradeDates.length); // 保持分母含 skipped，避免维度切换百分比跳变
        }
      }
      const grandTotal = totals.reduce((a, b) => a + b, 0) || 1;
      const summary: Partial<MoneyFlowSyncSummary> = {};
      let baseCurrent = 0;
      for (let i = 0; i < dims.length; i++) {
        summary[dims[i].key] = await (this as any)[dims[i].method](dto, {
          phase: dims[i].label,
          baseCurrent,
          total: totals[i],
          grandTotal,
          emit: (e: MoneyFlowSyncEvent) => subject.next(e),
        });
        baseCurrent += totals[i];
      }
      const failedCount = Object.values(summary).reduce((n, r) => n + (r?.errors.length ?? 0), 0);
      subject.next({
        type: 'done',
        message: failedCount ? `同步完成，${failedCount} 个交易日失败` : '同步完成',
        summary: summary as MoneyFlowSyncSummary,
      });
      subject.complete();
    } catch (err) {
      subject.next({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      subject.complete();
    }
  }, 0);
  return subject;
}
```

**注**：`baseCurrent` 累加每维 `total`（含 skipped），即使维度内 `incremental` 跳过全部 tradeDate 也保持单调推进。`total = allTradeDates.length` 是有意为之，配合 `current` 在每个 tradeDate 末尾加 1（无论 success/skipped/failed），保证 `current` 单调到 `total` 而不超出。

### 6.3 现有 `industries`/`sectors` 内部 `memberResult` 逻辑保留不动；`logger.log` 保留。`syncMembers` 不接入进度（成员同步在 ths_member 接口内部循环 ts_code，与 tradeDate 进度模型不同），由日志兜底。

### 6.4 单一职责：`syncStocks/syncIndustries/syncSectors/syncMarket` 内部仍负责 tradeDate 列表获取与 `incremental` 过滤；`startSync` 仅做编排与 `total` 预计算。两者重复调用 `getTradeDates`/`filterExistingDates` 一次，单测独立可跑。性能损耗可接受（`getTradeDates` 是单次 Tushare 调用，`filterExistingDates` 是单次 SQL）。

## 7. 前端改动详情

### 7.1 `packages/shared-types/src/money-flow.ts`

新增 `MoneyFlowSyncEvent` 与 `MoneyFlowSyncSummary` 导出（见第 5 节），与后端 `money-flow-sync.service.ts` 共享。前后端 import 同一个类型源，单点维护。

### 7.2 `apps/web/src/api/modules/moneyFlow.ts`

- **删除** `syncStocks/syncIndustries/syncSectors/syncMarket` 4 个方法。
- **新增**：
  ```ts
  syncRunUrl: (params: MoneyFlowSyncParams) => {
    const qs = new URLSearchParams({
      start_date: params.start_date,
      end_date: params.end_date,
    })
    if (params.syncMode) qs.set('syncMode', params.syncMode)
    return `${API_BASE}/money-flow/sync/run?${qs}`
  },
  ```
- 在 `export type { ... }` 块中追加 `MoneyFlowSyncEvent`、`MoneyFlowSyncSummary` 转出。

### 7.3 `apps/web/src/components/sync/useMoneyFlowSync.ts`

复用现有 `useSSE()` composable（与 `useCryptoSync.ts` 同模式）：

```ts
const sse = useSSE()
const finished = ref<null | { summary: MoneyFlowSyncSummary; errors: Array<{ phase: string; error: string }> }>(null)

const syncProgressVisible = computed(() => sse.status.value !== 'idle' || finished.value !== null)

function openModal() {
  if (!syncDateRange.value) syncDateRange.value = buildDefaultDateRange()
  if (!syncing.value) { sse.reset(); finished.value = null }
  show.value = true
  void loadDateRange()
}

async function confirmSync() {
  if (!syncDateRange.value) return
  syncing.value = true
  finished.value = null
  await sse.start(
    moneyFlowApi.syncRunUrl({
      start_date: toYYYYMMDD(syncDateRange.value[0]),
      end_date:   toYYYYMMDD(syncDateRange.value[1]),
      syncMode:   syncMode.value,
    }),
    {
      method: 'GET',
      onDone: (data?: { summary?: MoneyFlowSyncSummary }) => {
        if (data?.summary) {
          const errs = Object.entries(data.summary).flatMap(([phase, r]) =>
            (r?.errors ?? []).map(error => ({ phase, error })),
          )
          finished.value = { summary: data.summary, errors: errs }
          if (errs.length) message.error(`同步完成，${errs.length} 个交易日失败`)
          else message.success('资金流向同步完成')
        }
        syncing.value = false
        void loadDateRange()
      },
      onError: (msg) => {
        message.error(msg)
        syncing.value = false
      },
    },
  )
}
```

- 不再导出 `lastResult`，由 `finished` 取代。
- 关闭 Modal（`show.value = false`）时由调用方触发；本 composable 只负责状态管理。
- `useSSE.start()` 内部使用 `fetch + ReadableStream` 而非原生 `EventSource`，自动携带 cookie，鉴权一致；事件 shape `{type:'progress', percent, phase, current, total, message}` 已与后端协议对齐。

### 7.4 新建 `apps/web/src/components/sync/MoneyFlowSyncProgress.vue`（约 90 行）

- props：
  ```ts
  defineProps<{
    visible: boolean
    sse: ReturnType<typeof useSSE>
    finished: { summary: MoneyFlowSyncSummary; errors: Array<{phase, error}> } | null
  }>()
  ```
- 模板结构：
  - 顶部：`n-progress`（line）+ phase + percent 行，参照 `ASharesSyncModal.vue:78-93` 与 `SyncView.vue:212-223` 的样式
  - 中部：`sse.message.value` 灰色小字（重试时显示「重试中：…」）
  - `finished` 非空时追加汇总区块：
    - 一行：`✓ 同步完成` + 4 列 `phase: 写入 X / 跳过 Y / 失败 Z`
    - `errors.length > 0` 时 `n-collapse` 折叠展示前 10 条 `[phase] error`，超过 10 条显示 `还有 N 条…`
- 样式延用 `.sync-progress-panel` 设计语言。

### 7.5 `DataSyncModal.vue`

- 新增 prop：`finished: boolean`（默认 `false`）。
- 渲染逻辑修改：
  - 当 `finished=true`：
    - 「取消」按钮 `v-if="!finished"` 隐藏；
    - 「确认同步」按钮文案改为「关闭」，`type="default"`、`:loading="false"`、`:disabled="false"`；点击触发 `emit('update:show', false)` 而非 `emit('confirm')`；
    - `mask-closable=true`、`closable=true`（覆盖 `!syncing` 默认值）。
- 现有 `:disabled="syncing"`、各表单 `:disabled="syncing"` 不动。

### 7.6 `SyncView.vue`

- 解构新增字段：
  ```ts
  const {
    show: moneyFlowShow, syncing: moneyFlowSyncing,
    syncMode: moneyFlowSyncMode, syncDateRange: moneyFlowSyncDateRange,
    dateRangeLabel: moneyFlowDateRangeLabel, dateRangeLoading: moneyFlowDateRangeLoading,
    canConfirm: moneyFlowCanConfirm,
    sse: moneyFlowSse,
    finished: moneyFlowFinished,
    syncProgressVisible: moneyFlowProgressVisible,
    openModal: openMoneyFlowModal, confirmSync: confirmMoneyFlowSync,
  } = useMoneyFlowSync(message)
  ```
- 资金流向 `<DataSyncModal>` 增加 `:finished="!!moneyFlowFinished"` 与 `<template #extra>`：
  ```vue
  <data-sync-modal ... :finished="!!moneyFlowFinished">
    <template #extra>
      <MoneyFlowSyncProgress
        :visible="moneyFlowProgressVisible"
        :sse="moneyFlowSse"
        :finished="moneyFlowFinished"
      />
    </template>
  </data-sync-modal>
  ```

## 8. 测试

### 8.1 后端单测（`money-flow-sync.service.spec.ts`）

- **重试成功**：mock `tushareClient.query` 第一次抛错后第二次成功，断言 `emit` 收到 1 个「重试中」`progress` 事件 + 1 个正常 `progress` 事件，最终 `errors` 为空。
- **重试耗尽**：mock `tushareClient.query` 连续 3 次抛错，断言 `MoneyFlowSyncResult.errors` 累计 1 条，`emit` 收到 2 个「重试中」`progress` 事件 + 1 个正常 `progress`（`current` 推进），**方法不抛异常**。
- **startSync 串行 + done summary**：mock 4 维各 2 个 tradeDate（每维 1 成功 1 失败 mock），断言：
  - 事件序列以 `progress(phase=同步个股资金流, current=1)` 开始，每个 tradeDate 对应一次 `current` 推进的 `progress`；
  - 每个 phase 切换时 `phase` 字段同步切换；
  - 最后一个事件为 `done`，其 `summary.stocks.errors.length === 1` ... 4 维同理；
  - `done.message === '同步完成，4 个交易日失败'`。

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
| SSE 在反向代理（Nginx）下被缓冲，进度不实时 | 现有 a-shares SSE 已在生产验证；控制器手写 `Cache-Control: no-cache`、`Connection: keep-alive` header（与 a-shares 一致） |
| 长连接超时（如反代默认 60s 空闲断开） | 每个 `progress` 事件即心跳；30 天范围下事件密度足够（每天 1 事件 × 4 维 ≥ 120 事件，间隔 < 1s） |
| 同步过程中浏览器 Tab 切到后台，EventSource 继续工作但 UI 不更新 | Naive UI/Vue 响应式自动恢复；无需特殊处理 |
| 旧 POST 接口删除后，若有未发现的外部脚本依赖 → 404 | 已 grep 确认仅本 Modal 调用；如需进一步保险可保留旧接口标 `@Deprecated` 一个版本 → **本设计采用 D2 直接删除**，由 PR review 兜底 |
