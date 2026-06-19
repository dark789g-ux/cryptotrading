# 标的分栏视图列设置 设计文档

| 字段 | 值 |
|---|---|
| 日期 | 2026-06-20 |
| 状态 | Draft，待用户审阅 |
| 相关 spec | `2026-06-19-symbols-panel-view-toggle-design/`（视图切换本体）、`2026-06-19-symbols-columns-button-into-filters-design.md`（列设置按钮迁移到 Filters） |

## 1. 背景与问题

### 1.1 现状（file:line 为证）

标的面板（A 股 / 美股 / Crypto）有两种视图模式：

- **表格视图（table）**：`#table` slot，`n-data-table` 绑定 `columns` —— 该 `columns` 由 `useSymbolColumnPreferences` 返回，**完全由列偏好驱动**。
- **分栏视图（split）**：`#split-left` slot，`n-data-table` 绑定 `simpleColumns` / `compactColumns` —— **三个 Panel 均硬编码**，完全不受列设置影响。

```text
ASharesPanel.vue:218-230        simpleColumns   = [名称, 代码, 现价]      硬编码
UsStocksPanel.vue:174-199       compactColumns  = [股票名称, 股票代码, 现价] 硬编码
CryptoSymbolsPanel.vue:195-199  simpleColumns   = [股票名称, 股票代码, 现价] 硬编码
```

列设置按钮（在三个 Filters 里，emit `update:showColumnSettings`）打开 `ColumnSettingsDrawer`，drawer 的 `:definitions` 始终是该市场**完整列全集**，`v-model` 绑定 `scopePreferences`（当前 scope 的扁平 `ColumnPreferenceItem[]`）。

**结论：当前列设置只对表格视图生效，对分栏视图完全无效。** 分栏视图用户无法自定义左表显示哪些列。

### 1.2 视图模式现状

`viewMode`（table/split）目前是 `SymbolsPanelLayout` 的**内部状态**：

- 持久化在 localStorage：`symbols_panel_view_mode_${scope}`（SymbolsPanelLayout.vue:94）。
- `viewMode` 是可选 prop + `update:viewMode` 事件（L74-92, L138-147）。
- **三个 Panel 均未绑定 `view-mode` prop 或事件**——它们不感知当前是哪种视图。

Filters 组件也无 `viewMode` prop，"列设置"按钮是纯单向 emit，无视当前视图。

### 1.3 后端持久化现状

`SymbolsViewColumnPreferences` 扁平结构（前后端各一份镜像）：

```ts
// preferences.service.ts:12-16 / preferences.ts:8-12
interface SymbolsViewColumnPreferences {
  crypto: ColumnPreferenceItem[]     // { key, visible }
  aShares: ColumnPreferenceItem[]
  usStocks: ColumnPreferenceItem[]
}
```

存储为通用 jsonb 行（`user_preferences` 表，key = `symbols_view_columns`）。`sanitizeSymbolsView`（service.ts:33-41）强制结构为这三 scope，**没有按视图再分层**。

## 2. 目标

让分栏视图左表也支持列设置，且：

1. **一个"列设置"按钮**，按当前视图（table / split）生效——drawer 控制"当前可见那张表"的列。
2. **后端独立持久化**两套偏好（table / split），登录账号可见、跨设备一致。
3. 分栏视图 drawer **复用完整列全集**（definitions 不变）。
4. **split 视图默认可见列 = table 偏好的拷贝**（首次使用 / 老数据迁移时）。

## 3. 关键约束与权衡

### 3.1 ColumnSettingsDrawer 签名锁死（不可改 modelValue 类型）

`ColumnSettingsDrawer` 被 4 处复用：

| 消费方 | modelValue 类型 | 文件 |
|---|---|---|
| ASharesPanel / UsStocksPanel / CryptoSymbolsPanel | `scopePreferences`（扁平 `ColumnPreferenceItem[]`） | 见各 Panel |
| CandleRunSymbolMetrics（回测） | `scopePreferences`（扁平） | CandleRunSymbolMetrics.vue:32-39 |
| WatchlistTableSettings（自选） | `draftPreferences`（扁平） | WatchlistTableSettings.vue:6 |

`ColumnSettingsDrawer.vue:224-233` 的 props：`modelValue: ColumnPreferenceItem[]`。

**决策：ColumnSettingsDrawer 完全不动。** Panel 端负责把"当前视图的偏好"切片成扁平数组传给 drawer，保存时再写回对应视图槽位。

### 3.1.1 backtest / watchlist 的影响边界（grep 实证）

