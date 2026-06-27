# A 股指数 K 线 Modal 添加 0AMV / 0AMV_MACD 副图（Design）

> 一句话目标：在 `a-shares-index-kline-modal` 中为申万 SW 与同花顺 industry/concept 指数接入活跃市值（AMV）数据，副图白名单增加 `0AMV` 与 `0AMV_MACD`，渲染行为与 A 股个股一致；大盘（`category=market`）保持现状。

## 1. 背景与问题

`ASharesIndexKlineModal` 当前仅支持 `VOL / KDJ / MACD` 副图，注释写明「指数无活跃市值」。用户从 **申万指数**（`ASharesIndexSwPanel`）或 **同花顺指数**（`ASharesIndexThsPanel`）点击行打开 Modal 时，无法查看与个股同款的 `0AMV` / `0AMV_MACD` 副图。

**现状差异：**

| 维度 | A 股个股 `AShareDetailPanel` | 指数 `ASharesIndexKlineModal` |
|------|------------------------------|-------------------------------|
| 数据 | K 线 + 资金流 + AMV 并行 | 仅 `indexDailyApi.queryKline` |
| 合并 | `mergeKlineWithAmv` | 无 |
| 副图 | 含 `0AMV` / `0AMV_MACD` | 不含 |
| AMV API | `/active-mv/stock/:tsCode` | 无 |

**数据可用性：**

| category | AMV 后端 |
|----------|----------|
| `industry` / `concept`（同花顺 `.TI`） | 已有 `industry_amv_daily` / `concept_amv_daily` |
| `sw`（申万 `.SI`） | **无**（2026-06-23 SW 集成 spec 标注「申万 AMV 本次不做」） |
| `market` | 无指数级 AMV（全市场 OAMV 为独立面板） |

图表渲染层（`klineChartOptions.ts`）已支持 `0AMV` / `0AMV_MACD`，**无需改 ECharts 配置**；缺口在数据管线与白名单。

## 2. 范围（已与用户确认）

| 维度 | 决定 |
|------|------|
| 指数范围 | 申万 SW + 同花顺 industry/concept |
| 副图 | `0AMV` + `0AMV_MACD`（与个股一致） |
| 日期对齐 | 扩展 AMV GET API 支持 `startDate/endDate`（与 Modal B 类区间选择器对齐） |
| 合规标注 | 暂不加 `amv-caption` |
| SW 数据入库 | 纳入一键同步，新增 `sw-amv` step |
| 大盘 `market` | 不请求 AMV，副图白名单不变 |

**不在范围：**

- 主图 BRICK、FLOW 副图
- `category=market` 的 AMV
- 修改 `KlineChart` / `klineChartOptions` 渲染逻辑
- 更新 `trendFetchers.ts`（MoneyFlow 行业 Modal 仍用 `days=250`，本 spec 不顺带改）

## 3. 方案（已采纳：方案 A）

**统一 fetcher + SW AMV 后端 + AMV API 区间扩展。**

- 新建 `sw-amv.service.ts` + `sw_amv_daily` 表
- 扩展 `GET /active-mv/{industry,concept,sw}/:tsCode` 支持区间查询
- 前端抽 `aSharesIndexKlineFetcher.ts`，Modal 按 `row.category` 动态白名单

## 4. 架构与数据流

```text
ASharesIndexSwPanel / ASharesIndexThsPanel
        │ row click
        ▼
ASharesIndexKlineModal
        │ loadKline(startDate, endDate)
        ▼
fetchIndexKline(row, startDate, endDate)
        │
        ├─ indexDailyApi.queryKline ──────► K 线 + MA/MACD/KDJ/BBI/BRICK
        │
        └─ activeMvApi.getByCategory ─────► AmvSeriesRow[]
              │ sw       → GET /active-mv/sw/:tsCode
              │ industry → GET /active-mv/industry/:tsCode
              │ concept  → GET /active-mv/concept/:tsCode
              │ market   → skip
        │
        ▼
mergeKlineWithAmv(kline, amvRows)
        │
        ▼
KlineChart  availableSubplots 含 '0AMV' | '0AMV_MACD'
              prefsKey="a-shares-index-kline"（不变）
```

**SW AMV 计算管线**（镜像 `industry-amv.service.ts`）：

