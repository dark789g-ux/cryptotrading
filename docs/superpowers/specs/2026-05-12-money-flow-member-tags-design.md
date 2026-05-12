# Money Flow 行业/板块成分股 — 涨幅/净流入列与"添加标签"

日期: 2026-05-12

## 背景

Money Flow 行业/板块面板的"详情" Modal 中已有「成分股」Tab，目前仅展示 #/代码/名称 三列，无任何业务字段、无排序、无操作入口。

本次在该表格上叠加两个能力：

1. 新增两列「涨跌幅%」「净流入(亿)」，可表头排序。
2. 表格上方新增「添加标签」按钮，把当前成分股一键加入以"行业/板块名"为名的自选股列表（项目内的"标签"机制即 `watchlists`，没有独立 tag 表）。同名列表已存在则复用，已在列表内的股票不重复加入。

## 数据现状

- `ths_member_stocks(ts_code, con_code, con_name, is_new)` — 不含涨跌幅/资金流。
- `money_flow_stocks(ts_code, trade_date, pct_change, net_amount, …)` — 自带 `pct_change` 与 `net_amount`（万元，service 在返回前 ÷10000 转亿）。
- `watchlists(id, name, user_id, …)` / `watchlist_items(id, watchlist_id, symbol)` — 当前 **没有** `(watchlist_id, symbol)` 唯一约束。

## 设计

### 1. 后端

#### 1.1 `GET /money-flow/members` 扩展

- DTO：`QueryMemberDto { ts_code: string; trade_date?: string }`；`trade_date` 校验为 8 位 `YYYYMMDD`。
- service `queryMembers(tsCode, tradeDate?)`：
  - 基础 from `ths_member_stocks m`。
  - 当 `tradeDate` 传入：`LEFT JOIN money_flow_stocks mfs ON mfs.ts_code = m.con_code AND mfs.trade_date = :tradeDate`，select 出 `mfs.pct_change`、`mfs.net_amount`。
  - 不传 `tradeDate`：保留现有行为，`pctChange/netAmount` 为 `null`。
  - 排序仍 `m.con_code ASC`。
  - 行映射：`netAmount` 在返回前 ÷10000（亿元口径），`pctChange` 原值（百分比）。停牌等无 `mfs` 行时两列均 `null`。

#### 1.2 共享类型扩展

`packages/shared-types/src/money-flow.ts` 的 `MoneyFlowMemberRow` 新增：

```ts
pctChange: number | null   // 百分比，原值
netAmount: number | null   // 亿元
```

#### 1.3 新增 `POST /watchlists/upsert-by-name`

- Controller：`WatchlistsController.upsertByName(@CurrentUser, @Body dto)`。
- DTO：`UpsertByNameDto { name: string; symbols: string[] }`；`name` 非空，`symbols` 非空数组。
- Service `upsertByName(userId, dto)`：单事务内
  1. 入参 `symbols` 按原序去重（保留首次出现）。
  2. `findOne({ userId, name })`；不存在则 create，记 `created=true`。
  3. 取该 `watchlist` 现有 `items.symbol` Set，与去重后的入参对比，得 `toInsert`。
  4. `INSERT INTO watchlist_items (watchlist_id, symbol) SELECT $1, unnest($2::text[]) ON CONFLICT (watchlist_id, symbol) DO NOTHING`。
  5. 返回 `{ watchlistId, name, created, added, skipped }`，其中：
     - `added = toInsert.length`（实际新增到 watchlist_items 的条数）
     - `skipped = dedupedSymbols.length - toInsert.length`（去重后传入但已在列表里的）
     - 入参重复"压缩"（原始 N → 去重 K，K<N）不计入 skipped，仅 `logger.warn` 一行 `[upsertByName] symbols 含重复：original=N deduped=K`（CLAUDE.md upsert 去重规范）。

#### 1.4 数据库迁移

新增 TypeORM migration `AddWatchlistItemsUniqueIndex`：

1. 去重存量数据：
   ```sql
   DELETE FROM watchlist_items a USING watchlist_items b
   WHERE a.watchlist_id = b.watchlist_id
     AND a.symbol = b.symbol
     AND a.id > b.id;
   ```