回测与自选列表**不 import `useSymbolColumnPreferences` 这个 composable 本身**，只从它 import 三个纯函数：

```text
useBacktestMetricsColumnPreferences.ts:4-8   import { buildColumnsFromPreference, createDefaultScopePreferences, normalizeScopePreferences }
useWatchlistColumnPreferences.ts:4-8         同上
stores/watchlist.ts:4                        同上
```

**承诺：本次改造不改动这 3 个纯函数的签名**（`normalizeScopePreferences(defs, items)` 保持不变，不引入 fallback 参数）。所有 fallback / viewMode 切片逻辑在 composable 内部用私有函数实现。因此 backtest / watchlist **零影响**（§6.4 仍做回归测试）。

### 3.2 split 默认 = table 偏好拷贝（与"分栏应简洁"的张力）

2026-06-19 view-toggle spec（`01-background-decisions.md:11`）曾规定 split-left 是"名称/代码/现价的精简列表"。用户本轮决策选了"复用 table 偏好"，意味着 split 视图初始可能显示几十列（含指标），与"简洁概览"定位有张力。

**缓解措施（写进 spec，实现时落实）：**
- 老数据迁移时，split 槽位初始化为 table 偏好的**深拷贝**，但用户可随时独立调整。
- spec 明确记录这个张力，作为已知设计取舍，不做隐式截断（如偷偷只取前 N 列会让人困惑）。

### 3.3 后端兼容老数据（无痛升级）+ fallback 职责划分

老用户后端存的是扁平 `{ aShares: [...] }`。新结构是 `{ aShares: { table: [...], split: [...] } }`。

**前后端职责严格分层（避免重复 fallback）：**

- **后端 `sanitizeScopeView` 只做结构净化，不做业务 fallback。** 老数组 → `{ table: [...], split: [] }`；新对象 → 原样净化；非法 → `{ table: [], split: [] }`。后端返回的 `split: []` 表示"未知/未设置"。
- **前端 `load()` 是唯一的业务 fallback 层。** 拿到后端 payload 后，对每个 scope：若 `split` 为空数组，用 `table` 深拷贝填充。

```text
后端 sanitizeScopeView（只净化）：
  数组   → { table: items, split: [] }
  对象   → { table: sanitizeItems(obj.table), split: sanitizeItems(obj.split) }
  其它   → { table: [], split: [] }

前端 load（唯一 fallback 层）：
  对每个 scope：
    table = payload[scope].table
    split = payload[scope].split.length > 0 ? payload[scope].split : deepClone(table)
```

**关键推论**：因为后端已把老数据统一净化成"对象"形态，**前端 load 永远走对象分支，不存在"数组分支"**。所有业务 fallback（split 空 → table 拷贝）在前端完成。这样职责单一、可测试、无死代码。

**写回（save）永远是新结构**。用户首次保存即无痛升级，无需 migration 脚本。

## 4. 架构设计

### 4.1 数据流总览

```text
┌─────────────────────────────────────────────────────────────────┐
│  ASharesPanel / UsStocksPanel / CryptoSymbolsPanel              │
│                                                                 │
│    viewMode ◀──v-model:view-mode──▶ SymbolsPanelLayout          │
│      │                              （渲染 table 或 split slot）  │
│      ▼                                                          │
│    useSymbolColumnPreferences(scope, defs, viewMode)            │
│    ┌──────────────────────────────────────────────┐             │
│    │  preferences = {                              │             │
│    │    aShares: { table: [...], split: [...] },   │  ← 两套偏好 │
│    │    crypto:   { table: [...], split: [...] },  │             │
│    │    usStocks: { table: [...], split: [...] },  │             │
│    │  }                                            │             │
│    └──────────────────────────────────────────────┘             │
│      │              │              │                            │
│      ▼              ▼              ▼                            │
│   tableColumns   splitColumns   scopePreferences                 │
│   (绑 #table)    (绑 #split-    (绑 drawer；随 viewMode 在       │
│                   left)          table/split 间切片)             │
└─────────────────────────────────────────────────────────────────┘
                      │ save()
                      ▼
           后端 preferences（jsonb，新结构 §4.4）
```

### 4.2 viewMode 提升到 Panel（Layout 零改动，新增 composable）

**重要发现（grep 实证）**：`SymbolsPanelLayout.vue:138-147` 的 `viewMode` computed 已实现"受控 + fallback 双模"——`get: props.viewMode ?? persistedViewMode.value`，`set: persist + emit`；`L162-167` 还有 watch 同步外部 prop。**Layout 端无需任何改动**。

