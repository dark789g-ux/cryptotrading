# 标的自选组标签 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在标的表格中展示每个标的所属的自选组标签，并支持按自选组多选筛选（OR 语义）。

**Architecture:** 后端在 symbols 和 a-shares 两个查询接口中增加 tags 聚合字段和 watchlistIds 筛选参数；前端增加标签列渲染和多选筛选器，共享 `useWatchlistTagFilter` composable。

**Tech Stack:** NestJS + TypeORM (raw SQL)、PostgreSQL、Vue 3 + Naive UI

---

## File Structure

### Backend (modify)
- `apps/server/src/catalog/symbols/symbols.service.ts` — 加 tags 子查询 + watchlistIds 过滤
- `apps/server/src/market-data/a-shares/data-access/a-shares-query.sql.ts` — 加 tags 子查询 + watchlistIds 过滤
- `apps/server/src/market-data/a-shares/a-shares.types.ts` — QueryASharesDto 加 watchlistIds
- `apps/server/src/market-data/a-shares/a-shares.service.ts` — 透传 watchlistIds

### Frontend (create)
- `apps/web/src/composables/symbols/useWatchlistTagFilter.ts` — 共享标签筛选逻辑

### Frontend (modify)
- `apps/web/src/api/modules/symbols.ts` — SymbolRow / SymbolQueryBody 加 tags / watchlistIds
- `apps/web/src/api/modules/aShares.ts` — AShareRow / AShareQueryBody 加 tags / watchlistIds
- `apps/web/src/components/symbols/cryptoColumns.ts` — 加 tags 列
- `apps/web/src/components/symbols/a-shares/aSharesColumns.ts` — 加 tags 列
- `apps/web/src/components/symbols/CryptoSymbolsPanel.vue` — 加标签筛选器
- `apps/web/src/components/symbols/a-shares/ASharesFilters.vue` — 加标签筛选器
- `apps/web/src/components/symbols/a-shares/useASharesQuery.ts` — 集成 watchlistIds

---

### Task 1: 后端 — crypto query 加 tags 和 watchlistIds

**Files:**
- Modify: `apps/server/src/catalog/symbols/symbols.service.ts:7-15,95-157`

- [ ] **Step 1: 扩展 QuerySymbolsDto**

在 `QuerySymbolsDto` 接口中增加 `watchlistIds` 字段：

```ts
export interface QuerySymbolsDto {
  interval: string;
  page: number;
  page_size: number;
  sort: { field: string; asc: boolean };
  q?: string;
  conditions?: QuerySymbolCondition[];
  fields?: string[];
  watchlistIds?: string[];  // 新增
}
```

- [ ] **Step 2: querySymbols 方法加 tags 子查询和 watchlistIds 过滤**

在 `querySymbols` 方法中，解构增加 `watchlistIds`，在 SELECT 中增加 tags 聚合子查询，在 WHERE 中增加 watchlistIds 过滤：

