# 活跃市值（0AMV）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Symbols 页面新增"活跃市值" TAB，以 K 线图形式展示 0AMV 指标

**Architecture:** 后端新增 0AMV 模块（Entity + Service + Controller），复用 TushareClientService 拉取 930903.CSI 数据并计算 0AMV；前端复用 KlineChart 组件展示 K 线图；数据同步页面添加手动同步按钮

**Tech Stack:** NestJS + TypeORM + PostgreSQL + Vue 3 + Naive UI + ECharts

---

## 文件结构

### 后端（apps/server/src/）

| 文件 | 职责 |
|------|------|
| `entities/oamv/oamv-daily.entity.ts` | 0AMV 日线数据 Entity |
| `market-data/oamv/oamv.module.ts` | NestJS 模块 |
| `market-data/oamv/oamv.controller.ts` | API 控制器（同步 + 查询） |
| `market-data/oamv/oamv.service.ts` | 业务逻辑（计算 + 存储 + 查询） |
| `market-data/oamv/oamv.types.ts` | 类型定义 |

### 前端（apps/web/src/）

| 文件 | 职责 |
|------|------|
| `api/modules/oamv.ts` | API 接口层 |
| `components/symbols/ActiveMarketValuePanel.vue` | 活跃市值面板组件 |
| `views/SymbolsView.vue` | 修改：添加第三个 TAB |
| `views/sync/SyncView.vue` | 修改：添加 0AMV 同步按钮 |

---

## Task 1: 创建数据库表和 Entity

**Files:**
- Create: `apps/server/src/entities/oamv/oamv-daily.entity.ts`

- [ ] **Step 1: 创建 Entity 文件**

```typescript
// apps/server/src/entities/oamv/oamv-daily.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm'

@Entity('oamv_daily')
@Index(['tradeDate'], { unique: true })
export class OamvDailyEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ name: 'trade_date', type: 'varchar', length: 8 })
  tradeDate: string

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  open: string

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  high: string

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  low: string

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  close: string

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date
}
```

- [ ] **Step 2: 创建数据库表**

```bash
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "
CREATE TABLE IF NOT EXISTS oamv_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_date VARCHAR(8) NOT NULL,
  open NUMERIC(12,2) NOT NULL,
  high NUMERIC(12,2) NOT NULL,
  low NUMERIC(12,2) NOT NULL,
  close NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS IDX_oamv_daily_trade_date ON oamv_daily(trade_date);
"
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/entities/oamv/oamv-daily.entity.ts
git commit -m "feat(oamv): add OamvDailyEntity and database table"
```

---

## Task 2: 创建 0AMV 计算服务

**Files:**
- Create: `apps/server/src/market-data/oamv/oamv.types.ts`
- Create: `apps/server/src/market-data/oamv/oamv.service.ts`

- [ ] **Step 1: 创建类型定义**

```typescript
// apps/server/src/market-data/oamv/oamv.types.ts
export interface OamvCalcResult {
  tradeDate: string
  open: number
  high: number
  low: number
  close: number
}

export interface TushareIndexDaily {
  trade_date: string
  open: number
  high: number
  low: number
  close: number
  amount: number
}
```

- [ ] **Step 2: 创建 Service（包含计算逻辑）**

