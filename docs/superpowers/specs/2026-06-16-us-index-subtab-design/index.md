# 美股 Tab 二级标签（美股 | 美股指数）+ 纳指100 K 线 — 设计总入口

> 在 Symbols 工作台「美股」顶层 Tab 内增设二级标签栏：「美股」（现有个股表，原样）+「美股指数」（纳斯达克100 日线 K 线，含 VOL/KDJ/MACD 副图）。本设计是 2026-06-16 美股个股 Tab（`docs/superpowers/specs/2026-06-16-us-stocks-tab-design/`）的增量。

## 背景与目标

- **数据源已一手验证**：`ak.index_us_stock_sina(symbol=".NDX")`（akshare 1.18.64）→ 列 `date/open/high/low/close/volume/amount`（`amount` 恒 0 丢弃），约 3099 行回溯到 ~2013，最新 2026-06-15 收 30543.92。无需 token、**无复权概念**。
- **采集必须走 Python**（AkShare 是 Python-only）：ths-index-daily 的「NestJS 内 SSE 直连 Tushare」模式**不可照搬**——指数采集走 Python 管线（CLI 首灌 / 派 `us_index_sync` job），NestJS 只读查询 + 派 job。
- **v1 范围**：二级标签 UI + 纳指100 全量历史 K 线 + 指数采集/存储/查询全链路 + 同步按钮（完整对齐 us-stocks）。
- **明确推迟（P2）**：更多指数（`.IXIC/.DJI/.INX`，数据源已验证可取，靠多灌一个 `index_code` 即可，无需改 schema）、指数列表/筛选表格。

## 已敲定决策（brainstorming 2026-06-16）

| # | 决策 | 取定 |
|---|------|------|
| 1 | 新模块 vs 扩展 us-stocks | **新建** `market-data/us-index-daily/`（结构镜像 ths-index-daily） |
| 2 | catalog 表 | v1 **硬编码 `.NDX`**，无 catalog/tracked；表有 `index_code` 列，P2 多灌即可 |
| 3 | 二级 Tab 位置 | **包装组件** `UsStocksTabsContainer.vue` 内 n-tabs，**不动**顶层 button |
| 4 | 同步触发 | Python `us_index_sync` run_type + CLI 首灌 + NestJS POST /sync 派 job + 前端同步按钮（**完整对齐 us-stocks**） |
| 5 | 指数表格 | v1 **不做**，只做指数选择 + K 线 |
| 6 | 首灌区间 | **全量回溯**（`20100101:<today>`，orchestrator 裁窗，akshare 实返 ~2013 起） |
| 7 | indicator 列 | **复用全部 17 列**（逐字对齐 `raw.us_daily_indicator`），最大化复用 `calc_us_indicators` + 动态 upsert |
| 8 | open_time 格式 | **`YYYY-MM-DD`**（对齐美股个股，service 用 `formatTradeDateLabel`） |

## 端到端数据流