```ts
async querySymbols(dto: QuerySymbolsDto) {
  const {
    interval, page, page_size, sort, q = '',
    conditions = [],
    watchlistIds = [],  // 新增
  } = dto;

  const SORT_COL_MAP: Record<string, string> = {
    symbol: 'k.symbol',
    close: 'k.close',
    ma5: 'k.ma5',
    ma30: 'k.ma30',
    ma60: 'k.ma60',
    kdjJ: 'k.kdj_j',
    riskRewardRatio: 'k.risk_reward_ratio',
    stopLossPct: 'k.stop_loss_pct',
    openTime: 'k.open_time',
  };

  let sql = `
    WITH latest AS (
      SELECT symbol, MAX(open_time) AS max_time
      FROM klines
      WHERE interval = $1
      GROUP BY symbol
    )
    SELECT
      k.symbol,
      k.close,
      k.ma5,
      k.ma30,
      k.ma60,
      k.kdj_j AS "kdjJ",
      k.risk_reward_ratio AS "riskRewardRatio",
      k.stop_loss_pct AS "stopLossPct",
      k.open_time AS "openTime",
      COALESCE(
        (SELECT jsonb_agg(DISTINCT jsonb_build_object('id', w.id::text, 'name', w.name))
         FROM watchlist_items wi
         JOIN watchlists w ON w.id = wi.watchlist_id
         WHERE wi.symbol = k.symbol),
        '[]'::jsonb
      ) AS tags
    FROM klines k
    JOIN latest ON k.symbol = latest.symbol AND k.open_time = latest.max_time AND k.interval = $1
    JOIN symbols s ON s.symbol = k.symbol
    WHERE s.is_excluded = false`;

  const params: Array<string | number> = [interval];
  let pi = 2;

  if (q) {
    sql += ` AND k.symbol ILIKE $${pi}`;
    params.push(`%${q}%`);
    pi++;
  }

  // watchlistIds 过滤（并集）
  if (watchlistIds.length > 0) {
    sql += ` AND k.symbol IN (SELECT wi2.symbol FROM watchlist_items wi2 WHERE wi2.watchlist_id = ANY($${pi}::text[]))`;
    params.push(watchlistIds);
    pi++;
  }

  for (const cond of conditions.slice(0, 10)) {
    const col = KLINE_INDICATOR_COLUMNS[cond.field];
    const op = KLINE_OP_MAP[cond.op];
    if (!col || !op) continue;
    if (cond.valueType === 'field') {
      const compareCol = KLINE_INDICATOR_COLUMNS[cond.compareField];
      if (!compareCol) continue;
      sql += ` AND k.${col} ${op} k.${compareCol}`;
    } else {
      sql += ` AND k.${col} ${op} $${pi}`;
      params.push(cond.value);
      pi++;
    }
  }

  const countSql = `SELECT COUNT(*) FROM (${sql}) sub`;
  const countResult = await this.dataSource.query(countSql, params);
  const total = parseInt(countResult[0].count, 10);

  const sortCol = SORT_COL_MAP[sort.field] ?? 'k.symbol';
  sql += ` ORDER BY ${sortCol} ${sort.asc ? 'ASC' : 'DESC'} NULLS LAST`;

  const offset = (page - 1) * page_size;
  sql += ` LIMIT $${pi} OFFSET $${pi + 1}`;
  params.push(page_size, offset);

  const items = await this.dataSource.query(sql, params);

  return { items, total, page, page_size };
}
```

- [ ] **Step 3: 手动验证**