```typescript
// apps/server/src/market-data/oamv/oamv.service.ts
import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { OamvDailyEntity } from '../../entities/oamv/oamv-daily.entity'
import { TushareClientService } from '../a-shares/services/tushare-client.service'
import type { OamvCalcResult, TushareIndexDaily } from './oamv.types'

// 0AMV 参数
const OAMVN = 10
const OAMVK = 0.87
const OAMV_AMOUNT_DIV = 1_000_000

@Injectable()
export class OamvService {
  private readonly logger = new Logger(OamvService.name)

  constructor(
    @InjectRepository(OamvDailyEntity)
    private readonly repo: Repository<OamvDailyEntity>,
    private readonly tushareClient: TushareClientService,
  ) {}

  /**
   * 通达信风格 SMA 递推计算
   */
  private tdSma(values: number[], n: number = 10, m: number = 1): number[] {
    const result: number[] = []
    let sma: number | null = null

    for (const x of values) {
      if (x === null || x === undefined || isNaN(x)) {
        result.push(NaN)
        continue
      }
      if (sma === null) {
        sma = x
      } else {
        sma = (m * x + (n - m) * sma) / n
      }
      result.push(sma)
    }

    return result
  }

  /**
   * 通达信风格 EMA 递推计算
   */
  private tdEma(values: number[], n: number = 12): number[] {
    const result: number[] = []
    let ema: number | null = null

    for (const x of values) {
      if (x === null || x === undefined || isNaN(x)) {
        result.push(NaN)
        continue
      }
      if (ema === null) {
        ema = x
      } else {
        ema = (2 * x + (n - 1) * ema) / (n + 1)
      }
      result.push(ema)
    }

    return result
  }

  /**
   * 计算 0AMV 指标
   */
  calc0amv(data: TushareIndexDaily[]): OamvCalcResult[] {
    if (data.length === 0) return []

    // 按日期排序
    const sorted = [...data].sort((a, b) => a.trade_date.localeCompare(b.trade_date))

    // Step 1: 成交额平滑（tushare amount 单位是千元，需先 ×1000）
    const amountYuan = sorted.map(d => d.amount * 1000)
    const oamvv1Raw = this.tdSma(amountYuan, OAMVN, 1)
    const oamvv1 = oamvv1Raw.map(v => v / OAMV_AMOUNT_DIV)

    // Step 2: 价格基准（前一日收盘价的5日均线）
    const closes = sorted.map(d => d.close)
    const refClose1 = [NaN, ...closes.slice(0, -1)] // REF(CLOSE, 1)
    const oamvv3: number[] = []
    for (let i = 0; i < refClose1.length; i++) {
      const start = Math.max(0, i - 4)
      const window = refClose1.slice(start, i + 1).filter(v => !isNaN(v))
      oamvv3.push(window.length > 0 ? window.reduce((a, b) => a + b, 0) / window.length : NaN)
    }

    // Step 3: OAMV 四价
    const multiplier = 0.1 * OAMVK
    const results: OamvCalcResult[] = sorted.map((d, i) => ({
      tradeDate: d.trade_date,
      open: oamvv1[i] * d.open / oamvv3[i] * multiplier,
      high: oamvv1[i] * d.high / oamvv3[i] * multiplier,
      low: oamvv1[i] * d.low / oamvv3[i] * multiplier,
      close: oamvv1[i] * d.close / oamvv3[i] * multiplier,
    }))

    return results
  }

  /**
   * 从 Tushare 同步 0AMV 数据
   */
  async sync0amv(days: number = 60): Promise<{ synced: number }> {
    this.logger.log(`开始同步 0AMV 数据，天数: ${days}`)

    // 计算日期范围
    const endDate = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const startDate = new Date(Date.now() - (days + 20) * 86400000).toISOString().slice(0, 10).replace(/-/g, '')

    // 从 Tushare 拉取 930903.CSI 数据
    const fields = 'trade_date,open,high,low,close,amount'
    const rows = await this.tushareClient.query('index_daily', {
      ts_code: '930903.CSI',
      start_date: startDate,
      end_date: endDate,
    }, fields)

    if (!rows || rows.length === 0) {
      this.logger.warn('Tushare 返回空数据')
      return { synced: 0 }
    }

    this.logger.log(`从 Tushare 获取到 ${rows.length} 条数据`)

    // 转换为 TushareIndexDaily 类型
    const indexData: TushareIndexDaily[] = rows.map(r => ({
      trade_date: String(r.trade_date),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      amount: Number(r.amount),
    }))

    // 计算 0AMV
    const calcResults = this.calc0amv(indexData)

    // 过滤无效值并保存
    const validResults = calcResults.filter(r =>
      !isNaN(r.open) && !isNaN(r.high) && !isNaN(r.low) && !isNaN(r.close)
    )

    if (validResults.length === 0) {
      this.logger.warn('计算结果为空')
      return { synced: 0 }
    }

    // 使用 upsert 去重保存
    const entities = validResults.map(r => ({
      tradeDate: r.tradeDate,
      open: r.open.toFixed(2),
      high: r.high.toFixed(2),
      low: r.low.toFixed(2),
      close: r.close.toFixed(2),
    }))

    await this.repo
      .createQueryBuilder()
      .insert()
      .into(OamvDailyEntity)
      .values(entities)
      .orUpdate(['open', 'high', 'low', 'close'], ['tradeDate'])
      .execute()

    this.logger.log(`同步完成，保存 ${entities.length} 条数据`)
    return { synced: entities.length }
  }

  /**
   * 查询 0AMV 数据
   */
  async get0amvData(days: number = 250): Promise<OamvDailyEntity[]> {
    return this.repo.find({
      order: { tradeDate: 'ASC' },
      take: days,
    })
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/market-data/oamv/oamv.types.ts apps/server/src/market-data/oamv/oamv.service.ts
git commit -m "feat(oamv): add OamvService with 0AMV calculation logic"
```

