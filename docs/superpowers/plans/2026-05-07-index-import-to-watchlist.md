# 指数成分股一键导入 Watchlist 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Watchlist 侧边栏的右键菜单中新增"从指数导入成员"，用户选择预置指数后，后端实时从 Tushare 拉取最新成分股，全量覆盖该 watchlist 的成员。

**Architecture:** 后端在 `WatchlistsModule` 中直接注入 `TushareClientService`（仅依赖全局 `ConfigService`），新增 `POST /watchlists/:id/import-from-index` 路由；前端在 `WatchlistSidebar.vue` 的下拉菜单追加入口，弹出 `ImportFromIndexModal.vue` 进行确认。

**Tech Stack:** NestJS 10 / TypeORM / Vue 3 + Naive UI / TypeScript / Tushare Pro HTTP API

---

## 文件地图

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/server/src/catalog/watchlists/watchlists.module.ts` | 修改 | 添加 `TushareClientService` 到 providers |
| `apps/server/src/catalog/watchlists/watchlists.service.ts` | 修改 | 新增 `importFromIndex` 方法 |
| `apps/server/src/catalog/watchlists/watchlists.controller.ts` | 修改 | 新增 `POST /:id/import-from-index` 路由 |
| `apps/server/src/catalog/watchlists/watchlists.service.spec.ts` | 修改 | 补充 `importFromIndex` 单测 |
| `apps/web/src/api/modules/watchlists.ts` | 修改 | 新增 `importFromIndex` 方法 |
| `apps/web/src/components/watchlist/ImportFromIndexModal.vue` | 新建 | 指数导入确认弹窗组件 |
| `apps/web/src/components/watchlist/WatchlistSidebar.vue` | 修改 | 右键菜单追加"从指数导入"选项 |

---

## Task 1：后端 — 在 WatchlistsModule 注入 TushareClientService

**Files:**
- Modify: `apps/server/src/catalog/watchlists/watchlists.module.ts`

**背景：** `TushareClientService` 当前仅在 `ASharesModule` 内作为 provider，未导出。由于它只依赖全局注册的 `ConfigService`，可直接在 `WatchlistsModule` 中声明为 provider，无需跨模块导入。

- [ ] **Step 1: 修改 `watchlists.module.ts`，添加 TushareClientService**

将文件改为：

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WatchlistsController } from './watchlists.controller';
import { WatchlistsService } from './watchlists.service';
import { WatchlistEntity } from '../../entities/watchlist/watchlist.entity';
import { WatchlistItemEntity } from '../../entities/watchlist/watchlist-item.entity';
import { TushareClientService } from '../../market-data/a-shares/services/tushare-client.service';

@Module({
  imports: [TypeOrmModule.forFeature([WatchlistEntity, WatchlistItemEntity])],
  controllers: [WatchlistsController],
  providers: [WatchlistsService, TushareClientService],
  exports: [WatchlistsService],
})
export class WatchlistsModule {}
```

- [ ] **Step 2: 验证模块文件头部正确**

读取文件前 15 行，确认 import 顺序无误，`TushareClientService` 路径正确。

- [ ] **Step 3: 编译检查**

```powershell
cd apps/server ; npx tsc --noEmit
```

期望：无 TS 错误。

---

## Task 2：后端 — 实现 `importFromIndex` 服务方法

**Files:**
- Modify: `apps/server/src/catalog/watchlists/watchlists.service.ts`

**背景：** 需要在 `WatchlistsService` 中注入 `TushareClientService`，并实现全量覆盖逻辑。`index_member` 接口返回的 `con_code` 字段即为成分股 ts_code，直接写入 `watchlist_items.symbol`。

- [ ] **Step 1: 更新 WatchlistsService 的 constructor，注入 TushareClientService**

找到文件头部 import 区域和 constructor，修改为：