重启后端服务，用 curl 或前端调用 `POST /api/symbols/query` 确认：
1. 不传 `watchlistIds` 时，返回的 items 每条都有 `tags` 字段（空数组或标签数组）
2. 传 `watchlistIds` 时，只返回属于指定自选组的标的

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/catalog/symbols/symbols.service.ts
git commit -m "feat(server): add tags aggregation and watchlistIds filter to crypto symbols query"
```

---

### Task 2: 后端 — A shares query 加 tags 和 watchlistIds

**Files:**
- Modify: `apps/server/src/market-data/a-shares/a-shares.types.ts:23-32`
- Modify: `apps/server/src/market-data/a-shares/data-access/a-shares-query.sql.ts:80-154`

- [ ] **Step 1: 扩展 QueryASharesDto**

在 `a-shares.types.ts` 的 `QueryASharesDto` 中增加 `watchlistIds`：

```ts
export interface QueryASharesDto {
  page?: number;
  pageSize?: number;
  q?: string;
  market?: string | null;
  industry?: string | null;
  priceMode?: 'qfq' | 'raw';
  sort?: { field?: string; order?: SortOrder; asc?: boolean };
  conditions?: QueryCondition[];
  watchlistIds?: string[];  // 新增
}
```

- [ ] **Step 2: buildASharesBaseQuery 加 tags 子查询和 watchlistIds 过滤**

在 `a-shares-query.sql.ts` 的 `buildASharesBaseQuery` 函数中：

1. 在 SELECT 列表末尾（`q.trade_date AS "tradeDate"` 之后）增加 tags 子查询：

```ts
let sql = `
    WITH latest AS (
      SELECT ts_code, MAX(trade_date) AS trade_date
      FROM a_share_daily_quotes
      GROUP BY ts_code
    )
    SELECT
      s.ts_code AS "tsCode",
      s.symbol,
      s.name,
      s.market,
      s.industry,
      ${priceCols.close} AS close,
      ${priceCols.change} AS change,
      ${priceCols.pctChg} AS "pctChg",
      q.amount,
      m.turnover_rate AS "turnoverRate",
      m.volume_ratio AS "volumeRatio",
      m.pe,
      m.pe_ttm AS "peTtm",
      m.pb,
      m.total_mv AS "totalMv",
      m.circ_mv AS "circMv",
      q.trade_date AS "tradeDate",
      COALESCE(
        (SELECT jsonb_agg(DISTINCT jsonb_build_object('id', w.id::text, 'name', w.name))
         FROM watchlist_items wi
         JOIN watchlists w ON w.id = wi.watchlist_id
         WHERE wi.symbol = s.ts_code),
        '[]'::jsonb
      ) AS tags
    FROM a_share_symbols s
    LEFT JOIN latest l ON l.ts_code = s.ts_code
    LEFT JOIN a_share_daily_quotes q ON q.ts_code = s.ts_code AND q.trade_date = l.trade_date
    LEFT JOIN a_share_daily_metrics m ON m.ts_code = s.ts_code AND m.trade_date = l.trade_date
    LEFT JOIN a_share_daily_indicators i ON i.ts_code = s.ts_code AND i.trade_date = l.trade_date
    WHERE s.list_status = 'L'
  `;
```

2. 在所有条件过滤之后（`for (const condition ...)` 循环之后），增加 watchlistIds 过滤：

```ts
if (dto.watchlistIds && dto.watchlistIds.length > 0) {
  sql += ` AND s.ts_code IN (SELECT wi2.symbol FROM watchlist_items wi2 WHERE wi2.watchlist_id = ANY($${paramIndex}::text[]))`;
  params.push(dto.watchlistIds);
  paramIndex++;
}
```

- [ ] **Step 3: 手动验证**

重启后端，调用 `POST /api/a-shares/query` 确认 tags 和 watchlistIds 过滤正常工作。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/market-data/a-shares/a-shares.types.ts apps/server/src/market-data/a-shares/data-access/a-shares-query.sql.ts
git commit -m "feat(server): add tags aggregation and watchlistIds filter to A shares query"
```

---

### Task 3: 前端 — 更新 API 类型定义

**Files:**
- Modify: `apps/web/src/api/modules/symbols.ts:56-73`
- Modify: `apps/web/src/api/modules/aShares.ts:18-36,67-76`

- [ ] **Step 1: 更新 symbols.ts 类型**

在 `SymbolQueryBody` 中增加 `watchlistIds`，在 `SymbolRow` 中增加 `tags`：

```ts
export interface SymbolQueryBody {
  interval?: string
  q?: string
  page?: number
  pageSize?: number
  page_size?: number
  sort?: { field?: string | null; order?: 'ascend' | 'descend' | null; asc?: boolean }
  conditions?: SymbolConditionPayload[]
  watchlistIds?: string[]  // 新增
}

export interface SymbolRow extends Record<string, unknown> {
  symbol: string
  tags?: { id: string; name: string }[]  // 新增
}
```

- [ ] **Step 2: 更新 aShares.ts 类型**

在 `AShareQueryBody` 中增加 `watchlistIds`，在 `AShareRow` 中增加 `tags`：

