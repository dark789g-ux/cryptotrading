# A 股数据 TAB 新增「A 股指数」二级 TAB

- 创建日期：2026-06-22
- 状态：设计已确认，待实现

## 背景

`SymbolsView` 的「A 股数据」TAB 目前只有股票面板（`ASharesPanel.vue`），没有指数。用户希望在该 TAB 下加二级 TAB：首页股票、第二页「A 股相关指数」（大盘 + 行业 + 概念），用行情表 + K 线 Modal 展示。

后端两类 A 股指数数据就绪程度不同（两次 Explore 摸底 + Tushare 文档查证）：

| 指数类型 | 现状 |
|---|---|
| 同花顺行业/概念指数（`*.TI`，type I/N） | ✅ `ths_index_daily_quotes` + `ths_index_daily_indicators` + `ths_index_catalog` 已就绪；`GET /api/ths-index-daily?ts_code=...` 已被 money-flow 的 K 线 Modal 在用 |
| 大盘指数（`000001.SH` 上证 / `399001.SZ` 深证成指 / …） | ❌ 未落库到指数日线表；仅在 `market-data/daily-review/snapshot/snapshot-builder.service.ts:149-167` 实时拉 Tushare `index_daily`（注：0AMV 930903.CSI 已落 `oamv_daily`，但那是单指数 AMV 表，非通用大盘行情） |

用户选定**方案 C：新建统一指数日线表**，把行业/概念数据迁移进去 + 大盘指数也进同一张表，长期最干净（代价：要迁移现有 ths 数据 + 改造同步，回归风险最高）。

## 目标

1. 「A 股数据」TAB 下新增二级 TAB（股票 / A 股指数），照抄美股 `UsStocksTabsContainer` 模式。
2. 新建统一指数日线表（`index_daily_quotes` + `index_daily_indicators`），用 `category` 字段区分 `market`/`industry`/`concept`，迁移现有 ths 数据 + 新增大盘指数落库。
3. 「A 股指数」内容区：指数行情表（远程分页/排序/筛选 + 列偏好）+ 点击行弹 K 线 Modal。
4. 列偏好系统加 `aSharesIndex` scope。

## 非目标

- 不动美股指数（`raw.us_index_daily`）、不动申万行业分类（`raw.index_classify`/`index_member`，是另一套 `.SI` 体系）。
- 不给大盘指数加市值（Tushare `index_daily` 不返回 `total_mv/float_mv`，指数本无市值概念）。
- 不引入 0AMV 副图（`oamv_daily` 单指数 930903.CSI，价值有限，留后续）。
- 不改 KlineChart 组件本身。

## 设计决策

| # | 决策 | 选定 | 理由 |
|---|---|---|---|
| 1 | 指数范畴 | 大盘 + 行业 + 概念全都要 | 完整指数工作台 |
| 2 | 内容形态 | 行情表 + K 线 Modal | 400+ 指数需排序浏览；点行看 K 线 |
| 3 | 数据模型 | 方案 C：统一表 + 迁移 | 长期最干净；语义统一；代价是迁移成本 |
| 4 | 大盘清单 | 8 个（核心 4 + 宽基 4） | 上证/深证成指/创业板指/科创50 + 沪深300/上证50/中证500/中证1000 |

## Tushare index_daily 事实（已查官方文档，非记忆）

- 接口名 `index_daily`，**2000 积分**可调取（当前 7000 满足），单次最多 **8000 行**，按 `start_date/end_date` 补全。
- 入参：`ts_code`（必选）+ `trade_date/start_date/end_date`（`YYYYMMDD`）。
- 出参：`ts_code, trade_date, close, open, high, low, pre_close, change, pct_chg, vol(手), amount(千元)`。
- **不含** `total_mv/float_mv/turnover_rate`（大盘指数无市值）。
- **不含申万行业指数行情**（那些走 `ths_daily`，已在用）。
- ⚠️ 文档警告：`399001.SZ` 深证成指成交量/成交额只含 500 成分股，要全深市成交用 `399107.SZ` 深证A指。

### 字段映射（行业/概念 vs 大盘）

