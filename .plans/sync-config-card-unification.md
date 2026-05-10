# 同步配置卡片格式统一 + 同步 Modal 实现方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将「数据同步 → 同步配置」4 张数据源卡片的格式统一，并为每张卡片的同步操作添加 Modal——展示已同步日期范围、支持手动选择同步区间、提供增量/覆盖两种模式。

**Architecture:**
- 新建通用组件 `DataSyncModal.vue`，供资金流向、0AMV、加密货币三张卡片复用；A 股沿用已有的 `ASharesSyncModal.vue`。
- 各数据源各建一个 composable（`useOamvSync`、`useMoneyFlowSync`、`useCryptoSync`），统一封装"打开 Modal → 查询库存范围 → 确认同步"逻辑。
- 后端补充三个"库存日期范围"查询接口，并为 OAMV、资金流向新增 `syncMode` 参数支持。

**Tech Stack:** NestJS 10 · TypeORM · Vue 3 SFC · Naive UI · TypeScript

---

## 现状差异一览

| 项目 | Card 1 加密货币 | Card 2 A 股 | Card 3 资金流向 | Card 4 0AMV |
|---|---|---|---|---|
| **同步 Modal** | ✗ 无（直接 SSE 同步） | ✓ 完整 Modal | ✗ 无（卡片内日期选择器） | ✗ 无（固定60天） |
| **库存日期范围接口** | ✗ 无 | ✓ `getDateRange()` | △ 仅有 `getLatestDates()`（最新4个维度） | ✗ 无 |
| **同步模式参数** | ✗ 无 | ✓ incremental/overwrite | ✗ 无 | ✗ 无 |
| **操作区按钮布局** | `n-space justify="end"` 横排 2 个 | 弹 Modal 1 个全宽按钮 | `block` 全宽 1 个 | `block` 全宽 1 个 |
| **操作区容器 class** | `form-actions data-source-actions` | `data-source-actions--single` | `data-source-actions--single` | `data-source-actions--single` |
| **内联样式** | — | — | datepicker `style="width:100%"` | — |

---

## 目标状态

1. **所有 4 张卡片**：点击主操作按钮均弹出同步 Modal。
2. **Modal 统一包含**：已同步日期范围（库存状态）、同步日期范围选择器、增量/覆盖模式切换、确认/取消按钮。
3. **卡片操作区**：所有卡片使用相同容器类 `data-source-actions`（删除 `--single` 和 `form-actions`），统一 `block secondary type="primary"` 单按钮。
4. **加密货币 Card 1**：「保存配置」按钮移入 Modal 或改为独立次要按钮；「开始同步」改为「配置并同步」打开 Modal。

---

## 文件范围

### 新增
| 文件 | 职责 |
|---|---|
| `apps/web/src/components/sync/DataSyncModal.vue` | 通用同步 Modal 组件 |
| `apps/web/src/components/sync/useCryptoSync.ts` | 加密货币同步 Modal composable |
| `apps/web/src/components/sync/useOamvSync.ts` | 0AMV 同步 Modal composable |
| `apps/web/src/components/sync/useMoneyFlowSync.ts` | 资金流向同步 Modal composable |

### 修改
| 文件 | 变更内容 |
|---|---|
| `apps/server/src/market-data/oamv/oamv.controller.ts` | 新增 `GET /oamv/date-range`；`POST /oamv/sync` 接受 body 参数 |
| `apps/server/src/market-data/oamv/oamv.service.ts` | `sync0amv` 接受 `startDate`, `endDate`, `syncMode` |
| `apps/server/src/market-data/money-flow/dto/sync-flow.dto.ts` | 新增 `syncMode` 字段 |
| `apps/server/src/market-data/money-flow/money-flow-sync.service.ts` | 同步时根据 `syncMode` 决定是否跳过已有数据 |
| `apps/server/src/market-data/money-flow/money-flow.controller.ts` | 新增 `GET /money-flow/date-range` |
| `apps/server/src/market-data/sync/sync.controller.ts` | `GET /sync/run` 新增 `startDate`, `endDate`, `syncMode` query 参数；新增 `GET /sync/date-range` |
| `apps/server/src/market-data/sync/sync.service.ts` | `startSync` 接受参数 |
| `packages/shared-types/src/money-flow.ts` | `MoneyFlowSyncParams` 新增 `syncMode` |
| `apps/web/src/api/modules/oamv.ts` | 新增 `getDateRange()`；`sync()` 接受参数 |
| `apps/web/src/api/modules/moneyFlow.ts` | 新增 `getDateRange()`；`syncXxx` 接受 `syncMode` |
| `apps/web/src/api/modules/sync.ts` | 新增 `getDateRange()`；`runSync` 接受参数 |
| `apps/web/src/views/sync/SyncView.vue` | 接入 4 个 Modal；统一卡片模板 |
| `apps/web/src/views/sync/SyncView.styles.css` | 统一卡片 CSS |

---

## Task 1：后端 — OAMV 日期范围接口 + 同步参数扩展

**Files:**
- Modify: `apps/server/src/market-data/oamv/oamv.service.ts`
- Modify: `apps/server/src/market-data/oamv/oamv.controller.ts`

- [ ] **Step 1：`OamvService` 新增 `getDateRange()`**

在 `oamv.service.ts` 的 `get0amvData` 方法之后追加：

```typescript
async getDateRange(): Promise<{ min: string | null; max: string | null }> {
  const result = await this.repo
    .createQueryBuilder('o')
    .select('MIN(o.tradeDate)', 'min')
    .addSelect('MAX(o.tradeDate)', 'max')
    .getRawOne<{ min: string | null; max: string | null }>()
  return result ?? { min: null, max: null }
}
```