```text
raw.index_member (l1/l2/l3_code = idx, is_new='Y')
        +
index_daily_quotes (category='sw', OHLC)
        +
raw.daily_quote Σamount (成分股 × trade_date, ×1000 千元→元)
        ▼
calcAmvSeries → calcMacd(12,26,9) → calcSignal / calcZdf
        ▼
sw_amv_daily UPSERT
```

## 5. 后端设计

### 5.1 数据库

新表 `sw_amv_daily`，列与 `industry_amv_daily` 同构：

| 列 | 说明 |
|----|------|
| `ts_code` | 申万指数代码（`.SI` 后缀） |
| `trade_date` | `YYYYMMDD` |
| `amv_open/high/low/close` | AMV OHLC |
| `amv_dif/dea/macd` | MACD 三列 |
| `amv_zdf` | 涨跌幅（展示用） |
| `signal` | 三态 -1/0/+1 |
| `member_count` | 当日有 amount 的成分股数 |

约束：`UNIQUE(ts_code, trade_date)`；`CHECK(signal IN (-1,0,1))`。

Migration：`apps/server/src/migration/YYYYMMDDHHMMSS-create-sw-amv-daily.sql` + 同名 `.ps1`（docker exec 格式）。Entity：`SwAmvDailyEntity`。

### 5.2 `sw-amv.service.ts`

新建独立 service（不塞进 `ThsIndexAmvService`，避免 THS/SW 成分来源混淆）。

**`syncSw(opts)`**：

- `startDate` / `endDate`：与 `syncIndustry` 相同——缺省 `startDate` 时兜底 `'00000000'`；一键同步路径始终传入 run 区间
- `tsCodes` 缺省 → 从 `sw_index_catalog` 取全部 `.SI` 代码
- 逐指数调用 `syncOneSwIndex(idx, startDate, endDate, syncMode)`

**`syncOneSwIndex` 核心逻辑**（对齐 `industry-amv.syncOneIndex`）：

1. **成分股**：`raw.index_member` 中 `l1_code = :idx OR l2_code = :idx OR l3_code = :idx`，且 `is_new = 'Y'` → 取 **`ts_code` 列**（个股代码，非 industry 的 `ths_member_stocks.con_code`）→ `conCodes[]`（快照口径，与 industry 一致，不做 PIT 逐日回溯）
2. **价侧**：`index_daily_quotes` WHERE `ts_code = :idx AND category = 'sw'`
3. **量侧**：复用 industry 的 `aggregateAmount(conCodes, fetchStart, endDate)` 裸 SQL 模式
4. **公式**：`calcAmvSeries` → `calcMacd` → 裁热身（`WARMUP_ROWS = 90`）→ UPSERT
5. **完整性 warn**：成分覆盖不足、amount 空、后缀非 `.SI` 等，遵循 data-integrity 规则

**`getSw(tsCode, days?, range?)`**：从 `sw_amv_daily` 读取，映射为 `AmvSeriesRow[]`。

### 5.3 GET API 区间扩展

三端点统一语义（沿用 `oamv.controller`）：

```
GET /api/active-mv/{industry|concept|sw}/:tsCode
  ?days=250
  &startDate=YYYYMMDD&endDate=YYYYMMDD
```

| 规则 | 说明 |
|------|------|
| 优先级 | 有 `startDate` 或 `endDate` → range 模式，**忽略** `days` |
| range 模式 | `Between` / `MoreThanOrEqual` / `LessThanOrEqual`（见 `oamv.service.get0amvData`） |
| 无 range | 最近 `days` 条 DESC take 后 reverse ASC（现有行为） |
| 校验 | `startDate/endDate` 须匹配 `^\d{8}$`；SW 端点额外校验 `.SI` 后缀 |
| 返回 | `AmvSeriesRow[]` camelCase |

**实现要点：**

- 新建 `apps/server/src/market-data/active-mv/amv-series-query.ts`，导出 `getSeriesWithRange(repo, tsCode, days, range?)`（range 语义对齐 `oamv.service.get0amvData`），供 industry/concept/sw 三 repo 复用
- 扩展签名链：`ActiveMvController` → `ActiveMvService.getIndustry|getConcept|getSw(tsCode, days, range?)` → 各子 service 内部调 `getSeriesWithRange`
- `ThsIndexAmvService.getSeriesByType` 改为委托 `getSeriesWithRange`（消除重复）
- `ActiveMvController` 新增 SW 路由块（`signals` 静态路由仍排在 `:tsCode` 之前）

