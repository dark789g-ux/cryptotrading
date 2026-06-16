# 交接：美股 Tab 下增设二级标签（美股 | 美股指数）+ 纳指100 K线图

> **一句话目标**：在 Symbols 工作台「美股」顶层 Tab 内部增设二级标签栏，含两个标签——
> 「美股」（即现有个股表，原样保留）与「美股指数」；「美股指数」里展示**纳斯达克100指数**的日线 K 线图（可扩展到道指/标普500/纳指综合）。
>
> 本文档自包含，可整段贴给全新会话直接接手。**建议新会话先走 `/brainstorming`**（下方开放问题需敲定），经设计批准 + spec 自审 + 用户审阅后再用 `subagent-driven-development` 实现。

---

## 背景与范围

美股个股 Tab 已于 2026-06-16 全栈交付并合入本地 main（见 `docs/superpowers/specs/2026-06-16-us-stocks-tab-design/`）：AkShare → `raw.us_*` → NestJS `market-data/us-stocks` → 前端 `UsStocksPanel`。本任务是它的**增量**：给「美股」Tab 套一层二级标签，新增「美股指数」视图放指数 K 线。

**范围内（v1）**：二级标签 UI + 纳指100 指数日线 K 线（含 KDJ/MACD 副图所需指标）+ 指数数据采集/存储/查询全链路。
**明确推迟（P2，建议）**：更多指数（道指/标普500/纳指综合，数据源已验证可取，只是 v1 先做纳指100）、指数列表筛选/排序表格（v1 只要 K 线图，不要表格）。

---

## ✅ 已核验数据源（一手 spike，权威，可直接进实现）

本会话已 `uv run python` 实跑 `akshare==1.18.64`：

```text
ak.index_us_stock_sina(symbol=".NDX")   # 纳斯达克100, 数据源=新浪
  → 列: date, open, high, low, close, volume, amount   (amount 恒为 0, 不可用)
  → 3099 行, 回溯到 ~2013, 最新 2026-06-15 收 30543.92
其它可取符号(同接口, 便于 P2 扩):
  .IXIC=纳指综合  .DJI=道指  .INX=标普500
```

- **纳指100 的 symbol 是 `.NDX`**（带前导点）。无需 token。
- `amount` 恒 0 → 不入库/不用；`volume` 可用。
- 指数**不需要复权**（无 adj_factor 概念），比个股简单：只存 OHLCV + 在 close 上算指标。
- ⚠️ 实现期仍须按 `.claude/rules/data-integrity.md`：写进 fail-fast/落库前，对 `.NDX` 再跑一次真实调用确认列名/symbol 格式，别只信本文。

---

## 现状摸底（file:line 为证；进硬断言前到源头复核，子代理报告属二手）

### 1. 二级标签要插哪 — `apps/web/src/views/market/SymbolsView.vue`
- 顶层 Tab 是**手写 `<button role="tab">` 数组**（非 n-tabs），4 个：`crypto/aShares/activeMarketValue/usStocks`（`activeTab` 类型 L70）。
- `usStocks` 分支是 `<keep-alive>` 内的 `v-else` → 渲染 `<us-stocks-panel />`（L52–57）。
- **推荐**：usStocks 分支改渲染一个**新包装组件**（含二级 n-tabs），而非改 SymbolsView 的顶层 button（改动内聚、不动顶层风格）。

### 2. K 线组件复用契约 — `apps/web/src/components/kline/KlineChart.vue`
- props（L40–65）：`data: KlineChartBar[]`(必填)、`height`、`showToolbar`、`granularity='date'`、`availableSubplots`(副图白名单)、`prefsKey`(localStorage 副图偏好隔离键)、`range`/`disabledRange` 等。
- `KlineChartBar`（`apps/web/src/api/modules/market/symbols.ts` L24–64）：必填 `open_time`(**YYYYMMDD string**)、`open/high/low/close/volume`(number)；可选指标 `MA5/30/60/120/240`、`KDJ.K/D/J`、`DIF/DEA/MACD`、`BBI` 等（副图靠这些字段）。
- 副图键全集（`subplotConfig.ts` L15）：`VOL|KDJ|MACD|BRICK|FLOW|0AMV|0AMV_MACD`；美股个股详情传 `['VOL','KDJ','MACD']`（`UsStockDetailDrawer.vue` L64）——**指数 K 线同样用 `['VOL','KDJ','MACD']`**。
- `KlineChart` 已 `defineExpose({ resize })`：二级 Tab 切到「美股指数」时需调 `resize()`（keep-alive + echarts 不自动 resize）。