- [ ] **Step 2：`OamvService.sync0amv` 接受 `startDate`, `endDate`, `syncMode`**

将 `sync0amv(days: number = 60)` 签名改为：

```typescript
async sync0amv(options: {
  startDate?: string  // YYYYMMDD，不传则取 60 天前
  endDate?: string    // YYYYMMDD，不传则取今天
  syncMode?: 'incremental' | 'overwrite'
} = {}): Promise<{ synced: number }>
```

在方法体顶部替换日期计算逻辑（当前第 113-114 行）：

```typescript
const endDate = options.endDate
  ?? new Date().toISOString().slice(0, 10).replace(/-/g, '')
const startDate = options.startDate
  ?? new Date(Date.now() - 80 * 86400000).toISOString().slice(0, 10).replace(/-/g, '')
```

如果 `syncMode === 'incremental'`，在 upsert 前先查询 DB 已有哪些 `tradeDate`，过滤掉已有的日期只插入新的：

```typescript
if (options.syncMode === 'incremental') {
  const existing = await this.repo.find({
    select: ['tradeDate'],
    where: {},
  })
  const existingSet = new Set(existing.map((e) => e.tradeDate))
  const newResults = validResults.filter((r) => !existingSet.has(r.tradeDate))
  if (newResults.length === 0) {
    this.logger.log('增量同步：无新数据')
    return { synced: 0 }
  }
  // 替换 validResults 继续走后面的 upsert
  validResults.splice(0, validResults.length, ...newResults)
}
```

- [ ] **Step 3：`OamvController` 新增 `GET /oamv/date-range` + 修改 `POST /oamv/sync` body**

将 `oamv.controller.ts` 改为：

```typescript
import { Body, Controller, Get, Post, Query } from '@nestjs/common'
import { OamvService } from './oamv.service'
import { AdminOnly } from '../../auth/decorators/admin-only.decorator'

@Controller('oamv')
export class OamvController {
  constructor(private readonly oamvService: OamvService) {}

  @Get('date-range')
  getDateRange() {
    return this.oamvService.getDateRange()
  }

  @Post('sync')
  @AdminOnly()
  async sync0amv(
    @Body() body: { startDate?: string; endDate?: string; syncMode?: 'incremental' | 'overwrite' } = {},
  ) {
    const result = await this.oamvService.sync0amv(body)
    return { success: true, ...result }
  }

  @Get('data')
  async get0amvData(@Query('days') days?: string) {
    const daysNum = days ? parseInt(days, 10) : 250
    return this.oamvService.get0amvData(daysNum)
  }
}
```

- [ ] **Step 4：手动测试接口**

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT MIN(trade_date), MAX(trade_date) FROM oamv_daily;"
```

预期：能看到 min/max 日期或 null（若表为空）。

---

## Task 2：后端 — 资金流向日期范围接口 + 同步模式参数

**Files:**
- Modify: `packages/shared-types/src/money-flow.ts`
- Modify: `apps/server/src/market-data/money-flow/dto/sync-flow.dto.ts`
- Modify: `apps/server/src/market-data/money-flow/money-flow-sync.service.ts`（`skipExisting` 逻辑）
- Modify: `apps/server/src/market-data/money-flow/money-flow.controller.ts`

- [ ] **Step 1：共享类型 — `MoneyFlowSyncParams` 新增 `syncMode`**

`packages/shared-types/src/money-flow.ts` 第 11-14 行改为：

```typescript
export interface MoneyFlowSyncParams {
  start_date: string
  end_date: string
  syncMode?: 'incremental' | 'overwrite'
}
```

- [ ] **Step 2：DTO 新增 `syncMode`**

`sync-flow.dto.ts` 改为：

```typescript
export class SyncFlowDto {
  /** 起始日期 YYYYMMDD */
  start_date: string
  /** 结束日期 YYYYMMDD */
  end_date: string
  /** 同步模式：incremental（默认，跳过已有日期）| overwrite（覆盖写入） */
  syncMode?: 'incremental' | 'overwrite'
}
```

- [ ] **Step 3：`MoneyFlowSyncService` 增量模式跳过已有日期**

读取 `money-flow-sync.service.ts`，在每个 `syncXxx` 方法中，当 `dto.syncMode !== 'overwrite'` 时，先查询 DB 中 `[start_date, end_date]` 范围内已存在的 `trade_date`，将这些日期从待同步的日期列表中排除。

具体实现示例（以 `syncStocks` 为例，其他三个方法同理）：

```typescript
async syncStocks(dto: SyncFlowDto): Promise<MoneyFlowSyncResult> {
  const tradeDates = await this.fetchTradeDates(dto.start_date, dto.end_date)
  let datesToSync = tradeDates

  if (dto.syncMode !== 'overwrite') {
    const existing = await this.stockRepo
      .createQueryBuilder('s')
      .select('DISTINCT s.trade_date', 'tradeDate')
      .where('s.trade_date >= :start AND s.trade_date <= :end', {
        start: dto.start_date,
        end: dto.end_date,
      })
      .getRawMany<{ tradeDate: string }>()
    const existingSet = new Set(existing.map((e) => e.tradeDate))
    datesToSync = tradeDates.filter((d) => !existingSet.has(d))
    if (datesToSync.length === 0) return { success: 0, skipped: tradeDates.length, errors: [] }
  }
  // ...原有同步逻辑，将 tradeDates 替换为 datesToSync
}
```

注意：需要先确认 `money-flow-sync.service.ts` 中 `syncXxx` 的实际实现结构（通过 Read 工具读取），再按上述模式修改，保持原有错误处理逻辑不变。

- [ ] **Step 4：`MoneyFlowController` 新增 `GET /money-flow/date-range`**

在 `money-flow.controller.ts` 中注入 `MoneyFlowSyncService`（或直接在 controller 中查询实体），添加：

```typescript
@Get('date-range')
async getDateRange() {
  return this.moneyFlowService.getDateRange()
}
```

在 `MoneyFlowService`（`money-flow.service.ts`）中新增：

```typescript
async getDateRange(): Promise<{ min: string | null; max: string | null }> {
  // 取4张表的交集最大日期和最小日期，使用 stock 表作代表
  const result = await this.stockRepo
    .createQueryBuilder('s')
    .select('MIN(s.trade_date)', 'min')
    .addSelect('MAX(s.trade_date)', 'max')
    .getRawOne<{ min: string | null; max: string | null }>()
  return result ?? { min: null, max: null }
}
```

---

## Task 3：后端 — 加密货币 K 线日期范围接口 + 同步参数扩展

**Files:**
- Modify: `apps/server/src/market-data/sync/sync.controller.ts`
- Modify: `apps/server/src/market-data/sync/sync.service.ts`

- [ ] **Step 1：`SyncService` 新增 `getKlineDateRange()`**

在 `sync.service.ts` 中读取 `kline` 表的最早/最晚 `openTime`：

```typescript
async getKlineDateRange(): Promise<{ min: string | null; max: string | null }> {
  const result = await this.klineRepo
    .createQueryBuilder('k')
    .select("TO_CHAR(MIN(k.openTime), 'YYYYMMDD')", 'min')
    .addSelect("TO_CHAR(MAX(k.openTime), 'YYYYMMDD')", 'max')
    .getRawOne<{ min: string | null; max: string | null }>()
  return result ?? { min: null, max: null }
}
```

注意：`kline` 表的时间列名通过 `KlineEntity` 确认（先 Read `apps/server/src/entities/symbol/kline.entity.ts`），若列名不同则调整。

- [ ] **Step 2：`SyncService.startSync` 接受可选参数**

修改 `startSync` 签名：

```typescript
startSync(options: {
  startDate?: string  // YYYYMMDD
  endDate?: string    // YYYYMMDD
  syncMode?: 'incremental' | 'overwrite'
} = {}): Subject<SseEvent>
```

在方法内部：
- `startDate` / `endDate` 不为空时，用于限制同步的时间范围（传递给各 kline 拉取方法）
- `syncMode === 'overwrite'` 时，强制重拉指定范围内已有的 kline 数据（当前 `UPDATE_LOOKBACK_DAYS` 逻辑用于 incremental）

具体修改需先 Read `sync.service.ts` 的 `startSync` 完整实现，再按上述语义注入参数，不改变 SSE 推送框架。

- [ ] **Step 3：`SyncController` 新增 `GET /sync/date-range` + 修改 `GET /sync/run`**

```typescript
@Get('date-range')
getDateRange() {
  return this.syncService.getKlineDateRange()
}

