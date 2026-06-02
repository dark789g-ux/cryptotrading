# 04 · 前端：板块 tab 补 0AMV 副图 + API 封装

← 返回 [`./index.md`](./index.md)

## 现状

- `MoneyFlowView.vue:41-46` 三 tab：`market` / `industry` / `sector`。资金流侧
  `industry`(行业) 与 `sector`(板块) 本就是**两张独立表**（`money_flow_industry` /
  `money_flow_sector`），互不混。
- `IndustryFlowPanel.vue` 的副图白名单含 `'0AMV'/'0AMV_MACD'`（`IndustryFlowPanel.vue:66-68`），
  趋势数据经 `trendFetchers.ts` 的 `fetchIndustryTrend` 合并 `activeMvApi.getIndustry(tsCode)`。
- `SectorFlowPanel.vue`（板块）**无 0AMV 副图**，`fetchSectorTrend` 不拉 AMV。
- 个股 AMV 副图在 `AShareDetailDrawer.vue`，走 `activeMvApi.getStock(tsCode)`，本设计不动。

## ⚠️ 实现前必做的真源核对（不得假设）

把概念 AMV 副图挂到"板块"tab 前，**必须核实 `SectorFlowPanel` 行的标识符与 THS `type='N'`
的 `.TI` 指数代码是否同源**：

```text
核对方法（任选其一，落真源）：
  - 查 money_flow_sector 表的 ts_code 样本，比对 ths_index_catalog WHERE type='N' 的 ts_code；
  - 或读 SectorFlowPanel 行绑定字段 + 后端 querySectors 的 SQL，确认其 code 列含义。
判定：
  - 同源（板块行 ts_code 即 .TI 且 type='N'）→ 副图直接走 activeMvApi.getConcept(tsCode)。
  - 不同源（编码体系不同 / 无 ts_code）→ 需先做代码映射或另开"概念 AMV"入口；
    本 spec 不预设映射方案，发现不同源时停下来与负责人确认。
```

> 教训依据 `.claude/rules/datetime.md`「K 线副图对齐 key 不得假设两接口日期格式同源」——
> 同理，**指数代码同源性也不得假设**，必须字面核对。

## 改动清单（前端，假定核对结论为"同源"）

### `apps/web/src/api/modules/market/active-mv.ts`

镜像现有 industry 方法，**新增**（本文件由接线 Agent 统一拥有，见
[`./05-task-split-and-verification.md`](./05-task-split-and-verification.md)）：

```text
getConcept(tsCode, days=250)      → GET  /api/active-mv/concept/{tsCode}?days=
getConceptSignals(tradeDate)      → GET  /api/active-mv/concept/signals?tradeDate=
syncConcept(params)               → POST /api/active-mv/concept/sync
```

### `apps/web/src/components/money-flow/trendFetchers.ts`

- 新增 `fetchConceptTrend`（或在 `fetchSectorTrend` 内并入 AMV 合并），参照 `fetchIndustryTrend`：
  `Promise.all([ths-index-daily K线, querySectors 资金流, activeMvApi.getConcept])` →
  `mergeKlineWithAmv(mergeKlineWithMoneyFlow(kline, flow), amvRows)`。
- 复用 `mergeAmv.ts` 的 `normalizeDateKey`（去短横统一 YYYYMMDD），日期对齐机制不变。

### `apps/web/src/components/money-flow/SectorFlowPanel.vue`

- 副图白名单加 `'0AMV'/'0AMV_MACD'`（与 IndustryFlowPanel 对齐）。
- 把白名单传给 `FlowTrendModal` 的 `availableSubplots`，使 `showAmvCaption`
  （`FlowTrendModal.vue:134-137`）生效。
- 趋势 fetcher 切到含 AMV 的版本。

### `apps/web/src/components/money-flow/FlowTrendModal.vue`

- 标注文案：复用/新增 `AMV_CAPTION_*`（概念可共用现有"信号未校准 + 成分股快照"标注）。
  无结构性改动，仅确保概念场景 caption 正确显示。

## 展示一致性

行业 tab 维持现状（它本就是 type='I'）。改完后行业、板块两 tab 各自展示对应类别的 0AMV 副图，
用户在两个独立 tab 下分别查看，类别不再混淆——即"扶正为一级类别"在前端的落点。

## 验收（本部分）

- `pnpm --filter @cryptotrading/web type-check` **且** `pnpm --filter @cryptotrading/web build`
  （vite）双双通过（记忆教训：type-check 绿 ≠ SFC 能编译，懒加载路由尤甚）。
- 浏览器实看：`/money-flow` → 板块 tab → 任一概念指数点"详情" → K 线下出现 0AMV/0AMV_MACD 副图
  且 caption 显示；切到行业 tab 副图仍正常。
- 若 `.vue` 触碰行数逼近 500，跑相应 lint（`SectorFlowPanel`/`FlowTrendModal` 不在 quant 域，
  但仍守 500 行硬约束，必要时拆分）。
