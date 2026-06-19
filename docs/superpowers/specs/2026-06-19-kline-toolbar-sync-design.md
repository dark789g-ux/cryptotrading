# KlineChartToolbar 与已加载 K 线时间同步设计

## 背景与目标

`KlineChartToolbar.vue` 中的 `kline-toolbar__range` 目前显示的是**用户选中的时间区间**（用户未选择或清空时显示为空），而当前 K 线图中实际已加载的 bar 范围可能因以下原因与之不同：

- 服务端重查场景（A 股/美股）中，后端按 `limit` 返回区间内最近 N 根，用户选的大区间名不副实。
- 客户端裁切场景（Crypto/美股指数）中，用户选的区间与 `displayKlineData` 的首末 bar 可能不完全重合。
- 默认窗口场景（美股指数最近 200 根）中，用户未选区间但图表实际只显示了一部分。

本设计目标：

1. `kline-toolbar__range` 中显示的数值应当和当前 K 线图中**已加载 bar 的首末时间**保持一致。
2. 用户在 `n-date-picker` 中选定区间并点击确认后，K 线图中加载的 K 线数量应当相应变化。

## 术语

| 术语 | 含义 |
|---|---|
| `desiredRange` | 用户在 `n-date-picker` 中选择并确认的时间区间，用于驱动数据加载。 |
| `actualRange` | 当前实际已加载到 `KlineChart` 的 `data` 中第一根和最后一根 bar 的 `open_time` 所对应的毫秒时间戳区间。 |
| A 类（客户端裁切） | 父组件先加载全量数据，再用 `slice*BarsByRange` 在本地裁切出 `displayKlineData`。 |
| B 类（服务端重查） | 父组件把 `desiredRange` 传给后端，后端返回对应区间（或受 limit 截断后）的数据。 |

## 现状

- `KlineChartToolbar.vue` 是纯透传组件：`:value="range"`，`@update:value` 直接 `emit('update:range')`。当 `range` 为 `null`（用户未选择）时，日期选择器显示为空。
- `KlineChart.vue` 是纯展示组件：数据、`range` 由父组件提供；副图偏好的初始 key 与白名单由父组件指定，实际状态由内部 `useKlineChartPrefs` 管理并回传父组件。
- Range 状态通过 `useKlineRangePicker()` 在父组件局部管理，没有专门的 chart Pinia store。
- 时间字段统一为 `open_time: string`，但格式分为两种：
  - A 股/美股/0AMV：`YYYY-MM-DD`
  - Crypto：ISO 时间戳（如 `2024-01-01T08:00:00Z`）
- 前端日期选择器使用本地午夜毫秒，禁止混用 UTC 方法（参见 `klineDateRange.ts` 约定）。

## 设计方案

### 采纳方案

采用**方案 1：Toolbar 自计算 actual range**。只扩展 `KlineChartToolbar.vue` 的能力，父组件保持现有 A/B 类加载逻辑不变。

### 核心思路

1. `KlineChartToolbar` 新增 `data: KlineChartBar[]` prop。
2. 工具栏显示值从 `data` 派生（`actualRange`），而不是直接使用 `range` prop。
3. `range` prop 保留，作为数据为空时的 fallback，用于回显用户刚选的 `desiredRange`。
4. 用户在 `n-date-picker` 中确认区间后，仍通过 `emit('update:range')` 通知父组件加载。
5. 父组件加载/裁切完成后更新 `data`，Toolbar 显示自动刷新为新的 `actualRange`。

### 数据流

```text
父组件持有 data 和 desiredRange（range）
        │
        │ ① 把 data 传入 Toolbar（新增 prop）
        ▼
┌───────────────────────┐
│ KlineChartToolbar     │
│  ┌─────────────────┐  │
│  │ 显示 actualRange │  │◀── computed: 从 data 首末 bar 派生
│  │                 │  │
│  │ 用户点确认        │  │
│  └────────┬────────┘  │
└───────────┼───────────┘
            │ ② emit('update:range', desiredRange)
            ▼
父组件执行现有加载/裁切逻辑
            │
            ▼
data 更新 ──▶ 回到 ①，Toolbar 显示自动刷新
```