```typescript
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, QueryFailedError, Repository } from 'typeorm';
import { WatchlistEntity } from '../../entities/watchlist/watchlist.entity';
import { WatchlistItemEntity } from '../../entities/watchlist/watchlist-item.entity';
import { TushareClientService } from '../../market-data/a-shares/services/tushare-client.service';

export const INDEX_ALLOWLIST: Record<string, string> = {
  '399300.SZ': '沪深300',
  '000016.SH': '上证50',
  '000905.SH': '中证500',
  '000852.SH': '中证1000',
  '000010.SH': '上证180',
};

@Injectable()
export class WatchlistsService {
  constructor(
    @InjectRepository(WatchlistEntity)
    private readonly watchlistRepo: Repository<WatchlistEntity>,
    @InjectRepository(WatchlistItemEntity)
    private readonly itemRepo: Repository<WatchlistItemEntity>,
    private readonly tushareClient: TushareClientService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}
```

- [ ] **Step 2: 在类末尾（`reorderItems` 之后）添加 `importFromIndex` 方法**

```typescript
  async importFromIndex(
    userId: string,
    watchlistId: string,
    indexCode: string,
  ): Promise<{ imported: number; replaced: number }> {
    if (!INDEX_ALLOWLIST[indexCode]) {
      throw new BadRequestException(`不支持的指数代码：${indexCode}`);
    }

    const w = await this.watchlistRepo.findOne({
      where: { id: watchlistId, userId } as any,
      relations: ['items'],
    });
    if (!w) throw new NotFoundException(`Watchlist ${watchlistId} not found`);

    const replaced = w.items?.length ?? 0;

    const rows = await this.tushareClient.query(
      'index_member',
      { index_code: indexCode },
      'con_code',
    );

    const conCodes = rows
      .map((r) => String(r['con_code'] ?? '').trim())
      .filter(Boolean);

    if (conCodes.length === 0) {
      throw new BadRequestException('未找到该指数成分数据');
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(WatchlistItemEntity, { watchlistId });
      const items = conCodes.map((symbol) =>
        manager.create(WatchlistItemEntity, { watchlistId, symbol, displayOrder: 0 }),
      );
      await manager.save(WatchlistItemEntity, items);
    });

    return { imported: conCodes.length, replaced };
  }
```

- [ ] **Step 3: 读取文件头部，确认 imports 顺序正确**

读取 `watchlists.service.ts` 前 30 行，确认 `DataSource` 已从 `typeorm` 导入，`TushareClientService` import 路径无误。

- [ ] **Step 4: 编译检查**

```powershell
cd apps/server ; npx tsc --noEmit
```

期望：无 TS 错误。

---

## Task 3：后端 — 添加路由到 Controller

**Files:**
- Modify: `apps/server/src/catalog/watchlists/watchlists.controller.ts`

- [ ] **Step 1: 在 `watchlists.controller.ts` 的 `reorderItems` 方法之后添加新路由**

在文件末尾（最后一个 `}` 前）添加：

```typescript
  @Post(':id/import-from-index')
  importFromIndex(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { indexCode?: string },
  ) {
    const indexCode = (body.indexCode ?? '').trim();
    if (!indexCode) throw new ConflictException('indexCode 不能为空');
    return this.watchlistsService.importFromIndex(user.id, id, indexCode);
  }
```

确认文件顶部已有 `ConflictException` 的导入（当前文件第 2 行已导入）。

- [ ] **Step 2: 读取文件头部，确认导入正确**

读取 `watchlists.controller.ts` 前 10 行，确认没有多余或缺少的 imports。

- [ ] **Step 3: 编译检查**

```powershell
cd apps/server ; npx tsc --noEmit
```

期望：无 TS 错误。

- [ ] **Step 4: 提交**

```powershell
git add apps/server/src/catalog/watchlists/
git commit -m "feat(server): add import-from-index endpoint to watchlists"
```

---

## Task 4：后端 — 单元测试

**Files:**
- Modify: `apps/server/src/catalog/watchlists/watchlists.service.spec.ts`

**背景：** 现有测试框架使用 Jest mock，需要在 `beforeEach` 中增加 `TushareClientService` 和 `DataSource` 的 mock。

- [ ] **Step 1: 更新 spec 文件的 import 区（前 10 行）**

在现有 import 后追加：

```typescript
import { TushareClientService } from '../../market-data/a-shares/services/tushare-client.service';
import { getDataSourceToken } from '@nestjs/typeorm';
import { INDEX_ALLOWLIST } from './watchlists.service';
```

