# Money Flow 净流入趋势详情 Modal 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在行业/板块/个股表格中增加「操作」列，点击「详情」弹出 Modal 展示该实体的净流入历史趋势图。

**Architecture:** 后端扩展现有 API 的 `ts_code` 过滤能力；前端新建 `FlowTrendModal` 组件封装日期选择 + 趋势图，三个 Panel 各自提供 fetchFn 回调。

**Tech Stack:** NestJS + TypeORM (后端)、Vue 3 + Naive UI + ECharts (前端)

---

### Task 1: 后端 — 扩展 ts_code 过滤

**Files:**
- Modify: `apps/server/src/market-data/money-flow/money-flow.service.ts:43-51,53-61`
- Modify: `apps/server/src/market-data/money-flow/dto/query-flow.dto.ts:6`

- [ ] **Step 1: 修改 queryIndustries 增加 ts_code 过滤**

在 `apps/server/src/market-data/money-flow/money-flow.service.ts` 的 `queryIndustries` 方法中，`return qb.getMany()` 之前增加：

```ts
    if (dto.ts_code) {
      qb.andWhere('i.ts_code = :ts', { ts: dto.ts_code });
    }
```

完整方法变为：
```ts
  async queryIndustries(dto: QueryFlowDto): Promise<MoneyFlowIndustryRow[]> {
    const qb = this.industryRepo.createQueryBuilder('i').orderBy('i.net_amount', 'DESC');
    if (dto.trade_date) {
      qb.where('i.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('i.trade_date >= :s AND i.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    if (dto.ts_code) {
      qb.andWhere('i.ts_code = :ts', { ts: dto.ts_code });
    }
    return qb.getMany();
  }
```

- [ ] **Step 2: 修改 querySectors 增加 ts_code 过滤**

在同一文件的 `querySectors` 方法中，`return qb.getMany()` 之前增加：

```ts
    if (dto.ts_code) {
      qb.andWhere('s.ts_code = :ts', { ts: dto.ts_code });
    }
```

完整方法变为：
```ts
  async querySectors(dto: QueryFlowDto): Promise<MoneyFlowSectorRow[]> {
    const qb = this.sectorRepo.createQueryBuilder('s').orderBy('s.net_amount', 'DESC');
    if (dto.trade_date) {
      qb.where('s.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('s.trade_date >= :s AND s.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    if (dto.ts_code) {
      qb.andWhere('s.ts_code = :ts', { ts: dto.ts_code });
    }
    return qb.getMany();
  }
```

- [ ] **Step 3: 更新 QueryFlowDto 注释**

在 `apps/server/src/market-data/money-flow/dto/query-flow.dto.ts` 中，将第 6 行注释从：
```ts
  /** 仅个股查询支持，过滤单只股票 */
```
改为：
```ts
  /** 按实体代码过滤（个股 ts_code、行业 ts_code、板块 ts_code） */
```

- [ ] **Step 4: 构建验证**

Run: `pnpm --filter @cryptotrading/server build`
Expected: 编译成功，无错误

---

### Task 2: 前端 — 新建 FlowTrendModal 组件

**Files:**
- Create: `apps/web/src/components/money-flow/FlowTrendModal.vue`

- [ ] **Step 1: 创建 FlowTrendModal.vue**

创建 `apps/web/src/components/money-flow/FlowTrendModal.vue`：