### `KlineChartToolbar.vue` 改动

#### Props

```ts
const props = withDefaults(
  defineProps<{
    granularity: Granularity
    range: [number, number] | null      // 用户上一次确认的选择（desiredRange）
    data: KlineChartBar[]               // 新增：当前实际已加载数据
    disabledRange?: boolean
    prefs: SubplotPrefs
    update: (partial: RawSubplotPrefs) => void
    reset: () => void
  }>(),
  { disabledRange: false },
)
```

#### `actualRange` computed

```ts
const actualRange = computed<[number, number] | null>(() => {
  if (props.data.length === 0) return null

  const first = props.data[0].open_time
  const last = props.data[props.data.length - 1].open_time

  return [openTimeToMs(first), openTimeToMs(last)]
})
```

#### `openTimeToMs` 工具函数

```ts
function openTimeToMs(openTime: string): number {
  // Crypto: ISO 时间戳
  if (openTime.includes('T')) {
    return new Date(openTime).getTime()
  }
  // A 股/美股/0AMV: YYYY-MM-DD，按本地午夜处理
  const [y, m, d] = openTime.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.getTime()
}
```

> 注意：必须使用 `getFullYear/getMonth/getDate` 等本地方法，禁止混用 `getUTC*`。项目约定 `n-date-picker` 与 `YYYY-MM-DD` 日期字符串均按同一本地时区解释，因此 `new Date(y, m - 1, d)` 与选择器毫秒值处于同一基准，不会产生偏移。

#### `n-date-picker` 绑定

```vue
<n-date-picker
  ...
  :value="actualRange ?? range"
  @update:value="onRangeUpdate"
/>
```

#### `onRangeUpdate`

```ts
function onRangeUpdate(value: [number, number] | null): void {
  emit('update:range', value)
}
```

该函数仅将用户确认后的 `value` 通过 `emit('update:range', value)` 向上抛出，不做任何本地状态写入或额外处理。

### `KlineChart.vue` 改动

`KlineChart` 本身需要把 `props.data` 透传给内部使用的 `KlineChartToolbar`：

```vue
<kline-chart-toolbar
  :data="props.data"
  :range="range"
  ...
/>
```

### 父组件改动

需要新增 `:data` 或确保 `KlineChart` 的 `:data` 正确透传的所有调用方：

| 父组件 | 类型 | 传入 Toolbar 的数据 |
|---|---|---|
| `CryptoSymbolsPanel.vue` | A 类客户端裁切 | `displayKlineData` |
| `WatchlistTable.vue` | A 类路径（Crypto） | `displayKlineData`（裁切后实际显示的数据） |
| `WatchlistTable.vue` | B 类路径（A 股） | 后端返回并传给 `KlineChart` 的 `klineData` |
| `AShareDetailDrawer.vue` | B 类服务端重查 | 后端返回并传给 `KlineChart` 的 `klineData` |
| `UsStockDetailDrawer.vue` | B 类服务端重查 | 后端返回并传给 `KlineChart` 的 `klineData` |
| `UsIndexPanel.vue` | A 类客户端裁切 | `displayBars` |

以下调用方不渲染 Toolbar，无需改动：

| 父组件 | 原因 |
|---|---|
| `FlowTrendModal.vue` | 不传 `show-toolbar`，Toolbar 不渲染 |

以下调用方渲染 Toolbar 但 `disabledRange=true`，建议补上 `:data` 以显示 actualRange：

| 父组件 | 原因 |
|---|---|
| `KlineChartModal.vue`（回测） | `:disabled-range="true"` |
| `SignalTradeKlineModal.vue` | `:disabled-range="true"` |

### 行为变化

| 场景 | 当前行为 | 新行为 |
|---|---|---|
| A 股选 5 年区间，后端返回最近 1000 根 | Toolbar 显示完整 5 年 | Toolbar 显示实际 1000 根的首末日期 |
| Crypto 选区间后客户端裁切 | Toolbar 显示用户选的区间 | Toolbar 显示裁切后首末 bar 时间 |
| us-index 默认显示最近 200 根 | Toolbar 为空 | Toolbar 显示这 200 根的首末时间 |
| 清空 range | Toolbar 为空，图表显示全部 | Toolbar 显示全部数据首末时间 |