- [ ] **Step 2: 在 `beforeEach` 的 `providers` 数组中追加两个 mock**

在现有两个 `getRepositoryToken` provider 之后追加：

```typescript
        {
          provide: TushareClientService,
          useValue: { query: jest.fn() },
        },
        {
          provide: getDataSourceToken(),
          useValue: {
            transaction: jest.fn((cb) => cb({
              delete: jest.fn(),
              create: jest.fn((_, data) => data),
              save: jest.fn(),
            })),
          },
        },
```

在 `beforeEach` 之后添加：

```typescript
  let tushareClient: jest.Mocked<TushareClientService>;
  let dataSource: { transaction: jest.Mock };
```

在 `beforeEach` 内 `service = module.get(...)` 之后：

```typescript
    tushareClient = module.get(TushareClientService);
    dataSource = module.get(getDataSourceToken());
```

- [ ] **Step 3: 添加测试 describe 块**

在文件末尾（最外层 `describe` 的最后一个 `}` 前）添加：

```typescript
  describe('importFromIndex', () => {
    const watchlistId = 'wl-uuid-1';
    const userId = 'user-1';

    beforeEach(() => {
      watchlistRepo.findOne.mockResolvedValue({
        id: watchlistId,
        userId,
        items: [{ symbol: 'OLD.SH' }],
      } as any);
    });

    it('should throw BadRequestException for unknown indexCode', async () => {
      await expect(
        service.importFromIndex(userId, watchlistId, 'UNKNOWN.XX'),
      ).rejects.toThrow('不支持的指数代码');
    });

    it('should throw BadRequestException when Tushare returns empty list', async () => {
      tushareClient.query.mockResolvedValue([]);
      await expect(
        service.importFromIndex(userId, watchlistId, '399300.SZ'),
      ).rejects.toThrow('未找到该指数成分数据');
    });

    it('should throw NotFoundException when watchlist not found', async () => {
      watchlistRepo.findOne.mockResolvedValue(null);
      tushareClient.query.mockResolvedValue([{ con_code: '600000.SH' }]);
      await expect(
        service.importFromIndex(userId, watchlistId, '399300.SZ'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should replace members and return counts', async () => {
      const conCodes = ['600000.SH', '000001.SZ'];
      tushareClient.query.mockResolvedValue(
        conCodes.map((c) => ({ con_code: c })),
      );

      const result = await service.importFromIndex(userId, watchlistId, '399300.SZ');

      expect(tushareClient.query).toHaveBeenCalledWith(
        'index_member',
        { index_code: '399300.SZ' },
        'con_code',
      );
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(result).toEqual({ imported: 2, replaced: 1 });
    });

    it('INDEX_ALLOWLIST should contain 5 entries', () => {
      expect(Object.keys(INDEX_ALLOWLIST)).toHaveLength(5);
    });
  });
```

- [ ] **Step 4: 运行测试**

```powershell
cd apps/server ; npx jest watchlists.service --no-coverage
```

期望：所有 `importFromIndex` 测试通过（PASS）。

- [ ] **Step 5: 提交**

```powershell
git add apps/server/src/catalog/watchlists/watchlists.service.spec.ts
git commit -m "test(server): add importFromIndex unit tests for watchlists service"
```

---

## Task 5：前端 — 扩展 watchlistApi

**Files:**
- Modify: `apps/web/src/api/modules/watchlists.ts`

- [ ] **Step 1: 在 `watchlistApi` 对象末尾添加 `importFromIndex` 方法**

在 `reorderItems` 方法之后（最后一个 `,` 后、`}` 前）添加：

```typescript
  importFromIndex: (id: string, indexCode: string) =>
    post<{ imported: number; replaced: number }>(
      `${API_BASE}/watchlists/${id}/import-from-index`,
      { indexCode },
    ),
```

- [ ] **Step 2: 读取文件，确认语法正确**

读取 `apps/web/src/api/modules/watchlists.ts`，确认对象末尾括号匹配。

- [ ] **Step 3: 前端 TS 检查**

```powershell
cd apps/web ; npx vue-tsc --noEmit
```

期望：无新增 TS 错误。

---

## Task 6：前端 — 创建 ImportFromIndexModal.vue 组件