```vue
<!-- apps/web/src/components/money-flow/FlowTrendModal.vue -->
<template>
  <AppModal
    :show="visible"
    :title="`${entityName} — 净流入趋势`"
    width="min(720px, 92vw)"
    @update:show="$emit('update:visible', $event)"
  >
    <div class="trend-modal-body">
      <FlowDateControl
        :hide-mode-toggle="false"
        :default-range-days="30"
        @change="onDateChange"
      />
      <FlowTrendChart :rows="chartRows" />
    </div>

    <template #actions>
      <n-button @click="$emit('update:visible', false)">关闭</n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
defineOptions({ name: 'FlowTrendModal' })

import { ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import FlowDateControl from './FlowDateControl.vue'
import FlowTrendChart from './FlowTrendChart.vue'
import type { MoneyFlowQueryParams } from '@/api/modules/moneyFlow'
import type { BarChartRow } from './money-flow.types'

const props = defineProps<{
  visible: boolean
  tsCode: string
  entityName: string
  fetchFn: (params: MoneyFlowQueryParams) => Promise<BarChartRow[]>
}>()

defineEmits<{
  'update:visible': [value: boolean]
}>()

const chartRows = ref<BarChartRow[]>([])
const loading = ref(false)
const currentParams = ref<MoneyFlowQueryParams>({})

async function load() {
  if (!currentParams.value.start_date && !currentParams.value.trade_date) return
  loading.value = true
  try {
    chartRows.value = await props.fetchFn({ ...currentParams.value, ts_code: props.tsCode })
  } catch {
    chartRows.value = []
  } finally {
    loading.value = false
  }
}

function onDateChange(params: MoneyFlowQueryParams) {
  currentParams.value = params
  load()
}

watch(() => props.visible, (v) => {
  if (v) {
    chartRows.value = []
    currentParams.value = {}
  }
})
</script>

<style scoped>
.trend-modal-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
</style>
```

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter @cryptotrading/web exec vue-tsc --noEmit`
Expected: 无类型错误

---

### Task 3: 前端 — IndustryFlowPanel 增加操作列

**Files:**
- Modify: `apps/web/src/components/money-flow/IndustryFlowPanel.vue`

- [ ] **Step 1: 添加 import**

在 `apps/web/src/components/money-flow/IndustryFlowPanel.vue` 的 `<script setup>` 中，现有 import 块末尾（第 39 行 `import type { KpiCardItem } from './money-flow.types'` 之后）添加：

```ts
import { NButton } from 'naive-ui'
import FlowTrendModal from './FlowTrendModal.vue'
import type { MoneyFlowQueryParams } from '@/api/modules/moneyFlow'
import type { BarChartRow } from './money-flow.types'
```

注意：`MoneyFlowQueryParams` 已从 `@/api/modules/moneyFlow` 导入（第 36 行），无需重复。实际只需添加：

```ts
import { NButton } from 'naive-ui'
import FlowTrendModal from './FlowTrendModal.vue'
import type { BarChartRow } from './money-flow.types'
```

- [ ] **Step 2: 添加响应式状态和 openDetail 函数**

在 `IndustryFlowPanel.vue` 的 `<script setup>` 中，`const latestDate = ref<string | null>(null)` 之后添加：

```ts
const trendVisible = ref(false)
const trendTsCode = ref('')
const trendEntityName = ref('')

function openDetail(row: MoneyFlowIndustryRow) {
  trendTsCode.value = row.tsCode
  trendEntityName.value = row.industry
  trendVisible.value = true
}

async function trendFetchFn(params: MoneyFlowQueryParams): Promise<BarChartRow[]> {
  const data = await moneyFlowApi.queryIndustries(params)
  return data.map(r => ({ label: r.tradeDate, value: Number(r.netAmount) || 0 }))
}
```

- [ ] **Step 3: 在 columns 数组末尾追加操作列**

在 `IndustryFlowPanel.vue` 的 `columns` 数组末尾（第 64 行 `}` 之后，第 65 行 `]` 之前）添加：

```ts
  {
    title: '操作',
    key: 'action',
    width: 70,
    render: (row) => h(NButton, { text: true, type: 'primary', onClick: () => openDetail(row) }, () => '详情'),
  },
```

- [ ] **Step 4: 在模板中添加 FlowTrendModal**

在 `IndustryFlowPanel.vue` 模板的 `</div>` 结束标签（根元素闭合）之前添加：

```html
    <FlowTrendModal
      v-model:visible="trendVisible"
      :ts-code="trendTsCode"
      :entity-name="trendEntityName"
      :fetch-fn="trendFetchFn"
    />
```

- [ ] **Step 5: 类型检查**

Run: `pnpm --filter @cryptotrading/web exec vue-tsc --noEmit`
Expected: 无类型错误

---

### Task 4: 前端 — SectorFlowPanel 增加操作列

**Files:**
- Modify: `apps/web/src/components/money-flow/SectorFlowPanel.vue`

- [ ] **Step 1: 添加 import**

在 `SectorFlowPanel.vue` 的 `<script setup>` 中，现有 import 块末尾添加：

```ts
import { NButton } from 'naive-ui'
import FlowTrendModal from './FlowTrendModal.vue'
import type { BarChartRow } from './money-flow.types'
```

- [ ] **Step 2: 添加响应式状态和 openDetail 函数**

在 `SectorFlowPanel.vue` 的 `<script setup>` 中，`const latestDate = ref<string | null>(null)` 之后添加：

```ts
const trendVisible = ref(false)
const trendTsCode = ref('')
const trendEntityName = ref('')

function openDetail(row: MoneyFlowSectorRow) {
  trendTsCode.value = row.tsCode
  trendEntityName.value = row.sector
  trendVisible.value = true
}

