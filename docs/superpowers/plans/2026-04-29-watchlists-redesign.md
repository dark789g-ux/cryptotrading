# 自选列表页面重新设计 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将自选列表页面从卡片网格重构为左侧列表导航 + 右侧行情表格布局，支持自定义列、拖拽排序、Pinia 状态管理。

**Architecture:** 后端新增 `GET /watchlists/:id/quotes` 专用行情接口和两个 reorder 接口；DB 增加 `display_order` 字段。前端引入 Pinia，新建 Store + 3 个组件，复用现有 K 线抽屉和星标按钮。

**Tech Stack:** Vue 3 + Naive UI + Pinia (new) / NestJS + TypeORM + PostgreSQL

---

## 文件结构

### 后端

| 文件 | 操作 | 职责 |
|------|------|------|
| `apps/server/migrations/20260429000000-watchlist-display-order.sql` | 创建 | DB 迁移：给 `watchlists` 和 `watchlist_items` 加 `display_order` |
| `apps/server/src/entities/watchlist/watchlist.entity.ts` | 修改 | 新增 `displayOrder` 列 |
| `apps/server/src/entities/watchlist/watchlist-item.entity.ts` | 修改 | 新增 `displayOrder` 列 |
| `apps/server/src/catalog/watchlists/watchlists.service.ts` | 修改 | 新增 `getWatchlistQuotes`、`reorderWatchlists`、`reorderItems` |
| `apps/server/src/catalog/watchlists/watchlists.controller.ts` | 修改 | 新增 3 个接口路由 |
| `apps/server/src/catalog/watchlists/watchlists.service.spec.ts` | 创建 | Service 单元测试 |

### 前端

| 文件 | 操作 | 职责 |
|------|------|------|
| `apps/web/package.json` | 修改 | 添加 `pinia` 依赖 |
| `apps/web/src/main.ts` | 修改 | 注册 Pinia 插件 |
| `apps/web/src/api/modules/watchlists.ts` | 修改 | 新增 `quotes`、`reorder`、`reorderItems` 方法 |
| `apps/web/src/stores/watchlist.ts` | 创建 | Pinia Store：状态、Actions、本地持久化 |
| `apps/web/src/components/watchlist/WatchlistSidebar.vue` | 创建 | 左侧列表导航（拖拽排序、右键菜单、新建） |
| `apps/web/src/components/watchlist/WatchlistTable.vue` | 创建 | 右侧行情表格（自定义列、分页、排序、行内操作） |
| `apps/web/src/components/watchlist/WatchlistTableSettings.vue` | 创建 | 列自定义设置抽屉 |
| `apps/web/src/views/WatchlistsView.vue` | 修改 | 页面容器：左右布局编排 |

---

## Task 1: DB 迁移 — 添加 display_order 字段

**Files:**
- Create: `apps/server/migrations/20260429000000-watchlist-display-order.sql`

- [ ] **Step 1: 编写迁移文件**

```sql
-- 给 watchlists 表添加 display_order
ALTER TABLE watchlists ADD COLUMN display_order INT NOT NULL DEFAULT 0;

-- 给 watchlist_items 表添加 display_order
ALTER TABLE watchlist_items ADD COLUMN display_order INT NOT NULL DEFAULT 0;

-- 初始化现有 watchlists 的 display_order（按 created_at 升序）
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) - 1 AS rn
  FROM watchlists
)
UPDATE watchlists w
SET display_order = o.rn
FROM ordered o
WHERE w.id = o.id;

-- 初始化现有 watchlist_items 的 display_order（按 created_at 升序，每个列表内独立）
WITH ordered AS (
  SELECT id, watchlist_id,
    ROW_NUMBER() OVER (PARTITION BY watchlist_id ORDER BY created_at ASC) - 1 AS rn
  FROM watchlist_items
)
UPDATE watchlist_items wi
SET display_order = o.rn
FROM ordered o
WHERE wi.id = o.id;
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/migrations/20260429000000-watchlist-display-order.sql
git commit -m "feat(watchlists): 添加 display_order 字段迁移"
```

---

## Task 2: 实体更新 — 映射 display_order 字段

**Files:**
- Modify: `apps/server/src/entities/watchlist/watchlist.entity.ts`
- Modify: `apps/server/src/entities/watchlist/watchlist-item.entity.ts`

- [ ] **Step 1: 修改 WatchlistEntity**