---

## Task 3: 创建 0AMV Controller 和 Module

**Files:**
- Create: `apps/server/src/market-data/oamv/oamv.controller.ts`
- Create: `apps/server/src/market-data/oamv/oamv.module.ts`
- Modify: `apps/server/src/app.module.ts`

- [ ] **Step 1: 创建 Controller**

```typescript
// apps/server/src/market-data/oamv/oamv.controller.ts
import { Controller, Get, Post, Query } from '@nestjs/common'
import { OamvService } from './oamv.service'
import { AdminOnly } from '../../decorators/admin-only.decorator'

@Controller('oamv')
export class OamvController {
  constructor(private readonly oamvService: OamvService) {}

  @Post('sync')
  @AdminOnly()
  async sync0amv() {
    const result = await this.oamvService.sync0amv()
    return { success: true, ...result }
  }

  @Get('data')
  async get0amvData(@Query('days') days?: string) {
    const daysNum = days ? parseInt(days, 10) : 250
    return this.oamvService.get0amvData(daysNum)
  }
}
```

- [ ] **Step 2: 创建 Module**

```typescript
// apps/server/src/market-data/oamv/oamv.module.ts
import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { OamvDailyEntity } from '../../entities/oamv/oamv-daily.entity'
import { OamvController } from './oamv.controller'
import { OamvService } from './oamv.service'
import { TushareClientService } from '../a-shares/services/tushare-client.service'

@Module({
  imports: [TypeOrmModule.forFeature([OamvDailyEntity])],
  controllers: [OamvController],
  providers: [OamvService, TushareClientService],
})
export class OamvModule {}
```

- [ ] **Step 3: 注册到 AppModule**

在 `apps/server/src/app.module.ts` 的 imports 数组中添加 `OamvModule`：

```typescript
import { OamvModule } from './market-data/oamv/oamv.module'

@Module({
  imports: [
    // ... 其他模块
    OamvModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/market-data/oamv/oamv.controller.ts apps/server/src/market-data/oamv/oamv.module.ts apps/server/src/app.module.ts
git commit -m "feat(oamv): add OamvController and OamvModule, register in AppModule"
```

---

## Task 4: 创建前端 API 接口

**Files:**
- Create: `apps/web/src/api/modules/oamv.ts`

- [ ] **Step 1: 创建 API 模块**

```typescript
// apps/web/src/api/modules/oamv.ts
import { api } from '../client'

export interface OamvData {
  id: string
  tradeDate: string
  open: string
  high: string
  low: string
  close: string
  createdAt: string
}

export interface OamvSyncResult {
  success: boolean
  synced: number
}

export const oamvApi = {
  /**
   * 同步 0AMV 数据
   */
  sync(): Promise<OamvSyncResult> {
    return api.post('/oamv/sync')
  },

  /**
   * 获取 0AMV 数据
   */
  getData(days: number = 250): Promise<OamvData[]> {
    return api.get('/oamv/data', { params: { days } })
  },
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/api/modules/oamv.ts
git commit -m "feat(oamv): add frontend API module for 0AMV"
```

---

## Task 5: 创建 ActiveMarketValuePanel 组件

**Files:**
- Create: `apps/web/src/components/symbols/ActiveMarketValuePanel.vue`

- [ ] **Step 1: 创建组件**

