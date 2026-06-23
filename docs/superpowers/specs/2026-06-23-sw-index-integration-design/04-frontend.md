# 04 · 前端（申万 sub-tab）

## 4.1 目标布局

```text
「A 股指数」面板（ASharesIndexPanel 改造为 sub-tab 容器）
┌──────────────────────────────────────────────────┐
│ [同花顺指数] [ 申万指数* ]      ← n-tabs 内嵌     │
│ ──────────────────────────                       │
│ 申万区 (ASharesIndexSwPanel):                     │
│  层级 [一级][二级][三级]   (n-radio-group)        │
│  [搜索] [刷新] [列设置]                           │
│  ┌──┬───┬──┬──┬──┬──┬────┬────┐                 │
│  │代码│名称│级│收│涨│量│ PE │ PB │  ← 仅申万区显示 │
│  └──┴───┴──┴──┴──┴──┴────┴────┘                 │
│  行点击 → ASharesIndexKlineModal (复用)           │
│ 同花顺区 (ASharesIndexThsPanel): 现有 n-select 不变 │
└──────────────────────────────────────────────────┘
```

## 4.2 组件拆分（单文件 ≤500 行 + 单一职责）

现有 `ASharesIndexPanel.vue`（已验证 T7/T8）改造为**薄 sub-tab 容器**，原逻辑下沉：

```text
a-shares-index/
├── ASharesIndexPanel.vue        ← 改：n-tabs 容器（同花顺/申万），薄
├── ASharesIndexThsPanel.vue     ← 新：原 ASharesIndexPanel 的同花顺逻辑（n-select + table）
├── ASharesIndexSwPanel.vue      ← 新：申万逻辑（层级切换 + table + pe/pb）
├── ASharesIndexKlineModal.vue   ← 不变（两区共用）
├── aSharesIndexColumns.ts       ← 改：pe/pb 列 + showValuation 开关
├── types.ts                     ← 改：IndexCategory +'sw'，IndexLatestRow +pe/pb
└── useASharesIndexQuery.ts      ← 改：支持 type='sw' + level
```

> 拆分注意回归：原 `ASharesIndexPanel` 的 `onMounted`+`onActivated` 双触发 reload（`:133-142`，因 keep-alive）、`indexPanelRef.resize()`（`ASharesTabsContainer.vue:29-33`）要保留到对应 sub-panel。

## 4.3 类型与列定义

**`types.ts:11`**：
```ts
export type IndexCategory = 'market' | 'industry' | 'concept' | 'sw';
export interface IndexLatestRow { /* 现有字段... */ pe: number | null; pb: number | null; }
```

**`aSharesIndexColumns.ts`**：`createASharesIndexColumnDefs({ showValuation }: { showValuation: boolean })`
- 加 `pe`/`pb` 两列（sorter，`defaultVisible: true`）—— **sorter 依赖后端 `SORT_COL_MAP` 加 pe/pb**（[02 §2.8](./02-backend-sync.md)），否则点排序静默 fallback 到 pct_change
- `showValuation=false`（同花顺区）时从列数组剔除 pe/pb；`=true`（申万区）时包含
- 现有 CATEGORY_LABEL（`:14-18`）加 `sw: '申万'`

## 4.4 查询（level 过滤 + name 来源）

申万按 `level` 过滤，**level 与 name 都在 `sw_index_catalog`**（不在 `index_daily_quotes`）。采用**两步查询**避免 JOIN：

- 后端 `index-daily.service.ts`（`market-data/index-daily/`，非 ths-index-daily 目录）`getLatest` 加 sw 分支：
  ```text
  type='sw' 时:
    1. swCatalogRepo.find({ where: { level }, select: ['tsCode','name'] }) → rows[]
    2. baseWhere 追加 AND q."ts_code" = ANY($tsCodes)
    3. name 取自 sw_index_catalog（COALESCE(c.name, s.name)，见 02 §2.8）
  ```
- 前端 `useASharesIndexQuery`：申万区请求带 `type=sw&level=1|2|3`
- `WHERE q.category = $1`（`index-daily.service.ts:96`）的 `($1::text IS NULL OR q.category = $1)` 形式保留，level 作为额外参数

**性能权衡**：level=3 时 `tsCodes[]` 达 346，`ANY($tsCodes)` 配合 `DISTINCT ON` + 分页。申万全量约 35 万行（511 指数 × 5 年），量级小可接受；若未来卡顿，给 `index_daily_quotes WHERE category='sw'` 加部分索引。

## 4.5 K 线 Modal 复用

`ASharesIndexKlineModal.vue`（212 行，已验证 T8）零改动复用：副图白名单 `['VOL','KDJ','MACD']`（`:77`），调 `indexDailyApi.queryKline`，申万 tsCode 自动走通（数据在 `index_daily_quotes` category='sw'）。

> 注：`reference-n-modal-lazy-teleport-slot-klinechart` 记录的 n-modal KlineChart dev 渲染坑是 T8 已知项，production build 正常；本 spec 不新增 Modal，复用现成的，无新增风险。

## 4.6 列偏好（e2e 注意）

申万区列设置走 `useSymbolColumnPreferences('aSharesIndexSw', ...)`（独立 key，与同花顺区 `'aSharesIndex'` 分离），避免互染。**真机 e2e 若勾选申万列偏好，验完恢复默认**（项目规范：不在用户账号留脚印）。