缺的只是：Panel 端要持有 viewMode ref 并通过 `v-model:view-mode` 传进去。因此：

- **Layout 完全不动**（受控逻辑已就绪）。
- 新建 composable `apps/web/src/composables/symbols/usePanelViewMode.ts`，仅供 **Panel** 持有 viewMode ref：把 view-toggle 逻辑（读 localStorage key `symbols_panel_view_mode_${scope}`、初始值、persist）封装成 `usePanelViewMode(scope) => { viewMode }`。
- Layout 内部那套 localStorage 函数（L94-132）**保留不动**——作为"未绑定时 fallback"继续生效。这样 composable 与 Layout 解耦，Panel 走 composable、Layout 走自己的 fallback，两者通过 prop/emit 通信，无双向耦合。

三个 Panel 模板加 `v-model:view-mode="viewMode"`：

```vue
<symbols-panel-layout scope="aShares" v-model:view-mode="viewMode" ...>
```

> **为什么 Layout 不删内部 fallback**：保留它让 Layout 仍可独立使用（未来其它消费方不传 prop 时能 fallback），符合现有 view-toggle spec 的封装意图。Panel 端通过 composable 拿到同一个 localStorage key 的视图，二者初始值一致。

> **YAGNI 检查**：view-toggle spec（`03-dataflow-views-responsive.md:29-33`）当初刻意把 viewMode 留在 layout 内部，理由是"父组件不需要感知"。现在本次需求要求"按当前视图生效"，Panel 必须感知——这是需求驱动的必要提升，不是过度设计。

### 4.3 useSymbolColumnPreferences 改造

签名加 `viewMode` 参数（响应式）：

```ts
useSymbolColumnPreferences<Row>(
  scope: SymbolPreferenceScope,
  defs: MaybeRef<SymbolColumnDef<Row>[]>,
  viewMode: MaybeRef<'table' | 'split'>,   // ← 新增
)
```

内部 `preferences` 每个 scope 从 `ColumnPreferenceItem[]` 变为 `{ table: ColumnPreferenceItem[]; split: ColumnPreferenceItem[] }`。

**`scopePreferences` 计算属性按 viewMode 切片**（这是核心）。注意 getter 内必须 `unref(defs)`，与现实现一致（否则 defs 为 ref 时 `defs.map` 会炸）：

```ts
const scopePreferences = computed<ColumnPreferenceItem[]>({
  get() {
    const slot = unref(viewMode)  // 'table' | 'split'；响应式依赖会被收集
    return normalizeScopePreferences(unref(defs), preferences.value[scope][slot])
  },
  set(next) {
    const slot = unref(viewMode)
    preferences.value = {
      ...preferences.value,
      [scope]: {
        ...preferences.value[scope],
        [slot]: normalizeScopePreferences(unref(defs), next),
      },
    }
  },
})
```

新增 `tableColumns` / `splitColumns` 两个计算属性（Panel 直接绑 slot）：

```ts
const tableColumns = computed(() => buildColumnsFromPreference(unref(defs), getSlot('table')))
const splitColumns  = computed(() => buildColumnsFromPreference(unref(defs), getSlot('split')))
```

**`columns` 别名删除**（grep 实证：仅 3 个 Panel 解构消费，backtest/watchlist 用各自 composable，不依赖）。Panel 改绑 `tableColumns`。

**load() 逻辑**（单一对象分支，无死代码数组分支）：

```ts
async function load() {
  const payload = await preferencesApi.getSymbolsView()
  preferences.value = {
    [scope]: hydrateScope(unref(defs), payload[scope]),
    // 其它两 scope 也一并 hydrate（save 要回写完整三 scope）
  }
}

// composable 内私有函数，业务 fallback 只在这里
function hydrateScope(defs, raw): ScopeViewPreferences {
  const table = normalizeScopePreferences(defs, raw?.table ?? [])
  const splitRaw = raw?.split ?? []
  const split = splitRaw.length > 0
    ? normalizeScopePreferences(defs, splitRaw)
    : cloneColumnPreferences(table)   // ← 空 split 用 table 深拷贝
  return { table, split }
}
```

> `normalizeScopePreferences` 签名**不变**（仍是 `(defs, items) => ColumnPreferenceItem[]`），所有 fallback 在 `hydrateScope` 私有函数里完成。这样 §3.1.1 的 backtest/watchlist 零影响承诺成立。

### 4.4 后端 schema 扩展