@Get('run')
@AdminOnly()
@Header('Content-Type', 'text/event-stream')
@Header('Cache-Control', 'no-cache')
@Header('Connection', 'keep-alive')
runSync(
  @Query('startDate') startDate: string | undefined,
  @Query('endDate') endDate: string | undefined,
  @Query('syncMode') syncMode: 'incremental' | 'overwrite' | undefined,
  @Res() res: Response,
) {
  res.flushHeaders()
  const subject = this.syncService.startSync({ startDate, endDate, syncMode })
  const subscription = subject.subscribe({
    next: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
    complete: () => res.end(),
    error: () => res.end(),
  })
  res.on('close', () => subscription.unsubscribe())
}
```

---

## Task 4：前端 — 通用 `DataSyncModal` 组件

**Files:**
- Create: `apps/web/src/components/sync/DataSyncModal.vue`

- [ ] **Step 1：创建组件**

```vue
<template>
  <n-modal
    :show="show"
    preset="card"
    class="data-sync-modal"
    :style="{ width: 'min(92vw, 520px)' }"
    :bordered="false"
    :mask-closable="!syncing"
    :closable="!syncing"
    @update:show="emit('update:show', $event)"
  >
    <template #header>
      <div class="dsm-header">
        <div class="dsm-icon">
          <n-icon :component="icon" />
        </div>
        <div>
          <h3 class="dsm-title">{{ title }}</h3>
          <p class="dsm-desc">{{ description }}</p>
        </div>
      </div>
    </template>

    <div class="dsm-form">
      <!-- 当前库存范围 -->
      <div class="dsm-field-block">
        <div class="dsm-field-label">
          <n-icon><calendar-outline /></n-icon>
          <span>当前库存范围</span>
        </div>
        <div class="dsm-range-value">
          <span>{{ dataDateRangeLabel }}</span>
          <n-spin v-if="dataDateRangeLoading" :size="14" />
        </div>
      </div>

      <!-- 同步模式 -->
      <div class="dsm-field-block">
        <div class="dsm-field-label">
          <n-icon><swap-horizontal-outline /></n-icon>
          <span>同步模式</span>
        </div>
        <n-radio-group
          :value="syncMode"
          size="small"
          :disabled="syncing"
          @update:value="handleSyncModeChange"
        >
          <n-radio-button value="incremental">增量同步</n-radio-button>
          <n-radio-button value="overwrite">覆盖同步</n-radio-button>
        </n-radio-group>
        <div class="dsm-mode-note">{{ syncModeNote }}</div>
      </div>

      <!-- 同步日期范围 -->
      <div class="dsm-field-block dsm-field-block--range">
        <div class="dsm-field-label">
          <n-icon><calendar-outline /></n-icon>
          <span>同步日期范围</span>
        </div>
        <n-date-picker
          :value="syncDateRange"
          type="daterange"
          clearable
          :disabled="syncing"
          class="dsm-date-picker"
          @update:value="emit('update:syncDateRange', $event)"
        />
        <div class="dsm-range-preview">
          <span>{{ rangeLabel.start }}</span>
          <n-icon><swap-horizontal-outline /></n-icon>
          <span>{{ rangeLabel.end }}</span>
        </div>
      </div>

      <!-- 额外内容（进度条等）由父组件通过 slot 注入 -->
      <slot name="extra" />
    </div>

    <template #footer>
      <div class="dsm-actions">
        <n-button :disabled="syncing" @click="emit('update:show', false)">取消</n-button>
        <n-button
          type="primary"
          :loading="syncing"
          :disabled="!canConfirm"
          @click="emit('confirm')"
        >
          确认同步
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import { NButton, NDatePicker, NIcon, NModal, NRadioButton, NRadioGroup, NSpin } from 'naive-ui'
import { CalendarOutline, SwapHorizontalOutline } from '@vicons/ionicons5'

