# 02 · 后端同步

## 2.1 新目录与文件

```text
apps/server/src/market-data/sw-index-daily/
├── sw-index-daily.module.ts
├── sw-index-daily-sync.service.ts        ← 镜像 ths-index-daily-sync.service.ts
├── sw-index-daily-sync.controller.ts
└── dto/
    └── sw-index-daily-sync.dto.ts
```

实体 `SwIndexCatalog` 在 `apps/server/src/entities/sw-index/`（见 [01-data-model.md §1.4](./01-data-model.md)）。

## 2.2 SwIndexDailySyncService（双入口，镜像 ths）

**镜像** `ThsIndexDailySyncService`（`apps/server/src/market-data/ths-index-daily/ths-index-daily-sync.service.ts`），建**双入口**与 ths 完全对齐（消除 sync/startSync 歧义，[03 §3.3](./03-one-click-sync.md) step 用 startSync）：

- `sync(dto): Promise<SwIndexSyncResult>` — 普通 await，**controller 全量回填用**（对应 ths `:53-261`）
- `startSync(dto): Subject<SyncEvent>` — SSE 进度推送，**one-click step 用**（对应 ths `:266`），拿 progress/done/error 事件

`dto = { start_date, end_date, syncMode: 'incremental' | 'overwrite' }`。两入口共享核心逻辑（resolveOpenTradeDates → 过滤 → 横拉 → 换算 → upsert → recalculate），区别仅在返回形式（result vs Subject）。

流程：
1. `resolveOpenTradeDates`（trade_cal 取交易日，复用 ths 同款 helper）
2. 增量过滤 `filterExistingDates`（syncMode='incremental' 时跳过已存在 trade_date；`'overwrite'` 全量）
3. **目录灌入**：`tushareClient.query('index_classify', { market: 'SW' }, INDEX_CLASSIFY_FIELDS)` → `batchUpsert(swCatalogRepo, rows, ['tsCode'])` 灌 `sw_index_catalog`（31/134/346 三级）
4. **行情横拉**：for 循环每个 trade_date，`params = { trade_date }`，`runWithRetry(() => tushareClient.query('sw_daily', params, SW_DAILY_FIELDS))`（当日全 < 4000 行）
5. **单位换算 + 字段映射**（map 内，落库前，见 §2.3）
6. upsert 前 `deduplicateBy`（按 tsCode+tradeDate 去重）
7. `batchUpsert` 写 `index_daily_quotes` `category='sw'`
8. 收尾对 affected tsCodes 调 `indicatorService.recalculateForSymbols(tsCodes)`

## 2.3 单位换算（硬规矩，落库前在 fetcher map 内做）

| 字段 | sw_daily 单位 | 现库列 | 换算 |
|------|--------------|--------|------|
| vol | 万股 | `vol_hand`（手） | **×100**（1 手=100 股） |
| amount | 万元 | `amount`（千元） | **×10** |
| total_mv | 万元 | `total_mv_wan`（万元） | 一致，不换算 |
| float_mv | 万元 | `float_mv_wan`（万元） | 一致，不换算 |
| pe | — | `pe`（新列） | 直填 |
| pb | — | `pb`（新列） | 直填 |
| close/open/high/low/pre_close/pct_chg | — | 同名 | 直填（注意 `pct_chg`→`pctChange`） |

> 不换算会差 10/100 倍且混在同列查不出——最大的坑。复用 `asNullableFloat` / `asNullableNumeric` helper（与 ths 同源 `:173-190`）。

## 2.4 data-integrity（强制）

镜像 ths 的空数据处理（`ths-index-daily-sync.service.ts:158-159`）：

```ts
// 双路径 warn（缺一不可）
if (payload?.data == null) logger.warn({ apiName: 'sw_daily', params }, 'sw_daily returned null');
if (rows.length === 0) {
  logger.warn({ apiName: 'sw_daily', params }, 'sw_daily returned 0 rows');
  errors.push({ apiName: 'sw_daily_empty', params });  // 0 行显式 failedItems
}
```

- **禁 `.catch(() => [])`** 吞错：错误 try/catch + push `errors` + continue
- `runWithRetry` 包裹 fetcher（与 ths 同款重试）

## 2.5 复用

- `recalculateForSymbols`（`apps/server/src/market-data/ths-index-daily/ths-index-daily-indicator.service.ts:32-47`）：读全 category、不分类，申万 K 线零改动自动有 MA/MACD/KDJ/BBI/BRICK
- `_shared/sync-helpers`（`batchUpsert` / `deduplicateBy`）：与 ths 同源零漂移
- `runWithRetry` / `resolveOpenTradeDates` / `filterExistingDates`：复用 ths 同款

## 2.6 Controller — 首次全量入口

**文件**：`sw-index-daily-sync.controller.ts`

```ts
@Controller('sw-index-daily')
export class SwIndexDailySyncController {
  @Get('sync')
  @AdminOnly()
  sync(@Query() dto: SwIndexDailySyncDto) {
    return this.service.sync(dto);  // 全量回填：?start_date=20210101&end_date=<today>&syncMode=overwrite
  }
}
```

- 路由 `GET /api/sw-index-daily/sync`（全局 `/api` 前缀）
- 首次回填近 5 年：`syncMode=overwrite`，`start_date=20210101`（sw 2021 版起点），`end_date=今天`
- 日常增量由 one-click-sync 的 sw-index-daily step 调（见 [03](./03-one-click-sync.md)），调 `syncMode='incremental'`

## 2.7 字段清单（SW_DAILY_FIELDS / INDEX_CLASSIFY_FIELDS）

⚠️ **实施前必须用 `tushare-sync-dev` skill 查文档确认**（交接文档转述的 `index_classify`/`sw_daily` 字段名/单位是二手信息，进 fetcher 硬映射前自己核）。查证后把字段清单冻结写进本节。

参考（交接文档，待核）：`sw_daily` 含 `ts_code/trade_date/close/open/high/low/pre_close/pct_chg/vol/amount/pe/pb/total_mv/float_mv`；`index_classify` 含 `l1_code/l1_name/l2_code/l2_name/l3_code/l3_name`。

## 2.8 查询层改动（getLatest 支持 sw，含 name + pe/pb 投影）

`getLatest`（`apps/server/src/market-data/index-daily/index-daily.service.ts`）现 `LEFT JOIN ths_index_catalog c ON c.ts_code = q.ts_code`（`:116`）取 name，**申万 tsCode 不在该表，name 会恒 null** → 前端 fallback 显示代码（`:127` `r.name ?? r.tsCode`）。须改：

1. **name 来源**：sw 分支额外 `LEFT JOIN sw_index_catalog s ON s.ts_code = q.ts_code`，`name` 取 `COALESCE(c.name, s.name)`（同花顺走 c、申万走 s）
2. **pe/pb 投影**：现 SELECT（`:108-123`）无 pe/pb，加 `q.pe`/`q.pb` 到 SELECT 与 `IndexLatestRow` 映射
3. **pe/pb 排序**：现 `SORT_COL_MAP`（`:15-21`）无 pe/pb，前端 pe/pb 列若 `sorter: true`，后端须加 `pe`/`pb` 到 SORT_COL_MAP，否则点排序 fallback 到 pct_change（静默错排）。见 [04 §4.3](./04-frontend.md) 联动

> 跨切面契约：后端 `IndexLatestRow`/`IndexLatestSortField` + 前端 `IndexLatestRow`（`types.ts:21-35`）+ 列定义（`aSharesIndexColumns.ts`）三处同步加 pe/pb。