```ts
export interface AShareRow {
  tsCode: string
  symbol: string
  name: string
  market: string | null
  industry: string | null
  close: string | null
  change: string | null
  pctChg: string | null
  amount: string | null
  turnoverRate: string | null
  volumeRatio: string | null
  pe: string | null
  peTtm: string | null
  pb: string | null
  totalMv?: string | null
  circMv?: string | null
  tradeDate: string | null
  tags?: { id: string; name: string }[]  // 新增
}

export interface AShareQueryBody {
  page: number
  pageSize: number
  q?: string
  market?: string | null
  industry?: string | null
  priceMode?: ASharePriceMode
  sort?: { field?: string; order?: 'ascend' | 'descend' | null; asc?: boolean }
  conditions?: NumericConditionPayload[]
  watchlistIds?: string[]  // 新增
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/api/modules/symbols.ts apps/web/src/api/modules/aShares.ts
git commit -m "feat(web): add tags and watchlistIds to API types"
```

---

### Task 4: 前端 — 创建 useWatchlistTagFilter composable

**Files:**
- Create: `apps/web/src/composables/symbols/useWatchlistTagFilter.ts`

- [ ] **Step 1: 创建 composable**

```ts
import { computed, ref } from 'vue'
import { useWatchlistStore } from '@/stores/watchlist'

export function useWatchlistTagFilter() {
  const watchlistStore = useWatchlistStore()
  const selectedWatchlistIds = ref<string[]>([])

  const watchlistOptions = computed(() =>
    watchlistStore.watchlists.map((w) => ({ label: w.name, value: w.id })),
  )

  const watchlistIds = computed(() =>
    selectedWatchlistIds.value.length > 0 ? selectedWatchlistIds.value : undefined,
  )

  function resetWatchlistFilter() {
    selectedWatchlistIds.value = []
  }

  return {
    selectedWatchlistIds,
    watchlistOptions,
    watchlistIds,
    resetWatchlistFilter,
    ensureWatchlistsLoaded: watchlistStore.ensureWatchlistsLoaded,
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/composables/symbols/useWatchlistTagFilter.ts
git commit -m "feat(web): create useWatchlistTagFilter composable"
```

---

### Task 5: 前端 — cryptoColumns 加 tags 列

**Files:**
- Modify: `apps/web/src/components/symbols/cryptoColumns.ts:15-82`

- [ ] **Step 1: 添加 tags 列定义**

在 `createCryptoColumnDefs` 返回的数组中，在 `openTime` 列之后、`actions` 列之前插入 tags 列。需要额外导入 `NTag`：

```ts
import { NButton, NIcon, NTag, NTooltip, type DataTableColumns } from 'naive-ui'
```

在 `openTime` 列定义之后添加：

```ts
{
  title: 'Tags',
  key: 'tags',
  width: 180,
  render: (row) => {
    const tags = row.tags as { id: string; name: string }[] | undefined
    if (!tags || tags.length === 0) return h('span', { style: 'color: var(--color-text-secondary)' }, '—')
    return h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' },
      tags.map((tag) => h(NTag, { size: 'small', bordered: false, round: true }, { default: () => tag.name })),
    )
  },
},
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/symbols/cryptoColumns.ts
git commit -m "feat(web): add tags column to crypto symbols table"
```

---

### Task 6: 前端 — aSharesColumns 加 tags 列

**Files:**
- Modify: `apps/web/src/components/symbols/a-shares/aSharesColumns.ts:22-90`

- [ ] **Step 1: 添加 tags 列定义**

在 `createASharesColumnDefs` 返回的数组中，在 `tradeDate` 列之后、`actions` 列之前插入 tags 列。需要额外导入 `NTag`：

```ts
import { NButton, NIcon, NTag, NTooltip, type DataTableColumns } from 'naive-ui'
```

在 `tradeDate` 列定义之后添加：

```ts
{
  title: '标签',
  key: 'tags',
  width: 180,
  render: (row) => {
    const tags = row.tags as { id: string; name: string }[] | undefined
    if (!tags || tags.length === 0) return h('span', { style: 'color: var(--color-text-secondary)' }, '—')
    return h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' },
      tags.map((tag) => h(NTag, { size: 'small', bordered: false, round: true }, { default: () => tag.name })),
    )
  },
},
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/symbols/a-shares/aSharesColumns.ts
git commit -m "feat(web): add tags column to A shares table"
```

