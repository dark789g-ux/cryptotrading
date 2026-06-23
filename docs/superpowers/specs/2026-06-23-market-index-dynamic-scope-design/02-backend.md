# 02 · 后端

## 2.1 MarketIndexScopeService（新建，放 index-catalog 域）

**文件**：`apps/server/src/market-data/index-catalog/market-index-scope.service.ts`（与 catalog 同域）

```ts
@Injectable()
export class MarketIndexScopeService {
  // 拉候选：index_basic(market=SSE/SZSE/CSI, category=规模/综合) + 即时算 noise_tag
  async discoverCandidates(): Promise<MarketIndexCandidate[]>

  // 当前范围：catalog WHERE type='M'
  async getScope(): Promise<MarketIndexScopeRow[]>

  // 加入范围：upsert catalog type='M'
  async addToScope(tsCode: string, name: string): Promise<void>

  // 移除：delete catalog type='M'
  async removeFromScope(tsCode: string): Promise<void>
}
```

### discoverCandidates 逻辑

1. `tushareClient.query('index_basic', { market } in [SSE/SZSE/CSI], ...)` —— 参考 `apps/server/src/catalog/watchlists/watchlists.service.ts:32-74` 现成调用（已覆盖 market='SW'，大盘用 SSE/SZSE/CSI）
2. 过滤基础宽基（6 位纯数字 ts_code + `category IN (规模指数,综合指数)`）
3. 即时算 `noise_tag`（见 [05 §噪声规则](./05-validation-and-tasks.md)）
4. 标注每个候选是否已在范围（`type='M'` 存在判定）
5. 返回候选清单（带标签）

> ⚠️ `index_basic` 的 `category` 参数名/可选值是进硬逻辑的事实，**实施前用 `tushare-sync-dev` skill 查文档确认**（交接文档"规模指数/综合指数"是二手转述）。`watchlists.service.ts:32-74` 当前只按 `market` 拉、取 `ts_code/name`，未用 category 过滤——本任务需要 category，必须查证。

### 复用

- `_shared/sync-helpers` 的 `batchUpsert`（与 catalog sync 同源）
- `ThsIndexCatalog` 实体（无需新实体）

## 2.2 MarketIndexSyncService 改造（读 catalog 替代 LIST）

**文件**：`apps/server/src/market-data/ths-index-daily/market-index-sync.service.ts:72-177`

改动点：遍历对象从 `MARKET_INDEX_LIST` 改为 catalog `type='M'`：

```ts
// 改前 (:87): for (const { tsCode } of MARKET_INDEX_LIST)
// 改后:
const scopeRows = await this.catalogRepo.find({ where: { type: 'M' } });
for (const { tsCode, name } of scopeRows) { ... }
```

**保留不变**：
- `computeSegments` 5 年分段（`:47-48, :180-195`）
- 0 行 failedItem（`:115-122`，双路径 warn + `index_daily_empty`）
- upsert 去重（`:143-153`）
- 收尾 `recalculateForSymbols`（`:164`）
- 空范围兜底：`scopeRows.length === 0` 时 warn + 返回空结果（不伪装成功）

## 2.3 废弃 MARKET_INDEX_LIST + 改造 IndexCatalogQueryService（关键）

`MARKET_INDEX_LIST` 有 **5 处消费方**（grep），最关键是 **`IndexCatalogQueryService`**——这是前端大盘 Tab n-select 选项的真源，**不改造则整个 spec 的「单一数据源、前端零改动」卖点不成立**：

- **`index-catalog/index-catalog-query.service.ts`**：`:5` import LIST、`:57-83` `queryMarket()` **直接读常量返回**（不查 DB）。`findAll('market')` → `queryMarket()` → 常量。
  - **必须改造**：`queryMarket()` 改为 `catalogRepo.find({ where: { type: 'M' }, order: { tsCode: 'ASC' } })`，否则①删 LIST 后编译失败②前端大盘 Tab 仍硬编码 8 个、管理页面增删不生效。
- **`index-catalog-query.service.spec.ts`**（`:6,:52,:55,:101,:102` 引用 LIST，断言「category=market 不查 DB」）→ **重写为 mock `catalogRepo`**（改造后 category=market 也查 DB）。
- 其余 3 处消费方（grep 确认）按需改造。

**删除 `market-index-list.ts`（:18-27）** 前，确认上述改造完成 + grep 无残留引用。

> migration 硬塞的 8 行 SQL（`20260622120000:9-23`）**保留**（DB 初始数据，作初始范围），代码常量 LIST 删除。

## 2.4 Controller

**文件**：`apps/server/src/market-data/index-catalog/market-index-scope.controller.ts`（新）

```ts
@Controller('market-index-scope')
export class MarketIndexScopeController {
  @Get('discover')  @AdminOnly()   discover()          // 发现候选
  @Get()                            list()              // 当前范围
  @Post('add')     @AdminOnly()     add(@Body() dto)    // { tsCode, name }
  @Post('remove')  @AdminOnly()     remove(@Body() dto) // { tsCode }
}
```

- 路由前缀 `market-index-scope`（全局 `/api`）
- 写操作（discover/add/remove）`@AdminOnly()`，读（list）可放宽
- 注册到 `IndexCatalogModule`（或新建 `MarketIndexScopeModule`）

## 2.5 data-integrity

- `discoverCandidates` 拉 `index_basic`：空数据双路径 warn（`data=null` 且 `items.length=0`）+ `index_basic_empty` failedItems
- `MarketIndexSyncService.sync`：范围内某 tsCode 拉 0 行 → 保留现有 `index_daily_empty` failedItem（`:115-122`）
- 禁 `.catch(()=>[])`
