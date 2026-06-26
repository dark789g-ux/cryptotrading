# 02 · 前端重构

> 上游：[01-backend-and-migration.md](./01-backend-and-migration.md) ｜ 下游：[03-testing-risks-tasks.md](./03-testing-risks-tasks.md)

## 1. 现状（前端，file:line 为证）

- 通用底座 `apps/web/src/composables/symbols/useSymbolColumnPreferences.ts`
  - `useSymbolColumnPreferences(scope, defs, viewMode)`（`:137`）：内部维护**整份** `SymbolsViewColumnPreferences`（5 scope），`load()` 调 `preferencesApi.getSymbolsView()`（`:193`）、`save()` 调 `saveSymbolsView()`（`:218`）整份读写；`:152-159` 注释"其它 scope 留空、save 前 load 补全"。
  - 纯函数 `createDefaultScopePreferences`/`normalizeScopePreferences`/`buildColumnsFromPreference`（`:31-103`）、`hydrateScope`（`:122-135`）。
- API 层 `apps/web/src/api/modules/user-config/preferences.ts`：`getSymbolsView`/`saveSymbolsView`（`:22-26`）+ `SymbolsViewColumnPreferences` 写死类型（`:14-20`）。类型经 `@/api` 桶文件 re-export。
- 5 个老消费方：`ASharesPanel.vue` / `UsStocksPanel.vue` / `CryptoSymbolsPanel.vue` / `a-shares-index/ASharesIndexThsPanel.vue` / `a-shares-index/ASharesIndexSwPanel.vue`。
- 自选股：`composables/watchlist/useWatchlistColumnPreferences.ts`（转调 `useWatchlistStore`）+ `stores/watchlist.ts`（`columnPreferences` ref `:70` 同步初始化自 localStorage `watchlist-columns`，`saveColumnPreferences` `:168-171` 写 localStorage，`migrateLegacyColumns` `:21-46` 老格式兼容）。
- 回测表：`composables/backtest/useBacktestMetricsColumnPreferences.ts`（localStorage `backtest-metrics-columns`，返回 `columnsBase`，host 在其上 post-map 注入受控排序）+ 消费方 `CandleRunSymbolMetrics`。

## 2. 重构后数据流

```text
  ASharesPanel ┐
  UsStocksPanel│
  CryptoPanel  │
  IndexThs     ┼→ useTableColumnPreferences(tableId, defs, viewMode)
  IndexSw      │      ├─ load() → GET /preferences/columns/:tableId
  WatchlistTable│     └─ save() → PUT /preferences/columns/:tableId
  BacktestTable┘   tableId ∈ {aShares,usStocks,crypto,aSharesIndex,aSharesIndexSw,watchlist,backtestMetrics}
```

## 3. 改动清单

### 3.1 API 层（`api/modules/user-config/preferences.ts` + `@/api` 桶）

- 删 `getSymbolsView`/`saveSymbolsView` 与 `SymbolsViewColumnPreferences` 类型。
- 新增：
  ```ts
  getTableColumns: (tableId: string) =>
    request<ScopeViewPreferences>(`${API_BASE}/preferences/columns/${tableId}`),
  saveTableColumns: (tableId: string, body: ScopeViewPreferences) =>
    put<{ ok: true }>(`${API_BASE}/preferences/columns/${tableId}`, body),
  ```
- 保留 `ColumnPreferenceItem` / `ScopeViewPreferences`；同步 `@/api` re-export（移除 `SymbolsViewColumnPreferences` 导出，grep 全仓引用清零）。

### 3.2 通用 composable（`useSymbolColumnPreferences.ts` → `useTableColumnPreferences.ts`）

- 改名文件 + 导出 `useTableColumnPreferences(tableId: string, defs, viewMode = 'table')`。
- 内部状态从"整份 5-scope 对象"简化为**当前表自己**的 `ScopeViewPreferences`：
  - `load()` → `preferencesApi.getTableColumns(tableId)` → `hydrateScope(defs, payload)`。
  - `save()` → `preferencesApi.saveTableColumns(tableId, preferences.value)`（只写自己，**删掉**"save 前补全其它 scope"逻辑）。
  - 初始化：`preferences` ref 先填 `defaultScopeView()`（默认列），load 后覆盖（异步兜底，见 §4）。
- **通用 composable 自身返回字段不变**：`loading/saving/loaded/scopePreferences/tableColumns/splitColumns/load/save/reset/setColumnVisible/moveColumn/moveColumnByKey`。据此：
  - **已持久化 5 表**：返回字段名与原 `useSymbolColumnPreferences` 完全相同 → 调用方零行为改动（仅改函数名 + tableId）。
  - **自选股 / 回测表**：现有 composable 返回字段名不同（`columns` / `columnsBase`，且无 `load`/`loading`），**不是零改动**——需在转调层把 `tableColumns` 别名回 `columns`、并新增 `load()` 调用（详见 §3.4 / §3.5）。
