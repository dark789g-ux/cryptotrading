# 06 · 前端（UsIndexPanel 接 AMV 副图）

> 渲染层（`KlineChart` / `subplotConfig` / `klineChartOptions` / `mergeAmv`）**零改** —— `0AMV`/`0AMV_MACD`
> 副图键与渲染已完整实现（已核验）。只需新增 api client + 改 `UsIndexPanel.vue` 两处。合并前必跑
> `pnpm --filter @cryptotrading/web build`（vite，type-check 查不出 SFC 编译错）；单文件 ≤500 行；
> 注释勿含 `*/` token（`reference_vue_comment_star_slash_trap`）。

## 1. 新建 `api/modules/market/usIndexAmv.ts`

照 [usIndexDaily.ts:21-36] 模式：
```ts
export const usIndexAmvApi = {
  query: (params: { index_code: string; start_date: string; end_date: string }) =>
    request<AmvSeriesRow[]>(
      `${API_BASE}/us-index-amv?index_code=${encodeURIComponent(params.index_code)}` +
      `&start_date=${params.start_date}&end_date=${params.end_date}`,
    ),
  getDateRange: (index_code: string) =>
    request<{ start: string | null; end: string | null }>(
      `${API_BASE}/us-index-amv/date-range?index_code=${encodeURIComponent(index_code)}`,
    ),
  triggerSync: (body: { dateRange?: [string, string]; symbols?: string[] } = {}) =>
    post<{ jobId: string }>(`${API_BASE}/us-index-amv/sync`, body),
}
```
- 复用 `AmvSeriesRow` 类型（[api/modules/market/active-mv.ts:18-32](apps/web/src/api/modules/market/active-mv.ts:18)：`tradeDate, amvOpen/High/Low/Close, amvDif/Dea/Macd,
  amvZdf, signal, memberCount?`）—— 后端 `getSeries` 返回严格同构。

## 2. 改 `UsIndexPanel.vue`（两处）

**(a) availableSubplots（[UsIndexPanel.vue:59]）：**
```ts
const availableSubplots: SubplotKey[] = ['VOL', 'KDJ', 'MACD', '0AMV', '0AMV_MACD']
```

**(b) reload()（[UsIndexPanel.vue:71-87]）—— ⚠️ 仅增量改动，保留现有 try/catch + 未灌提示骨架：**

真 `reload()` 用 `try{...}catch{ message.error(...) }` 包裹，未灌数据时 `message.warning('未灌数据，请先同步')`。
**不要整段替换**，只在 try 内把「单取 K 线」换成「并行取 K 线 + AMV 再 merge」：

```ts
// try 块内原本：bars.value = await usIndexDailyApi.query({...})
// 改为（其余 try/catch、未灌 message.warning('未灌数据，请先同步')、return 全部保留不动）：
const [kline, amvRows] = await Promise.all([
  usIndexDailyApi.query({ index_code: selectedIndex.value, start_date: start, end_date: end }),
  usIndexAmvApi.query({ index_code: selectedIndex.value, start_date: start, end_date: end })
    .catch(() => [] as AmvSeriesRow[]),                   // AMV 失败降级，不拖垮主图
])
bars.value = mergeKlineWithAmv(kline, amvRows)            // 泛型，复用
```
- `mergeKlineWithAmv`（[mergeAmv.ts:26]）泛型 `<T extends KlineChartBar>`，往 bar 写
  `'0AMV'/'0AMV.DIF'/'0AMV.DEA'/'0AMV.MACD'`，直接复用、零改。
- AMV 日期范围用 K 线的 `start/end`（来自 us-index-daily 的 date-range，AMV 与 K 线同窗）。
- 保留现 `onMounted + onActivated` 双触发（懒 tab-pane onActivated 首挂载不触发，
  `reference_lazy_tab_pane_onactivated`，**勿改回纯 onActivated**）。

## 3. 日期对齐

- K 线 `open_time` = `YYYY-MM-DD`（后端 `formatTradeDateLabel`，
  [us-index-daily/utils/us-index-format.util.ts:13](apps/server/src/market-data/us-index-daily/utils/us-index-format.util.ts:13)）。
- AMV `tradeDate` = `YYYYMMDD`（后端 `getSeries` 不转，[05](./05-nestjs-and-api.md#6-契约要点)）。
- `mergeAmv.normalizeDateKey`（[mergeAmv.ts:12]）`s.replace(/-/g,'')` 两侧去横线对齐 → 字面相等命中，
  **无需额外转换**（`.claude/rules/datetime.md` 副图对齐 key 字面相等要求，靠 normalizeDateKey 满足）。

## 4. 副图开关默认

`0AMV`/`0AMV_MACD` 在 `subplotConfig.defaultPrefsFor` 默认 `visible:true`，但仅当 `availableSubplots` 含这两键
才渲染（已核验）。`UsIndexPanel` `prefs-key="us-index"` —— 新增两键后旧用户偏好若已持久化不含这两键，
`normalizePrefs` 会按 `availableSubplots` 白名单补齐（默认显示）。e2e 验完若改了列偏好顺手恢复默认
（`CLAUDE.md` 持久化状态验完恢复）。

## 5. 不改清单（明确边界）

- `KlineChart.vue` / `composables/kline/subplotConfig.ts` / `klineChartOptions.ts` / `mergeAmv.ts`：**零改**。
- `UsStocksTabsContainer.vue`：**零改**（AMV 在 index pane 内部，tab 结构不动）。
- 美股个股 Tab / `us_symbol` 相关：**零改**（成分股不进策划清单）。
