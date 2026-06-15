# 04 · 两个 consumer 改造：A股 与 自选股

← 返回 [index.md](./index.md)

## 1. A股 consumer（`apps/web/src/components/symbols/a-shares/aSharesColumns.ts`）

> 注意真实路径在嵌套 `a-shares/` 子目录下；从此处 `import ... from '../indicatorColumnDefs'` 正好解析到 `components/symbols/indicatorColumnDefs.ts`（[03](./03-shared-catalogue-grouping.md) §1 约定的落点）。

`createASharesColumnDefs`（`:25-129`）当前返回 17 个非指标列。改动：在 `tags` 列之后、`操作` 列之前，**splice 进共享指标列**（A股 全隐藏）：

```ts
import { INDICATOR_DESCRIPTORS, buildIndicatorColumns } from '../indicatorColumnDefs'
// ...在 return 数组中 tags 之后、actions 之前：
...buildIndicatorColumns<AShareRow>(INDICATOR_DESCRIPTORS, { defaultVisible: false }),
```

- A股 数值是 `string | null`，默认 accessor `(row,key)=>row[key]` + 渲染器 `Number()` 归一即可，无需自定 accessor。
- `ASharesPanel.vue` 在 `createASharesColumnDefs` 返回后把动态 `buySignal` 列 push 到 `baseDefs`（`:179-192`），所以最终列序是 `…tags, [指标列], 操作(actions,fixed-right), buySignal`——buySignal 落在 `actions` 之后（既有行为），与本次 splice 不冲突。
- 指标列 `sorter: true` → 点表头触发 **remote 排序**（依赖 [02 §3](./02-backend-screener.md#3-排序映射-raw_sort_col_map) 的 sort 映射）。A股 表是 `remote`，排序字段经后端解析。

> 不动 `createASharesColumns`（`:131-133`，`as DataTableColumns` 直转那条）——它走的是非 prefs 路径，本 spec 的列经 `useSymbolColumnPreferences('aShares', columnDefs)` 流转，二者并存。实现时确认 `ASharesPanel.vue` 实际用的是 `columnDefs`（prefs 路径），新指标列才会进列设置。

## 2. 自选股 consumer（`watchlistColumnDefs.ts`）去重

`createWatchlistColumnDefs`（`:63-337`）当前**内联声明了 18 个指标列**（`:237-263`：ma5..ma240 / kdjJ/K/D / dif/dea/macd / bbi / quoteVolume10 / atr14 / lossAtr14 / low9 / high9 / riskRewardRatio / stopLossPct）。改动：

- **删除** `:237-263` 这 18 条内联指标列定义。
- 在同一位置 splice 进共享目录（保留默认可见集）：

```ts
...buildIndicatorColumns<WatchlistQuoteRow>(INDICATOR_DESCRIPTORS, {
  defaultVisible: (k) => new Set(['ma5','ma30','kdjJ','riskRewardRatio']).has(k),
}),
```

- 保留所有非指标列不动（symbol/name/market/.../tags/openTime/modelScore/buySignal/actions），以及它们的 crypto 守卫（`isWatchlistAShare`/`dashForCrypto`）。
- **本期目录会比自选股原有多出 brick/amv 6 列**：自选股 `WatchlistQuoteRow` 若无这些字段，则渲染器读不到值 → 一律 `-`，并默认隐藏，对自选股无害。
  - 决策：保持目录单一（A股/自选股共用全集），多出的列在无数据源处自然显示 `-`。若希望自选股不出现 brick/amv，可让 builder 支持 `only?: string[]` 白名单——**默认不加白名单**（YAGNI），实现时若自选股 UI 觉得冗余再议。

### canonical key 对齐硬约束

去重成立的**前提**：自选股 `WatchlistQuoteRow` 的指标字段名与 A股 `AShareRow` / descriptor key **完全一致**。

- 已核 `watchlistColumnDefs.ts:237-263` 用的就是 canonical key（`ma5/kdjJ/dif/atr14/lossAtr14/riskRewardRatio/stopLossPct/quoteVolume10/low9/high9` 等），与本 spec 一致。
- **实现时必须 grep `WatchlistQuoteRow` 类型定义逐字段核对**（数据完整性规范：进 join/字段断言前亲查类型，禁二手转述）。任一字段名不一致 → 先统一命名，或在自选股 consumer 用自定 `accessor` 适配，**不得**让目录迁就单边别名。

## 3. 渲染零漂移校验点（去重正确性）

抽取后，自选股指标列渲染必须与改前逐 bit 等价：

| 校验 | 改前（watchlistColumnDefs） | 抽取后（目录渲染器） |
|------|------|------|
| null/NaN | `formatFixed`→`'-'` | 渲染器→`'-'` ✓ |
| 小数位 | ma=4 / kdj=2 / rr=2 / stop=2 | descriptor.decimals 对齐 ✓ |
| stopLossPct 后缀 | `${toFixed(2)}%` | suffix `'%'` ✓ |
| 默认可见 | ma5/ma30/kdjJ/RR=true | defaultVisible 集合对齐 ✓ |
| descKey | kdj_j/macd_dif/atr14/... | descriptor.descKey 对齐 ✓ |
| sorter | 全 true | builder `sortable:true` ✓ |

> 自选股排序是表格本地排序（非 remote），`sorter:true` 行为不变。

## 4. 不动项

- `ColumnSettingsDrawer.vue`：泛型通用，零改。
- `useSymbolColumnPreferences.ts` / `useWatchlistColumnPreferences.ts`：复用现有 `normalizeScopePreferences` / `buildColumnsFromPreference`，零改。
- `columnTypes.ts`（`SymbolColumnDef`）：接口够用，零改（除非回测表需扩 `sortOrder`——见 [05](./05-backtest-table.md)，结论是**不扩接口**，用 post-map）。