```vue
<!-- apps/web/src/components/symbols/ActiveMarketValuePanel.vue -->
<template>
  <div class="active-mv-panel">
    <div class="panel-header">
      <div>
        <h2 class="panel-title">活跃市值（0AMV）</h2>
        <p class="panel-subtitle">中证A股指数 930903.CSI 活跃市值指标</p>
      </div>
      <n-button :loading="syncing" @click="handleSync">
        <template #icon><n-icon><sync-outline /></n-icon></template>
        同步数据
      </n-button>
    </div>

    <n-card :bordered="false">
      <n-spin :show="loading">
        <kline-chart v-if="chartData.length > 0" :data="chartData" height="600px" />
        <n-empty v-else description="暂无数据，请先同步" />
      </n-spin>
    </n-card>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ActiveMarketValuePanel' })

import { computed, onMounted, ref } from 'vue'
import { NButton, NCard, NEmpty, NIcon, NSpin, useMessage } from 'naive-ui'
import { SyncOutline } from '@vicons/ionicons5'
import KlineChart from '@/components/kline/KlineChart.vue'
import { oamvApi, type OamvData } from '@/api/modules/oamv'
import type { KlineChartBar } from '@/api'

const message = useMessage()
const loading = ref(false)
const syncing = ref(false)
const oamvData = ref<OamvData[]>([])

/**
 * 将 0AMV 数据转换为 KlineChartBar 格式
 */
const chartData = computed<KlineChartBar[]>(() => {
  return oamvData.map(d => {
    // 将 YYYYMMDD 格式转换为 YYYY-MM-DD
    const date = `${d.tradeDate.slice(0, 4)}-${d.tradeDate.slice(4, 6)}-${d.tradeDate.slice(6, 8)}`
    return {
      open_time: date,
      open: Number(d.open),
      high: Number(d.high),
      low: Number(d.low),
      close: Number(d.close),
      volume: 0, // 0AMV 无成交量概念
      // 其他字段设为 null
      MA5: null,
      MA30: null,
      MA60: null,
      MA120: null,
      MA240: null,
      'KDJ.K': null,
      'KDJ.D': null,
      'KDJ.J': null,
      DIF: null,
      DEA: null,
      MACD: null,
      brickChart: undefined,
    }
  })
})

async function loadData() {
  loading.value = true
  try {
    oamvData.value = await oamvApi.getData(250)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '加载数据失败')
  } finally {
    loading.value = false
  }
}

async function handleSync() {
  syncing.value = true
  try {
    const result = await oamvApi.sync()
    message.success(`同步完成，共 ${result.synced} 条数据`)
    await loadData()
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '同步失败')
  } finally {
    syncing.value = false
  }
}

onMounted(() => {
  void loadData()
})
</script>

<style scoped>
.active-mv-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.panel-title {
  margin: 0;
  font-size: 22px;
  line-height: 1.2;
}

.panel-subtitle {
  margin: 6px 0 0;
  color: var(--color-text-secondary);
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/symbols/ActiveMarketValuePanel.vue
git commit -m "feat(oamv): add ActiveMarketValuePanel component with KlineChart"
```

---

## Task 6: 修改 SymbolsView 添加新 TAB

**Files:**
- Modify: `apps/web/src/views/SymbolsView.vue`

- [ ] **Step 1: 修改 SymbolsView.vue**