| 统一表列 | 来源（industry/concept，`ths_daily`） | 来源（market，`index_daily`） |
|---|---|---|
| `pct_change` | `pct_change` | `pct_chg`（**字段名不同，同步时映射**） |
| `vol_hand`（手） | ths_daily `vol` | index_daily `vol` |
| `amount`（千元） | — （ths_daily 无，NULL） | `amount`（**新增列**） |
| `total_mv_wan`/`float_mv_wan`（万元） | `total_mv/float_mv` ÷10000 | — （无，NULL） |
| `turnover_rate` | `turnover_rate` | — （无，NULL） |

## 数据模型

### 统一表 schema

`index_daily_quotes`（public schema，去 `ths_` 前缀，在现有 `ths_index_daily_quotes` 字段上增量）：

```text
index_daily_quotes
├─ id              bigint PK auto
├─ ts_code         varchar(20)  NOT NULL
├─ trade_date      varchar(8)   NOT NULL          -- YYYYMMDD（禁 new Date，见 datetime.md）
├─ open/high/low/close/pre_close/change/pct_change  double precision  nullable
├─ vol_hand        double precision  nullable     -- 成交量(手)（沿用现有列名，避免重命名连锁）
├─ amount          double precision  nullable     -- ★新增 成交额(千元) 仅大盘有
├─ total_mv_wan    numeric(20,4)     nullable     -- 万元 仅行业/概念有
├─ float_mv_wan    numeric(20,4)     nullable     -- 万元 仅行业/概念有
├─ turnover_rate   double precision  nullable     -- 仅行业/概念有
├─ category        varchar(8)   NOT NULL          -- ★ 'market'|'industry'|'concept'
└─ updated_at      timestamptz NOT NULL
   UNIQUE(ts_code, trade_date)
   INDEX(category, trade_date DESC)
   INDEX(ts_code, trade_date DESC)
```

`index_daily_indicators`：照搬现有（`ma5/ma30/ma60/ma120/ma240, dif/dea/macd, kdj_k/kdj_d/kdj_j, bbi, brick/brick_delta/brick_xg`）+ `category` + `UNIQUE(ts_code, trade_date)`。

> 字段类型/nullable 以现有实体为准，实现前 grep `apps/server/src/entities/ths-index-daily/*.entity.ts` 逐字段核对（agent 报告为二手信息，进 migration 前亲查）。

### category 与现有 ths type 的映射

```text
ths_index_catalog.type  →  index_daily_quotes.category
        'I' (industry)   →      'industry'
        'N' (concept)    →      'concept'
        ★ 'M' (新增)     →      'market'   大盘指数(000001.SH 等，代码 .SH/.SZ)
```

## 迁移策略（零回归核心）

```text
1. 迁移前先给 ths_index_catalog 灌入大盘 8 个(type='M')（见下「catalog 扩展」）
2. CREATE index_daily_quotes + index_daily_indicators (含 category NOT NULL)
3. INSERT...SELECT 从 ths_index_daily_quotes 迁移，category 判据统一走 catalog.type（非大盘清单硬编码）:
        LEFT JOIN ths_index_catalog c USING(ts_code)
        category = CASE c.type WHEN 'I' THEN 'industry' WHEN 'N' THEN 'concept'
                               WHEN 'M' THEN 'market' ELSE RAISE('未知 type') END
   （判据统一走 catalog.type，避免大盘清单在 SQL 字面量与代码常量双写；catalog 已含 type='M' 大盘行）
4. 同步迁移 ths_index_daily_indicators → index_daily_indicators (category 同上)
5. RENAME 旧表 ths_index_daily_{quotes,indicators} → *_legacy 备份(不 DROP)
6. 保留旧 API /api/ths-index-daily 作薄封装，全部 3 子路由(GET /、GET /date-range、
   POST /recalc) 加 WHERE category IN ('industry','concept')，防大盘行情泄漏 money-flow
   → trendFetchers.ts / FlowTrendModal.vue(调 recalc) / useThsIndexDailySync 零改动
7. ★改 industry-amv.service.ts:296-340 assertSuffixes(LIMIT 5 抽样断 .TI):
   迁移后统一表混入 .SH/.SZ 大盘行，抽样会抓到非 .TI → AMV 同步 throw。
   改为 WHERE category IN ('industry','concept') 后再抽样;同步改 :78 注入新 entity
```