`preferences.service.ts`：

```ts
export interface ScopeViewPreferences {
  table: ColumnPreferenceItem[]
  split: ColumnPreferenceItem[]
}

export interface SymbolsViewColumnPreferences {
  crypto: ScopeViewPreferences
  aShares: ScopeViewPreferences
  usStocks: ScopeViewPreferences
}
```

`sanitizeScopeColumns`（L21-31）改造为 `sanitizeScopeView`（**只做结构净化，不做业务 fallback**——fallback 在前端 `hydrateScope`，见 §3.3 / §4.3）：

```ts
function sanitizeScopeView(input: unknown): ScopeViewPreferences {
  // 兼容老格式：数组 → 当作 table，split 落空 []（表示未设置，前端会 fallback）
  if (Array.isArray(input)) {
    return { table: sanitizeItems(input), split: [] }
  }
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    return {
      table: sanitizeItems(obj.table),
      split: sanitizeItems(obj.split),
    }
  }
  return { table: [], split: [] }
}

function sanitizeItems(input: unknown): ColumnPreferenceItem[] {
  // 原 sanitizeScopeColumns 逻辑
}
```

`sanitizeSymbolsView`（L33-41）三 scope 都改调 `sanitizeScopeView`。

> **不写 migration 脚本**：sanitize 在读时兼容老格式，前端 load 时把 table 拷贝给 split，用户首次 save 即升级为新格式。jsonb schemaless，无需 DDL。

> **前端类型镜像同步**：`apps/web/src/api/modules/user-config/preferences.ts:8-12` 的 `SymbolsViewColumnPreferences` 同步改为新结构。

### 4.5 三个 Panel 的 split-left 接上偏好

删掉硬编码列定义，改绑 `splitColumns`：

```text
ASharesPanel.vue:218-230        删 simpleColumns  →  #split-left 绑 splitColumns
UsStocksPanel.vue:174-199       删 compactColumns →  #split-left 绑 splitColumns
CryptoSymbolsPanel.vue:195-199  删 simpleColumns  →  #split-left 绑 splitColumns
```

模板里 `:columns="simpleColumns"` → `:columns="splitColumns"`。

`compactRowProps`（UsStocksPanel.vue:201-208）保留——选中态逻辑与列无关。

### 4.6 drawer 标题加视图后缀（可选，提升可感知性）

Panel 给 drawer 的 `title` 动态化：

```vue
:title="`${baseTitle}（${viewMode === 'split' ? '分栏视图' : '表格视图'}）`"
```

例：`A 股 Columns（分栏视图）`。让用户明确知道这次设置作用于哪张表。

## 5. 变更清单

```text
新增：
  apps/web/src/composables/symbols/usePanelViewMode.ts

后端：
  apps/server/src/preferences/preferences.service.ts
    - SymbolsViewColumnPreferences 结构改为 scope → {table, split}
    - sanitizeScopeColumns → sanitizeScopeView + sanitizeItems
    - sanitizeSymbolsView 调用点更新

前端类型：
  apps/web/src/api/modules/user-config/preferences.ts
    - SymbolsViewColumnPreferences 同步新结构

composable：
  apps/web/src/composables/symbols/useSymbolColumnPreferences.ts
    - 签名加 viewMode 参数
    - preferences 内部结构按 {table, split} 分层
    - scopePreferences 按 viewMode 切片（getter 内 unref(defs)）
    - 新增 tableColumns / splitColumns
    - 删 columns 别名
    - load() 用私有 hydrateScope 做 fallback（空 split → table 深拷贝）
    - normalizeScopePreferences 等 3 个导出纯函数签名不变

组件：
  apps/web/src/components/symbols/SymbolsPanelLayout.vue
    - 零改动（受控+fallback 已就绪，见 §4.2）
  apps/web/src/components/symbols/ASharesPanel.vue
    - 持有 viewMode（usePanelViewMode），v-model 给 layout
    - 删 simpleColumns，#split-left 绑 splitColumns，#table 改绑 tableColumns
    - drawer title 加视图后缀
  apps/web/src/components/symbols/UsStocksPanel.vue   （同上，删 compactColumns）
  apps/web/src/components/symbols/CryptoSymbolsPanel.vue （同上）
```

**不改：**
- `ColumnSettingsDrawer.vue`（签名锁死，见 §3.1）
- `columnGroupMeta.ts` / `columnTypes.ts`（分组、类型复用）
- 后端 controller / entity / 路由（payload 结构变了但路由不变）
- backtest / watchlist 的列偏好 composable（只消费 3 个签名不变的纯函数，见 §3.1.1）
- `SymbolsPanelLayout.vue` 内部 fallback 逻辑（作为未绑定时的兜底保留）