- 纯函数（`createDefaultScopePreferences` 等）原样保留（自选股 store / 回测 composable 仍 import 它们，路径若随改名变动需同步更新 import）。
- 类型 `SymbolPreferenceScope = keyof SymbolsViewColumnPreferences`（`:8`）改为 `type ColumnPreferenceTableId = string`（或从共享类型引白名单联合）。

### 3.3 五个已持久化老消费方

逐个把 `useSymbolColumnPreferences('aShares', ...)` → `useTableColumnPreferences('aShares', ...)`（tableId 字符串**逐字不变**）+ 更新 import 路径。其余用法（drawer 绑定、tableColumns/splitColumns）不动。另 2 个表（watchlist / backtestMetrics）的改造见 §3.4 / §3.5。

| 消费方 | tableId |
|---|---|
| ASharesPanel | `aShares` |
| UsStocksPanel | `usStocks` |
| CryptoSymbolsPanel | `crypto` |
| ASharesIndexThsPanel | `aSharesIndex` |
| ASharesIndexSwPanel | `aSharesIndexSw` |

### 3.4 自选股

- `useWatchlistColumnPreferences.ts` 改为转调 `useTableColumnPreferences('watchlist', defs, 'table')`，返回 `{ saving, scopePreferences, columns: tableColumns, reset, save, load }`（保持 WatchlistTable 调用面，补 `load`）。
- **移除 `stores/watchlist.ts` 的列偏好逻辑**：删 `columnPreferences` ref（`:70`）、`saveColumnPreferences`（`:168-171`）、`loadColumnPreferences`/`buildDefaultColumnPreferences`/`migrateLegacyColumns`（`:10-56`）、`STORAGE_KEY`（`:7`）及导出（`:186,192`）。store 只保留自选列表本身。
- **实现前必做**：grep `store.columnPreferences` / `saveColumnPreferences` / `useWatchlistStore().*columnPreferences` 全部引用，确认除 `useWatchlistColumnPreferences` 外无其它消费方（有则一并迁移）。
- WatchlistTable 挂载时触发 `load()`（原 localStorage 同步，现需异步，见 §4）。**挂载时机硬约束**：若该组件在 `<keep-alive>` 或 naive-ui `n-tabs` lazy pane 内，须 `onMounted` + `onActivated` **双挂** `load()`——`n-tabs` lazy pane 首挂载**不触发** `onActivated`（见 `.claude/rules/vue3-frontend.md` 与 MEMORY `reference_lazy_tab_pane_onactivated`）。实现前先确认 WatchlistTable 的实际挂载边界。

### 3.5 回测表

- `useBacktestMetricsColumnPreferences.ts` 改为转调 `useTableColumnPreferences('backtestMetrics', defs, 'table')`，删 localStorage 读写（`:10-30`）。
- 原返回 `columnsBase` → 改用通用 `tableColumns`（二者均 `buildColumnsFromPreference` 结果，等价）；host 的受控排序 post-map 挂到 `tableColumns` 上不变。补 `load` 给消费方在挂载时调用。
- `CandleRunSymbolMetrics` 挂载时触发 `load()`（同步→异步，见 §4）；挂载时机同样遵守 §3.4 的 keep-alive / `n-tabs` lazy pane 双挂约束，实现前确认其挂载边界。

## 4. 必须暴露的行为变化：同步 → 异步

- 自选股/回测表原来 localStorage **同步**读，组件渲染时列已就绪。
- 改后端后变**异步** `load()`，首帧偏好未回 → 用 `createDefaultScopePreferences(defs)` 兜底默认列，load 完成响应式刷新。
- 通用 composable 现有初始化（`preferences` ref 先填默认、load 后覆盖）天然处理 → **这是统一红利，不需额外 loading 占位**，但实现时确认默认列在首帧正确渲染、load 回来无闪烁回退。
- **空记录兜底链路**：新用户无记录时后端返回 `EMPTY_SCOPE_VIEW`（`{table:[],split:[]}`），前端 `hydrateScope(defs, {table:[],split:[]})` 内 `normalizeScopePreferences` 会按 defs 补全所有列的默认可见性 → 最终渲染**完整默认列**而非空表，无需额外处理。

## 5. 前端门禁（合并前必跑，见 `.claude/rules/vue3-frontend.md`）

- `pnpm --filter @cryptotrading/web type-check`
- `pnpm --filter @cryptotrading/web build`（vite，type-check 查不出 SFC 编译错）
- `pnpm --filter @cryptotrading/web test`（vitest，含改动的 spec）