---

### Task 7: 前端 — CryptoSymbolsPanel 加标签筛选器

**Files:**
- Modify: `apps/web/src/components/symbols/CryptoSymbolsPanel.vue:23-49,89-194`

- [ ] **Step 1: 集成 useWatchlistTagFilter**

在 `<script setup>` 中导入并使用 composable：

```ts
import { useWatchlistTagFilter } from '@/composables/symbols/useWatchlistTagFilter'

const {
  selectedWatchlistIds,
  watchlistOptions,
  watchlistIds,
  resetWatchlistFilter,
  ensureWatchlistsLoaded,
} = useWatchlistTagFilter()
```

- [ ] **Step 2: buildQuery 加 watchlistIds**

修改 `buildQuery` 函数，增加 `watchlistIds`：

```ts
const buildQuery = () => ({
  interval: selectedInterval.value,
  q: searchQuery.value,
  conditions: conditions.value,
  watchlistIds: watchlistIds.value,  // 新增
  sort: { field: sortKey.value ?? 'symbol', asc: sortOrder.value !== 'descend' },
  page: page.value,
  page_size: pageSize.value,
})
```

- [ ] **Step 3: resetFilters 加 watchlist 重置**

修改 `resetFilters` 函数：

```ts
const resetFilters = () => {
  conditions.value = []
  searchQuery.value = ''
  resetWatchlistFilter()  // 新增
  page.value = 1
  void loadData()
}
```

- [ ] **Step 4: 模板加标签筛选器**

在 `NumericConditionFilter` 组件之前（`<n-input>` 之后），添加标签多选下拉框：

```vue
<n-select
  v-model:value="selectedWatchlistIds"
  :options="watchlistOptions"
  multiple
  filterable
  placeholder="标签"
  clearable
  style="width: 200px"
  @update:value="applyFilters"
/>
```

- [ ] **Step 5: onMounted 加载 watchlist 数据**

在 `onMounted` 中增加 `ensureWatchlistsLoaded` 调用：

```ts
onMounted(() => {
  void ensureWatchlistsLoaded()  // 新增
  void loadFields()
  void loadColumnPreferences().catch((err: unknown) => {
    message.error(err instanceof Error ? err.message : String(err))
  })
  void loadData()
})
```

- [ ] **Step 6: 手动验证**