## 边界情况

### 1. 空数据

- `data.length === 0` 时 `actualRange` 返回 `null`。
- Toolbar fallback 到 `range`，显示用户刚选的 `desiredRange`。
- 若 `range` 也为 `null`，则 `n-date-picker` 显示为空。
- 不触发额外加载，避免空数据 → 加载 → 空数据的死循环。

### 2. 后端 `limit` 截断

- 父组件拿到后端返回的 `data` 后原样传入 Toolbar。
- Toolbar 只信任 `data` 的首末 bar，不感知用户原始选择。

### 3. 默认窗口

- 默认行为：父组件把 `displayBars`（如 `allBars.slice(-200)`）传入 Toolbar，Toolbar 显示实际窗口的首末时间。
- 例外：仅在调用方明确需要保留"未选区间"空状态时，才允许在未选区间时传 `null` 给 Toolbar 的 `data`。

### 4. 并发请求

- `n-date-picker` 点确认才触发一次，天然防抖。
- 父组件现有异步请求应保持取消/忽略过期请求的习惯；如现有代码缺失，本次改造可顺带补。

### 5. 时间精度与格式

- `openTimeToMs` 兼容两种 `open_time` 格式。
- 秒级/分钟级精度由数据本身决定，工具栏只负责显示数据已有精度。

### 6. 循环更新风险

```text
用户确认 range ──▶ 父组件加载 ──▶ data 更新 ──▶ actualRange 更新
                              ↑                         │
                              └──────── 不会再次 emit ──┘
```

`actualRange` 只是 computed 显示，不会 emit 事件，因此不会形成循环。

## 测试方案

### 单元测试

为 `KlineChartToolbar.vue` 新增 vitest 测试：

| 用例 | 输入 | 期望 |
|---|---|---|
| 空数据 + 无 range | `data=[]`, `range=null` | `n-date-picker` 值为 null |
| 空数据 + 有 range | `data=[]`, `range=[A,B]` | 显示 `[A,B]` |
| 有数据（日期格式） | `data=[{open_time:'2024-01-01'}, {open_time:'2024-01-05'}]` | 显示对应本地午夜 ms |
| 有数据（ISO 格式） | `data=[{open_time:'2024-01-01T08:00:00Z'}, ...]` | 正确解析为 ms |
| 用户确认选择 | 触发 `@update:value` | `emit('update:range')` 被调用一次 |

### 端到端 / 手测

1. **A 股详情抽屉：** 选一个超过 1000 根的区间，确认 Toolbar 显示实际返回的首末日期。
2. **Crypto 详情抽屉：** 选一个区间，确认 Toolbar 显示裁切后首末 bar 时间。
3. **us-index 面板：** 不选区间时，确认 Toolbar 显示最近 200 根的首末时间。
4. **清空 range：** 确认图表显示全部数据，Toolbar 显示全部数据首末时间。
5. **回测/信号弹窗：** 确认禁用 range 的场景下 Toolbar 仍正常显示 actualRange。

### 回归检查

- A 股/美股价格模式切换（前复权/不复权）后，Toolbar 是否随 `data` 刷新。
- 粒度切换（date/hour/minute）后，Toolbar 格式与数据精度是否一致。

## 风险与回滚

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| `openTimeToMs` 时区/格式处理错误 | Toolbar 显示时间偏移或解析失败 | 严格遵循本地午夜约定，补充单元测试覆盖两种格式 |
| 父组件漏传 `:data` | Toolbar 显示为空或 fallback 到旧 range | 修改时 grep 所有 `KlineChartToolbar` / `kline-chart` 调用点 |
| 用户不习惯显示被截断后的区间 | 交互预期变化 | 在需求层面已确认；如需可后续在 Toolbar 旁增加"实际加载"提示 |

回滚方式：恢复 `KlineChartToolbar.vue` 中 `:value="actualRange ?? range"` 为 `:value="range"`，并移除 `data` prop。