```text
Python (apps/quant-pipeline)  ── AkShare ak.index_us_stock_sina(".NDX") → 新浪
  akshare_client.fetch_us_index(symbol)    [新; 复用 _throttle/重试/空数据双路径 warn]
  sync/us_index.py                         [新; 单次抓→裁窗去重→calc_us_indicators(复用17列)→upsert]
     ├─► raw.us_index_daily      (index_code, trade_date YYYYMMDD, OHLCV; numeric(30,10))  无复权
     └─► raw.us_index_indicator  (index_code, trade_date, 17 指标列; double precision)
  sync/us_index_orchestrator.run_us_index_sync(job_id, date_range, symbols=('.NDX',))  [新]
  worker/dispatcher: _ROUTES["us_index_sync"] = _runner_us_index_sync                   [新]
  cli: quant us-index-sync --date-range --symbols                                        [新; 首灌走它]
                                   │ (raw SQL 只读)
NestJS (apps/server/src/market-data/us-index-daily/)  [新模块; 表落 raw schema]
  GET  /api/us-index-daily?index_code=&start_date=&end_date=  → KlineChartBar[]  (open_time=YYYY-MM-DD)
  GET  /api/us-index-daily/date-range?index_code=            → { start, end }
  POST /api/us-index-daily/sync  (@AdminOnly, @CurrentUser → 派 us_index_sync job)
                                   │ (HTTP)
前端 (apps/web)
  SymbolsView.vue L56:  <us-stocks-panel/>  ──►  <us-stocks-tabs-container/>  [新]
     <n-tabs type="line" animated display-directive="show:lazy">
       ├ pane「美股」     = <UsStocksPanel/>   (原样, 零改)
       └ pane「美股指数」 = <UsIndexPanel/>     [新]
            ├ 指数选择(v1 单项=纳斯达克100, n-select 结构留 P2)
            ├ 同步按钮 → usIndexApi.triggerSync() → 进度组件(复用 us-stocks)
            └ <KlineChart :availableSubplots="['VOL','KDJ','MACD']" prefsKey="us-index" ref>
                切到本 pane / 切回美股顶层 Tab 时调 .resize()
```

## 子文档清单

按下列编号顺序阅读；实现期 **D（前端）依赖 B（后端契约）**、**C（Python）可与 B 并行**、二者都在 A 之后：

1. [01-data-model.md](./01-data-model.md) — 两张 raw 表 DDL、migration `.sql`+`.ps1`、TypeORM 实体 + 双注册。**所有列名/类型的权威源**。
2. [02-backend-nestjs.md](./02-backend-nestjs.md) — `us-index-daily` 模块（module/controller/service/types/util）、3 端点契约、KlineChartBar 映射、run_type 枚举两处加 `us_index_sync`。
3. [03-python-pipeline.md](./03-python-pipeline.md) — akshare_client/us_index/orchestrator/dispatcher/cli、错误处理（空数据双路径 / failed_items）、指标复用。
4. [04-frontend.md](./04-frontend.md) — TabsContainer/UsIndexPanel/api/SymbolsView 改动、resize 编排、keep-alive 注意。
5. [05-testing-rollout.md](./05-testing-rollout.md) — 测试矩阵、CLI 首灌 + 真机 e2e、**任务切分（文件域互不相交）与依赖顺序**。

## 跨文档引用约定

- 引用子文档用相对路径；需深引用时加锚点，如 `[列定义](./01-data-model.md#raw-us_index_daily)`（01 已埋 `raw-us_index_daily` / `raw-us_index_indicator` 两锚点，02 已埋 `端点契约`）。当前多数互链到文件级即可。
- 现状锚点统一标 `文件:行号`（如 [us-stocks.service.ts:230](../../../../apps/server/src/market-data/us-stocks/us-stocks.service.ts)），实现期进 fail-fast/migration 前**仍须到源头复核**（`.claude/rules/data-integrity.md`：本设计中的事实虽已逐项源头核验，但二次确认是硬规范）。

## 任务切分速览（详见 05）

```text
A 迁移+实体+双注册   migrations/*us-index*  ·  entities/raw/us-index-daily-*  ·  app.module.ts(加2行)
B NestJS 模块        market-data/us-index-daily/*  ·  ml-job.entity.ts(+1)  ·  create-job.dto.ts(+1)   依赖 A 实体
C Python 管线        akshare_client.py(改) · us_index.py(新) · us_index_orchestrator.py(新)
                     · worker/dispatcher.py(改) · cli.py(改) (+pytest)        落库需 A 已建表
D 前端               UsStocksTabsContainer.vue · us-index/UsIndexPanel.vue
                     · usIndexDaily.ts · SymbolsView.vue(改) (+vitest)         依赖 B 接口
顺序: A → (B ‖ C) → D → e2e   （依赖与文件域冲突面隔离的完整说明见 05）
```

> 上为速览；任务依赖、文件域互不相交证明、上线 e2e 步骤以 [05-testing-rollout.md](./05-testing-rollout.md) 为准（避免双维护）。