在浏览器中打开加密标的页面，确认：
1. 筛选栏出现"标签"多选下拉框，选项为当前用户的所有自选组
2. 选中标签后表格只显示属于该自选组的标的
3. 多选标签为 OR 语义（属于任一选中自选组即显示）
4. 点击 Reset 后标签筛选被清空
5. 表格中 Tags 列正确显示标签

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/symbols/CryptoSymbolsPanel.vue
git commit -m "feat(web): add watchlist tag filter to crypto symbols panel"
```

---

### Task 8: 前端 — ASharesFilters 加标签筛选器

**Files:**
- Modify: `apps/web/src/components/symbols/a-shares/ASharesFilters.vue:1-136`
- Modify: `apps/web/src/components/symbols/a-shares/useASharesQuery.ts:1-262`
- Modify: `apps/web/src/components/symbols/ASharesPanel.vue:73-116`

- [ ] **Step 1: useASharesQuery 集成 watchlistIds**

在 `useASharesQuery.ts` 中导入并使用 composable：

```ts
import { useWatchlistTagFilter } from '@/composables/symbols/useWatchlistTagFilter'
```

在函数体开头解构：

```ts
const {
  selectedWatchlistIds,
  watchlistOptions,
  watchlistIds,
  resetWatchlistFilter,
  ensureWatchlistsLoaded,
} = useWatchlistTagFilter()
```

修改 `loadData` 中的 `aSharesApi.query` 调用，增加 `watchlistIds`：

```ts
const res = await aSharesApi.query({
  page: page.value,
  pageSize: pageSize.value,
  q: searchQuery.value,
  market: selectedMarket.value,
  industry: selectedIndustry.value,
  priceMode: priceMode.value,
  watchlistIds: watchlistIds.value,  // 新增
  sort: { field: sortKey.value ?? 'tsCode', order: sortOrder.value },
  conditions: buildConditions(),
})
```

修改 `resetFilters` 增加 `resetWatchlistFilter()`：

```ts
function resetFilters() {
  searchQuery.value = ''
  selectedMarket.value = null
  selectedIndustry.value = null
  pctChangeMin.value = null
  turnoverRateMin.value = null
  advancedConditions.value = []
  priceMode.value = 'qfq'
  resetWatchlistFilter()  // 新增
  page.value = 1
  void loadData()
}
```

修改 `reload` 增加 `ensureWatchlistsLoaded`：

```ts
async function reload() {
  await Promise.all([
    ensureWatchlistsLoaded(),  // 新增
    loadSummary(),
    loadFilterOptions(),
    loadFilterPresets(),
    loadData(),
  ])
}
```

在 return 中导出新增的属性：

```ts
return {
  // ...existing...
  selectedWatchlistIds,
  watchlistOptions,
  // ...
}
```

- [ ] **Step 2: ASharesFilters 接收并渲染标签筛选器**

在 `ASharesFilters.vue` 的 props 中增加：

```ts
defineProps<{
  // ...existing props...
  selectedWatchlistIds: string[]
  watchlistOptions: Array<{ label: string; value: string }>
}>()
```

在 emits 中增加：

```ts
const emit = defineEmits<{
  // ...existing emits...
  'update:selectedWatchlistIds': [value: string[]]
}>()
```

在模板中，`<n-select>` (行业) 之后、`<n-input-number>` (涨跌幅) 之前，添加标签筛选器：

```vue
<n-select
  :value="selectedWatchlistIds"
  :options="watchlistOptions"
  multiple
  filterable
  placeholder="标签"
  clearable
  class="filter-select"
  @update:value="emit('update:selectedWatchlistIds', $event)"
/>
```

- [ ] **Step 3: ASharesPanel 传递标签相关 props**

在 `ASharesPanel.vue` 的模板中，`<a-shares-filters>` 组件上增加绑定：

```vue
<a-shares-filters
  v-model:search-query="searchQuery"
  v-model:selected-market="selectedMarket"
  v-model:selected-industry="selectedIndustry"
  v-model:selected-watchlist-ids="selectedWatchlistIds"
  v-model:price-mode="priceMode"
  v-model:pct-change-min="pctChangeMin"
  v-model:turnover-rate-min="turnoverRateMin"
  v-model:advanced-conditions="advancedConditions"
  :market-options="marketOptions"
  :industry-options="industryOptions"
  :watchlist-options="watchlistOptions"
  :filter-presets="filterPresets"
  :filter-presets-loading="filterPresetsLoading"
  @apply="applyFilters"
  @reset="resetFilters"
  @update:price-mode="handlePriceModeChange"
  @refresh-filter-presets="loadFilterPresets"
  @create-filter-preset="createFilterPreset"
  @overwrite-filter-preset="overwriteFilterPreset"
  @rename-filter-preset="renameFilterPreset"
  @delete-filter-preset="deleteFilterPreset"
  @apply-filter-preset="applyFilterPreset"
/>
```

在 `<script setup>` 的解构中增加：

```ts
const {
  // ...existing...
  selectedWatchlistIds,
  watchlistOptions,
} = useASharesQuery(message)
```

- [ ] **Step 4: 手动验证**

在浏览器中打开 A 股数据页面，确认：
1. 筛选栏出现"标签"多选下拉框
2. 选中标签后表格只显示属于该自选组的标的
3. 多选标签为 OR 语义
4. 重置后标签筛选被清空
5. 表格中"标签"列正确显示

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/symbols/a-shares/ASharesFilters.vue apps/web/src/components/symbols/a-shares/useASharesQuery.ts apps/web/src/components/symbols/ASharesPanel.vue
git commit -m "feat(web): add watchlist tag filter to A shares panel"
```
