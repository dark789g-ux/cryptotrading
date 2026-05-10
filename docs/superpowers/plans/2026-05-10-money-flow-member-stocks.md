# Money Flow 成分股列表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Money Flow 行业/板块详情 Modal 中新增成分股列表 Tab，同步时从 Tushare `ths_member` 拉取成分股映射存入本地 DB。

**Architecture:** 新建 `ths_member_stocks` 表存储行业/板块→成分股映射。同步资金流数据时自动调用 Tushare `ths_member` 拉取映射。前端 FlowTrendModal 改为 Tab 布局（趋势 / 成分股），成分股 Tab 懒加载。

**Tech Stack:** NestJS + TypeORM + PostgreSQL + Vue 3 + Naive UI + Tushare API

---

### Task 1: 数据库 — 创建 ths_member_stocks 表

**Files:**
- Execute: `docker exec crypto-postgres psql` (DDL)

- [ ] **Step 1: 创建表和索引**

```sql
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "
CREATE TABLE IF NOT EXISTS ths_member_stocks (
  id        SERIAL PRIMARY KEY,
  ts_code   VARCHAR(20) NOT NULL,
  con_code  VARCHAR(20) NOT NULL,
  con_name  VARCHAR(50),
  is_new    VARCHAR(2),
  UNIQUE (ts_code, con_code)
);
CREATE INDEX IF NOT EXISTS idx_ths_member_stocks_ts_code ON ths_member_stocks (ts_code);
"
```

Expected: `CREATE TABLE` + `CREATE INDEX` 无报错

- [ ] **Step 2: 验证表结构**

```sql
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d ths_member_stocks"
```

Expected: 显示 id, ts_code, con_code, con_name, is_new 列及唯一约束

- [ ] **Step 3: Commit**

```bash
git add .
git commit -m "db: create ths_member_stocks table for industry/sector member mapping"
```

---

### Task 2: Entity — 创建 ThsMemberStockEntity

**Files:**
- Create: `apps/server/src/entities/money-flow/ths-member-stock.entity.ts`

- [ ] **Step 1: 创建实体文件**

```typescript
// apps/server/src/entities/money-flow/ths-member-stock.entity.ts
import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('ths_member_stocks')
@Unique(['tsCode', 'conCode'])
export class ThsMemberStockEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'ts_code', length: 20 })
  tsCode: string;

  @Column({ name: 'con_code', length: 20 })
  conCode: string;

  @Column({ name: 'con_name', length: 50, nullable: true })
  conName: string | null;

  @Column({ name: 'is_new', length: 2, nullable: true })
  isNew: string | null;
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
npx tsc --noEmit -p apps/server/tsconfig.json
```