```vue
<!-- apps/web/src/views/SymbolsView.vue -->
<template>
  <div class="symbols-view workspace-page">
    <div class="workspace-page-header symbols-header">
      <div>
        <h1 class="workspace-page-title">Symbols</h1>
        <p class="page-subtitle">标的工作台</p>
      </div>
      <div class="symbol-tabs" role="tablist" aria-label="标的类型">
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'crypto'"
          class="symbol-tabs__tab"
          :class="{ 'symbol-tabs__tab--active': activeTab === 'crypto' }"
          @click="activeTab = 'crypto'"
        >
          加密标的
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'aShares'"
          class="symbol-tabs__tab"
          :class="{ 'symbol-tabs__tab--active': activeTab === 'aShares' }"
          @click="activeTab = 'aShares'"
        >
          A 股数据
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'activeMarketValue'"
          class="symbol-tabs__tab"
          :class="{ 'symbol-tabs__tab--active': activeTab === 'activeMarketValue' }"
          @click="activeTab = 'activeMarketValue'"
        >
          活跃市值
        </button>
      </div>
    </div>

    <keep-alive>
      <crypto-symbols-panel v-if="activeTab === 'crypto'" />
      <a-shares-panel v-else-if="activeTab === 'aShares'" />
      <active-market-value-panel v-else />
    </keep-alive>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'SymbolsView' })

import { ref } from 'vue'
import ASharesPanel from '../components/symbols/ASharesPanel.vue'
import CryptoSymbolsPanel from '../components/symbols/CryptoSymbolsPanel.vue'
import ActiveMarketValuePanel from '../components/symbols/ActiveMarketValuePanel.vue'

const activeTab = ref<'crypto' | 'aShares' | 'activeMarketValue'>('crypto')
</script>

<style scoped>
.symbols-view { max-width: 1400px; }
.symbols-header { align-items: center; }
.page-subtitle { margin: 6px 0 0; color: var(--color-text-secondary); }

.symbol-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 0 2px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
}

.symbol-tabs__tab {
  position: relative;
  margin: 0;
  padding: 10px 16px 12px;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: color 0.2s ease;
}

.symbol-tabs__tab:hover {
  color: var(--color-text);
}

.symbol-tabs__tab:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
  border-radius: 4px;
}

.symbol-tabs__tab--active {
  color: var(--color-text);
}

.symbol-tabs__tab--active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  background: var(--color-primary);
  border-radius: 2px 2px 0 0;
  opacity: 1;
  transform: scaleX(1);
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.symbol-tabs__tab:not(.symbol-tabs__tab--active)::after {
  opacity: 0;
  transform: scaleX(0.6);
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/views/SymbolsView.vue
git commit -m "feat(oamv): add Active Market Value tab to SymbolsView"
```

---

## Task 7: 修改数据同步页面添加 0AMV 同步按钮

**Files:**
- Modify: `apps/web/src/views/sync/SyncView.vue`

- [ ] **Step 1: 在 SyncView.vue 中添加 0AMV 同步区域**

在资金流向同步区域后面添加新的 section：

```vue
<!-- 在 SyncView.vue 的 template 中添加 -->
<section class="data-source-card">
  <h3>活跃市值（0AMV）</h3>
  <p>中证A股指数 930903.CSI 的活跃市值指标</p>
  <n-button
    block
    secondary
    type="primary"
    :loading="oamvSyncing"
    @click="syncOamv"
  >
    同步 0AMV
  </n-button>
</section>
```

- [ ] **Step 2: 添加同步逻辑**

在 `<script setup>` 中添加：

```typescript
import { oamvApi } from '@/api/modules/oamv'

const oamvSyncing = ref(false)

async function syncOamv() {
  oamvSyncing.value = true
  try {
    const result = await oamvApi.sync()
    message.success(`0AMV 同步完成，共 ${result.synced} 条数据`)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '0AMV 同步失败')
  } finally {
    oamvSyncing.value = false
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/views/sync/SyncView.vue
git commit -m "feat(oamv): add 0AMV sync button to SyncView"
```

---

## Task 8: 验证和测试

- [ ] **Step 1: 启动后端服务**

```bash
cd c:\codes\cryptotrading
pnpm --filter @cryptotrading/server start:dev
```

- [ ] **Step 2: 测试同步 API**

```bash
curl -X POST http://localhost:3000/api/oamv/sync
```

预期返回：`{"success":true,"synced":N}`

- [ ] **Step 3: 测试查询 API**

```bash
curl http://localhost:3000/api/oamv/data?days=10
```

预期返回：0AMV 数据数组

- [ ] **Step 4: 启动前端服务**

```bash
cd c:\codes\cryptotrading
pnpm --filter @cryptotrading/web dev
```

- [ ] **Step 5: 验证页面**

1. 打开 Symbols 页面
2. 点击"活跃市值" TAB
3. 验证 K 线图显示
4. 点击"同步数据"按钮
5. 验证数据更新

- [ ] **Step 6: Final Commit**

```bash
git add -A
git commit -m "feat(oamv): complete active market value feature"
```

---

## 验收标准

- [ ] Symbols 页面显示"活跃市值" TAB
- [ ] 点击 TAB 展示 0AMV K 线图
- [ ] K 线图显示 1 年数据（约 250 个交易日）
- [ ] 数据同步页面可手动触发 0AMV 同步
- [ ] 同步完成后 K 线图自动刷新
- [ ] 无 TypeScript 编译错误
- [ ] 无 ESLint 警告