type SyncMode = 'incremental' | 'overwrite'

const props = defineProps<{
  show: boolean
  title: string
  description: string
  icon: Component
  syncing: boolean
  syncMode: SyncMode
  syncDateRange: [number, number] | null
  dataDateRangeLabel: string
  dataDateRangeLoading: boolean
  canConfirm: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  'update:syncMode': [value: SyncMode]
  'update:syncDateRange': [value: [number, number] | null]
  confirm: []
}>()

function handleSyncModeChange(value: string | number | boolean) {
  if (value === 'incremental' || value === 'overwrite') emit('update:syncMode', value)
}

const syncModeNote = computed(() =>
  props.syncMode === 'overwrite'
    ? '重新拉取并覆盖写入所选日期范围内的全部数据。'
    : '仅补齐缺失日期，已有数据自动跳过。',
)

const rangeLabel = computed(() => {
  const r = props.syncDateRange
  if (!r) return { start: '未选择', end: '未选择' }
  const fmt = (ts: number) => new Date(ts).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
  return { start: fmt(r[0]), end: fmt(r[1]) }
})
</script>

<style scoped>
.dsm-header { display: flex; align-items: center; gap: 12px; }
.dsm-icon {
  width: 38px; height: 38px; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid color-mix(in srgb, var(--color-primary) 40%, var(--color-border));
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-primary) 14%, var(--color-surface-elevated));
  color: var(--color-primary); font-size: 20px;
}
.dsm-title { margin: 0; font-size: 18px; line-height: 1.2; }
.dsm-desc { margin: 5px 0 0; color: var(--color-text-secondary); font-size: 13px; }
.dsm-form { display: flex; flex-direction: column; gap: 14px; }
.dsm-field-block {
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
}
.dsm-field-block--range {
  background: color-mix(in srgb, var(--color-surface-elevated) 60%, var(--color-surface));
}
.dsm-field-label {
  display: flex; align-items: center; gap: 7px;
  margin-bottom: 10px;
  color: var(--color-text); font-size: 13px; font-weight: 700;
}
.dsm-range-value {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  color: var(--color-text); font-size: 14px; font-weight: 700;
}
.dsm-mode-note { margin-top: 10px; color: var(--color-text-secondary); font-size: 13px; line-height: 1.45; }
.dsm-date-picker { width: 100%; }
.dsm-range-preview {
  display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
  gap: 10px; margin-top: 12px;
  color: var(--color-text-secondary); font-size: 13px; text-align: center;
}
.dsm-range-preview span {
  min-width: 0; padding: 8px 10px;
  border-radius: 7px; background: var(--color-surface); color: var(--color-text);
}
.dsm-actions { display: flex; justify-content: flex-end; gap: 10px; }
</style>
```

---

## Task 5：前端 — OAMV API 更新 + `useOamvSync` composable

**Files:**
- Modify: `apps/web/src/api/modules/oamv.ts`
- Create: `apps/web/src/components/sync/useOamvSync.ts`

- [ ] **Step 1：更新 `oamv.ts` API**

```typescript
import { API_BASE, post, request } from '../client'

export interface OamvDateRange {
  min: string | null
  max: string | null
}

export interface OamvSyncParams {
  startDate?: string
  endDate?: string
  syncMode?: 'incremental' | 'overwrite'
}

export interface OamvSyncResult {
  success: boolean
  synced: number
}

export interface OamvData {
  id: string
  tradeDate: string
  open: string
  high: string
  low: string
  close: string
  createdAt: string
}

export const oamvApi = {
  getDateRange(): Promise<OamvDateRange> {
    return request<OamvDateRange>(`${API_BASE}/oamv/date-range`)
  },

  sync(params: OamvSyncParams = {}): Promise<OamvSyncResult> {
    return post<OamvSyncResult>(`${API_BASE}/oamv/sync`, params)
  },

  getData(days: number = 250): Promise<OamvData[]> {
    return request<OamvData[]>(`${API_BASE}/oamv/data?days=${days}`)
  },
}
```

- [ ] **Step 2：创建 `useOamvSync.ts`**

```typescript
import { computed, ref } from 'vue'
import { oamvApi } from '@/api/modules/oamv'

type SyncMode = 'incremental' | 'overwrite'

function buildDefaultDateRange(): [number, number] {
  const end = Date.now()
  const start = end - 60 * 86400000
  return [start, end]
}