Expected: 无报错（可能有其他文件的已有报错，只要新增文件无错即可）

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/entities/money-flow/ths-member-stock.entity.ts
git commit -m "feat(entity): add ThsMemberStockEntity for member stock mapping"
```

---

### Task 3: 共享类型 — 新增 MoneyFlowMemberRow

**Files:**
- Modify: `packages/shared-types/src/money-flow.ts`

- [ ] **Step 1: 在文件末尾追加 MoneyFlowMemberRow 接口**

在 `packages/shared-types/src/money-flow.ts` 文件末尾（`MoneyFlowMarketRow` 接口之后）追加：

```typescript
/** GET /money-flow/members 单行（ths_member_stocks 成分股映射） */
export interface MoneyFlowMemberRow {
  tsCode: string
  conCode: string
  conName: string | null
  isNew: string | null
}
```

- [ ] **Step 2: 验证 shared-types 编译**

```bash
pnpm --filter @cryptotrading/shared-types build
```

Expected: 无报错

- [ ] **Step 3: Commit**

```bash
git add packages/shared-types/src/money-flow.ts
git commit -m "feat(shared-types): add MoneyFlowMemberRow interface"
```

---

### Task 4: DTO — 创建 QueryMemberDto

**Files:**
- Create: `apps/server/src/market-data/money-flow/dto/query-member.dto.ts`

- [ ] **Step 1: 创建 DTO 文件**

```typescript
// apps/server/src/market-data/money-flow/dto/query-member.dto.ts
export class QueryMemberDto {
  /** 行业/板块的 THS 指数代码（如 881101.TI） */
  ts_code!: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/market-data/money-flow/dto/query-member.dto.ts
git commit -m "feat(dto): add QueryMemberDto for member stock query"
```

---

### Task 5: 同步服务 — 新增 syncMembers() 方法

**Files:**
- Modify: `apps/server/src/market-data/money-flow/money-flow-sync.service.ts`

- [ ] **Step 1: 添加 import 和构造函数注入**

在 `money-flow-sync.service.ts` 顶部 import 中新增 `ThsMemberStockEntity`：

```typescript
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
```

在构造函数中新增 `ThsMemberStockEntity` 的 repository 注入：

```typescript
@InjectRepository(ThsMemberStockEntity)
private readonly memberRepo: Repository<ThsMemberStockEntity>,
```

- [ ] **Step 2: 添加 syncMembers 方法**

在 `MoneyFlowSyncService` 类中（`syncMarket` 方法之后）添加：

```typescript
// ths_member: https://tushare.pro/wctapi/documents/261.md
const MEMBER_FIELDS = 'ts_code,con_code,con_name,is_new';

/**
 * 同步行业/板块成分股映射。
 * @param dimension 'industry' | 'sector' — 决定从哪张表取 ts_code 列表
 */
async syncMembers(dimension: 'industry' | 'sector'): Promise<MoneyFlowSyncResult> {
  const errors: string[] = [];
  const repo = dimension === 'industry' ? this.industryRepo : this.sectorRepo;

  // 从已同步的资金流表中取 DISTINCT ts_code
  const rows = await repo
    .createQueryBuilder('e')
    .select('DISTINCT e.ts_code', 'tsCode')
    .getRawMany<{ tsCode: string }>();
  const tsCodes = rows.map(r => r.tsCode).filter(Boolean);

  if (!tsCodes.length) {
    this.logger.warn(`syncMembers(${dimension}): 无 ts_code，请先同步${dimension === 'industry' ? '行业' : '板块'}资金流数据`);
    return { success: 0, skipped: 0, errors };
  }

  let success = 0;
  for (const tsCode of tsCodes) {
    try {
      const rows = await this.tushareClient.query(
        'ths_member',
        { ts_code: tsCode },
        MEMBER_FIELDS,
      );

      if (!rows.length) {
        this.logger.warn(`ths_member(${tsCode}) 返回空数据`);
        continue;
      }

      // 先删除该 ts_code 的旧数据，再批量插入
      await this.memberRepo.createQueryBuilder()
        .delete()
        .where('ts_code = :tsCode', { tsCode })
        .execute();

      const entities = rows.map(r => this.memberRepo.create({
        tsCode: asString(r.ts_code),
        conCode: asString(r.con_code),
        conName: asString(r.con_name) || null,
        isNew: asString(r.is_new) || null,
      }));

      const deduped = deduplicateBy(entities, ['tsCode', 'conCode']);
      const chunkSize = 1000;
      for (let i = 0; i < deduped.length; i += chunkSize) {
        await this.memberRepo.upsert(deduped.slice(i, i + chunkSize) as any, ['tsCode', 'conCode']);
      }
      success += deduped.length;
    } catch (e: unknown) {
      const msg = `[${tsCode}] ${String(e)}`;
      this.logger.warn(`syncMembers(${dimension}) 失败: ${msg}`);
      errors.push(msg);
    }
  }

  return { success, skipped: 0, errors };
}
```

- [ ] **Step 3: 修改 syncIndustries 和 syncSectors，同步完成后自动触发成员同步**

在 `syncIndustries` 方法的 `return` 语句之前添加：

```typescript
// 行业资金流同步完成后，自动同步成分股映射
const memberResult = await this.syncMembers('industry');
if (memberResult.errors.length) {
  errors.push(...memberResult.errors);
}
this.logger.log(`syncIndustries 完成: 资金流 ${success} 条, 成分股 ${memberResult.success} 条`);
```

将 `syncIndustries` 的 `return` 改为：

```typescript
return { success, skipped, errors };
```

同样在 `syncSectors` 方法的 `return` 之前添加：

```typescript
// 板块资金流同步完成后，自动同步成分股映射
const memberResult = await this.syncMembers('sector');
if (memberResult.errors.length) {
  errors.push(...memberResult.errors);
}
this.logger.log(`syncSectors 完成: 资金流 ${success} 条, 成分股 ${memberResult.success} 条`);
```

- [ ] **Step 4: 验证 TypeScript 编译**

```bash
pnpm --filter @cryptotrading/server build
```

Expected: 无新增报错

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/market-data/money-flow/money-flow-sync.service.ts
git commit -m "feat(sync): add syncMembers() and auto-trigger after industry/sector sync"
```

---

### Task 6: 同步控制器 — 新增独立同步端点

**Files:**
- Modify: `apps/server/src/market-data/money-flow/money-flow-sync.controller.ts`

- [ ] **Step 1: 添加 import 和端点**

在 `money-flow-sync.controller.ts` 顶部新增 import：

```typescript
import { QueryMemberDto } from './dto/query-member.dto';
```

在 `MoneyFlowSyncController` 类末尾添加：

```typescript
@Post('members')
@AdminOnly()
syncMembers(@Body() dto: QueryMemberDto) {
  const dimension = dto.ts_code === 'sector' ? 'sector' : 'industry';
  return this.syncService.syncMembers(dimension);
}
```

> 注意：独立端点接受 `QueryMemberDto`，`ts_code` 字段复用为维度标识（`'industry'` 或 `'sector'`）。也可设计为无入参同时同步两个维度。这里选择带维度参数，更灵活。

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
pnpm --filter @cryptotrading/server build
```

Expected: 无新增报错

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/market-data/money-flow/money-flow-sync.controller.ts
git commit -m "feat(sync): add POST /money-flow/sync/members endpoint"
```

---

### Task 7: 查询服务 — 新增 queryMembers() 方法

**Files:**
- Modify: `apps/server/src/market-data/money-flow/money-flow.service.ts`

- [ ] **Step 1: 添加 import**

在 `money-flow.service.ts` 顶部 import 中新增：

```typescript
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
import type { MoneyFlowMemberRow } from '@cryptotrading/shared-types';
```

在构造函数中新增：

```typescript
@InjectRepository(ThsMemberStockEntity)
private readonly memberRepo: Repository<ThsMemberStockEntity>,
```

- [ ] **Step 2: 添加 queryMembers 方法**

在 `MoneyFlowService` 类中（`getLatestDates` 方法之后）添加：

```typescript
async queryMembers(tsCode: string): Promise<MoneyFlowMemberRow[]> {
  return this.memberRepo
    .createQueryBuilder('m')
    .where('m.ts_code = :tsCode', { tsCode })
    .orderBy('m.con_code', 'ASC')
    .getMany();
}
```

- [ ] **Step 3: 验证 TypeScript 编译**

```bash
pnpm --filter @cryptotrading/server build
```

Expected: 无新增报错

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/market-data/money-flow/money-flow.service.ts
git commit -m "feat(query): add queryMembers() for member stock lookup"
```

---

### Task 8: 查询控制器 — 新增 GET /money-flow/members 端点

**Files:**
- Modify: `apps/server/src/market-data/money-flow/money-flow.controller.ts`

- [ ] **Step 1: 添加 import 和端点**

在 `money-flow.controller.ts` 顶部新增 import：

```typescript
import { QueryMemberDto } from './dto/query-member.dto';
```

在 `MoneyFlowController` 类末尾添加：

```typescript
@Get('members')
queryMembers(@Query() dto: QueryMemberDto) {
  return this.moneyFlowService.queryMembers(dto.ts_code);
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
pnpm --filter @cryptotrading/server build
```

Expected: 无新增报错

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/market-data/money-flow/money-flow.controller.ts
git commit -m "feat(api): add GET /money-flow/members endpoint"
```

---

### Task 9: Module — 注册新 Entity

**Files:**
- Modify: `apps/server/src/market-data/money-flow/money-flow.module.ts`

- [ ] **Step 1: 添加 import 和注册**

在 `money-flow.module.ts` 顶部新增 import：

```typescript
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
```

在 `TypeOrmModule.forFeature` 数组中新增 `ThsMemberStockEntity`：

```typescript
TypeOrmModule.forFeature([
  AShareSymbolEntity,
  MoneyFlowStockEntity,
  MoneyFlowIndustryEntity,
  MoneyFlowSectorEntity,
  MoneyFlowMarketEntity,
  ThsMemberStockEntity,  // 新增
]),
```

- [ ] **Step 2: 验证后端编译**

```bash
pnpm --filter @cryptotrading/server build
```

Expected: 无新增报错

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/market-data/money-flow/money-flow.module.ts
git commit -m "feat(module): register ThsMemberStockEntity in MoneyFlowModule"
```

---

### Task 10: 前端 API — 新增 getMembers 和 re-export 类型

**Files:**
- Modify: `apps/web/src/api/modules/moneyFlow.ts`

- [ ] **Step 1: 新增类型 re-export**

在 `apps/web/src/api/modules/moneyFlow.ts` 的 `export type { ... }` 块中新增 `MoneyFlowMemberRow`：

```typescript
export type {
  MoneyFlowQueryParams,
  MoneyFlowSyncParams,
  MoneyFlowSyncResult,
  MoneyFlowLatestDates,
  MoneyFlowStockRow,
  MoneyFlowIndustryRow,
  MoneyFlowSectorRow,
  MoneyFlowMarketRow,
  MoneyFlowMemberRow,  // 新增
} from '@cryptotrading/shared-types'
```

在 `import type { ... }` 块中也新增：

```typescript
import type {
  MoneyFlowQueryParams,
  MoneyFlowSyncParams,
  MoneyFlowSyncResult,
  MoneyFlowLatestDates,
  MoneyFlowStockRow,
  MoneyFlowIndustryRow,
  MoneyFlowSectorRow,
  MoneyFlowMarketRow,
  MoneyFlowMemberRow,  // 新增
} from '@cryptotrading/shared-types'
```

- [ ] **Step 2: 新增 getMembers 方法**

在 `moneyFlowApi` 对象中（`syncMarket` 之后）添加：

```typescript
getMembers: (tsCode: string) =>
  request<MoneyFlowMemberRow[]>(`${API_BASE}/money-flow/members?ts_code=${encodeURIComponent(tsCode)}`),
```

- [ ] **Step 3: 验证前端编译**

```bash
pnpm --filter @cryptotrading/web build
```

Expected: 无新增报错

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/api/modules/moneyFlow.ts
git commit -m "feat(api): add getMembers() and MoneyFlowMemberRow type export"
```

---

### Task 11: 前端 Modal — FlowTrendModal 改造为 Tab 布局

**Files:**
- Modify: `apps/web/src/components/money-flow/FlowTrendModal.vue`

- [ ] **Step 1: 改造 FlowTrendModal 为 Tab 布局**

将 `apps/web/src/components/money-flow/FlowTrendModal.vue` 整体替换为：

```vue
<!-- apps/web/src/components/money-flow/FlowTrendModal.vue -->
<template>
  <AppModal
    :show="visible"
    :title="`${entityName} — 详情`"
    width="min(720px, 92vw)"
    @update:show="$emit('update:visible', $event)"
  >
    <n-tabs v-model:value="activeTab" type="line" animated>
      <n-tab-pane name="trend" tab="趋势">
        <div class="trend-modal-body">
          <FlowDateControl
            :hide-mode-toggle="false"
            default-mode="range"
            :default-range-days="30"
            @change="onDateChange"
          />
          <FlowTrendChart :rows="chartRows" />
        </div>
      </n-tab-pane>

      <n-tab-pane v-if="showMembersTab" name="members" tab="成分股">
        <div class="members-body">
          <n-spin :show="membersLoading">
            <n-data-table
              :columns="memberColumns"
              :data="memberRows"
              :max-height="400"
              size="small"
              :pagination="{ pageSize: 50 }"
            />
            <div v-if="!membersLoading && !memberRows.length" class="empty-state">
              暂无成分股数据，请先同步资金流数据。
            </div>
          </n-spin>
        </div>
      </n-tab-pane>
    </n-tabs>

    <template #actions>
      <n-button @click="$emit('update:visible', false)">关闭</n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
defineOptions({ name: 'FlowTrendModal' })

import { h, ref, watch } from 'vue'
import { NButton, NDataTable, NSpin, NTabPane, NTabs } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import FlowDateControl from './FlowDateControl.vue'
import FlowTrendChart from './FlowTrendChart.vue'
import { moneyFlowApi, type MoneyFlowMemberRow, type MoneyFlowQueryParams } from '@/api/modules/moneyFlow'
import type { BarChartRow } from './money-flow.types'

const props = withDefaults(defineProps<{
  visible: boolean
  tsCode: string
  entityName: string
  fetchFn: (params: MoneyFlowQueryParams) => Promise<BarChartRow[]>
  showMembersTab?: boolean
}>(), {
  showMembersTab: false,
})

defineEmits<{
  'update:visible': [value: boolean]
}>()

const activeTab = ref('trend')
const chartRows = ref<BarChartRow[]>([])
const loading = ref(false)
let skipNextEmit = false

// 成分股相关
const memberRows = ref<MoneyFlowMemberRow[]>([])
const membersLoading = ref(false)
let membersLoaded = false

const memberColumns: DataTableColumns<MoneyFlowMemberRow> = [
  {
    title: '#',
    key: 'index',
    width: 50,
    render: (_row, index) => h('span', {}, String(index + 1)),
  },
  { title: '代码', key: 'conCode', width: 120 },
  { title: '名称', key: 'conName', width: 150 },
]

async function loadLatest() {
  loading.value = true
  try {
    const data = await props.fetchFn({ ts_code: props.tsCode, limit: 30 })
    chartRows.value = [...data].reverse()
  } catch {
    chartRows.value = []
  } finally {
    loading.value = false
  }
}

async function loadByDate(params: MoneyFlowQueryParams) {
  loading.value = true
  try {
    chartRows.value = await props.fetchFn({ ...params, ts_code: props.tsCode })
  } catch {
    chartRows.value = []
  } finally {
    loading.value = false
  }
}

function onDateChange(params: MoneyFlowQueryParams) {
  if (skipNextEmit) {
    skipNextEmit = false
    return
  }
  loadByDate(params)
}

async function loadMembers() {
  if (membersLoaded) return
  membersLoading.value = true
  try {
    memberRows.value = await moneyFlowApi.getMembers(props.tsCode)
    membersLoaded = true
  } catch {
    memberRows.value = []
  } finally {
    membersLoading.value = false
  }
}

watch(() => props.visible, (v) => {
  if (v) {
    chartRows.value = []
    memberRows.value = []
    membersLoaded = false
    activeTab.value = 'trend'
    skipNextEmit = true
    loadLatest()
  }
})

watch(activeTab, (tab) => {
  if (tab === 'members' && props.showMembersTab) {
    loadMembers()
  }
})
</script>

<style scoped>
.trend-modal-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.members-body {
  min-height: 200px;
}
.empty-state {
  color: var(--color-text-muted);
  text-align: center;
  padding: 40px;
}
</style>
```

- [ ] **Step 2: 验证前端编译**

```bash
pnpm --filter @cryptotrading/web build
```

Expected: 无新增报错

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/money-flow/FlowTrendModal.vue
git commit -m "feat(modal): add members tab to FlowTrendModal with lazy loading"
```

---

### Task 12: 前端面板 — 传递 showMembersTab prop

**Files:**
- Modify: `apps/web/src/components/money-flow/IndustryFlowPanel.vue`
- Modify: `apps/web/src/components/money-flow/SectorFlowPanel.vue`

- [ ] **Step 1: IndustryFlowPanel 添加 show-members-tab**

在 `IndustryFlowPanel.vue` 的 `<FlowTrendModal>` 标签上新增 prop：

```vue
<FlowTrendModal
  v-model:visible="trendVisible"
  :ts-code="trendTsCode"
  :entity-name="trendEntityName"
  :fetch-fn="trendFetchFn"
  :show-members-tab="true"
/>
```

- [ ] **Step 2: SectorFlowPanel 添加 show-members-tab**

在 `SectorFlowPanel.vue` 的 `<FlowTrendModal>` 标签上新增 prop：

```vue
<FlowTrendModal
  v-model:visible="trendVisible"
  :ts-code="trendTsCode"
  :entity-name="trendEntityName"
  :fetch-fn="trendFetchFn"
  :show-members-tab="true"
/>
```

- [ ] **Step 3: 验证前端编译**

```bash
pnpm --filter @cryptotrading/web build
```

Expected: 无新增报错

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/money-flow/IndustryFlowPanel.vue apps/web/src/components/money-flow/SectorFlowPanel.vue
git commit -m "feat(panel): pass showMembersTab to FlowTrendModal in industry/sector panels"
```

---

### Task 13: 端到端验证

**Files:**
- None (manual verification)

- [ ] **Step 1: 重启后端服务**

```bash
cd apps/server && pnpm start
```

Expected: 服务启动无报错，日志中看到 `MoneyFlowModule` 依赖解析成功

- [ ] **Step 2: 手动触发成员同步并验证数据**

```bash
# 同步行业资金流（会自动触发成分股同步）
curl -X POST http://localhost:3000/money-flow/sync/industries \
  -H "Content-Type: application/json" \
  -d '{"start_date":"20260509","end_date":"20260509"}'
```

Expected: 返回 JSON 包含 `success > 0`，日志中看到 `syncIndustries 完成: 资金流 X 条, 成分股 Y 条`

- [ ] **Step 3: 验证成分股查询 API**

```bash
# 用一个已知的行业 ts_code 查询成分股
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT DISTINCT ts_code FROM money_flow_industries LIMIT 1;"
```

取返回的 ts_code（如 `881101.TI`），然后：

```bash
curl "http://localhost:3000/money-flow/members?ts_code=881101.TI"
```

Expected: 返回 JSON 数组，每行包含 `tsCode`、`conCode`、`conName`，按 `conCode` 升序

- [ ] **Step 4: 前端验证**

启动前端 dev server，在 Money Flow 页面：
1. 切换到行业 Tab，点击某行业行的"详情"按钮
2. Modal 打开后，应看到两个 Tab：「趋势」和「成分股」
3. 点击「成分股」Tab，应显示该行业的成分股列表（序号、代码、名称）
4. 切换到板块 Tab，重复验证

Expected: 成分股 Tab 正常显示，数据与后端 API 返回一致
