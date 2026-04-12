# symbols/query 前后端 DTO 字段名不一致

## 背景
`POST /api/symbols/query` 前端发送的字段名与后端 `QuerySymbolsDto` 定义不匹配，导致 500 错误。

## 结论
前端 `buildQuery()` 必须严格按后端 `QuerySymbolsDto` 的字段名构造请求体，返回值用 `items` 不用 `data`。

## 详情

### 后端接口约定（`symbols.service.ts`）

```ts
interface QuerySymbolsDto {
  interval: string;
  page: number;
  page_size: number;                              // 非 pageSize
  sort: { field: string; asc: boolean };          // 非 sortKey + sortOrder
  q?: string;                                     // 非 search
  conditions?: { field: string; op: string; value: number }[];
  fields?: string[];
}
// 返回：{ items: any[]; total: number; page: number; page_size: number }
```

### 前端正确写法（`SymbolsView.vue`）

```ts
const buildQuery = () => ({
  interval: selectedInterval.value,
  q: searchQuery.value,                           // 不是 search
  conditions: conditions.value,
  sort: { field: sortKey.value ?? 'symbol', asc: sortOrder.value !== 'descend' },
  page: page.value,
  page_size: pageSize.value,                      // 不是 pageSize
})

// 响应取 items，不是 data
const res = await symbolApi.query(buildQuery())
symbols.value = res.items
```

### `useApi.ts` 返回类型

```ts
query: (body: object) => post<{ items: any[]; total: number }>(`${API_BASE}/symbols/query`, body),
```