2. 建唯一索引：
   ```sql
   CREATE UNIQUE INDEX uq_watchlist_items_watchlist_symbol
     ON watchlist_items (watchlist_id, symbol);
   ```
3. `WatchlistItemEntity` 加 `@Unique(['watchlistId', 'symbol'])`，与索引对齐。

人工核对脚本：
```bash
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "
  SELECT watchlist_id, symbol, COUNT(*) FROM watchlist_items
  GROUP BY 1,2 HAVING COUNT(*) > 1;"
```

### 2. 前端

#### 2.1 父组件透传 `trade_date`

`IndustryFlowPanel` / `SectorFlowPanel`：

- 在 `openDetail(row)` 时，新增传递 `currentParams.value.trade_date ?? latestDate.value` 给 `FlowTrendModal`。
- 模板新增 prop：`:members-trade-date="trendMembersTradeDate"`。

`FlowTrendModal`：

- 新增可选 prop `membersTradeDate: string | null`。
- 现有 `loadMembers` 调用改为 `moneyFlowApi.getMembers(props.tsCode, props.membersTradeDate)`。
- Modal 内 `FlowDateControl` 切换日期只影响「趋势」Tab，**不**重新拉成分股；外层面板的 trade_date 变化导致 Modal 重新打开时按现有 `membersLoaded` 重置即可。

#### 2.2 成分股表格列增量

`memberColumns` 在「名称」之后插入两列：

- 「涨跌幅%」`width: 90`：`sortOrder` 双向绑定 + `sorter: true`；render 时 `pctChange == null ? '—' : '${v>=0?"+":""}${v.toFixed(2)}%'`，红涨绿跌 class。
- 「净流入(亿)」`width: 110`，初始 `sortOrder: 'descend'`：同样配置；render `null → '—'`，否则 `v.toFixed(2)` + 红绿。

**NULL 末位** —— naive-ui 的列内 `sorter: (a,b)=>...` 拿不到当前方向，descend 会翻转结果导致 NULL 跑到顶部。采用**受控排序**：

1. 列定义里 `sorter: true`、`sortOrder: sortState.value.field === key ? sortState.value.order : false`。
2. 表格 `@update:sorter` 接收 `{ columnKey, order } | null`，写入本地 `sortState` ref（`{ field: string; order: 'ascend' | 'descend' } | null`）。
3. 通过 `computed sortedRows` 在客户端按 `sortState` 排序：

```ts
function compareWithNullsLast(a: number | null, b: number | null, order: 'ascend' | 'descend') {
  const aNull = a == null || !Number.isFinite(a)
  const bNull = b == null || !Number.isFinite(b)
  if (aNull && bNull) return 0
  if (aNull) return 1
  if (bNull) return -1
  return order === 'descend' ? b - a : a - b
}
```

`n-data-table :data="sortedRows"`。这样 NULL 在 ascend / descend 下都恒在末位。

#### 2.3 "添加标签"按钮

在「成分股」Tab 的 `n-spin` 之上、`n-data-table` 之上加一个工具栏 div：

```vue
<div class="members-toolbar">
  <n-button type="primary" :disabled="!canAddTag" :loading="addTagLoading" @click="onAddTag">
    + 添加标签
  </n-button>
  <span class="hint">共 {{ memberRows.length }} 只</span>
</div>
```

`canAddTag = computed(() => memberRows.value.length > 0 && !!props.entityName?.trim())`。

`onAddTag` 行为：

1. `addTagLoading = true`
2. 调 `watchlistApi.upsertByName({ name: props.entityName, symbols: memberRows.value.map(r => r.conCode) })`
3. 成功：`useMessage().success(...)`，文案：
   - `created` true：`已新建标签「${name}」，加入 ${added} 只`
   - `created` false：`已加入「${name}」：新增 ${added} 只，跳过已存在 ${skipped} 只`
4. 失败：`useMessage().error(err.message || '添加标签失败')`
5. `finally { addTagLoading = false }`
6. 成功后调 `useWatchlistStore().ensureWatchlistsLoaded(true)`（force 刷新），保持自选股 store 与服务端一致。

#### 2.4 前端 API

