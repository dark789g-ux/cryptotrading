# SymbolsView 列配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `SymbolsView.vue` 下的 Crypto / A 股两张表支持账号级列显示与顺序配置，并同步到服务端。

**Architecture:** 后端新增用户偏好存储与专用读写接口，按 `userId + key` 保存 `SymbolsView` 的列配置。前端抽出列元数据和配置规范化逻辑，用一个通用列设置抽屉编辑两张表的列顺序与可见性，再把配置映射回 `n-data-table` 的 `columns`。

**Tech Stack:** Vue 3 + Naive UI + Pinia + NestJS + TypeORM + PostgreSQL

---

### Task 1: 后端偏好存储

**Files:**
- Create: `apps/server/migrations/20260505000000-user-preferences.sql`
- Create: `apps/server/src/entities/user-preference.entity.ts`
- Create: `apps/server/src/preferences/preferences.module.ts`
- Create: `apps/server/src/preferences/preferences.service.ts`
- Create: `apps/server/src/preferences/preferences.controller.ts`
- Modify: `apps/server/src/app.module.ts`

- [ ] **Step 1: 写迁移和实体**

```sql
CREATE TABLE IF NOT EXISTS user_preferences (
  id character varying PRIMARY KEY,
  user_id character varying NOT NULL,
  key character varying NOT NULL,
  value jsonb NOT NULL DEFAULT CAST('{}' AS jsonb),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_preferences_user_key_unique UNIQUE (user_id, key)
);
```

```ts
@Entity('user_preferences')
export class UserPreferenceEntity {
  @PrimaryColumn()
  id: string;

  @Column({ name: 'user_id' })
  userId: string;

  @Column()
  key: string;

  @Column({ type: 'jsonb' })
  value: any;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

- [ ] **Step 2: 写偏好服务和控制器**

```ts
@Get('symbols-view')
getSymbolsView(@CurrentUser() user: CurrentUserPayload) {
  return this.preferencesService.getSymbolsView(user.id);
}

@Put('symbols-view')
saveSymbolsView(@CurrentUser() user: CurrentUserPayload, @Body() body: { crypto: unknown; aShares: unknown }) {
  return this.preferencesService.saveSymbolsView(user.id, body);
}
```

```ts
async getSymbolsView(userId: string) {
  const row = await this.repo.findOneBy({ userId, key: 'symbols_view_columns' });
  return row?.value ?? DEFAULT_SYMBOLS_VIEW_COLUMNS;
}
```

- [ ] **Step 3: 把模块挂进 `AppModule`**

```ts
TypeOrmModule.forFeature([UserPreferenceEntity])
```

- [ ] **Step 4: 跑后端构建**

Run: `cd apps/server && pnpm build`  
Expected: Nest 编译通过，新模块、实体、控制器都能被正确解析

- [ ] **Step 5: Commit**

```bash
git add apps/server/migrations/20260505000000-user-preferences.sql apps/server/src/entities/user-preference.entity.ts apps/server/src/preferences apps/server/src/app.module.ts
git commit -m "feat(preferences): add symbols view storage"
```

### Task 2: 后端配置规范化与测试

**Files:**
- Create: `apps/server/src/preferences/preferences.service.spec.ts`
- Modify: `apps/server/src/preferences/preferences.service.ts`

- [ ] **Step 1: 先写 service spec**

```ts
it('returns defaults when no preference exists', async () => {
  repo.findOneBy.mockResolvedValue(null);
  await expect(service.getSymbolsView('user-1')).resolves.toEqual(DEFAULT_SYMBOLS_VIEW_COLUMNS);
});
```

```ts
it('drops unknown columns and keeps locked columns visible', async () => {
  const saved = await service.saveSymbolsView('user-1', {
    crypto: [{ key: 'symbol', visible: false }, { key: 'ghost', visible: true }],
    aShares: [{ key: 'tsCode', visible: false }],
  });
  expect(saved.crypto[0].visible).toBe(true);
});
```

- [ ] **Step 2: 实现规范化逻辑**

```ts
function normalizeColumns(input: unknown, registry: ColumnDefinition[]) {
  // 只保留已知列，补默认列，锁定列强制 visible=true
}
```

- [ ] **Step 3: 跑 spec**

Run: `cd apps/server && npx jest src/preferences/preferences.service.spec.ts --verbose`  
Expected: 默认值、未知列、固定列约束都通过

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/preferences/preferences.service.ts apps/server/src/preferences/preferences.service.spec.ts
git commit -m "test(preferences): cover symbols view normalization"
```

### Task 3: 前端列元数据抽离

**Files:**
- Create: `apps/web/src/components/symbols/columnTypes.ts`
- Create: `apps/web/src/components/symbols/cryptoColumns.ts`
- Create: `apps/web/src/components/symbols/aSharesColumns.ts`
- Modify: `apps/web/src/components/symbols/CryptoSymbolsPanel.vue`
- Modify: `apps/web/src/components/symbols/ASharesPanel.vue`

- [ ] **Step 1: 定义列元数据**

```ts
export interface SymbolColumnDef<Row> {
  key: string
  title: string
  width?: number
  fixed?: 'left' | 'right'
  sorter?: boolean
  defaultVisible?: boolean
  locked?: boolean
  render: (row: Row) => VNodeChild
}
```

- [ ] **Step 2: 把现有 columns 从组件内挪到独立文件**

```ts
export const cryptoColumnDefs: SymbolColumnDef<SymbolRow>[] = [
  { key: 'symbol', title: 'Symbol', locked: true, fixed: 'left', defaultVisible: true, render: ... },
  { key: 'close', title: 'Close', defaultVisible: true, render: ... },
]
```

- [ ] **Step 3: 保持现有表格行为不变**

