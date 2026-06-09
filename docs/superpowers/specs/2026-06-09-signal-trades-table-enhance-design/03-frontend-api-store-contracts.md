# 03 · 前端 F3：API/store 契约（先行）

← [02](./02-backend-trades-sort-filter.md) ｜ [index](./index.md) ｜ 下一篇 [04](./04-frontend-trades-panel.md)

## 目标

定义 F1/F2 共同依赖的前端契约：A 股日 K 取数加日期窗口、trades 列表加排序/筛选参数与 `name` 字段。**此文件先实现**，F1/F2 据此并行。

## 现状（file:line）

- `api/modules/market/aShares.ts:143` `getKlines(tsCode, limit=300, priceMode='qfq')` → 拼 `?limit&priceMode`。
- `api/modules/strategy/signalStats.ts:131` `listTrades(runId, page=1, pageSize=50)` → 拼 `?page&pageSize`，返回 `TradesPage{items,total}`。
- `SignalTestTrade`（`signalStats.ts:78`）字段：`id/runId/tsCode/signalDate/buyDate/exitDate/buyPrice/exitPrice/ret/holdDays/exitReason`。
- store `stores/signalStats.ts:118` `fetchTrades(runId, page, pageSize)` → `tradesMap.set(runId, data)`（按 runId 覆写，无缓存守卫；**仅 `SignalStatsResult.vue:277` 读 `tradesMap`**）。

## 改动 1：aShares.getKlines 加日期窗口

```ts
getKlines: (
  tsCode: string,
  limit = 300,
  priceMode: ASharePriceMode = 'qfq',
  range?: { startDate?: string; endDate?: string },   // 新增，YYYYMMDD
) => {
  const qs = new URLSearchParams()
  qs.set('limit', String(limit))
  qs.set('priceMode', priceMode)
  if (range?.startDate) qs.set('startDate', range.startDate)
  if (range?.endDate)   qs.set('endDate', range.endDate)
  return request<AShareKlineBar[]>(`${API_BASE}/a-shares/${encodeURIComponent(tsCode)}/klines?${qs}`)
}
```

- 位置参数向后兼容：现有 `getKlines(tsCode, limit, priceMode)` 调用方不变。

## 改动 2：SignalTestTrade 加 name

```ts
export interface SignalTestTrade {
  // ...现有字段...
  name: string | null        // 新增：标的名称（后端响应期注入，可能为 null）
}
```

## 改动 3：listTrades 加排序/筛选参数

引入参数对象（避免长位置参数列表）：

```ts
export interface ListTradesParams {
  page?: number
  pageSize?: number
  sortField?: 'tsCode'|'signalDate'|'buyDate'|'exitDate'|'buyPrice'|'exitPrice'|'ret'|'holdDays'|'exitReason'
  sortOrder?: 'asc'|'desc'
  tsCode?: string
  exitReason?: SignalTestTrade['exitReason']
  retMin?: number          // 小数（前端已把百分比 ÷100）
  retMax?: number
  holdDaysMin?: number
  holdDaysMax?: number
}

listTrades(runId: string, params: ListTradesParams = {}) {
  const qs = new URLSearchParams()
  qs.set('page', String(params.page ?? 1))
  qs.set('pageSize', String(params.pageSize ?? 50))
  if (params.sortField) { qs.set('sortField', params.sortField); qs.set('sortOrder', params.sortOrder ?? 'asc') }
  if (params.tsCode)      qs.set('tsCode', params.tsCode)
  if (params.exitReason)  qs.set('exitReason', params.exitReason)
  if (params.retMin != null)       qs.set('retMin', String(params.retMin))
  if (params.retMax != null)       qs.set('retMax', String(params.retMax))
  if (params.holdDaysMin != null)  qs.set('holdDaysMin', String(params.holdDaysMin))
  if (params.holdDaysMax != null)  qs.set('holdDaysMax', String(params.holdDaysMax))
  return request<TradesPage>(`${API_BASE}/signal-tests/runs/${runId}/trades?${qs}`)
}
```

- 空字符串/`null`/`undefined` 一律不进 query（避免后端把空串当筛选）。

## 改动 4：store.fetchTrades 扩参 + 移除死缓存

```ts
async function fetchTrades(runId: string, params: ListTradesParams = {}) {
  return signalStatsApi.listTrades(runId, params)   // 直接 return，由调用方持有
}
```

- **移除 `tradesMap`**（重构后无读者：F2 面板改为本地 ref 持有 trades；竞态防护见 [04](./04-frontend-trades-panel.md#竞态与状态)）。实现时全局 grep `tradesMap` 确认仅 `SignalStatsResult.vue` 旧逻辑引用，随 F2 一并删除。
- 若担心一步到位风险：可保留 `tradesMap` 不读（死字段），但本设计倾向删除以免误导性缓存（与摸底结论一致）。

## 验证

- `pnpm --filter @cryptotrading/web type-check` 通过（契约类型自洽）。
- 不单独跑页面（无 UI 改动）；随 F1/F2 一起 `vite build` + 真机验证。

## 文件清单

- `apps/web/src/api/modules/market/aShares.ts`
- `apps/web/src/api/modules/strategy/signalStats.ts`
- `apps/web/src/stores/signalStats.ts`