### 5.4 POST 同步

```
POST /api/active-mv/sw/sync   @AdminOnly
Body: { startDate, endDate, syncMode?, tsCodes? }
Response: AmvSyncResult
```

### 5.5 一键同步

`OneClickStepKey` 新增 `'sw-amv'`，插入 **`concept-amv` 与 `oamv` 之间**：

```text
... → stock-amv → industry-amv → concept-amv → sw-amv → oamv
```

共 **11** 步。需同步更新：

| 文件 | 改动 |
|------|------|
| `apps/server/.../one-click-sync/types.ts` | `STEP_ORDER`、注释「10 步→11 步」 |
| `apps/server/.../one-click-sync/step-runners.ts` | 新增 `runSwAmv` |
| `apps/server/.../one-click-sync-orchestrator.service.ts` | `STEP_RUNNERS` 数组在 `runConceptAmv` 与 `runOamv` 之间插入 `runSwAmv` |
| `apps/web/.../sync/oneClickSync.types.ts` | 镜像 step key + 标签 + `buildInitialSteps()` 插入 `sw-amv` |
| `one-click-sync-orchestrator.service.spec.ts` | 步骤索引断言（`oamv` 从 index 9 → 10） |

`runSwAmv` 调用 `ctx.services.activeMv.syncSw(opts)`，结构与 `runIndustryAmv` 相同。

### 5.6 Module 注册

- `app.module.ts`：注册 `SwAmvDailyEntity`
- `active-mv.module.ts`：
  - `providers`：`SwAmvService`
  - `TypeOrmModule.forFeature`：`SwAmvDailyEntity`、`IndexMemberEntity`（成分股）、`SwIndexCatalogEntity`（默认指数列表）、`IndexDailyQuoteEntity`（价侧，若 industry 已注册可复用同一 import）

## 6. 前端设计

### 6.1 `active-mv.ts`

```typescript
interface AmvQueryOpts {
  days?: number
  startDate?: string
  endDate?: string
}

function buildAmvQueryString(opts?: AmvQueryOpts): string

activeMvApi.getIndustry(tsCode, opts?)
activeMvApi.getConcept(tsCode, opts?)
activeMvApi.getSw(tsCode, opts?)        // 新增
activeMvApi.syncSw(params?)             // 新增
```

- 向后兼容：`getIndustry(code, 250)` 仍可用（第二参数 number → 转 `{ days: 250 }`）
- `startDate/endDate` 为 Modal 传入的 YYYYMMDD（与 K 线 `indexDailyApi.queryKline` 同口径）

### 6.2 `aSharesIndexKlineFetcher.ts`（新文件）

```typescript
export async function fetchIndexKline(
  row: IndexLatestRow,
  startDate: string,
  endDate: string,
): Promise<KlineChartBar[]>
```

| `row.category` | K 线 | AMV |
|----------------|------|-----|
| `sw` | `indexDailyApi.queryKline` | `activeMvApi.getSw(tsCode, { startDate, endDate })` |
| `industry` | 同上 | `activeMvApi.getIndustry(...)` |
| `concept` | 同上 | `activeMvApi.getConcept(...)` |
| `market` | 同上 | 不请求 |

- `Promise.all` 并行；AMV `.catch(() => [] as AmvSeriesRow[])` 降级
- 返回 `mergeKlineWithAmv(kline, amvRows)`
- 单测覆盖：category 分支、并行语义、AMV 失败降级、merge 字段

### 6.3 `ASharesIndexKlineModal.vue`

```typescript
const BASE_SUBPLOTS: SubplotKey[] = ['VOL', 'KDJ', 'MACD']
const AMV_SUBPLOTS: SubplotKey[] = ['0AMV', '0AMV_MACD']

const availableSubplots = computed(() =>
  props.row?.category === 'market'
    ? BASE_SUBPLOTS
    : [...BASE_SUBPLOTS, ...AMV_SUBPLOTS],
)
```