### 3. 指数日线「同类参照」全链路 — A 股同花顺指数（直接镜像它）
- 实体：`apps/server/src/entities/ths-index-daily/ths-index-daily-quote.entity.ts`（`ths_index_daily_quotes`：ts_code/trade_date(YYYYMMDD)/OHLC/vol）、`ths-index-daily-indicator.entity.ts`（MA/DIF/DEA/MACD/KDJ/BBI…）。
- 后端模块：`apps/server/src/market-data/ths-index-daily/`：`ths-index-daily.module.ts`、`ths-index-daily.controller.ts`（`GET /ths-index-daily?ts_code=&start_date=&end_date=` → getKlines、`/date-range`）、`ths-index-daily.service.ts`（L51–116 raw SQL LEFT JOIN quotes+indicators，产出对齐 `KlineChartBar`，`open_time=tradeDate`）、`ths-index-daily-sync.controller.ts`（SSE 同步）。
- 前端：`apps/web/src/api/modules/market/thsIndexDaily.ts`（`query({ts_code,start_date,end_date})→KlineChartBar[]`）、同步 composable `apps/web/src/components/sync/useThsIndexDailySync.ts`。

### 4. 美股现有后端模块 — `apps/server/src/market-data/us-stocks/`
- controller 端点：`/us-stocks/{summary,filter-options,date-range,symbols,query,:ticker/klines,sync}` + `PUT /symbols/tracked`。
- module forFeature 4 实体（`raw.us_symbol/us_daily_quote/us_adj_factor/us_daily_indicator`）+ 导入 `QuantModule`（派 job）。
- 个股 K 线 fetcher：`apps/web/src/components/symbols/us-stocks/usStockDetailFetcher.ts`（`fetchUsStockKline`→`/us-stocks/:ticker/klines`）——指数 fetcher 照此写。

### 5. Python 美股管线（指数采集镜像它）— `apps/quant-pipeline/src/quant_pipeline/`
- `sync/akshare_client.py`（限频/重试/空数据双路径 warn）、`sync/us_indicators.py`（**移植自 `indicators.ts`，TS↔Python 对拍 7e-8**，可直接复用算指数指标）、`sync/us_daily.py`、`sync/us_orchestrator.py`、`worker/dispatcher.py` 的 `us_sync` 路由、`cli.py` 的 `quant us-sync`。指数版照此加 `index_us_stock_sina` 客户端方法 + `us_index.py` fetcher + 编排 + run_type/CLI。

### 6. 二级 Tab 写法参照（naive-ui n-tabs）
- **推荐**：`apps/web/src/components/strategy/SignalTestConfigPanel.vue` L8 — `<n-tabs type="line" animated display-directive="show:lazy">`（首次激活后保持渲染，适合 echarts 这种有副作用的组件）。
- 其它：`WatchlistsView.vue`（card 型）、`BacktestDetail.vue`（line 型）。

---

## 推荐方向（带理由；最终由 brainstorming 敲定）

```text
数据流(指数, 镜像个股但更简单——无复权):
  Python(quant-pipeline) ─AkShare index_us_stock_sina(".NDX")→ 新浪
    → raw.us_index_daily(OHLCV)  +  在 close 上用 us_indicators 算 MA/KDJ/MACD/BBI → raw.us_index_indicator
  NestJS market-data/us-index-daily(新模块, 镜像 ths-index-daily) 只读 → /api/us-index-daily?index_code=&start=&end=
  前端: 美股 Tab → 二级 n-tabs[美股 | 美股指数]
        美股 pane    = 现有 UsStocksPanel(原样)
        美股指数 pane = 新 UsIndexPanel: 指数选择(默认纳指100) + <KlineChart :availableSubplots="['VOL','KDJ','MACD']" prefsKey="us-index">
```

1. **数据模型**：新建 `raw.us_index_daily`（index_code/trade_date(YYYYMMDD)/open/high/low/close/volume）+ `raw.us_index_indicator`（ma/kdj/dif/dea/macd/bbi…，输入 close）。可选 `raw.us_index_catalog`（index_code `.NDX`/name 纳斯达克100指数/tracked），v1 也可先硬编码纳指100、catalog 留 P2。**无复权列**。
2. **后端**：新建平行模块 `market-data/us-index-daily/`（镜像 ths-index-daily），比塞进 us-stocks 干净、易测。端点 `GET /us-index-daily?index_code=&start_date=&end_date=` → `KlineChartBar[]`、`/date-range`、`POST /sync`（派 job）。
3. **Python 采集**：`akshare_client` 加 `fetch_us_index(symbol)`；新 `sync/us_index.py`（抓 → 算指标 → upsert）；新 run_type `us_index_sync`（dispatcher + CLI `quant us-index-sync`，与 `us_sync` 同构）。指标复用 `us_indicators.calc_us_indicators`（注意它要 open/high/low/close 四序列；指数有齐）。
4. **前端二级 Tab**：usStocks 分支渲染新 `UsStocksTabsContainer.vue`（`<n-tabs type="line" display-directive="show:lazy">`，pane「美股」=`<UsStocksPanel>`、pane「美股指数」=`<UsIndexPanel>`）。切到指数 pane 时调 `KlineChart.resize()`。
5. **K 线复用**：`UsIndexPanel` 用 `KlineChart`，数据走新 `usIndexApi.getKlines` → 映射成 `KlineChartBar`（`open_time` 必须 **YYYYMMDD string**，与副图按日期对齐字面相等，见 datetime 规范）。