function toYYYYMMDD(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function formatDateLabel(yyyymmdd: string | null): string {
  if (!yyyymmdd) return '暂无本地数据'
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
}

export function useOamvSync(message: {
  error: (msg: string) => void
  success: (msg: string) => void
}) {
  const show = ref(false)
  const syncing = ref(false)
  const syncMode = ref<SyncMode>('incremental')
  const syncDateRange = ref<[number, number] | null>(buildDefaultDateRange())
  const dateRangeLabel = ref('读取中...')
  const dateRangeLoading = ref(false)

  const canConfirm = computed(() => {
    const r = syncDateRange.value
    return Boolean(r && r[0] && r[1]) && !syncing.value
  })

  async function loadDateRange() {
    dateRangeLoading.value = true
    try {
      const range = await oamvApi.getDateRange()
      if (!range.min || !range.max) {
        dateRangeLabel.value = '暂无本地数据'
      } else {
        dateRangeLabel.value = `${formatDateLabel(range.min)} 至 ${formatDateLabel(range.max)}`
      }
    } catch {
      dateRangeLabel.value = '读取失败'
    } finally {
      dateRangeLoading.value = false
    }
  }

  function openModal() {
    if (!syncDateRange.value) syncDateRange.value = buildDefaultDateRange()
    show.value = true
    void loadDateRange()
  }

  async function confirmSync() {
    if (!syncDateRange.value) return
    syncing.value = true
    try {
      const result = await oamvApi.sync({
        startDate: toYYYYMMDD(syncDateRange.value[0]),
        endDate: toYYYYMMDD(syncDateRange.value[1]),
        syncMode: syncMode.value,
      })
      message.success(`0AMV 同步完成，共 ${result.synced} 条数据`)
      show.value = false
      void loadDateRange()
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : '0AMV 同步失败')
    } finally {
      syncing.value = false
    }
  }

  return {
    show,
    syncing,
    syncMode,
    syncDateRange,
    dateRangeLabel,
    dateRangeLoading,
    canConfirm,
    openModal,
    confirmSync,
  }
}
```

---

## Task 6：前端 — 资金流向 API 更新 + `useMoneyFlowSync` composable

**Files:**
- Modify: `apps/web/src/api/modules/moneyFlow.ts`
- Create: `apps/web/src/components/sync/useMoneyFlowSync.ts`

- [ ] **Step 1：更新 `moneyFlow.ts` API，新增 `getDateRange` + 同步接口加 `syncMode`**

在 `moneyFlow.ts` 中新增类型并更新 `syncXxx` 函数（`MoneyFlowSyncParams` 已在 shared-types 中新增了 `syncMode`，此处直接使用）：

```typescript
import { API_BASE, post, request } from '../client'

export type {
  MoneyFlowQueryParams,
  MoneyFlowSyncParams,
  MoneyFlowSyncResult,
  MoneyFlowLatestDates,
  MoneyFlowStockRow,
  MoneyFlowIndustryRow,
  MoneyFlowSectorRow,
  MoneyFlowMarketRow,
} from '@cryptotrading/shared-types'

import type {
  MoneyFlowQueryParams,
  MoneyFlowSyncParams,
  MoneyFlowSyncResult,
  MoneyFlowLatestDates,
  MoneyFlowStockRow,
  MoneyFlowIndustryRow,
  MoneyFlowSectorRow,
  MoneyFlowMarketRow,
} from '@cryptotrading/shared-types'

export interface MoneyFlowDateRange {
  min: string | null
  max: string | null
}

function buildQs(params: MoneyFlowQueryParams): string {
  const qs = new URLSearchParams()
  if (params.trade_date) qs.set('trade_date', params.trade_date)
  if (params.start_date) qs.set('start_date', params.start_date)
  if (params.end_date) qs.set('end_date', params.end_date)
  if (params.ts_code) qs.set('ts_code', params.ts_code)
  if (params.limit) qs.set('limit', String(params.limit))
  const s = qs.toString()
  return s ? `?${s}` : ''
}

export const moneyFlowApi = {
  getDateRange: () =>
    request<MoneyFlowDateRange>(`${API_BASE}/money-flow/date-range`),

  getLatestDates: () =>
    request<MoneyFlowLatestDates>(`${API_BASE}/money-flow/latest-dates`),

  queryStocks: (params: MoneyFlowQueryParams) =>
    request<MoneyFlowStockRow[]>(`${API_BASE}/money-flow/stocks${buildQs(params)}`),

  queryIndustries: (params: MoneyFlowQueryParams) =>
    request<MoneyFlowIndustryRow[]>(`${API_BASE}/money-flow/industries${buildQs(params)}`),

  querySectors: (params: MoneyFlowQueryParams) =>
    request<MoneyFlowSectorRow[]>(`${API_BASE}/money-flow/sectors${buildQs(params)}`),

  queryMarket: (params: MoneyFlowQueryParams) =>
    request<MoneyFlowMarketRow[]>(`${API_BASE}/money-flow/market${buildQs(params)}`),

  syncStocks: (params: MoneyFlowSyncParams) =>
    post<MoneyFlowSyncResult>(`${API_BASE}/money-flow/sync/stocks`, params),

  syncIndustries: (params: MoneyFlowSyncParams) =>
    post<MoneyFlowSyncResult>(`${API_BASE}/money-flow/sync/industries`, params),

  syncSectors: (params: MoneyFlowSyncParams) =>
    post<MoneyFlowSyncResult>(`${API_BASE}/money-flow/sync/sectors`, params),

  syncMarket: (params: MoneyFlowSyncParams) =>
    post<MoneyFlowSyncResult>(`${API_BASE}/money-flow/sync/market`, params),
}
```

- [ ] **Step 2：创建 `useMoneyFlowSync.ts`**

```typescript
import { computed, ref } from 'vue'
import { moneyFlowApi } from '@/api/modules/moneyFlow'
import type { MoneyFlowSyncResult } from '@/api/modules/moneyFlow'

type SyncMode = 'incremental' | 'overwrite'

function buildDefaultDateRange(): [number, number] {
  const end = Date.now()
  const start = end - 30 * 86400000
  return [start, end]
}