`moneyFlowApi.getMembers(tsCode, tradeDate?)`：拼 `&trade_date=...`。

`watchlistApi.upsertByName({ name, symbols })`：`POST ${API_BASE}/watchlists/upsert-by-name`。响应类型新增：

```ts
interface UpsertByNameResult { watchlistId: string; name: string; created: boolean; added: number; skipped: number }
```

### 3. 错误/边界

- 父面板 `trade_date` 为 `null` 且 `latestDate` 也为 `null` → 不传 `trade_date`，两列全 `—`。
- Modal 内日期选择不影响成分股 Tab，避免"用户改了趋势日期但成分股没刷新"造成误导。
- `upsert-by-name`：`name` 为空 → 409；`symbols` 为空 → 400（前端按钮 disabled 已拦截）。
- service 不使用 `.catch(()=>[])` 静默吞错；事务内任一步抛错回滚，控制器透出原始状态码。
- `LEFT JOIN money_flow_stocks` 自然产生 NULL，不算错误；不打 warn。
- `upsertByName` 当入参 `symbols` 含重复时记 `logger.warn` 原始/去重后条数（CLAUDE.md upsert 规范）。

### 4. 测试

后端：

- `money-flow.service.spec.ts` 扩展：
  - `queryMembers(ts, '20260512')` 返回 `pctChange/netAmount` 含值，且 `netAmount` 已 ÷10000。
  - `queryMembers(ts, '20260512')` 中某 con_code 在 `money_flow_stocks` 无当日记录 → 该行两字段 null。
  - `queryMembers(ts)` 不传日期 → 两字段均 null。
- 新建 `watchlists-upsert.service.spec.ts`：
  - name 不存在 → create+全量 added，`created=true`。
  - name 已存在、symbols 与现有部分重叠 → `added/skipped` 计数正确，`created=false`。
  - symbols 含重复 → 内部去重后 add，warn 一行。

前端：

- 类型检查 + 构建。
- 浏览器手测（含 keep-alive 切换）：
  - 行业面板 → 详情 → 成分股 Tab 表格两列正常显示；含 `—` 行；表头排序正常，NULL 末位。
  - 「添加标签」首次点击新建 watchlist + toast；二次点击全部 skipped + toast。
  - 自选股页面看到该 watchlist 出现并含正确成分。

### 5. 涉及文件

| 文件 | 变更 |
|------|------|
| `apps/server/src/market-data/money-flow/dto/query-member.dto.ts` | 增 `trade_date?` |
| `apps/server/src/market-data/money-flow/money-flow.service.ts` | `queryMembers` 加 LEFT JOIN + 字段映射 |
| `apps/server/src/market-data/money-flow/money-flow.controller.ts` | 透传 `trade_date` |
| `apps/server/src/market-data/money-flow/money-flow.service.spec.ts` | 扩展测试 |
| `packages/shared-types/src/money-flow.ts` | `MoneyFlowMemberRow` 增字段 |
| `apps/server/src/entities/watchlist/watchlist-item.entity.ts` | `@Unique(['watchlistId','symbol'])` |
| `apps/server/src/database/migrations/<ts>-AddWatchlistItemsUniqueIndex.ts` | 新建 migration |
| `apps/server/src/catalog/watchlists/dto/upsert-by-name.dto.ts` | 新建 |
| `apps/server/src/catalog/watchlists/watchlists.service.ts` | 新增 `upsertByName` |
| `apps/server/src/catalog/watchlists/watchlists.controller.ts` | 新增端点 |
| `apps/server/src/catalog/watchlists/watchlists-upsert.service.spec.ts` | 新建测试 |
| `apps/web/src/api/modules/moneyFlow.ts` | `getMembers` 增参 |
| `apps/web/src/api/modules/watchlists.ts` | 新增 `upsertByName` |
| `apps/web/src/components/money-flow/IndustryFlowPanel.vue` | `openDetail` 传 trade_date |
| `apps/web/src/components/money-flow/SectorFlowPanel.vue` | 同上 |
| `apps/web/src/components/money-flow/FlowTrendModal.vue` | 新 prop、表格两列、工具栏、添加标签逻辑 |
