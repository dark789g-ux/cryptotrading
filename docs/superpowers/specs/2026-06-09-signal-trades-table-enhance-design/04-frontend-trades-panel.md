# 04 · 前端 F2：trades 面板（筛选栏 + 可排序表 + 操作列 + 分页）

← [03](./03-frontend-api-store-contracts.md) ｜ [index](./index.md) ｜ 下一篇 [05](./05-frontend-kline-detail-modal.md)

## 目标

把 `SignalStatsResult.vue` 的「逐笔明细」tab 整块抽成 `SignalTradesPanel.vue`，承载筛选栏、可排序表、操作列、分页、详情 Modal 触发；`SignalStatsResult` 回归薄壳。依赖 [03 契约](./03-frontend-api-store-contracts.md) 与 [05 详情 Modal](./05-frontend-kline-detail-modal.md)。

## 现状（file:line）

- `SignalStatsResult.vue:137-148` trades tab：`<n-data-table remote :pagination @update:page>`，列定义 `:317-368`，分页 `:286-291`（`showSizePicker:false`），`loadTrades/handlePageChange` `:293-307`，`fmtTradeDate/fmtRetPct` 已有。

## 布局（ASCII）

```text
┌─ 逐笔明细 ───────────────────────────────────────────────────────────────┐
│ [代码搜索▢] [出场原因▼] [收益% ≥▢ ≤▢] [持仓天 ≥▢ ≤▢]  [重置]            │ ← 筛选栏
├──────────────────────────────────────────────────────────────────────────┤
│ 标的│名称│信号日│买入日│出场日│买价│出价│收益率⇅│持仓⇅│出场原因│操作│  │ ← 表头
│000001│平安银行│..│..│..│..│..│+3.2%│ 5 │ 信号 │[详情]│                  │
├──────────────────────────────────────────────────────────────────────────┤
│              共 N 条    [10/20/50▼]        ‹ 1 2 3 … ›                     │ ← 分页
└──────────────────────────────────────────────────────────────────────────┘
```

## 组件拆分

| 文件 | 职责 | 约 |
|------|------|----|
| `components/strategy/SignalTradesPanel.vue`（新） | orchestrator：筛选/排序/分页状态 + 取数 + 装配 | ~200 行 |
| `components/strategy/signalTradeColumns.ts`（新） | 列定义工厂 `buildTradeColumns({ onViewDetail })` | ~110 行 |
| `components/strategy/SignalTradeKlineModal.vue`（新） | 详情 K 线（见 [05](./05-frontend-kline-detail-modal.md)） | — |
| `views/strategy/SignalStatsResult.vue`（改） | trades tab 内容替换为 `<SignalTradesPanel :run-id="latestRun.id" />`，删除迁出的列/分页/加载逻辑 | 净减 |

> 拆分动机：`SignalStatsResult.vue` 现 410 行，叠加全部新逻辑将破 500 行（code-organization 规范）；抽出后两边都更聚焦。`views/strategy/**` 不在 `lint:quant-lines` 门禁内，但同样守 500 行约定。

## 列定义（signalTradeColumns.ts）

`buildTradeColumns(opts: { onViewDetail: (row: SignalTestTrade) => void }): DataTableColumns<SignalTestTrade>`

- 复用现有 render（`fmtTradeDate`、收益率染色、出场原因 labelMap）——把这些纯函数一并迁入本文件或共用 util。
- 列与排序：

| key | 标题 | sorter | render |
|-----|------|--------|--------|
| tsCode | 标的 | `true` | — |
| **name** | **名称** | **无** | `row.name ?? '—'`（默认⑤不可排序） |
| signalDate | 信号日 | `true` | fmtTradeDate |
| buyDate | 买入日 | `true` | fmtTradeDate |
| exitDate | 出场日 | `true` | fmtTradeDate |
| buyPrice | 买入价 | `true` | toFixed(3) |
| exitPrice | 出场价 | `true` | toFixed(3) |
| ret | 收益率 | `true` | 染色 % |
| holdDays | 持仓天数 | `true` | — |
| exitReason | 出场原因 | `true` | labelMap |
| actions | 操作 | 无 | `h(NButton,{size:'small',onClick:()=>opts.onViewDetail(row)},{default:()=>'详情'})`（参 `aSharesColumns.ts:111`，宽 70 fixed:'right'） |

- `sorter: true` → remote 排序，箭头状态由表格内部维护；面板 `@update:sorter` 取 columnKey/order 重拉。