- `loadKline` 改调 `fetchIndexKline(props.row, startDate, endDate)`
- 更新文件头注释（移除「指数无活跃市值」）
- **不改** LazyTeleport / `refreshChartAfterData` 逻辑

### 6.4 副图 UI 预期

```text
┌──────────────────────────────────────────────────────┐
│  801750.SI 半导体 K 线                    [区间选择] │
├──────────────────────────────────────────────────────┤
│  主图：K 线 + MA 叠加                                 │
├──────────────────────────────────────────────────────┤
│  VOL │ KDJ │ MACD │ 0AMV │ 0AMV_MACD  ← 工具栏切换  │
├──────────────────────────────────────────────────────┤
│  ... 副图栈（与个股同款 MACD 柱 + DIF/DEA 线） ...    │
└──────────────────────────────────────────────────────┘
（无 amv-caption 小字）
```

## 7. 错误处理

| 场景 | 行为 |
|------|------|
| AMV API 网络/500 错误 | `.catch → []`，主图正常；副图该日 `null` |
| SW 未 sync（表空） | 副图空，不触发 Modal empty-state（K 线有数据即可） |
| `category=market` | 不请求 AMV；白名单不含 AMV 副图 |
| 区间超出 AMV 覆盖 | merge 后缺日填 `null` |
| 非法 tsCode 后缀 | 后端 `400 BadRequestException` |

## 8. 测试计划

### 8.1 后端

| 文件 | 覆盖点 |
|------|--------|
| `sw-amv.service.spec.ts`（新） | 成分聚合、热身裁切、MACD 字段、空成分 warn |
| `active-mv.controller.spec.ts`（新） | range vs days 优先级、YYYYMMDD 校验、`.SI` 后缀 |
| `amv-series-query.spec.ts`（新，可选与 controller 合并） | `getSeriesWithRange` range/days 分支 |
| `one-click-sync-orchestrator.service.spec.ts`（扩） | 11 步顺序；`oamv` 断言 index 9→10 |

### 8.2 前端

| 文件 | 覆盖点 |
|------|--------|
| `aSharesIndexKlineFetcher.spec.ts`（新） | category 分支、Promise.all、merge、AMV 降级 |
| `ASharesIndexKlineModal.spec.ts`（扩） | sw 白名单含 `0AMV_MACD`；market 不含 |
| `mergeAmv.ts` | 已有单测，不重复 |

### 8.3 不改

- `klineChartOptions.spec.ts`（渲染层已有 0AMV_MACD 覆盖）

## 9. 实现检查清单

**后端**

- [ ] Migration `sw_amv_daily` + entity
- [ ] `sw-amv.service.ts` + spec
- [ ] `getSeriesWithRange` 共享 helper；扩展 industry/concept GET
- [ ] Controller 路由 + `ActiveMvService` 委托
- [ ] 一键同步 11 步 + 前后端 types 镜像

**前端**

- [ ] `active-mv.ts` 区间 query + `getSw`
- [ ] `aSharesIndexKlineFetcher.ts` + spec
- [ ] `ASharesIndexKlineModal.vue` 改动 + spec 扩

**验证**

- [ ] `pnpm --filter @cryptotrading/server exec jest sw-amv active-mv one-click-sync`
- [ ] `pnpm --filter @cryptotrading/web test aSharesIndexKline`
- [ ] 手动：申万指数 Modal 选区间 → 0AMV/0AMV_MACD 有数据（需先跑 sw-amv sync）

## 10. 参考文件

| 用途 | 路径 |
|------|------|
| 个股 AMV fetcher | `apps/web/.../a-shares/aShareDetailFetcher.ts` |
| 行业 AMV fetcher | `apps/web/.../money-flow/trendFetchers.ts` |
| 美股指数 AMV 模式 | `apps/web/.../us-index/UsIndexPanel.vue` |
| AMV 合并 | `apps/web/.../composables/kline/mergeAmv.ts` |
| Industry AMV 计算 | `apps/server/.../active-mv/industry-amv.service.ts` |
| OAMV 区间查询 | `apps/server/.../oamv/oamv.service.ts` |
| 指数 Modal 现状 | `apps/web/.../a-shares-index/ASharesIndexKlineModal.vue` |
| SW 集成 spec | `docs/superpowers/specs/2026-06-23-sw-index-integration-design/index.md` |