- migration 纯手写 SQL（项目 `synchronize:false`，无 Alembic 运行时），配 `.ps1` 包装。模板参考 `apps/server/src/migration/20260517120000-quant-raw-schema-migration.sql`（`ALTER ... SET SCHEMA` + `RENAME` + `.down.sql` 回滚）。
- 旧表 `_legacy` 备份保留，验证无误后再决定清理时机（不在本 spec 范围 DROP）。

## 后端

### 实体（新建/重命名）

- `IndexDailyQuoteEntity`（`@Entity('index_daily_quotes')`）— 字段同 ths + `amount` + `category`
- `IndexDailyIndicatorEntity`（`@Entity('index_daily_indicators')`）— 字段同 ths + `category`
- 改 `apps/server/src/app.module.ts:185-187` 的 entities 注册（替换 Ths 两个 entity 为新 entity；`ThsIndexCatalogEntity` 保留）
- **双注册坑**（见 memory `typeorm_entity_dual_registration`）：新 entity 须同时加 module forFeature + app.module 根 entities 数组
- **entity 注入消费方全量替换**（grep `@InjectRepository(ThsIndexDaily(Quote|Indicator)Entity)`）：
    - `ths-index-daily.service.ts`（K 线查询）
    - `ths-index-daily-sync.service.ts`（同步写入）
    - `ths-index-daily-indicator.service.ts`（指标计算）
    - ★`active-mv/industry-amv.service.ts:78`（**阻断**：见迁移策略第 7 步 assertSuffixes，漏改则 AMV 同步 throw）

### catalog 扩展（统一目录）

- `ThsIndexCatalogEntity.type` 扩枚举允许 `'M'`（当前只 `'I'/'N'`，varchar(4) 无 DB CHECK 约束则无需 migration；实现前 grep entity 确认有无 CHECK）
- 大盘指数清单**硬编码常量**（现有 `snapshot-builder.service.ts:9-14` `INDEX_LIST` 仅 **4 个**核心大盘，本 spec **新增 4 宽基** → 共 8），不在 `ths_index` 接口（Tushare `ths_index` 只给同花顺自家指数，取不到 000001.SH 等）：

```text
大盘清单 MARKET_INDEX_LIST (8)
  000001.SH 上证指数    399001.SZ 深证成指    399006.SZ 创业板指    000688.SH 科创50
  000300.SH 沪深300    000016.SH 上证50     000905.SH 中证500    000852.SH 中证1000
```

> 实现前 grep `snapshot-builder.service.ts:9-14` 核对实际 `INDEX_LIST`，据实增删（二手转述）。

### 同步改造

- **行业/概念**：沿用 `ThsIndexDailySyncService` 调 `ths_daily` + catalog 过滤，但写入**新表**并打 `category`（I→industry / N→concept）。
- **大盘（新增）**：在 NestJS 加 `index_daily` 调用（照 `oamv.service.ts:164-168` 的 Tushare 调用风格，不走 Python），遍历 `MARKET_INDEX_LIST`，写新表 `category='market'`。**历史较长（上证 1990 起），单次 8000 行限制按 ~5 年一段分段拉取**。`index_daily.vol` 单位「手」，与 `ths_daily.vol` 同源，复用现有 `volHand*100` 转「股」输出（K 线 volume 副图数量级一致，勿漏单位换算）。
- SSE 进度：可扩展现有 `ths-index-daily/sync` 或新建 `/api/index-daily/sync`，建议合并为一个「指数日线同步」SSE，分阶段推 progress（行业 → 概念 → 大盘）。

### 接口清单（新建 + 兼容）

| 接口 | 用途 | 入参 | 出参 |
|---|---|---|---|
| `GET /api/index-catalog?category=market\|industry\|concept&q=` | 统一目录（行情表左侧/筛选） | category、模糊搜索 | `IndexCatalogRow[]`（ts_code, name, category, count?） |
| `GET /api/indices/latest?type=&q=&sort=&order=&page=&pageSize=` | 行情表最新行情 | 类型/搜索/排序/分页 | `{ rows: IndexLatestRow[], total }`，每行最新一日 OHLC/pct_change/vol/amount/total_mv_wan |
| `GET /api/index-daily?ts_code=&start_date=&end_date=` | K 线（查统一表） | ts_code、日期 | `KlineChartBar[]`（`open_time=YYYYMMDD` 契约不变） |
| `GET /api/ths-index-daily` 全部 3 子路由（薄封装，保留） | 旧路径兼容（money-flow） | `GET /`、`GET /date-range`、`POST /recalc` | 内部查 `index_daily_quotes`，**全部子路由加 `WHERE category IN ('industry','concept')`**（防大盘泄漏；`recalc` 被 `FlowTrendModal.vue:325` 用、`date-range` 被 `useThsIndexDailySync` 用） |