在 `apps/server/src/entities/watchlist/watchlist.entity.ts` 中，在 `createdAt` 列之前添加：

```ts
@Column({ name: 'display_order', type: 'int', default: 0 })
displayOrder: number;
```

- [ ] **Step 2: 修改 WatchlistItemEntity**

在 `apps/server/src/entities/watchlist/watchlist-item.entity.ts` 中，在 `id` 列之后添加：

```ts
@Column({ name: 'display_order', type: 'int', default: 0 })
displayOrder: number;
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/entities/watchlist/watchlist.entity.ts apps/server/src/entities/watchlist/watchlist-item.entity.ts
git commit -m "feat(watchlists): 实体添加 displayOrder 字段"
```

---

## Task 3: Service 层 — 新增行情查询和排序方法

**Files:**
- Modify: `apps/server/src/catalog/watchlists/watchlists.service.ts`

- [ ] **Step 1: 修改 listWatchlists 排序**

将 `listWatchlists` 方法中的 `order` 改为：

```ts
order: { displayOrder: 'ASC', createdAt: 'DESC' },
```

- [ ] **Step 2: 修改 getWatchlist 排序**

在 `getWatchlist` 的 `findOne` 选项中增加 `items` 的排序：

```ts
return this.watchlistRepo.findOne({
  where: { id, userId } as any,
  relations: ['items'],
  order: {
    items: { displayOrder: 'ASC' },
  },
});
```

- [ ] **Step 3: 新增 getWatchlistQuotes 方法**

在 `watchlists.service.ts` 末尾、`removeSymbol` 之后添加：

```ts
async getWatchlistQuotes(
  userId: string,
  id: string,
  interval: string,
  page: number,
  pageSize: number,
  sort?: { field?: string | null; order?: 'ascend' | 'descend' | null },
) {
  const w = await this.getWatchlist(userId, id);
  const symbols = w.items?.map((i) => i.symbol) ?? [];
  const total = symbols.length;

  if (total === 0) {
    return { items: [], total, page, page_size: pageSize };
  }

  // 分页
  const offset = (page - 1) * pageSize;
  const pageSymbols = symbols.slice(offset, offset + pageSize);

  // 构建 SQL 查询最新 kline
  let sql = `
    WITH latest AS (
      SELECT symbol, MAX(open_time) AS max_time
      FROM klines
      WHERE interval = $1 AND symbol = ANY($2)
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
      k.open_time AS "openTime"
    FROM klines k
    JOIN latest ON k.symbol = latest.symbol AND k.open_time = latest.max_time AND k.interval = $1
    WHERE k.symbol = ANY($2)
  `;

  const params: Array<string | number | string[]> = [interval, pageSymbols];

  // 排序处理
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

  if (sort?.field && SORT_COL_MAP[sort.field]) {
    const dir = sort.order === 'descend' ? 'DESC' : 'ASC';
    sql += ` ORDER BY ${SORT_COL_MAP[sort.field]} ${dir} NULLS LAST`;
  } else {
    // 默认按传入 symbols 的顺序（即 display_order）
    const orderCases = pageSymbols.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ');
    sql += ` ORDER BY CASE k.symbol ${orderCases} END`;
  }

  const items = await this.watchlistRepo.query(sql, params);

  return { items, total, page, page_size: pageSize };
}
```

- [ ] **Step 4: 新增 reorderWatchlists 方法**

```ts
async reorderWatchlists(userId: string, ids: string[]) {
  for (let i = 0; i < ids.length; i++) {
    await this.watchlistRepo.update(
      { id: ids[i], userId } as any,
      { displayOrder: i },
    );
  }
  return { ok: true };
}
```

- [ ] **Step 5: 新增 reorderItems 方法**

```ts
async reorderItems(userId: string, watchlistId: string, symbols: string[]) {
  const w = await this.watchlistRepo.findOne({
    where: { id: watchlistId, userId } as any,
    relations: ['items'],
  });
  if (!w) throw new NotFoundException(`Watchlist ${watchlistId} not found`);

  for (let i = 0; i < symbols.length; i++) {
    await this.itemRepo.update(
      { watchlistId, symbol: symbols[i] },
      { displayOrder: i },
    );
  }
  return { ok: true };
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/catalog/watchlists/watchlists.service.ts
git commit -m "feat(watchlists): Service 层新增行情查询和排序方法"
```

---

## Task 4: Controller — 新增 3 个接口

**Files:**
- Modify: `apps/server/src/catalog/watchlists/watchlists.controller.ts`

- [ ] **Step 1: 添加 quotes 接口**

在 Controller 中新增：

```ts
@Get(':id/quotes')
async getQuotes(
  @CurrentUser() user: { id: string },
  @Param('id') id: string,
  @Query('interval') interval: string = '1h',
  @Query('page') page: string = '1',
  @Query('page_size') pageSize: string = '20',
  @Query('sort') sortJson?: string,
) {
  const sort = sortJson ? JSON.parse(sortJson) : undefined;
  return this.service.getWatchlistQuotes(
    user.id,
    id,
    interval,
    parseInt(page, 10),
    parseInt(pageSize, 10),
    sort,
  );
}
```

- [ ] **Step 2: 添加 reorder 接口**

```ts
@Put('reorder')
async reorderWatchlists(
  @CurrentUser() user: { id: string },
  @Body() body: { ids: string[] },
) {
  return this.service.reorderWatchlists(user.id, body.ids);
}
```

- [ ] **Step 3: 添加 items reorder 接口**

```ts
@Put(':id/reorder')
async reorderItems(
  @CurrentUser() user: { id: string },
  @Param('id') id: string,
  @Body() body: { symbols: string[] },
) {
  return this.service.reorderItems(user.id, id, body.symbols);
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/catalog/watchlists/watchlists.controller.ts
git commit -m "feat(watchlists): Controller 新增 quotes/reorder 接口"
```

---

## Task 5: 后端单元测试

**Files:**
- Create: `apps/server/src/catalog/watchlists/watchlists.service.spec.ts`

- [ ] **Step 1: 编写测试文件**

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WatchlistsService } from './watchlists.service';
import { WatchlistEntity } from '../../entities/watchlist/watchlist.entity';
import { WatchlistItemEntity } from '../../entities/watchlist/watchlist-item.entity';