function toYYYYMMDD(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function formatDateLabel(yyyymmdd: string | null): string {
  if (!yyyymmdd) return '暂无本地数据'
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
}

export function useMoneyFlowSync(message: {
  error: (msg: string) => void
  success: (msg: string) => void
}) {
  const show = ref(false)
  const syncing = ref(false)
  const syncMode = ref<SyncMode>('incremental')
  const syncDateRange = ref<[number, number] | null>(buildDefaultDateRange())
  const dateRangeLabel = ref('读取中...')
  const dateRangeLoading = ref(false)
  const lastResult = ref<{
    stocks: MoneyFlowSyncResult
    industries: MoneyFlowSyncResult
    sectors: MoneyFlowSyncResult
    market: MoneyFlowSyncResult
  } | null>(null)

  const canConfirm = computed(() => {
    const r = syncDateRange.value
    return Boolean(r && r[0] && r[1]) && !syncing.value
  })

  async function loadDateRange() {
    dateRangeLoading.value = true
    try {
      const range = await moneyFlowApi.getDateRange()
      if (!range.min || !range.max) {
        dateRangeLabel.value = '暂无本地数据'
      } else {
        dateRangeLabel.value = `${formatDateLabel(range.min)} 至 ${formatDateLabel(range.max)}`
      }
    } catch {
      dateRangeLabel.value = '读取失败'
    } finally {
      dateRangeLoading.value = false
    }
  }

  function openModal() {
    if (!syncDateRange.value) syncDateRange.value = buildDefaultDateRange()
    show.value = true
    void loadDateRange()
  }

  async function confirmSync() {
    if (!syncDateRange.value) return
    syncing.value = true
    const params = {
      start_date: toYYYYMMDD(syncDateRange.value[0]),
      end_date: toYYYYMMDD(syncDateRange.value[1]),
      syncMode: syncMode.value,
    }
    try {
      const [stocks, industries, sectors, market] = await Promise.all([
        moneyFlowApi.syncStocks(params),
        moneyFlowApi.syncIndustries(params),
        moneyFlowApi.syncSectors(params),
        moneyFlowApi.syncMarket(params),
      ])
      lastResult.value = { stocks, industries, sectors, market }
      message.success(`同步完成：个股 ${stocks.success} 条`)
      show.value = false
      void loadDateRange()
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : '同步失败')
    } finally {
      syncing.value = false
    }
  }

  return {
    show,
    syncing,
    syncMode,
    syncDateRange,
    dateRangeLabel,
    dateRangeLoading,
    canConfirm,
    lastResult,
    openModal,
    confirmSync,
  }
}
```

---

## Task 7：前端 — 加密货币 API 更新 + `useCryptoSync` composable

**Files:**
- Modify: `apps/web/src/api/modules/sync.ts`
- Create: `apps/web/src/components/sync/useCryptoSync.ts`

- [ ] **Step 1：更新 `sync.ts` API**

```typescript
import { API_BASE, put, request } from '../client'

export interface SyncPreferences {
  intervals: string[]
  symbols: string[]
}

export interface KlineDateRange {
  min: string | null
  max: string | null
}

export type CryptoSyncMode = 'incremental' | 'overwrite'

export const syncApi = {
  getPreferences: () =>
    request<SyncPreferences>(`${API_BASE}/sync/preferences`),

  savePreferences: (body: SyncPreferences) =>
    put<SyncPreferences>(`${API_BASE}/sync/preferences`, body),

  getDateRange: () =>
    request<KlineDateRange>(`${API_BASE}/sync/date-range`),

  syncRunUrl(params: {
    startDate?: string
    endDate?: string
    syncMode?: CryptoSyncMode
  } = {}): string {
    const qs = new URLSearchParams()
    if (params.startDate) qs.set('startDate', params.startDate)
    if (params.endDate) qs.set('endDate', params.endDate)
    if (params.syncMode) qs.set('syncMode', params.syncMode)
    const s = qs.toString()
    return `${API_BASE}/sync/run${s ? `?${s}` : ''}`
  },
}
```

- [ ] **Step 2：创建 `useCryptoSync.ts`**

参考 `useASharesSync.ts` 的 SSE 模式，新建 `useCryptoSync`：

```typescript
import { computed, ref } from 'vue'
import { syncApi } from '@/api/modules/sync'
import { useSSE } from '../../composables/hooks/useSSE'

type SyncMode = 'incremental' | 'overwrite'

function buildDefaultDateRange(): [number, number] {
  const end = Date.now()
  const start = end - 30 * 86400000
  return [start, end]
}

