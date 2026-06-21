# 04 · 表格列与前端

> 前置：[02-calc-and-db.md](./02-calc-and-db.md)（roc10/20/60 已落库）。本篇让 ROC 作为表格列显示并支持服务端排序。

## 4.1 后端：主 SQL 加 ROC 列 + 排序映射

### 4.1a A 股主 SQL

`apps/server/src/market-data/a-shares/data-access/a-shares-query.sql.ts`，`buildASharesBaseQuery`（:134-179）的 SELECT 列表，在 `amvMacd` 之后、tags 之前加：

```sql
        i.roc10 AS "roc10", i.roc20 AS "roc20", i.roc60 AS "roc60",
```

排序映射 `RAW_SORT_COL_MAP`（:50-92）加三行：

```ts
  roc10: 'i.roc10',
  roc20: 'i.roc20',
  roc60: 'i.roc60',
```

> `QFQ_SORT_COL_MAP`（:94-99）`...RAW_SORT_COL_MAP` 自动继承，无需额外加。

### 4.1b 加密主 SQL

`apps/server/src/catalog/symbols/symbols.service.ts`，`querySymbols`（:98-125）的 SELECT 列表，在 `stopLossPct` 之后、tags 之前加：

```sql
        k.roc10, k.roc20, k.roc60,
```

排序映射 `SORT_COL_MAP`（:86-96）加三行：

```ts
      roc10: 'k.roc10',
      roc20: 'k.roc20',
      roc60: 'k.roc60',
```

### 4.1c 行类型扩展

`apps/web/src/api/modules/market/aShares.ts`，`AShareRow`（:18-49）加：

```ts
  roc10: string | null; roc20: string | null; roc60: string | null
```

加密的 `SymbolRow`（在 `apps/web/src/api` 下）同样加 roc10/20/60。

## 4.2 表格筛选条件映射（易遗漏，独立于 query-builder）

> ⚠️ 表格自带的「高级筛选条件」（前端 ASharesFilters/CryptoSymbolsFilters）走的是**独立于 strategy-conditions.query-builder 的映射表**。ROC 落库后，这些映射也要加 ROC 三档，否则表格里按 ROC 筛选会静默失效（`if (!col) continue` 跳过）。**此路径无 cross**（映射表无 cross 操作符）。

### 4.2a A 股表格筛选映射

`apps/server/src/market-data/a-shares/data-access/a-shares-query.sql.ts`：
- `RAW_CONDITION_COL_MAP`（:12-38）加：`roc10: 'i.roc10', roc20: 'i.roc20', roc60: 'i.roc60',`
- `QFQ_CONDITION_COL_MAP`（:40-48）`...RAW_CONDITION_COL_MAP` 自动继承，无需额外加。

### 4.2b 加密表格筛选映射

`apps/server/src/catalog/symbols/symbols.service.ts`，`KLINE_INDICATOR_COLUMNS`（:24-31）加：

```ts
  roc10: 'roc10', roc20: 'roc20', roc60: 'roc60',
```

> `KLINE_OP_MAP`（:33-35）仅 gt/gte/lt/lte/eq/neq，无 cross——加密表格筛选本就不支持 cross，ROC 不改变这一点。

## 4.3 前端：表格列定义

### 4.3a A 股列定义（descriptor 体系）

`apps/web/src/components/symbols/indicatorColumnDefs.ts`，`INDICATOR_DESCRIPTORS`（:37-64）加三条，放 ATR14 之后：

```ts
  { key: 'roc10', title: 'ROC10', decimals: 2, suffix: '%', descKey: 'roc10' },
  { key: 'roc20', title: 'ROC20', decimals: 2, suffix: '%', descKey: 'roc20' },
  { key: 'roc60', title: 'ROC60', decimals: 2, suffix: '%', descKey: 'roc60' },
```

> A 股表格列走 `buildIndicatorColumns`（descriptor 驱动），加 descriptor 即自动出列、出排序、出列设置抽屉分组。

### 4.3b 加密列定义（硬编码）

`apps/web/src/components/symbols/cryptoColumns.ts`，`createCryptoColumnDefs`（:15-99）数组里，在 `Stop %` 之后加三条（仿现有 `formatFixed`）：

```ts
    { title: 'ROC10', key: 'roc10', descKey: 'roc10', width: 90, sorter: true, render: (row) => formatFixed(row.roc10 as number | null | undefined, 2) + '%' },
    { title: 'ROC20', key: 'roc20', descKey: 'roc20', width: 90, sorter: true, render: (row) => formatFixed(row.roc20 as number | null | undefined, 2) + '%' },
    { title: 'ROC60', key: 'roc60', descKey: 'roc60', width: 90, sorter: true, render: (row) => formatFixed(row.roc60 as number | null | undefined, 2) + '%' },
```

> 加密列是硬编码不走 descriptor，需手工加。`%` 后缀：ROC 是百分比。注意 `formatFixed` 返回 `value.toFixed(digits)`，需在其后拼 `%`，或改用带 suffix 的写法（参考 A 股 `stopLossPct` 的 suffix 模式）。

### 4.3c 列分组（columnGroupMeta）

`apps/web/src/components/symbols/columnGroupMeta.ts`，`COLUMN_KEY_GROUP`（:17-86）的均线组或新增动量组。建议放「均线」组（ROC 与价格趋势相关），或新增 `{ key: 'momentum', label: '动量' }` 组。`roc10/roc20/roc60` → `'momentum'`（或 `'ma'`）。

### 4.3d 字段说明（fieldDescriptions）

`apps/web/src/components/common/fieldDescriptions.ts`，为 `roc10/roc20/roc60` 加说明（descKey），解释「N 日变化率百分比」。

## 4.4 默认可见性

ROC 三档默认**不可见**（`defaultVisible` 不设或 false），用户按需在列设置抽屉勾选。避免默认列过多。与现有 `brick`/`amv` 等次要指标一致（它们也不默认可见）。

## 4.5 性能

落库后 ROC 是预存列，排序读列 O(1)，无现算开销。表格按 ROC 排序与按 MA5 排序性能等同（均 ORDER BY 预存列 + NULLS LAST）。

## 4.6 cross 支持的路径边界

| 路径 | cross（上穿/下穿） | 原因 |
|---|---|---|
| strategy-conditions.query-builder（标的筛选模块） | ✅ 支持 | cross 逻辑读 daily_indicator/klines 预存列取前一根，ROC 列入表后自动可用 |
| 表格筛选（a-shares-query / symbols.service） | ❌ 不支持 | 映射表无 cross 操作符，表格筛选本就只支持比较类 |

ROC 落库**不改变**这个既有边界。如需 ROC 穿越 0 轴，用 strategy-conditions 模块（标的筛选页）。