`CryptoSymbolsPanel` 和 `ASharesPanel` 先继续用完整列定义渲染，确保重构后页面外观和排序逻辑不变。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/symbols/columnTypes.ts apps/web/src/components/symbols/cryptoColumns.ts apps/web/src/components/symbols/aSharesColumns.ts apps/web/src/components/symbols/CryptoSymbolsPanel.vue apps/web/src/components/symbols/ASharesPanel.vue
git commit -m "refactor(symbols): extract column metadata"
```

### Task 4: 前端偏好同步与列映射

**Files:**
- Create: `apps/web/src/composables/symbols/useSymbolColumnPreferences.ts`
- Create: `apps/web/src/api/modules/preferences.ts`
- Modify: `apps/web/src/api/index.ts`

- [ ] **Step 1: 写前端 API**

```ts
export interface SymbolsViewColumnPreferences {
  crypto: ColumnPreferenceItem[]
  aShares: ColumnPreferenceItem[]
}

export const preferencesApi = {
  getSymbolsView: () => request<SymbolsViewColumnPreferences>(`${API_BASE}/preferences/symbols-view`),
  saveSymbolsView: (body: SymbolsViewColumnPreferences) =>
    put<{ ok: true }>(`${API_BASE}/preferences/symbols-view`, body),
}
```

- [ ] **Step 2: 写 composable**

```ts
export function useSymbolColumnPreferences(scope: 'crypto' | 'aShares', defs: SymbolColumnDef<any>[]) {
  // load -> normalize -> computed columns
  // save -> optimistic update -> rollback on failure
}
```

- [ ] **Step 3: 覆盖加载和回滚**

```ts
const previous = cloneDeep(current.value)
try {
  await preferencesApi.saveSymbolsView(nextPayload)
} catch (err) {
  current.value = previous
  throw err
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/composables/symbols/useSymbolColumnPreferences.ts apps/web/src/api/modules/preferences.ts apps/web/src/api/index.ts
git commit -m "feat(web): add symbols view preference client"
```

### Task 5: 列设置抽屉组件

**Files:**
- Create: `apps/web/src/components/symbols/ColumnSettingsDrawer.vue`

- [ ] **Step 1: 先写组件骨架**

```vue
<template>
  <n-drawer v-model:show="show" placement="right" :width="360">
    <n-drawer-content title="列设置" closable>
      ...
    </n-drawer-content>
  </n-drawer>
</template>
```

- [ ] **Step 2: 做可见性与顺序编辑**

```ts
function moveUp(index: number) { /* swap */ }
function moveDown(index: number) { /* swap */ }
function toggleVisible(key: string, visible: boolean) { /* respect locked */ }
function resetToDefault() { /* restore defs order */ }
```

- [ ] **Step 3: 做保存 / 取消**

保存时只输出 `SymbolsViewColumnPreferences`，不直接碰表格渲染细节。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/symbols/ColumnSettingsDrawer.vue
git commit -m "feat(web): add symbols column settings drawer"
```

### Task 6: 接入 SymbolsView

**Files:**
- Modify: `apps/web/src/views/SymbolsView.vue`
- Modify: `apps/web/src/components/symbols/CryptoSymbolsPanel.vue`
- Modify: `apps/web/src/components/symbols/ASharesPanel.vue`

- [ ] **Step 1: 在两个 panel 工具栏加“列设置”按钮**

```vue
<n-button @click="showColumnSettings = true">列设置</n-button>
```

- [ ] **Step 2: 用 composable 生成最终 columns**

```ts
const columns = computed(() => buildColumnsFromPreference(cryptoColumnDefs, cryptoPrefs.value))
```

- [ ] **Step 3: 把 drawer 绑定到当前 tab**

切换 tab 时保持各自的 drawer 状态和配置状态独立。

- [ ] **Step 4: 手工验证**

Run: `cd apps/web && pnpm dev`  
Expected: 打开 `SymbolsView`，修改列显示与顺序，刷新后仍保留，切换账号后隔离

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/views/SymbolsView.vue apps/web/src/components/symbols/CryptoSymbolsPanel.vue apps/web/src/components/symbols/ASharesPanel.vue
git commit -m "feat(symbols): wire column preferences into view"
```

### Task 7: 端到端验证

**Files:**
- Modify: as needed from the above tasks

- [ ] **Step 1: 后端跑新 spec**

Run: `cd apps/server && pnpm test -- preferences`

- [ ] **Step 2: 前端跑 typecheck**

Run: `cd apps/web && pnpm type-check`

- [ ] **Step 3: 前端跑构建**

Run: `cd apps/web && pnpm build`

- [ ] **Step 4: 手工验证**

验证清单：

- 用户 A 保存 Crypto 列配置后刷新仍在
- 用户 B 看不到用户 A 的配置
- A 股 tab 维持自己的配置
- 固定列不会被隐藏
- 保存失败时回滚到旧状态

- [ ] **Step 5: 最终整理**

```bash
git add -A
git commit -m "feat(symbols): support account-level column preferences"
```

## Self-Review

**Spec coverage**

- 账号级同步: Task 1, 4
- 两个 tab 独立配置: Task 4, 6
- 可见性与顺序: Task 5, 6
- 固定列约束: Task 2, 5
- 默认值与新增列回填: Task 2, 4
- 保存失败回滚: Task 4, 5
- 验证: Task 7

**Placeholder scan**

- No TBD / TODO / implement later placeholders
- 所有代码步骤都指向具体文件和函数
- 所有测试步骤都给出了明确命令

**Type consistency**

- `SymbolsViewColumnPreferences` 用于 API、composable、drawer 的同一份数据结构
- `SymbolColumnDef<Row>` 是前端列元数据统一入口
- `locked` 只表示不可隐藏/不可重排，不影响渲染