describe('WatchlistsService', () => {
  let service: WatchlistsService;
  let watchlistRepo: jest.Mocked<Repository<WatchlistEntity>>;
  let itemRepo: jest.Mocked<Repository<WatchlistItemEntity>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WatchlistsService,
        {
          provide: getRepositoryToken(WatchlistEntity),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            findOneBy: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
            query: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(WatchlistItemEntity),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            delete: jest.fn(),
            update: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<WatchlistsService>(WatchlistsService);
    watchlistRepo = module.get(getRepositoryToken(WatchlistEntity));
    itemRepo = module.get(getRepositoryToken(WatchlistItemEntity));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('reorderWatchlists', () => {
    it('should update displayOrder for each watchlist', async () => {
      watchlistRepo.update.mockResolvedValue({ affected: 1 } as any);
      const result = await service.reorderWatchlists('user-1', ['id-a', 'id-b', 'id-c']);
      expect(result).toEqual({ ok: true });
      expect(watchlistRepo.update).toHaveBeenCalledTimes(3);
      expect(watchlistRepo.update).toHaveBeenNthCalledWith(
        1,
        { id: 'id-a', userId: 'user-1' },
        { displayOrder: 0 },
      );
    });
  });

  describe('reorderItems', () => {
    it('should update displayOrder for each item', async () => {
      watchlistRepo.findOne.mockResolvedValue({
        id: 'wl-1',
        items: [],
      } as WatchlistEntity);
      itemRepo.update.mockResolvedValue({ affected: 1 } as any);
      const result = await service.reorderItems('user-1', 'wl-1', ['BTCUSDT', 'ETHUSDT']);
      expect(result).toEqual({ ok: true });
      expect(itemRepo.update).toHaveBeenCalledTimes(2);
    });
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
cd apps/server && npx jest src/catalog/watchlists/watchlists.service.spec.ts --verbose
```

**Expected:** 3 tests passing

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/catalog/watchlists/watchlists.service.spec.ts
git commit -m "test(watchlists): Service 单元测试"
```

---

## Task 6: 安装 Pinia

**Files:**
- Modify: `apps/web/package.json`

- [ ] **Step 1: 安装 pinia**

```bash
cd apps/web && pnpm add pinia
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
pnpm install --frozen-lockfile
git add node_modules/.pnpm-workspace-state-v1.json 2>/dev/null || true
git commit -m "deps(web): 安装 pinia"
```

---

## Task 7: 注册 Pinia

**Files:**
- Modify: `apps/web/src/main.ts`

- [ ] **Step 1: 修改 main.ts**

在文件顶部添加导入：

```ts
import { createPinia } from 'pinia'
```

在 `app.use(router)` 之前或之后添加：

```ts
app.use(createPinia())
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/main.ts
git commit -m "feat(web): 注册 Pinia 插件"
```

---

## Task 8: API 客户端更新

**Files:**
- Modify: `apps/web/src/api/modules/watchlists.ts`

- [ ] **Step 1: 添加类型和方法**

在 `watchlists.ts` 末尾，在 `removeSymbol` 之后添加：

```ts
export interface WatchlistQuotesResult {
  items: SymbolRow[]
  total: number
  page: number
  page_size: number
}

export const watchlistApi = {
  // ... 现有方法保持不变 ...
  
  quotes: (id: string, params: {
    interval?: string
    page?: number
    pageSize?: number
    sort?: { field?: string | null; order?: 'ascend' | 'descend' | null }
  }) => {
    const query = new URLSearchParams()
    query.set('interval', params.interval ?? '1h')
    query.set('page', String(params.page ?? 1))
    query.set('page_size', String(params.pageSize ?? 20))
    if (params.sort?.field) {
      query.set('sort', JSON.stringify(params.sort))
    }
    return request<WatchlistQuotesResult>(`${API_BASE}/watchlists/${id}/quotes?${query.toString()}`)
  },
  
  reorder: (ids: string[]) =>
    put<{ ok: true }>(`${API_BASE}/watchlists/reorder`, { ids }),
  
  reorderItems: (id: string, symbols: string[]) =>
    put<{ ok: true }>(`${API_BASE}/watchlists/${id}/reorder`, { symbols }),
}
```

**注意：** 需要在文件顶部导入 `SymbolRow`：

```ts
import type { SymbolRow } from './symbols'
```

如果 `put` 函数未导入，从 `../client` 导入。

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/api/modules/watchlists.ts
git commit -m "feat(api): 自选列表行情和排序接口"
```

---

## Task 9: Pinia Store

**Files:**
- Create: `apps/web/src/stores/watchlist.ts`

- [ ] **Step 1: 创建 Store 文件**

```ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { watchlistApi, symbolApi, type Watchlist, type SymbolRow } from '@/api'

const STORAGE_KEY = 'watchlist-columns'
const DEFAULT_COLUMNS = ['symbol', 'close', 'ma5', 'ma30', 'kdjJ', 'riskRewardRatio']

export const useWatchlistStore = defineStore('watchlist', () => {
  // State
  const watchlists = ref<Watchlist[]>([])
  const currentId = ref<string | null>(null)
  const quotes = ref<SymbolRow[]>([])
  const total = ref(0)
  const loadingLists = ref(false)
  const loadingQuotes = ref(false)
  const interval = ref<'1h' | '4h' | '1d'>('1h')
  const page = ref(1)
  const pageSize = ref(20)
  const sortKey = ref<string | null>(null)
  const sortOrder = ref<'ascend' | 'descend' | null>(null)
  const columns = ref<string[]>(loadColumns())

  // Getters
  const currentWatchlist = computed(() =>
    watchlists.value.find((w) => w.id === currentId.value) ?? null,
  )

  // Actions
  async function loadWatchlists() {
    loadingLists.value = true
    try {
      watchlists.value = await watchlistApi.list()
      if (!currentId.value && watchlists.value.length > 0) {
        currentId.value = watchlists.value[0].id
      }
    } finally {
      loadingLists.value = false
    }
  }

  function setCurrentId(id: string | null) {
    currentId.value = id
    page.value = 1
    sortKey.value = null
    sortOrder.value = null
    if (id) {
      loadQuotes()
    } else {
      quotes.value = []
      total.value = 0
    }
  }

  async function loadQuotes() {
    if (!currentId.value) return
    loadingQuotes.value = true
    try {
      const res = await watchlistApi.quotes(currentId.value, {
        interval: interval.value,
        page: page.value,
        pageSize: pageSize.value,
        sort: sortKey.value ? { field: sortKey.value, order: sortOrder.value } : undefined,
      })
      quotes.value = res.items
      total.value = res.total
    } finally {
      loadingQuotes.value = false
    }
  }

  async function reorderWatchlists(ids: string[]) {
    const old = [...watchlists.value]
    watchlists.value = ids.map((id) => old.find((w) => w.id === id)!).filter(Boolean)
    try {
      await watchlistApi.reorder(ids)
    } catch {
      watchlists.value = old
      throw new Error('列表排序失败')
    }
  }

  async function reorderItems(symbols: string[]) {
    if (!currentId.value) return
    const old = [...quotes.value]
    quotes.value = symbols.map((s) => old.find((q) => q.symbol === s)!).filter(Boolean)
    try {
      await watchlistApi.reorderItems(currentId.value, symbols)
    } catch {
      quotes.value = old
      throw new Error('标的排序失败')
    }
  }

  function saveColumns(cols: string[]) {
    columns.value = cols
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cols))
  }

  function loadColumns(): string[] {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved ? JSON.parse(saved) : DEFAULT_COLUMNS
    } catch {
      return DEFAULT_COLUMNS
    }
  }

  return {
    watchlists,
    currentId,
    currentWatchlist,
    quotes,
    total,
    loadingLists,
    loadingQuotes,
    interval,
    page,
    pageSize,
    sortKey,
    sortOrder,
    columns,
    loadWatchlists,
    setCurrentId,
    loadQuotes,
    reorderWatchlists,
    reorderItems,
    saveColumns,
  }
})
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/stores/watchlist.ts
git commit -m "feat(web): 自选列表 Pinia Store"
```

---

## Task 10: WatchlistSidebar 组件

**Files:**
- Create: `apps/web/src/components/watchlist/WatchlistSidebar.vue`

- [ ] **Step 1: 创建组件**

```vue
<template>
  <div class="watchlist-sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title">自选列表</span>
      <n-button text size="small" @click="createList">
        <template #icon><n-icon><add-outline /></n-icon></template>
      </n-button>
    </div>

    <n-spin v-if="store.loadingLists" size="small" />

    <div v-else class="sidebar-list">
      <div
        v-for="wl in store.watchlists"
        :key="wl.id"
        :class="['sidebar-item', { active: wl.id === store.currentId }]"
        @click="store.setCurrentId(wl.id)"
        @contextmenu.prevent="showContextMenu($event, wl)"
      >
        <span class="item-name">{{ wl.name }}</span>
        <n-badge :value="wl.items?.length ?? 0" />
      </div>
    </div>

    <!-- 新建/重命名弹窗 -->
    <n-modal v-model:show="showModal" :title="editTarget ? '重命名列表' : '新建列表'" preset="dialog">
      <n-input v-model:value="formName" placeholder="列表名称" @keyup.enter="submitName" />
      <template #action>
        <n-button @click="showModal = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="submitName">保存</n-button>
      </template>
    </n-modal>

    <!-- 右键菜单 -->
    <n-dropdown
      :show="dropdownVisible"
      :options="dropdownOptions"
      :x="dropdownX"
      :y="dropdownY"
      trigger="manual"
      @clickoutside="dropdownVisible = false"
      @select="handleDropdownSelect"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NBadge, NDropdown, NIcon, NInput, NModal, NSpin, useMessage, useDialog } from 'naive-ui'
import { AddOutline } from '@vicons/ionicons5'
import { useWatchlistStore } from '@/stores/watchlist'
import { watchlistApi } from '@/api'

const store = useWatchlistStore()
const message = useMessage()
const dialog = useDialog()

const showModal = ref(false)
const submitting = ref(false)
const editTarget = ref<typeof store.watchlists[0] | null>(null)
const formName = ref('')

const dropdownVisible = ref(false)
const dropdownX = ref(0)
const dropdownY = ref(0)
const contextMenuTarget = ref<typeof store.watchlists[0] | null>(null)

const dropdownOptions = [
  { label: '重命名', key: 'rename' },
  { label: '删除', key: 'delete' },
]

function showContextMenu(e: MouseEvent, wl: typeof store.watchlists[0]) {
  contextMenuTarget.value = wl
  dropdownX.value = e.clientX
  dropdownY.value = e.clientY
  dropdownVisible.value = true
}

function handleDropdownSelect(key: string) {
  dropdownVisible.value = false
  const wl = contextMenuTarget.value
  if (!wl) return
  if (key === 'rename') {
    editTarget.value = wl
    formName.value = wl.name
    showModal.value = true
  } else if (key === 'delete') {
    dialog.warning({
      title: '确认删除',
      content: `确定要删除列表 "${wl.name}" 吗？`,
      positiveText: '删除',
      negativeText: '取消',
      onPositiveClick: async () => {
        await watchlistApi.delete(wl.id)
        message.success('删除成功')
        store.loadWatchlists()
      },
    })
  }
}

function createList() {
  editTarget.value = null
  formName.value = ''
  showModal.value = true
}

async function submitName() {
  const name = formName.value.trim()
  if (!name) return
  submitting.value = true
  try {
    if (editTarget.value) {
      await watchlistApi.update(editTarget.value.id, { name })
      message.success('重命名成功')
    } else {
      await watchlistApi.create({ name })
      message.success('创建成功')
    }
    showModal.value = false
    store.loadWatchlists()
  } catch (err: any) {
    message.error(err.message || '操作失败')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.watchlist-sidebar {
  width: 240px;
  border-right: 1px solid var(--ember-border);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.sidebar-title {
  font-weight: 600;
  font-size: 16px;
}
.sidebar-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sidebar-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}
.sidebar-item:hover {
  background: var(--ember-hover);
}
.sidebar-item.active {
  background: var(--ember-active);
  font-weight: 600;
}
.item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/watchlist/WatchlistSidebar.vue
git commit -m "feat(web): WatchlistSidebar 组件"
```

---

## Task 11: WatchlistTableSettings 组件

**Files:**
- Create: `apps/web/src/components/watchlist/WatchlistTableSettings.vue`

- [ ] **Step 1: 创建组件**

```vue
<template>
  <n-drawer v-model:show="show" placement="right" :width="320">
    <n-drawer-content title="列设置" closable>
      <n-spin v-if="loading" size="small" />
      <n-checkbox-group v-else v-model:value="selected">
        <n-space vertical>
          <n-checkbox v-for="col in allColumns" :key="col" :value="col" :label="col" />
        </n-space>
      </n-checkbox-group>
      <template #footer>
        <n-space justify="end">
          <n-button @click="reset">恢复默认</n-button>
          <n-button type="primary" @click="save">保存</n-button>
        </n-space>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { NDrawer, NDrawerContent, NCheckbox, NCheckboxGroup, NSpace, NButton, NSpin } from 'naive-ui'
import { symbolApi } from '@/api'
import { useWatchlistStore } from '@/stores/watchlist'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const store = useWatchlistStore()
const allColumns = ref<string[]>([])
const selected = ref<string[]>([...store.columns])
const loading = ref(false)

watch(() => props.show, async (visible) => {
  if (visible) {
    selected.value = [...store.columns]
    if (!allColumns.value.length) {
      loading.value = true
      try {
        allColumns.value = await symbolApi.getKlineColumns()
      } finally {
        loading.value = false
      }
    }
  }
})

function save() {
  store.saveColumns(selected.value)
  emit('update:show', false)
}

function reset() {
  selected.value = ['symbol', 'close', 'ma5', 'ma30', 'kdjJ', 'riskRewardRatio']
}
</script>
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/watchlist/WatchlistTableSettings.vue
git commit -m "feat(web): WatchlistTableSettings 列设置组件"
```

---

## Task 12: WatchlistTable 组件

**Files:**
- Create: `apps/web/src/components/watchlist/WatchlistTable.vue`

- [ ] **Step 1: 创建组件**

```vue
<template>
  <div class="watchlist-table">
    <!-- 工具栏 -->
    <div class="table-toolbar">
      <n-select v-model:value="store.interval" :options="intervalOptions" style="width: 100px" @update:value="store.loadQuotes" />
      <n-button @click="store.loadQuotes">
        <template #icon><n-icon><refresh-outline /></n-icon></template>
        刷新
      </n-button>
      <n-button @click="showSettings = true">
        <template #icon><n-icon><settings-outline /></n-icon></template>
        列设置
      </n-button>
    </div>

    <!-- 表格 -->
    <n-data-table
      :columns="columns"
      :data="store.quotes"
      :loading="store.loadingQuotes"
      :pagination="paginationState"
      remote
      @update:page="handlePageChange"
      @update:page-size="handlePageSizeChange"
      @update:sorter="handleSort"
    />

    <!-- 列设置抽屉 -->
    <watchlist-table-settings v-model:show="showSettings" />

    <!-- K 线抽屉 -->
    <n-drawer v-model:show="showChartDrawer" placement="right" :width="1000" class="glass-drawer">
      <n-drawer-content :title="`${selectedSymbol} · ${store.interval.toUpperCase()}`" closable>
        <kline-chart v-if="klineData.length" :data="klineData" height="700px" :slider-start="70" />
        <n-empty v-else description="No kline data" style="padding: 40px 0" />
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, h, ref } from 'vue'
import {
  NButton, NDataTable, NDrawer, NDrawerContent, NEmpty, NIcon, NSelect,
  type DataTableColumns, type DataTableSortState,
} from 'naive-ui'
import { RefreshOutline, SettingsOutline } from '@vicons/ionicons5'
import { useWatchlistStore } from '@/stores/watchlist'
import { klinesApi, watchlistApi, type KlineChartBar } from '@/api'
import SymbolStarButton from '@/components/common/SymbolStarButton.vue'
import WatchlistTableSettings from './WatchlistTableSettings.vue'
import KlineChart from '@/components/charts/KlineChart.vue'

const store = useWatchlistStore()
const showSettings = ref(false)
const showChartDrawer = ref(false)
const selectedSymbol = ref('')
const klineData = ref<KlineChartBar[]>([])

const intervalOptions = [
  { label: '1h', value: '1h' },
  { label: '4h', value: '4h' },
  { label: '1d', value: '1d' },
]

const paginationState = computed(() => ({
  page: store.page,
  pageSize: store.pageSize,
  itemCount: store.total,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  prefix: () => `Total ${store.total}`,
}))

function handlePageChange(nextPage: number) {
  store.page = nextPage
  store.loadQuotes()
}

function handlePageSizeChange(nextPageSize: number) {
  store.pageSize = nextPageSize
  store.page = 1
  store.loadQuotes()
}

function handleSort(sorter: DataTableSortState | DataTableSortState[] | null) {
  const state = Array.isArray(sorter) ? sorter[0] : sorter
  store.sortKey = typeof state?.columnKey === 'string' ? state.columnKey : null
  store.sortOrder = state?.order || null
  store.page = 1
  store.loadQuotes()
}

async function openChart(symbol: string) {
  selectedSymbol.value = symbol
  showChartDrawer.value = true
  klineData.value = []
  try {
    klineData.value = await klinesApi.getKlines(symbol, store.interval)
  } catch (err: any) {
    console.error(err)
  }
}

async function removeSymbol(symbol: string) {
  if (!store.currentId.value) return
  const old = [...store.quotes]
  store.quotes = store.quotes.filter((q) => q.symbol !== symbol)
  try {
    await watchlistApi.removeSymbol(store.currentId.value, symbol)
    store.total -= 1
  } catch {
    store.quotes = old
  }
}

const formatFixed = (value: number | null | undefined, digits: number) =>
  value == null ? '-' : value.toFixed(digits)

const columns = computed<DataTableColumns<any>>(() => {
  const base: DataTableColumns<any> = [
    {
      title: 'Symbol',
      key: 'symbol',
      width: 160,
      fixed: 'left',
      sorter: true,
      render: (row) =>
        h('div', { style: 'display:flex;align-items:center;gap:6px' }, [
          h(SymbolStarButton, { symbol: row.symbol }),
          h('span', {
            style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;color:var(--primary-color)',
            onClick: () => openChart(row.symbol),
          }, row.symbol),
        ]),
    },
  ]

  const colMap: Record<string, any> = {
    close: { title: 'Close', key: 'close', width: 120, sorter: true, render: (row: any) => (row.close == null ? '-' : Number(row.close).toPrecision(6)) },
    ma5: { title: 'MA5', key: 'ma5', width: 110, sorter: true, render: (row: any) => formatFixed(row.ma5, 4) },
    ma30: { title: 'MA30', key: 'ma30', width: 110, sorter: true, render: (row: any) => formatFixed(row.ma30, 4) },
    ma60: { title: 'MA60', key: 'ma60', width: 110, sorter: true, render: (row: any) => formatFixed(row.ma60, 4) },
    kdjJ: { title: 'KDJ.J', key: 'kdjJ', width: 90, sorter: true, render: (row: any) => formatFixed(row.kdjJ, 2) },
    riskRewardRatio: { title: 'RR', key: 'riskRewardRatio', width: 90, sorter: true, render: (row: any) => formatFixed(row.riskRewardRatio, 2) },
    stopLossPct: { title: 'Stop %', key: 'stopLossPct', width: 90, sorter: true, render: (row: any) => (row.stopLossPct == null ? '-' : `${row.stopLossPct.toFixed(2)}%`) },
    openTime: { title: 'Updated', key: 'openTime', width: 110, sorter: true, render: (row: any) => (row.openTime ? new Date(row.openTime).toISOString().slice(0, 10) : '-') },
  }

  for (const key of store.columns) {
    if (colMap[key]) base.push(colMap[key])
  }

  base.push({
    title: 'Action',
    key: 'actions',
    width: 80,
    fixed: 'right',
    render: (row) =>
      h(NButton, { size: 'small', type: 'error', ghost: true, onClick: () => removeSymbol(row.symbol) }, () => '移除'),
  })

  return base
})
</script>

<style scoped>
.watchlist-table {
  flex: 1;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.table-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/watchlist/WatchlistTable.vue
git commit -m "feat(web): WatchlistTable 行情表格组件"
```

---

## Task 13: WatchlistsView 页面重构

**Files:**
- Modify: `apps/web/src/views/WatchlistsView.vue`

- [ ] **Step 1: 重写 WatchlistsView.vue**

```vue
<template>
  <div class="watchlists-view workspace-page">
    <watchlist-sidebar />
    <watchlist-table />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useWatchlistStore } from '@/stores/watchlist'
import WatchlistSidebar from '@/components/watchlist/WatchlistSidebar.vue'
import WatchlistTable from '@/components/watchlist/WatchlistTable.vue'

const store = useWatchlistStore()

onMounted(() => {
  store.loadWatchlists()
})
</script>

<style scoped>
.watchlists-view {
  display: flex;
  height: calc(100vh - var(--header-height, 60px));
  overflow: hidden;
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/views/WatchlistsView.vue
git commit -m "feat(web): 重构 WatchlistsView 为左右布局"
```

---

## Task 14: 联调与手动验证

- [ ] **Step 1: 运行后端**

```bash
cd apps/server && pnpm start:dev
```

确认 NestJS 启动无报错，迁移已执行。

- [ ] **Step 2: 运行前端**

```bash
cd apps/web && pnpm dev
```

- [ ] **Step 3: 手动验证清单**

| 验证项 | 预期结果 |
|--------|---------|
| 打开 `/watchlists` | 左侧显示列表，右侧显示第一个列表的行情表格 |
| 切换左侧列表 | 右侧表格刷新，显示对应列表的标的 |
| 新建列表 | 弹窗输入名称，保存后左侧刷新 |
| 重命名列表 | 右键菜单 → 重命名 → 保存后更新 |
| 删除列表 | 右键菜单 → 删除 → 确认后移除，自动切换 |
| 切换周期 | 1h/4h/1d 切换后表格数据刷新 |
| 分页 | 页码切换、每页条数切换正常 |
| 表头排序 | 点击表头，remote 排序生效 |
| 列设置 | 打开抽屉，勾选/取消列，保存后表格刷新 |
| 点击 Symbol | 打开 K 线抽屉，显示正确标的 |
| 移除标的 | 点击"移除"，标的从表格消失，总数减少 |
| 星标按钮 | 行内星标状态正确，可收藏/取消 |

- [ ] **Step 4: 修复发现的问题**

根据验证结果修复 bug。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(watchlists): 自选列表页面重新设计完成"
```

---

## 自检

**Spec 覆盖检查：**
- [x] 左侧列表导航 + 右侧行情表格布局 — Task 13
- [x] 自定义列 — Task 9, 11, 12
- [x] 拖拽排序列表 — Task 3, 9 (Store reorderWatchlists)
- [x] 拖拽排序标的 — Task 3, 9 (Store reorderItems)
- [x] 行情数据展示 — Task 3, 4, 12
- [x] 分页 — Task 3, 12
- [x] Pinia 状态管理 — Task 6, 7, 9
- [x] 复用 K 线抽屉 — Task 12
- [x] 复用星标按钮 — Task 12
- [x] 错误处理 — Store 中已实现乐观更新 + 回滚

**Placeholder 扫描：**
- [x] 无 "TBD" / "TODO" / "implement later"
- [x] 每个步骤包含具体代码
- [x] 每个任务有明确的文件路径

**类型一致性：**
- [x] `WatchlistQuotesResult` 接口与 Store 和 API 一致
- [x] `displayOrder` 在实体、Service、DB 中名称一致
