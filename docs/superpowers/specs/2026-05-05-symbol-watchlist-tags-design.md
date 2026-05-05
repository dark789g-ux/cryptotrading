# 标的自选组标签设计

日期：2026-05-05

## 背景

标的（symbol）可被纳入多个自选组（watchlist）。用户希望在标的表格中看到每个标的属于哪些自选组（以标签形式展示），并能按自选组筛选标的（多选，并集/OR 语义）。

## 方案：后端 JOIN 查询 + 前端标签展示与筛选

### 数据流

```
前端 POST /api/symbols/query
  body: { ...existing, watchlistIds?: string[] }
       ↓
后端 LEFT JOIN watchlist_items + watchlists
  → 每个 symbol 聚合出 tags: [{id, name}, ...]
  → watchlistIds 过滤（并集：属于任一选中自选组即匹配）
       ↓
返回 { items: [{...symbolFields, tags}], total }
       ↓
前端渲染 tags 列（n-tag 标签组）
前端筛选栏多选下拉（选项 = 当前用户所有自选组名）
```

### 后端改动

#### 1. DTO 扩展

`QuerySymbolsDto` 增加可选字段：

```ts
watchlistIds?: string[]  // 自选组 ID 列表，OR 语义
```

#### 2. querySymbols 方法改造

在现有 CTE 查询基础上：

- LEFT JOIN `watchlist_items wi ON wi.symbol = k.symbol`
- LEFT JOIN `watchlists w ON w.id = wi.watchlist_id`
- SELECT 中增加聚合：`ARRAY_AGG(DISTINCT jsonb_build_object('id', w.id, 'name', w.name)) FILTER (WHERE w.id IS NOT NULL) AS tags`
- 若 `watchlistIds` 非空，加子查询过滤：`k.symbol IN (SELECT wi2.symbol FROM watchlist_items wi2 WHERE wi2.watchlist_id = ANY(:watchlistIds))`（用子查询避免 JOIN 导致分页计数膨胀）
- GROUP BY 需包含所有非聚合列

#### 3. 响应类型

每个 item 增加 `tags: { id: string; name: string }[]`，空时为 `[]`。

### 前端改动

#### 1. 类型定义

`SymbolRow` 增加 `tags?: { id: string; name: string }[]`。

#### 2. tags 列

在 `cryptoColumns.ts` 和 A 股对应列定义中新增列：

- 渲染为多个 `<n-tag size="small">` 水平排列
- 空 tags 显示 `—`

#### 3. 标签筛选器

在筛选栏中增加 `n-select`：

- `multiple` + `filterable`
- 选项来源：watchlist store 中当前用户的所有自选组（已有数据，无需新请求）
- 选中值通过 `watchlistIds` 传给后端
- 和现有筛选条件（q、conditions）并列，互不影响

#### 4. 共享逻辑

CryptoSymbolsPanel 和 ASharesPanel 共享标签筛选逻辑，提取 composable `useWatchlistTagFilter`。

### 不变部分

- watchlist 实体/表结构不变
- 自选组管理流程不变
- 现有筛选（q、NumericConditionFilter）逻辑不变
