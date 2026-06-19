# Symbols 视图 Columns 列设置按钮迁入各视图 Filters

> 日期：2026-06-19 ｜ 域：symbols（市场标的页）｜ 状态：设计待审

## 背景与目标

市场标的页（`SymbolsView`）四个 tab：crypto / aShares / activeMarketValue / usStocks。其中 crypto / aShares / usStocks 三个 Panel 共用 `SymbolsPanelLayout.vue`。

当前「Columns 列设置」按钮**写死在 `SymbolsPanelLayout` 的 header**（L11-16），三个视图共享同一个按钮。点它 emit `update:showColumnSettings(true)`，各 Panel 各自渲染自己的 `ColumnSettingsDrawer`。

列设置的**内容**早已按 scope 独立（每个 Panel 各自 `useSymbolColumnPreferences(scope, defs)`，后端 API 持久化、三 scope 完全隔离），但那个**共享按钮**让「这是哪个视图的列设置」在视觉上不清晰，且把列设置入口放在了与筛选无关的 layout 顶栏。

**目标**：把 Columns 按钮从共享 layout 迁入三个视图各自的 filters 组件（位于「重置」按钮左边），让每个视图拥有自己专属的列设置入口；同时从 layout 删除共享按钮，避免重复。

## 现状（摸底事实，file:line 为证）

### Columns 按钮当前位置
`apps/web/src/components/symbols/SymbolsPanelLayout.vue`
- L11-16：`<n-button secondary>` + `SettingsOutline` 图标 + 文案「Columns」，位于 header 的 `.header-left`，顺序 Refresh → **Columns** → 视图切换
- L85 / L97：`showColumnSettings` prop + `update:showColumnSettings` emit
- L146 / L171-179 / L196-201：内部 `persistedShowColumnSettings` ref / computed / watch
- L211-213：`handleOpenColumnSettings()` → `showColumnSettings.value = true` + emit

### 三个 filters 的重置按钮位置
- `a-shares/ASharesFilters.vue` L91-112：`.filter-actions` 顺序 `重置 → 高级筛选 → 筛选方案 → 应用`，重置是第一个；样式 `margin-left:auto; display:flex; gap:10px`
- `us-stocks/UsStocksFilters.vue` L64：`.filter-actions` 顺序 `重置 → 高级筛选 → 应用`
- `crypto/CryptoSymbolsFilters.vue` L34：`.filter-actions` 顺序 `Reset → Filters → Apply`（英文）

### scope 隔离（早已成立）
`composables/symbols/useSymbolColumnPreferences.ts`：scope ∈ `crypto | aShares | usStocks`，三 scope 完全隔离，后端 API 持久化（非 localStorage）。三 Panel 各自独立调用，互不干扰。

### 不受影响
- 活跃市值 tab（`ActiveMarketValuePanel`）不用 SymbolsPanelLayout
- `backtest/CandleRunSymbolMetrics.vue` 不用 SymbolsPanelLayout（自有列设置按钮，走另一套 composable `useBacktestMetricsColumnPreferences`）

## 设计

### 接线方式：v-model 平移（方案 1）

filters 新增 `showColumnSettings` prop + `update:showColumnSettings` emit。Panel 把现有 `showColumnSettings` ref 的绑定从 `<symbols-panel-layout>` 平移到 `<*-filters>`；`ColumnSettingsDrawer` 仍在 Panel 根、绑定不变。

数据流（改后）：

```text
[用户点 filters 里的「列设置」]
        │  emit('update:showColumnSettings', true)
        ▼
[Panel 的 showColumnSettings ref = true]
        │  v-model:show
        ▼
[ColumnSettingsDrawer 打开] ──(用户改完点保存)──▶ drawer emit update:show(false)
        │                                              │
        ▼                                              ▼
   Panel ref = false（关闭）                    save → 后端 API（仅本 scope）
```

淘汰方案：
- 方案 2（filters 仅 emit 单向 `openColumnSettings`）：省一个 prop，但与既有 v-model 模式不一致，未真正省事。
- 方案 3（连 drawer 一起搬进 filters）：破坏 Panel 持有 query / columns / scope 的职责边界，过度。

### 改动清单

**1. 三个 filters 组件** — 在 `.filter-actions` 内、重置按钮**左边**新增「列设置」按钮

```text
ASharesFilters .filter-actions
  改前:  [ 重置 ] [ 高级筛选▾ ] [ 筛选方案▾ ] [ 应用 ]
  改后:  [ ⚙ 列设置 ] [ 重置 ] [ 高级筛选▾ ] [ 筛选方案▾ ] [ 应用 ]
```

按钮规格：
- `secondary` + `SettingsOutline` 图标 + 中文文案「列设置」（三视图统一中文）
- 点击 `emit('update:showColumnSettings', true)`
- 新增 props：`showColumnSettings?: boolean`
- 新增 emits：`'update:showColumnSettings': [boolean]`

涉及文件：
- `apps/web/src/components/symbols/a-shares/ASharesFilters.vue`
- `apps/web/src/components/symbols/us-stocks/UsStocksFilters.vue`
- `apps/web/src/components/symbols/crypto/CryptoSymbolsFilters.vue`

**2. 三个 Panel** — 接线平移
- 从 `<symbols-panel-layout>` 移除 `v-model:showColumnSettings`
- 加到各自 `<*-filters>` 上（`v-model:show-column-settings="showColumnSettings"`）
- `ColumnSettingsDrawer` 保持 Panel 根、绑定不变

涉及文件：
- `apps/web/src/components/symbols/ASharesPanel.vue`
- `apps/web/src/components/symbols/UsStocksPanel.vue`
- `apps/web/src/components/symbols/CryptoSymbolsPanel.vue`

**3. `SymbolsPanelLayout.vue` 瘦身**
- 删 Columns `<n-button>`（L11-16）
- 删 `showColumnSettings` prop（L85）、`update:showColumnSettings` emit（L97）
- 删内部 `persistedShowColumnSettings` ref / computed / watch（L146 / L171-179 / L196-201）
- 删 `handleOpenColumnSettings`（L211-213）
- 删 `SettingsOutline` import（L77）
- header-left 仅剩 Refresh + 视图切换

**4. 测试**
- `SymbolsPanelLayout.spec.ts`：删 Columns 按钮断言（「3 个 button」→「2 个」、删 `update:showColumnSettings` 用例 L109-116）
- 三个 filters 各补单测：mount → 点「列设置」→ 断言 emit `update:showColumnSettings(true)`

## 不在范围（YAGNI）

- 列设置**内容** / scope 逻辑（早已各视图独立，本次只动按钮位置与归属）
- 活跃市值 tab、`CandleRunSymbolMetrics`（均不经 SymbolsPanelLayout）
- crypto filters 现有 `Reset` / `Apply` 英文文案中文化（既有不一致，不顺带改；本次仅统一新增的 columns 按钮文案为中文）
- 视图切换 / split 布局等 layout 其它能力（不动）

## 验证标准

1. 三视图各自 filters 里出现「列设置」按钮，位于重置左边
2. layout header 不再有 Columns 按钮（无重复）
3. 任一视图点「列设置」→ 仅打开**本视图**的 drawer，列改动仅影响本 scope（切到其它视图不受影响）
4. keep-alive 切 tab 不误关 drawer、不串 scope
5. 单测：layout 不再断言 Columns 按钮；三 filters 各有「点按钮 → emit」用例
6. 门禁：`pnpm --filter @cryptotrading/web type-check` 绿、`pnpm --filter @cryptotrading/web test`（vitest）绿
