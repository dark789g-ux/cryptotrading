# 01 · 接线：一键同步新增 AMV 步骤

← 返回 [`./index.md`](./index.md)

## 现状

`useOneClickSync.ts` 定义 4 步，`start()`（`useOneClickSync.ts:415-431`）按序执行：

```text
1 a-shares     GET /api/a-shares/sync/run        (SSE)
2 money-flow   GET /api/money-flow/sync/run      (SSE)
3 ths-index-daily  GET /api/ths-index-daily/sync/run  (SSE)
4 oamv         POST /api/oamv/sync               (普通 POST，仅 930903.CSI 大盘)
```

第 4 步 `runOamv()`（`useOneClickSync.ts:374-397`）调 `oamvCtrl.confirmSync()`，是普通 POST + await，
**这是新增 AMV 步骤的参照模板**。

## 目标步骤序列

在第 3 步"指数日线"之后追加三步（它们依赖的 `raw.daily_quote` / `ths_index_daily_quotes`
由前面步骤刚拉好，时序顺），末尾保留大盘 0AMV 并重命名标签：

```text
1 A股数据        a-shares
2 资金流向       money-flow
3 指数日线       ths-index-daily
4 个股AMV        stock-amv     POST /api/active-mv/stock/sync     {syncMode:'incremental'}
5 行业指数AMV    industry-amv  POST /api/active-mv/industry/sync  {syncMode:'incremental'}
6 板块(概念)AMV  concept-amv   POST /api/active-mv/concept/sync   {syncMode:'incremental'}
7 大盘0AMV       oamv          POST /api/oamv/sync   ← 标签由"活跃市值0AMV"改为"大盘0AMV(中证全指)"
```

## 改动清单（前端）

### `apps/web/src/components/sync/oneClickSync.types.ts`

- 须同步改**三处**（缺一不可）：
  1. `OneClickStepKey`（L3）增加 `'stock-amv' | 'industry-amv' | 'concept-amv'`；
  2. `STEP_LABELS`（L47，`Record<OneClickStepKey,string>`）补三个新 key 的 label，并把
     `oamv` 的 label 由"活跃市值 0AMV"改为 `大盘 0AMV（中证全指）`（label 集中在此常量，
     **不在** `buildInitialSteps` 内联）；
  3. `buildInitialSteps()`（L69）按目标顺序追加三步（`emptyStep('stock-amv')` 等，
     label 自动取自 `STEP_LABELS`）。
- 步骤顺序须与 `useOneClickSync.ts` 的 `start()` 调用顺序一致。

### `apps/web/src/components/sync/useOneClickSync.ts`

- 新增 `runStockAmv()` / `runIndustryAmv()` / `runConceptAmv()`，**全部照 `runOamv()` 模板**
  （普通 POST、`steps.value[i].percent=30` 起步、await 后置 100、`setStepStatus`、异常入 `errors`）。
- `start()` 在 `runThsIndexDaily()` 之后、`runOamv()` 之前依次插入三步，每步后保留
  `if (cancelled.value) { markRemainingSkipped(...) ; return }` 模式，索引顺延。
- 注意 `markRemainingSkipped` 的 `fromIndex` 随新步骤数调整。

### 新增 composable：`apps/web/src/components/sync/useActiveMvSync.ts`

参照 `useOamvSync.ts` 结构，封装个股/行业/概念三类 sync：

```text
useActiveMvSync(message) 暴露：
  syncDateRange / syncMode ref
  syncStock()    → activeMvApi.syncStock({startDate,endDate,syncMode})
  syncIndustry() → activeMvApi.syncIndustry({...})
  syncConcept()  → activeMvApi.syncConcept({...})
```

> `activeMvApi.syncConcept` 由前端 API 层新增，见 [`./04-frontend.md`](./04-frontend.md)。

### `apps/web/src/components/sync/OneClickSyncPanel.vue`

- 顶部 `ocs-subtitle` 文案更新为：
  `按顺序同步：A股数据 → 资金流向 → 指数日线 → 个股/行业/板块 AMV → 大盘 0AMV`。
- 其余模板/样式无需改（步骤列表已是 `v-for` 渲染，自动适配新步骤）。

## 耗时 / timeout 处理（硬约束）

- 一键同步的三类 AMV 步骤**一律 `syncMode:'incremental'`**。日增量只算选定日期范围内的新交易日，
  量很小（个股按 `STOCK_BATCH=50` 分批，单股 ~30-200ms；增量日通常仅几天）。
- **全量回填禁止进一键同步**：个股全量 ~4000 只最坏 ~13 分钟，普通 POST 会撞网关 60s timeout。
  全量回填仍走各自页面的手动同步。
- spec 实现时须在 `runStockAmv` 注释写明"仅增量；全量回填请走 /symbols 个股同步页"，
  并在该步 message 中提示当前为增量模式。

## 验收（本部分）

- 选一个**小日期范围**（如最近 3 个交易日）跑一键同步，第 4/5/6 步均 `success` 且写入行数 > 0
  （或增量无新数据时显式提示，不报错）。
- 第 7 步标签显示"大盘 0AMV（中证全指）"。
- 取消按钮在新步骤运行时仍能 best-effort 中断（普通 POST 无 abort 句柄，等其返回，参照
  `cancel()` 对 `i===3` 的现有注释处理）。