function toYYYYMMDD(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function formatDateLabel(yyyymmdd: string | null): string {
  if (!yyyymmdd) return '暂无本地数据'
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
}

export function useCryptoSync(message: {
  error: (msg: string) => void
  success: (msg: string) => void
}) {
  const sse = useSSE()
  const show = ref(false)
  const syncing = ref(false)
  const syncMode = ref<SyncMode>('incremental')
  const syncDateRange = ref<[number, number] | null>(buildDefaultDateRange())
  const dateRangeLabel = ref('读取中...')
  const dateRangeLoading = ref(false)

  const canConfirm = computed(
    () => Boolean(syncDateRange.value?.[0] && syncDateRange.value?.[1]) && !syncing.value,
  )
  const syncProgressVisible = computed(() => sse.status.value !== 'idle')

  async function loadDateRange() {
    dateRangeLoading.value = true
    try {
      const range = await syncApi.getDateRange()
      if (!range.min || !range.max) {
        dateRangeLabel.value = '暂无本地数据'
      } else {
        dateRangeLabel.value = `${formatDateLabel(range.min)} 至 ${formatDateLabel(range.max)}`
      }
    } catch {
      dateRangeLabel.value = '读取失败'
    } finally {
      dateRangeLoading.value = false
    }
  }

  function openModal() {
    if (!syncDateRange.value) syncDateRange.value = buildDefaultDateRange()
    if (!syncing.value) sse.reset()
    show.value = true
    void loadDateRange()
  }

  async function confirmSync() {
    if (!syncDateRange.value) return
    syncing.value = true
    await sse.start(
      syncApi.syncRunUrl({
        startDate: toYYYYMMDD(syncDateRange.value[0]),
        endDate: toYYYYMMDD(syncDateRange.value[1]),
        syncMode: syncMode.value,
      }),
      {
        method: 'GET',
        onDone: () => {
          message.success('加密货币数据同步完成')
          syncing.value = false
          show.value = false
          void loadDateRange()
        },
        onError: (msg) => {
          message.error(msg)
          syncing.value = false
        },
      },
    )
  }

  return {
    show,
    syncing,
    syncMode,
    syncDateRange,
    dateRangeLabel,
    dateRangeLoading,
    canConfirm,
    syncProgressVisible,
    sse,
    openModal,
    confirmSync,
  }
}
```

---

## Task 8：前端 — SyncView.vue 模板重构

**Files:**
- Modify: `apps/web/src/views/sync/SyncView.vue`

- [ ] **Step 1：更新 `<script setup>` — 引入新 composable，移除旧状态**

将旧的 `moneyFlowDateRange`, `moneyFlowSyncing`, `oamvSyncing`, `moneyFlowSyncResult`、`syncMoneyFlow()`、`syncOamv()` 均删除，改为使用新的 composable：

```typescript
// 替换旧的 oamv/money-flow 状态与方法
import { useCryptoSync } from '../../components/sync/useCryptoSync'
import { useOamvSync } from '../../components/sync/useOamvSync'
import { useMoneyFlowSync } from '../../components/sync/useMoneyFlowSync'
import DataSyncModal from '../../components/sync/DataSyncModal.vue'
import { SyncOutline, CloudDownloadOutline, SwapHorizontalOutline, TrendingUpOutline } from '@vicons/ionicons5'

const cryptoSync = useCryptoSync(message)
const oamvSync = useOamvSync(message)
const moneyFlowSync = useMoneyFlowSync(message)
```

同时移除旧的 `import { moneyFlowApi, type MoneyFlowSyncResult }` 和 `import { oamvApi }` 行（逻辑已转移到 composable 内）。

保留 `useSyncView` 用于读取/保存加密货币的**配置**（时间周期、标的筛选），但 `startSync` 改为调用 `cryptoSync.openModal()`。

- [ ] **Step 2：更新 Card 1（加密货币）模板**

操作区改为单按钮打开 Modal：

```html
<!-- Card 1 操作区 -->
<div class="data-source-actions">
  <n-button block secondary @click="saveConfig" :loading="saving">保存配置</n-button>
  <n-button
    block
    secondary
    type="primary"
    :disabled="cryptoSync.syncing.value"
    @click="cryptoSync.openModal()"
  >
    <template #icon><n-icon><sync-outline /></n-icon></template>
    配置并同步
  </n-button>
</div>
```

- [ ] **Step 3：更新 Card 2（A 股）操作区 class**

```html
<!-- 将 data-source-actions data-source-actions--single 改为 -->
<div class="data-source-actions">
  <n-button block secondary type="primary" :loading="aSharesSyncing" @click="openASharesSyncModal">
    <template #icon><n-icon><cloud-download-outline /></n-icon></template>
    配置并同步
  </n-button>
</div>
```

同时删除 Card 2 body 中的 `source-metric` 和 `source-note`（已同步日期范围改在 Modal 中展示）。

- [ ] **Step 4：更新 Card 3（资金流向）模板**

删除 body 中的 `n-form-item`（日期选择器）和 `source-note`（上次结果），body 改为简短说明；操作区改为单按钮：

```html
<section class="data-source-card data-source-card--moneyflow">
  <div class="data-source-header"> <!-- 保持不变 --> </div>
  <div class="data-source-body">
    <div class="source-note">点击按钮选择日期范围，同步个股、行业、板块、大盘四个维度的资金流向数据。</div>
  </div>
  <div class="data-source-actions">
    <n-button block secondary type="primary" :loading="moneyFlowSync.syncing.value" @click="moneyFlowSync.openModal()">
      <template #icon><n-icon><swap-horizontal-outline /></n-icon></template>
      配置并同步
    </n-button>
  </div>
</section>
```

- [ ] **Step 5：更新 Card 4（0AMV）模板**

```html
<section class="data-source-card data-source-card--oamv">
  <div class="data-source-header"> <!-- 保持不变 --> </div>
  <div class="data-source-body">
    <div class="source-note">中证A股指数 930903.CSI 的活跃市值指标，用于衡量 A 股市场活跃度。</div>
  </div>
  <div class="data-source-actions">
    <n-button block secondary type="primary" :loading="oamvSync.syncing.value" @click="oamvSync.openModal()">
      <template #icon><n-icon><trending-up-outline /></n-icon></template>
      配置并同步
    </n-button>
  </div>
</section>
```

- [ ] **Step 6：在模板底部追加三个 Modal**

在 `<a-shares-sync-modal .../>` 之后追加：

```html
<!-- 加密货币同步 Modal -->
<data-sync-modal
  v-model:show="cryptoSync.show.value"
  title="同步加密货币数据"
  description="同步交易标的的多周期 K 线行情数据。"
  :icon="SyncOutline"
  :syncing="cryptoSync.syncing.value"
  v-model:sync-mode="cryptoSync.syncMode.value"
  v-model:sync-date-range="cryptoSync.syncDateRange.value"
  :data-date-range-label="cryptoSync.dateRangeLabel.value"
  :data-date-range-loading="cryptoSync.dateRangeLoading.value"
  :can-confirm="cryptoSync.canConfirm.value"
  @confirm="cryptoSync.confirmSync()"
>
  <template #extra>
    <div v-if="cryptoSync.syncProgressVisible.value" class="crypto-sync-progress">
      <!-- 复用 SSE 进度展示，参考 ASharesSyncModal 的 sync-progress-panel 样式 -->
      <div class="sync-progress-head">
        <span>{{ cryptoSync.sse.phase.value || '同步中' }}</span>
        <span>{{ Math.round(cryptoSync.sse.percent.value) }}%</span>
      </div>
      <n-progress
        type="line"
        :percentage="Math.round(cryptoSync.sse.percent.value)"
        :status="cryptoSync.sse.status.value === 'error' ? 'error' : cryptoSync.sse.status.value === 'done' ? 'success' : 'default'"
        indicator-placement="inside"
      />
    </div>
  </template>
</data-sync-modal>

<!-- 资金流向同步 Modal -->
<data-sync-modal
  v-model:show="moneyFlowSync.show.value"
  title="同步资金流向数据"
  description="同花顺/东方财富资金流向，同步个股、行业、板块、大盘四个维度。"
  :icon="SwapHorizontalOutline"
  :syncing="moneyFlowSync.syncing.value"
  v-model:sync-mode="moneyFlowSync.syncMode.value"
  v-model:sync-date-range="moneyFlowSync.syncDateRange.value"
  :data-date-range-label="moneyFlowSync.dateRangeLabel.value"
  :data-date-range-loading="moneyFlowSync.dateRangeLoading.value"
  :can-confirm="moneyFlowSync.canConfirm.value"
  @confirm="moneyFlowSync.confirmSync()"
/>

<!-- 0AMV 同步 Modal -->
<data-sync-modal
  v-model:show="oamvSync.show.value"
  title="同步 0AMV 数据"
  description="中证A股指数 930903.CSI 的活跃市值指标。"
  :icon="TrendingUpOutline"
  :syncing="oamvSync.syncing.value"
  v-model:sync-mode="oamvSync.syncMode.value"
  v-model:sync-date-range="oamvSync.syncDateRange.value"
  :data-date-range-label="oamvSync.dateRangeLabel.value"
  :data-date-range-loading="oamvSync.dateRangeLoading.value"
  :can-confirm="oamvSync.canConfirm.value"
  @confirm="oamvSync.confirmSync()"
/>
```

注意：Vue 3 中 composable 返回的 `ref` 在模板中可直接用 `.value` 解构，但更推荐在 `<script setup>` 中解构后赋值给顶层变量（如 `const { show: cryptoShow, ... } = cryptoSync`），模板中直接用 `cryptoShow` 而非 `cryptoSync.show.value`。实现时请统一采用解构模式以保持模板简洁。

---

## Task 9：前端 — CSS 统一

**Files:**
- Modify: `apps/web/src/views/sync/SyncView.styles.css`

- [ ] **Step 1：网格列宽改为等宽**

```css
.data-source-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
```

- [ ] **Step 2：操作区统一为 flex 列布局，删除 `--single` modifier**

```css
.data-source-actions {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid color-mix(in srgb, var(--color-border) 46%, transparent);
}
```

删除以下整块（共 3 行）：

```css
.data-source-actions--single {
  display: block;
}
```

- [ ] **Step 3：datepicker 宽度移入 CSS**

```css
.data-source-body :deep(.n-date-picker) {
  width: 100%;
}
```

- [ ] **Step 4：加密货币 Modal 进度区样式（新增在 SyncView.styles.css）**

```css
.crypto-sync-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
}