**Files:**
- Create: `apps/web/src/components/watchlist/ImportFromIndexModal.vue`

- [ ] **Step 1: 创建组件文件**

```vue
<template>
  <AppModal
    v-model:show="show"
    title="从指数导入成员"
    width="min(480px, 90vw)"
    :mask-closable="!loading"
    :closable="!loading"
  >
    <div class="import-index-body">
      <n-form-item label="选择指数" :show-feedback="false">
        <n-select
          v-model:value="selectedCode"
          :options="indexOptions"
          placeholder="请选择指数"
          :disabled="loading"
        />
      </n-form-item>

      <n-alert v-if="selectedCode" type="warning" :show-icon="true" style="margin-top: 12px">
        将从 Tushare 拉取
        <strong>{{ indexOptions.find(o => o.value === selectedCode)?.label }}</strong>
        最新成分股，并<strong>覆盖</strong>「{{ watchlistName }}」现有的
        <strong>{{ currentMemberCount }} 条成员</strong>。此操作不可撤销。
      </n-alert>
    </div>

    <template #actions>
      <n-button :disabled="loading" @click="show = false">取消</n-button>
      <n-button
        type="error"
        :loading="loading"
        :disabled="!selectedCode"
        @click="handleConfirm"
      >
        确认导入
      </n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { NAlert, NButton, NFormItem, NSelect, useMessage } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import { watchlistApi } from '@/api'

const props = defineProps<{
  show: boolean
  watchlistId: string
  watchlistName: string
  currentMemberCount: number
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  imported: [count: number]
}>()

const show = ref(props.show)
watch(() => props.show, (v) => { show.value = v })
watch(show, (v) => emit('update:show', v))

const message = useMessage()
const loading = ref(false)
const selectedCode = ref<string | null>(null)

const INDEX_OPTIONS = [
  { label: '沪深300', value: '399300.SZ' },
  { label: '上证50', value: '000016.SH' },
  { label: '中证500', value: '000905.SH' },
  { label: '中证1000', value: '000852.SH' },
  { label: '上证180', value: '000010.SH' },
]
const indexOptions = INDEX_OPTIONS

// 关闭时重置选择
watch(show, (v) => {
  if (!v) selectedCode.value = null
})

async function handleConfirm() {
  if (!selectedCode.value) return
  loading.value = true
  try {
    const result = await watchlistApi.importFromIndex(props.watchlistId, selectedCode.value)
    const indexName = INDEX_OPTIONS.find(o => o.value === selectedCode.value)?.label ?? selectedCode.value
    message.success(`已导入 ${result.imported} 支 ${indexName} 成分股`)
    show.value = false
    emit('imported', result.imported)
  } catch (err: any) {
    const msg: string = err?.response?.data?.message ?? err?.message ?? '操作失败'
    if (msg.includes('未找到')) {
      message.error('未找到该指数成分数据')
    } else {
      message.error('获取指数成分失败，请稍后重试')
    }
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.import-index-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
```

- [ ] **Step 2: 前端 TS 检查**

```powershell
cd apps/web ; npx vue-tsc --noEmit
```

期望：无新增 TS 错误。

---

## Task 7：前端 — 在 WatchlistSidebar.vue 接入弹窗

**Files:**
- Modify: `apps/web/src/components/watchlist/WatchlistSidebar.vue`

**背景：** `WatchlistSidebar.vue` 使用 `n-dropdown` 右键菜单（`dropdownOptions` 数组），右键触发 `handleDropdownSelect`。需要：① 在 `dropdownOptions` 添加"从指数导入"选项；② 声明弹窗的 show/target 状态；③ 在 select handler 添加对应 case；④ template 添加 `ImportFromIndexModal`。

- [ ] **Step 1: 在 `<script setup>` 中 import ImportFromIndexModal**

在现有 import 列表末尾追加：

```typescript
import ImportFromIndexModal from '@/components/watchlist/ImportFromIndexModal.vue'
```

- [ ] **Step 2: 更新 `dropdownOptions`**

将现有：

```typescript
const dropdownOptions = [
  { label: '重命名', key: 'rename' },
  { label: '删除', key: 'delete' },
]
```

替换为：