- `getDateRange`：现有 `ThsIndexDailyService.getDateRange()` 是全表 min/max 不分 ts_code；新 K 线接口需**按 ts_code** 返回该指数的 min/max（实现时确认）。
- 大盘指数 K 线无 AMV/资金流副图数据，`mergeKlineWithMoneyFlow(kline, [])` 返回 `moneyFlow:undefined`，前端 KlineChart 容忍。

## 前端

### 结构

```text
SymbolsView.vue:54   <a-shares-panel> → <a-shares-tabs-container>
│
└─ ASharesTabsContainer.vue (新, 仿 UsStocksTabsContainer.vue)
   ├─ n-tabs type=line animated display-directive="show:lazy"
   ├─ n-tab-pane "股票"     → ASharesPanel.vue (零改动)
   └─ n-tab-pane "A 股指数" → ASharesIndexPanel.vue
       ├─ 行情表 [搜索][类型▾ market/all][排序▾][列设置(scope=aSharesIndex)]
       │   (列: 代码/名称/收盘/涨跌%/成交量/[成交额]/[市值], 400+行远程分页)
       └─ 点行 → ASharesIndexKlineModal.vue (KlineChart + MA/MACD/KDJ/成交量副图)
```

### 新建文件

```text
apps/web/src/components/symbols/
├─ ASharesTabsContainer.vue                 (新, ~40 行, 仿 UsStocksTabsContainer)
└─ a-shares-index/                          (新子目录)
   ├─ ASharesIndexPanel.vue                 (行情表 + 列设置 + 分页)
   ├─ ASharesIndexKlineModal.vue            (K 线 Modal, 复用 AppModal + KlineChart)
   ├─ aSharesIndexColumns.ts                (列定义)
   ├─ useASharesIndexQuery.ts               (列表查询 composable)
   └─ types.ts                              (IndexLatestRow/IndexCatalogRow)
```

### 列偏好加 aSharesIndex scope（7 处改动，无 migration）

落 DB（`user_preferences.value` jsonb），加 key **不需 migration**，但前后端必须同步（后端 `sanitizeSymbolsView` 会丢弃未声明 key）：

| # | 文件 | 改动 |
|---|---|---|
| 1 | `apps/server/src/preferences/preferences.service.ts:18-22` | `SymbolsViewColumnPreferences` 加 `aSharesIndex` |
| 2 | 同上 `:57-65` | `sanitizeSymbolsView` 加 `aSharesIndex: sanitizeScopeView(...)` |
| 3 | 同上 `:67-71` | `EMPTY_SYMBOLS_VIEW_PREFERENCES` 加 `aSharesIndex` |
| 4 | `apps/server/src/preferences/preferences.controller.ts:19` | body 类型加 `aSharesIndex?: unknown` |
| 5 | `apps/web/src/api/modules/user-config/preferences.ts:14-18` | 类型加 `aSharesIndex` |
| 6 | `apps/web/src/composables/symbols/useSymbolColumnPreferences.ts`（clone/初始/load 三处） | 各加一行 `aSharesIndex` |
| 7 | 新建 `ASharesIndexPanel.vue` | `useSymbolColumnPreferences('aSharesIndex', defs, viewMode)` |

> 行号以摸底为准，实现前亲查确认（agent 报告为二手信息）。

### 接入

- `apps/web/src/views/market/SymbolsView.vue:54`：`<a-shares-panel>` 改 `<a-shares-tabs-container>`，import 替换。
- keep-alive：`ASharesTabsContainer` 在顶层 `<keep-alive>` 内，指数 pane 内组件数据加载放 `onActivated` + `onMounted`（参考 `UsIndexPanel.vue:142-150`，见 vue3-frontend.md）。
- ECharts resize：照 `UsStocksTabsContainer.vue` 的 `watch(subTab)` + `onActivated` 双触发，子组件 `defineExpose({ resize })`。