## 6. 测试

### 6.1 后端单测（preferences.service.spec.ts）

```text
sanitizeScopeView 只净化结构（不做 fallback）：
  ✓ 老格式数组 → { table: [...], split: [] }
  ✓ 新格式对象 → { table: [...], split: [...] }
  ✓ 非法输入 → { table: [], split: [] }
  ✓ 部分缺失（只有 table）→ split 落空 []
getSymbolsView：老数据行 → 返回兼容结构（split:[]）
saveSymbolsView：新结构持久化后读回一致
```

> 注：后端返回 `split:[]` 表示"未设置"，业务级 fallback（空 split → table 拷贝）在前端 `hydrateScope` 完成，见 §4.3。

### 6.2 前端单测

`useSymbolColumnPreferences.spec.ts`（现有，扩展）：

```text
✓ viewMode='table' 时 scopePreferences 读 table 槽
✓ viewMode='split' 时 scopePreferences 读 split 槽
✓ 切换 viewMode → scopePreferences 切片
✓ hydrateScope：老格式（后端返回 split:[]）→ split 初始化为 table 深拷贝
✓ hydrateScope：新格式 split 非空 → 两槽位分别填充
✓ hydrateScope：新格式 split 为空 → split = table 深拷贝
✓ save → payload 为新结构（scope → {table, split}）
✓ tableColumns / splitColumns 独立计算
✓ normalizeScopePreferences 签名不变（回归 backtest/watchlist 兼容）
```

Panel 单测（ASharesPanel.spec.ts / UsStocksPanel.spec.ts / CryptoSymbolsPanel.spec.ts）：

```text
✓ #split-left 绑 splitColumns（不再硬编码 3 列）
✓ 切到 split 视图后打开 drawer → modelValue 是 split 槽
✓ drawer title 含视图后缀
```

### 6.3 端到端手测（browser-driving）

```text
1. 登录，进 A 股面板
2. 切到分栏视图
3. 点列设置 → drawer 显示"A 股 Columns（分栏视图）"
4. 勾选若干列（如加 PE、涨跌幅）→ 保存
5. 验证：分栏左表显示新列；切回表格视图，表格列不变（table 偏好独立）
6. 刷新页面 → 两套偏好都还在（后端持久化生效）
7. 换浏览器/无痕 → 偏好仍在（跨设备）
8. 验证老数据：手动把后端某用户存为老格式 → 读回时 split = table 拷贝
```

### 6.4 回归（backtest / watchlist）

```text
✓ 回测面板列设置正常（CandleRunSymbolMetrics）
✓ 自选列表列设置正常（WatchlistTableSettings）
（这两处用的是独立 composable，理论上零影响，但需回归跑一遍）
```

## 7. 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| backtest/watchlist 复用 ColumnSettingsDrawer 受影响 | 低 | 中 | drawer 签名不动（§3.1），只回归测试 |
| 老用户 split 初始显示几十列（与简洁定位冲突） | 中 | 低 | spec 记录张力（§3.2），用户可自行精简 |
| viewMode 提升破坏 view-toggle spec 的封装意图 | 低 | 低 | 必要提升，YAGNI 已论证（§4.2） |
| 后端 jsonb 结构变更，并发写入丢 split | 低 | 中 | save 永远写完整三 scope × 两视图（6 槽），原子 upsert |

## 8. 验收标准

1. 分栏视图左表的列由 split 偏好驱动，不再是硬编码 3 列。
2. 分栏视图打开列设置，drawer 列池 = 完整列全集，标题含"分栏视图"后缀。
3. 分栏列设置与表格列设置互相独立（改 split 不影响 table，反之亦然）。
4. 两套偏好都持久化到后端，跨设备可见。
5. 老用户（后端扁平格式）首次访问，split 视图初始 = table 偏好拷贝，无报错。
6. 回测面板、自选列表的列设置功能不受影响。
7. 前后端单测 + type-check + 端到端手测全通过。

## 9. 开放问题（实现时再定，不阻塞 spec）

- drawer 标题后缀文案是否需要 i18n 或进一步精简：当前中文够用。
- `usePanelViewMode` 是否复用 Layout 内部已存在的 localStorage key 常量（目前 spec 让 composable 独立定义同名 key），实现时若发现重复可抽到共享常量。