## 状态与取数（SignalTradesPanel.vue）

```ts
const props = defineProps<{ runId: string }>()
// 筛选栏
const fTsCode = ref(''); const fExitReason = ref<string|null>(null)
const fRetMinPct = ref<number|null>(null); const fRetMaxPct = ref<number|null>(null)   // 百分比输入
const fHoldMin = ref<number|null>(null);   const fHoldMax = ref<number|null>(null)
// 排序/分页
const sortField = ref<ListTradesParams['sortField']>(undefined)
const sortOrder = ref<'asc'|'desc'|undefined>(undefined)
const page = ref(1); const pageSize = ref(50)
// 显示态（本地持有，不经 store）
const rows = ref<SignalTestTrade[]>([]); const total = ref(0); const loading = ref(false)
```

### 参数装配（百分比 → 小数）

```ts
function buildParams(): ListTradesParams {
  return {
    page: page.value, pageSize: pageSize.value,
    sortField: sortField.value, sortOrder: sortOrder.value,
    tsCode: fTsCode.value.trim() || undefined,
    exitReason: fExitReason.value ?? undefined,
    retMin: fRetMinPct.value != null ? fRetMinPct.value / 100 : undefined,   // 默认④
    retMax: fRetMaxPct.value != null ? fRetMaxPct.value / 100 : undefined,
    holdDaysMin: fHoldMin.value ?? undefined,
    holdDaysMax: fHoldMax.value ?? undefined,
  }
}
```

### 竞态与状态

```ts
let reqSeq = 0
async function load() {
  const my = ++reqSeq
  loading.value = true
  try {
    const data = await store.fetchTrades(props.runId, buildParams())
    if (my !== reqSeq) return            // 仅采纳最新一次请求，旧响应丢弃
    rows.value = data.items; total.value = data.total
  } finally {
    if (my === reqSeq) loading.value = false
  }
}
```

- 解决摸底暴露的「按 runId 覆写、切筛选条件取到上次结果」隐患（本地 ref + seq 守卫，彻底不依赖 store 缓存）。

### 事件 → 重拉

- 筛选栏：代码输入 debounce ~300ms；其余「应用」即 `page=1; load()`。提供「重置」清空全部筛选 + `page=1; load()`。
- `@update:sorter(state)`：`columnKey` 经白名单校验后写 `sortField`，`order==='ascend'?'asc':'descend'?'desc':undefined`（清空排序回 undefined → 后端回落默认）；`page=1; load()`。
- `@update:page(p)`：`page=p; load()`。
- `@update:page-size(s)`：`pageSize=s; page=1; load()`（参 `useASharesQuery.ts:270`）。
- 首次加载：父用 `v-if`（tab `display-directive="show:lazy"`）已保证懒挂载；面板 `onMounted` 或 `watch(runId,{immediate:true})` 触发首拉。注意 keep-alive 场景用 `onActivated`（vue3-frontend 规范）——此面板在 Modal 内，无 keep-alive，`onMounted` 即可。

### 分页对象

```ts
const pagination = computed(() => ({
  page: page.value, pageSize: pageSize.value, itemCount: total.value,
  showSizePicker: true, pageSizes: [20, 50, 100], prefix: () => `共 ${total.value} 条`,
}))
```

## 详情触发

```ts
const detailRow = ref<SignalTestTrade|null>(null)
const showDetail = ref(false)
function onViewDetail(row: SignalTestTrade) { detailRow.value = row; showDetail.value = true }
```

模板挂 `<SignalTradeKlineModal v-model:show="showDetail" :trade="detailRow" />`（见 [05](./05-frontend-kline-detail-modal.md)）。

## 验证

1. `pnpm --filter @cryptotrading/web type-check` **且** `pnpm --filter @cryptotrading/web build`（vite，查 SFC 编译，vue3-frontend 规范）。
2. `pnpm --filter @cryptotrading/web lint:quant-lines` 不受影响（本文件域非 quant）；人工确认两文件 ≤500 行。
3. 真机：打开某方案详情 → 逐笔明细：① 各列排序升降序正确且翻页不串 ② 四类筛选生效（含百分比换算）③ 切每页条数重置到第一页 ④ 名称列正确显示 ⑤ 点「详情」弹 K 线。

## 文件清单

- `apps/web/src/components/strategy/SignalTradesPanel.vue`（新）
- `apps/web/src/components/strategy/signalTradeColumns.ts`（新）
- `apps/web/src/views/strategy/SignalStatsResult.vue`（改）