```typescript
const dropdownOptions = [
  { label: '重命名', key: 'rename' },
  { label: '从指数导入成员', key: 'import-index' },
  { label: '删除', key: 'delete' },
]
```

- [ ] **Step 3: 添加弹窗相关状态变量**

在 `const contextMenuTarget = ref(...)` 之后添加：

```typescript
const showImportModal = ref(false)
const importTarget = ref<typeof store.watchlists[0] | null>(null)
```

- [ ] **Step 4: 在 `handleDropdownSelect` 中添加 `import-index` 分支**

将现有 `handleDropdownSelect` 函数改为：

```typescript
function handleDropdownSelect(key: string) {
  dropdownVisible.value = false
  const wl = contextMenuTarget.value
  if (!wl) return
  if (key === 'rename') {
    editTarget.value = wl
    formName.value = wl.name
    showModal.value = true
  } else if (key === 'import-index') {
    importTarget.value = wl
    showImportModal.value = true
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
```

- [ ] **Step 5: 在 template 中添加 ImportFromIndexModal**

在 `</template>` 之前（`<!-- 右键菜单 -->` 的 `n-dropdown` 之后）添加：

```vue
    <!-- 从指数导入 -->
    <ImportFromIndexModal
      v-if="importTarget"
      v-model:show="showImportModal"
      :watchlist-id="importTarget.id"
      :watchlist-name="importTarget.name"
      :current-member-count="importTarget.items?.length ?? 0"
      @imported="store.loadWatchlists()"
    />
```

- [ ] **Step 6: 读取文件头部，确认 import 顺序**

读取 `WatchlistSidebar.vue` 的 `<script setup>` 的前 15 行，确认 `ImportFromIndexModal` import 存在且路径正确。

- [ ] **Step 7: 前端 TS 检查**

```powershell
cd apps/web ; npx vue-tsc --noEmit
```

期望：无新增 TS 错误。

- [ ] **Step 8: 提交**

```powershell
git add apps/web/src/
git commit -m "feat(web): add import-from-index to watchlist sidebar"
```

---

## Task 8：端到端冒烟测试

**目标：** 在本地运行后手动验证核心流程，确认实现符合验收标准。

- [ ] **Step 1: 启动开发服务器（如未启动）**

```powershell
# 后端（另开终端）
cd apps/server ; pnpm start:dev
# 前端（另开终端）
cd apps/web ; pnpm dev
```

- [ ] **Step 2: 验证场景 1 — 正常导入**

1. 打开 A 股标的页面 → 找到自选列表侧边栏
2. 右键任意一个 watchlist → 菜单中出现"从指数导入成员"
3. 点击"从指数导入成员" → 弹出 ImportFromIndexModal
4. 选择"沪深300" → 确认文案显示指数名、watchlist 名、当前成员数
5. 点击"确认导入" → 按钮 loading → 成功后 toast「已导入 xxx 支 沪深300 成分股」
6. 侧边栏 badge 数字更新为约 300
7. 用该 watchlist 在 A 股筛选面板筛选，结果包含沪深300成分股

- [ ] **Step 3: 验证场景 2 — 取消不修改数据**

1. 右键 watchlist → 从指数导入成员
2. 选择"上证50"后点击"取消"
3. 成员数不变

- [ ] **Step 4: 验证场景 3 — 重复点击防护**

1. 打开弹窗，选择指数，快速连续点击"确认导入"多次
2. 确认只发出一次 API 请求（按钮在 loading 期间禁用）

- [ ] **Step 5: 提交（若有任何调整）**

```powershell
git add -A
git commit -m "fix: address smoke test findings"
```

---

## 自检清单

| 验收标准 | 对应 Task |
|---------|-----------|
| 右键菜单出现"从指数导入成员" | Task 7 |
| 弹窗显示指数选择、watchlist 名和当前成员数 | Task 6 |
| 选择沪深300确认后成员被覆盖，toast 显示数量 | Task 2 + 6 + 7 |
| Tushare 失败时旧数据不变，toast 显示错误 | Task 2（事务回滚） + Task 6（错误处理） |
| 确认期间重复点击无效 | Task 6（loading disabled） |
| 指数白名单校验，未知 indexCode 返回 400 | Task 2 |