async function trendFetchFn(params: MoneyFlowQueryParams): Promise<BarChartRow[]> {
  const data = await moneyFlowApi.querySectors(params)
  return data.map(r => ({ label: r.tradeDate, value: Number(r.netAmount) || 0 }))
}
```

- [ ] **Step 3: 在 columns 数组末尾追加操作列**

在 `SectorFlowPanel.vue` 的 `columns` 数组末尾（第 64 行 `}` 之后，第 65 行 `]` 之前）添加：

```ts
  {
    title: '操作',
    key: 'action',
    width: 70,
    render: (row) => h(NButton, { text: true, type: 'primary', onClick: () => openDetail(row) }, () => '详情'),
  },
```

- [ ] **Step 4: 在模板中添加 FlowTrendModal**

在 `SectorFlowPanel.vue` 模板的根元素闭合 `</div>` 之前添加：

```html
    <FlowTrendModal
      v-model:visible="trendVisible"
      :ts-code="trendTsCode"
      :entity-name="trendEntityName"
      :fetch-fn="trendFetchFn"
    />
```

- [ ] **Step 5: 类型检查**

Run: `pnpm --filter @cryptotrading/web exec vue-tsc --noEmit`
Expected: 无类型错误

---

### Task 5: 前端 — StockFlowPanel 增加操作列

**Files:**
- Modify: `apps/web/src/components/money-flow/StockFlowPanel.vue`

- [ ] **Step 1: 添加 import**

在 `StockFlowPanel.vue` 的 `<script setup>` 中，现有 import 块末尾添加：

```ts
import { NButton } from 'naive-ui'
import FlowTrendModal from './FlowTrendModal.vue'
import type { BarChartRow } from './money-flow.types'
```

注意：`NButton` 需要从 `naive-ui` 额外导入（已有 `NDataTable, NInput`）。

- [ ] **Step 2: 添加响应式状态和 openDetail 函数**

在 `StockFlowPanel.vue` 的 `<script setup>` 中，`const latestDate = ref<string | null>(null)` 之后添加：

```ts
const trendVisible = ref(false)
const trendTsCode = ref('')
const trendEntityName = ref('')

function openDetail(row: MoneyFlowStockRow) {
  trendTsCode.value = row.tsCode
  trendEntityName.value = row.name ?? row.tsCode
  trendVisible.value = true
}

async function trendFetchFn(params: MoneyFlowQueryParams): Promise<BarChartRow[]> {
  const data = await moneyFlowApi.queryStocks(params)
  return data.map(r => ({ label: r.tradeDate, value: Number(r.netAmount) || 0 }))
}
```

- [ ] **Step 3: 在 columns 数组末尾追加操作列**

在 `StockFlowPanel.vue` 的 `columns` 数组末尾（第 128 行 `}` 之后，第 129 行 `]` 之前）添加：

```ts
  {
    title: '操作',
    key: 'action',
    width: 70,
    render: (row) => h(NButton, { text: true, type: 'primary', onClick: () => openDetail(row) }, () => '详情'),
  },
```

- [ ] **Step 4: 在模板中添加 FlowTrendModal**

在 `StockFlowPanel.vue` 模板的根元素闭合 `</div>` 之前添加：

```html
    <FlowTrendModal
      v-model:visible="trendVisible"
      :ts-code="trendTsCode"
      :entity-name="trendEntityName"
      :fetch-fn="trendFetchFn"
    />
```

- [ ] **Step 5: 类型检查**

Run: `pnpm --filter @cryptotrading/web exec vue-tsc --noEmit`
Expected: 无类型错误

---

### Task 6: 整体验证

- [ ] **Step 1: 后端构建**

Run: `pnpm --filter @cryptotrading/server build`
Expected: 编译成功

- [ ] **Step 2: 前端类型检查**

Run: `pnpm --filter @cryptotrading/web exec vue-tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 3: 启动后端验证**

Run: `pnpm --filter @cryptotrading/server start`
Expected: 服务正常启动，无报错

- [ ] **Step 4: 人工功能验证**

1. 打开 Money Flow 页面，切换到「行业」Tab
2. 确认表格末尾出现「操作」列，每行有「详情」按钮
3. 点击某行「详情」，确认弹出 Modal，标题为「行业名 — 净流入趋势」
4. 确认 Modal 内有日期选择器（默认近 30 天）和柱状图
5. 切换日期范围，确认图表数据更新
6. 关闭 Modal，切换到「板块」「个股」Tab 重复验证
7. 确认「大盘」Tab 无变化