### API 模块

- `apps/web/src/api/modules/market/indexDaily.ts`（新）：`queryKline` / `getLatestList` / `getCatalog`
- `apps/web/src/api/modules/market/thsIndexDaily.ts` 保留（旧路径，内部可改指向新接口或不动）

## 关键约束 / 风险

- **datetime.md**：`trade_date` 存 `YYYYMMDD varchar`，禁 `new Date('YYYYMMDD')`；K 线 `open_time` 保持 `YYYYMMDD` 字面串契约（否则 money-flow/AMV 副图合并断）。`index_daily` 的 `trade_date` 同为 `YYYYMMDD`，对齐无风险。
- **database-sql.md**：`synchronize:false`，schema 走 migration SQL；TypeORM QueryBuilder `.select()` 用实体属性名不是列名。
- **vue3-frontend.md**：keep-alive + 懒加载路由，合并前必跑 `vite build`（不只 type-check）；`display-directive="show:lazy"` 不改 `show`。
- **data-integrity.md**：`total_mv_wan/float_mv_wan/turnover_rate/amount` 对 `category='market'` 行为合法 NULL（不进硬约束）；对 `category IN ('industry','concept')` 行，`total_mv_wan/float_mv_wan/turnover_rate` 为**硬约束非空**（行业/概念同步空值会伪装成功）。同步 fetcher 返回空须 `failedItems` 透出，不静默成功。
- **TypeORM 双注册**：新 entity 须同时加 module forFeature + app.module 根 entities 数组。

## 实现任务拆分（按独立文件域，便于并行）

```text
T1 数据模型+migration   [entities/index-daily/*, migration/*.sql, app.module.ts]
    │ (entity 就绪后解锁 T3/T4)
    ▼
T3 同步改造(行业/概念+大盘) [ths-index-daily-sync.service.ts, 新增大盘同步]
T4 查询接口(latest/catalog/kline+薄封装) [index-daily.service/controller, index-catalog 查询]
    │
T2 catalog 扩展(type='M'+清单常量) ── 独立(可并行 T1)

T5 列偏好 scope aSharesIndex(7处) ── 独立文件域(可并行)
T6 ASharesTabsContainer + SymbolsView 接入 ── 独立(可并行；index pane 先 stub 空 Panel 或注释 import，T7 再补真实 ASharesIndexPanel)

T7 ASharesIndexPanel 行情表+useASharesIndexQuery ── 依赖 T4(接口)+T5(scope)
T8 ASharesIndexKlineModal ── 依赖 T4(K线接口)

T9 migration 执行+数据迁移+真机 e2e ── 依赖 T1~T8 全完成
```

并行批次建议：**批次 1** = {T1, T2, T5, T6}（互不相交文件域）；**批次 2** = {T3, T4, T7, T8}（批次 1 完成后）；**批次 3** = {T9}。

## 验证标准

1. 迁移前先 `SELECT type, COUNT(*) FROM ths_index_catalog GROUP BY type` 落源记数；migration 跑通后 `index_daily_quotes` 行数 ≥ 旧 `ths_index_daily_quotes`；`category` 分布（market=8 含新增 4 宽基、industry/concept 与落源数一致）。
2. 旧路径回归：`/api/ths-index-daily?ts_code=881101.TI` 仍返回正确 K 线（且不含大盘行情）；money-flow 行业/概念趋势 Modal + KDJ recalc 正常；★industry-amv 同步不因 `assertSuffixes` throw（迁移第 7 步验证，阻断项）。
3. 新接口：`/api/indices/latest?type=market` 返回 8 行大盘；`/api/index-daily?ts_code=000001.SH` 返回上证 K 线。
4. 前端：A 股数据 TAB 下出现「股票/A 股指数」二级 TAB；行情表 400+ 行可分页/排序/搜索/类型筛选；点行弹 K 线 Modal（MA/MACD/KDJ 副图正常）。
5. 列偏好：勾选 aSharesIndex 列 → 刷新后持久化（save→load 不丢，证明前后端 scope 同步）。
6. 门禁：`pnpm --filter @cryptotrading/web type-check` + `vite build` + `pnpm --filter @cryptotrading/server exec jest` 全绿；`lint:quant-lines`（新 Vue 文件 ≤500 行）。