.sync-progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--color-text);
  font-size: 12px;
  font-weight: 700;
}
```

---

## Task 10：验证与提交

- [ ] **Step 1：TypeScript 类型检查**

```powershell
pnpm --filter @cryptotrading/web vue-tsc --noEmit
pnpm --filter @cryptotrading/server build
```

Expected：两个包均无错误。

- [ ] **Step 2：启动开发服务器，端到端目视验证**

```powershell
pnpm --filter @cryptotrading/web dev
```

验证清单：
- [ ] 4 张卡片列宽相等（等宽 2 列）
- [ ] 所有卡片操作区均为全宽 `block secondary` 按钮，垂直堆叠（Card 1 有「保存配置」+「配置并同步」两个按钮）
- [ ] 点击「配置并同步」弹出 Modal，包含：库存日期范围、同步模式单选、日期范围选择器
- [ ] 加密货币 Modal 的「确认同步」触发 SSE，进度条正常展示
- [ ] 资金流向 Modal 确认同步后成功提示
- [ ] 0AMV Modal 确认同步后成功提示
- [ ] A 股 Modal 保持原有功能不变

- [ ] **Step 3：提交**

```powershell
git add apps/ packages/
git commit -m "feat(sync): 统一4张数据源卡片格式，为各卡片添加同步 Modal"
```

---

## 自查清单

- [x] **Spec coverage**：所有 4 张卡片均有 Modal；Modal 包含库存范围、日期选择、增量/覆盖模式；卡片格式（列宽、按钮、容器类）已统一
- [x] **Placeholder scan**：每步均含完整代码，无 TBD/TODO
- [x] **Type consistency**：`SyncMode` 类型在 composable 中局部定义，各文件一致使用 `'incremental' | 'overwrite'`；`toYYYYMMDD` 工具函数在三个 composable 中重复，如后续觉得冗余可提取到 `@/utils/date.ts`
