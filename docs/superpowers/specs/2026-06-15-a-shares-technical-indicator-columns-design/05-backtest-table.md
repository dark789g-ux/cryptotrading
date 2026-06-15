# 05 · 回测「逐K 标的指标」表接入共享选择器

← 返回 [index.md](./index.md)

目标：`CandleRunSymbolMetrics.vue`（host）+ `useCandleRunSymbolMetricsColumns.ts`（列）现无列选择器、表宽 `scroll-x=1360`、指标列硬编码。接入共享 `ColumnSettingsDrawer` 让用户勾选/排序/持久化。

**这是本 spec 最复杂的一块**——有两处与共享路径的摩擦，必须显式处理，不能直接套 `useSymbolColumnPreferences`。

## 两处摩擦（务必处理）

1. **受控远程排序**：表用 `sortOrder: headerOrder(key)` 受控 + `@update:sorter="handleSort"` remote（`CandleRunSymbolMetrics.vue:84-89,96-99,177-193`）。而 `buildColumnsFromPreference` 产物**不含 `sortOrder`**（`useSymbolColumnPreferences.ts:83-91`）。
2. **留空守卫**：每个指标列渲染都有 `row.dataStatus === 'missing' ? '-' : fmt(...)`（`useCandleRunSymbolMetricsColumns.ts:81-131`）。共享渲染器默认无此守卫。

## 1. 列定义重构（`useCandleRunSymbolMetricsColumns.ts`）

拆成「纯 defs 工厂」+ 复用共享目录的指标子集：

```ts
// createBacktestMetricsColumnDefs(opts): SymbolColumnDef<RunSymbolMetricRow>[]
[
  { key:'symbol', title:'标的', fixed:'left', locked:true, defaultVisible:true, sorter:true, render:... },
  { key:'dataStatus', title:'数据', defaultVisible:true, sorter:true, render:... },   // 标签渲染
  { key:'barStatus',  title:'状态', defaultVisible:true, render: renderStatusTags },  // 非指标、无 sorter
  { key:'close', title:'收盘价', defaultVisible:true, sorter:true,
    render:(r)=> r.dataStatus==='missing' ? '-' : fmtNum(r.close,6) },                // 价格列，consumer 自渲
  // —— 指标子集复用共享目录 + blankWhen 守卫 ——
  ...buildIndicatorColumns<RunSymbolMetricRow>(
       INDICATOR_DESCRIPTORS.filter(d => BACKTEST_METRIC_KEYS.has(d.key)),  // close 不在目录;只 ma5/ma30/ma60/kdjJ/riskRewardRatio/stopLossPct
       { blankWhen:(r)=> r.dataStatus==='missing', defaultVisible:true }),
  { key:'actions', title:'操作', fixed:'right', locked:true, defaultVisible:true, render:... },
]
```

- `BACKTEST_METRIC_KEYS = {'ma5','ma30','ma60','kdjJ','riskRewardRatio','stopLossPct'}` —— 回测行（`RunSymbolMetricRow`）实有的指标字段（`number`）。`accessor` 默认即可（`Number()` 归一兼容 number）。
- 非指标列（symbol/dataStatus/barStatus/close/actions）保持 consumer 自渲染，含 `dataStatus` 守卫。
- 这些 key 经 `resolveColumnGroup` 落组：symbol→basic、close→quote、ma*→ma、kdjJ→kdjMacd、riskRewardRatio/stopLossPct→risk、actions→fixed、dataStatus/barStatus→meta(其它)。抽屉自动分组。

## 2. 列偏好持久化（localStorage，新建小 composable）

新建 `useBacktestMetricsColumnPreferences(defs)`（仿 `useWatchlistColumnPreferences` 结构，但**持久化用 localStorage 直读写**，不引 Pinia store、不碰 server `SymbolsViewColumnPreferences`）：

```ts
// storageKey = 'backtest-metrics-columns'
// scopePreferences: computed get/set，get=normalizeScopePreferences(defs, 读localStorage),
//                   set=写localStorage(normalize 后)
// columnsBase = computed(buildColumnsFromPreference(defs, scopePreferences))  // 不含 sortOrder
// reset()/save()/saving
```

- 复用 `normalizeScopePreferences` / `buildColumnsFromPreference` / `createDefaultScopePreferences`（`useSymbolColumnPreferences.ts` 导出，纯函数）。
- localStorage 读写需 try/catch（隐私模式/配额）；解析失败降级为默认 prefs。

## 3. 注入受控 sortOrder（host 侧 post-map，**不扩 SymbolColumnDef 接口**）

host `CandleRunSymbolMetrics.vue` 把 base 列 post-map 注入 `sortOrder`：

```ts
const columns = computed(() =>
  columnsBase.value.map((c) => ({ ...c, sortOrder: headerOrder(String(c.key)) }))
)
```

- `headerOrder` 读 `explicitSort/sortKey/sortOrder` 三个 ref（`:84-89`），故 `columns` 在排序变化时自动重算。✓
- 仅对有 `sorter` 的列，naive 才识别 `sortOrder`；无 sorter 的列（barStatus）带上 `sortOrder:false` 无副作用。
- `@update:sorter="handleSort"`、`buildBody().sort`、远程加载逻辑**全部不变**——排序字段 key 与列 key 一致即闭环。

## 4. host 接线（`CandleRunSymbolMetrics.vue`）

- `n-card title="本根 K · 回测标的池指标"` 的 `#header-extra` slot 加「列设置」按钮，点开 `ColumnSettingsDrawer`。
- 引入 `ColumnSettingsDrawer`：
  ```html
  <ColumnSettingsDrawer v-model:show="showColumnSettings" title="回测指标列"
    :definitions="defs" v-model="scopePreferences" :saving="saving" @save="onSaveColumns" />
  ```
  （drawer 用 `v-model:show` + `v-model`(modelValue) + `@save`，见 `ColumnSettingsDrawer.vue:220-233`）
- `n-data-table :columns="columns"`（post-map 后）替换原 `columns`。`scroll-x` 可保留 1360 或改 `'max-content'`（列数动态后建议 `max-content` 防裁切）。

## 5. 风险与边界

- **最高复杂度块**：若 sortOrder post-map 与 prefs 重排（列顺序）交互出意外（如拖动后排序态错位），实现时优先保证"排序态跟随 column key 而非位置"——`headerOrder(c.key)` 已按 key，天然正确。
- 回测 host 是 `:show` 驱动的子面板（`v-if`/`v-show` 由父定），列偏好 localStorage 读取放 setup 即可（无需等 show）。
- 不改回测后端、不改 `backtestApi.querySymbolMetrics` 契约、不改 `RunSymbolMetricRow`。
- 该表用户基数小、为 nice-to-have：若实现中发现 sortOrder×prefs 摩擦成本过高，可作为本 spec 内**最后落地、可独立回退**的一块（不影响 A股/自选股 已交付价值）。