---

## 待 brainstorming 敲定的开放问题

1. **新模块 vs 扩展 us-stocks**：推荐新建 `us-index-daily/`（独立、镜像 ths-index-daily）。确认。
2. **catalog 要不要**：v1 只纳指100，是硬编码 `.NDX` 还是建 `us_index_catalog` 表为 P2 扩道指/标普500预留？（AkShare 已验证 `.IXIC/.DJI/.INX` 可取）
3. **二级 Tab 位置**：包装组件内 n-tabs（推荐）vs 改 SymbolsView 顶层 button。
4. **同步触发**：新 run_type `us_index_sync` + CLI（推荐，本次首灌走 CLI 不重启）vs 复用 `us_sync` 加 flag。
5. **指数 K 线要不要做指数「列表/筛选表格」**：本需求只说「K线图」，建议 v1 不做表格、只做指数选择 + K 线。确认。
6. **首灌日期范围/时长**：指数数据回溯到 ~2013，确认要灌的区间（与个股窗口对齐 `[20250101, 最新]` 还是更长）。

---

## 硬约束 / 项目规范（务必遵守）

- **数据完整性**（`.claude/rules/data-integrity.md`）：`.NDX`/接口名/字段名进 fail-fast/migration/落库前再跑真实调用核验；空数据双路径 warn、0 行→failed_items、禁 `.catch(()=>[])`。
- **datetime**（`.claude/rules/datetime.md`）：`trade_date` 存 `varchar(8) YYYYMMDD`；K 线 `open_time` 与副图对齐**字符串字面相等**；AkShare 给 `YYYY-MM-DD` 需转。
- **DB/migration**：`.sql` + 同名 `.ps1`（`docker exec crypto-postgres`）；实体**双注册**（module forFeature + `app.module.ts` 根 entities[]）。
- **TypeORM**（`.claude/rules/database-sql.md`）：QueryBuilder `.select()` 用实体属性名不用 DB 列名；upsert 前按 PK 去重。
- **NestJS**：Controller 禁 `@UseGuards(AuthGuard)`（已全局）；**改后端必须重启**（`nest start` 无 watch；本会话经 preview「dev」server 重启过——`preview_stop`+`preview_start dev` 即重启整套 orchestrator）。
- **前端**：单文件 ≤500 行；**合并前必跑 `pnpm --filter @cryptotrading/web build`（vite）**，type-check 查不出 SFC 编译错；注释里勿写含 `*/` 的 token（如 `brick*/amv*` 会提前闭合 `/** */`，见本会话踩坑）。
- **派 agent 禁用 worktree 隔离**（Windows 锁文件）；按文件域切分任务避冲突。
- **子代理派发显式 `model: opus`**（Explore 摸底可 sonnet）。

---

## 验证标准

- Python pytest：`fetch_us_index` 空数据双路径；`us_index` 幂等 upsert；指数指标与 `us_indicators` 一致。
- NestJS jest：`/us-index-daily` query 产出对齐 `KlineChartBar`、date-range、sync enqueue 写对 run_type。
- 前端 vitest + **vite build** 必绿。
- 真机/CLI e2e：CLI 首灌纳指100 → 验 `raw.us_index_daily` 落库（最新日 close ≈ 30543，对照 2026-06-15）+ 指标非空 → 重启后端 → 美股 Tab 切「美股指数」二级标签 → KlineChart 渲染纳指100、副图 VOL/KDJ/MACD 有值、切 Tab resize 正常。

---

## 前序进度 / 待续

- 数据源已一手验证（`index_us_stock_sina(".NDX")`），现状已摸到 file:line（上）。**尚未写任何代码**。
- 下一步：新会话 `/brainstorming` 敲定上方开放问题 → 写 spec → SDD 实现 → CLI 首灌 → 真机 e2e。
- 完成后按 `prompts/` 约定：删除本文件或移入 `prompts/archive/`。
