# 美股 Tab（AkShare 数据源）— 设计 spec

> 一句话目标：在 Symbols 标的工作台新增第 4 个 Tab「美股」，展示层照搬「A 股数据」结构（基础列 + 技术指标列，**无**评分/买入信号）；数据用 **AkShare** 在 **Python(quant-pipeline)** 里抓**不复权日线 + 复权因子**，存好后自行算前复权与指标；先精选清单（CSV 播种 + tracked 标记位），schema 预留扩展到全美股。

## 背景与目标

Symbols 工作台现有三 Tab（加密标的 / A 股数据 / 活跃市值），由 `SymbolsView.vue` 用本地 `activeTab` ref + `v-if/v-else-if/v-else`（keep-alive 包裹）切换，无路由。本 spec 新增「美股」第 4 个 Tab，并搭建其完整数据链路。

**为什么不能照搬 A 股的同步代码**：A 股同步是 NestJS 直接 `axios` 调 `api.tushare.pro`（HTTP REST 服务）。AkShare **不是** HTTP 服务，是个 `import akshare` 的 Python 包（爬新浪/东财），**抓数必须跑在 Python 里**。所以「参考 A 股」在同步这块只参考其**数据建模思路**（存不复权 + 复权因子、后续算复权），代码路径无法照搬。展示/查询层（Vue 新 Tab + NestJS 查询接口）则可放心照搬 A 股结构。

本 spec 交付四块（用户已逐项拍板，见 [01-architecture-and-dataflow.md](./01-architecture-and-dataflow.md#用户已拍板的决策)）：

1. **Python 同步管线**（quant-pipeline，新 `us_sync` run_type）：AkShare 抓 raw + 因子 → SQL 算前复权 → Python 算指标 → 写 `raw.us_*`。
2. **数据模型**：`raw.us_symbol / us_daily_quote / us_adj_factor / us_daily_indicator` 四张表（NestJS migration 建表，Python 读写）。
3. **NestJS 查询 + 触发**：`market-data/us-stocks` 模块，只读 `raw.us_*` + 写 `us_symbol.tracked` + 派 `ml.jobs`。
4. **前端美股 Tab**：`UsStocksPanel` 及其 composable/columns/filters，复用共享列系统与 `ColumnSettingsDrawer`。

**明确推迟到 P2（不在本 spec）**：AkShare 全美股名单自动同步（v1 用 CSV 播种 tracked 集）、全市场规模的每日增量策略、filter presets（A 股的筛选方案）、美股评分模型、买入信号列、活跃市值(AMV)/砖块图美股版、独立 us_trade_cal/脏区表。理由见各子文档。

## 本次执行目标（用户 /goal）

> 完成冒烟测试后，同步美股数据，标的列表见 `doc/us_stocks_themes (1).csv`（62 只），时间 **2025-01-01 至 2026-06-12**。

- **冒烟测试**：CLI 直跑 `us_sync` 同步 1–2 只（如 NVDA/MSFT），验 `raw.us_*` 落库 + qfq 非空 + 指标非空。
- **真实灌数**：从 CSV 播种 `raw.us_symbol`（tracked=true），CLI 直跑全 62 只、`[20250101, 20260612]`。走 CLI 而非 worker/web，**不重启**用户在跑的 dev 服务。
- **已知数据问题**：`SPCX`(SpaceX) 未上市，AkShare 预期取不到 → 进 `failed_items`，同步后如实报告，不静默。

## 关键事实（已落源头核对，禁二手转述）

| 事实 | 证据 |
|------|------|
| Symbols Tab 用 `activeTab` ref + `v-if/v-else-if/v-else`（keep-alive），无路由 | `SymbolsView.vue:1-59`（type `'crypto'\|'aShares'\|'activeMarketValue'`） |
| A 股同步 = NestJS axios → `api.tushare.pro`，无 Python | `a-shares/services/tushare-client.service.ts:1-159` |
| AkShare 全仓零引用，仅声明 `tushare>=1.4` | grep akshare 无命中；`apps/quant-pipeline/pyproject.toml:9-33` |
| quant-pipeline 已有 Python 价格指标实现可复用 | `features/builder.py`、`factors/price.py`（`test_factors_price`） |
| `ALLOWED_RUN_TYPES` 现 12 个，无 us_sync | `create-job.dto.ts:60-73` |
| dispatcher `_ROUTES` 路由 run_type→runner | `worker/dispatcher.py:387-407` |
| 前复权在 DB 用 SQL 算（`原始价 × 当日因子 / 最新因子`）写回 qfq_* | `a-shares/sync/a-shares-sync-dirty-ranges.ts:65-130` |
| 列偏好 scope 现仅 `crypto\|aShares` | `useSymbolColumnPreferences.ts`、`api/.../preferences.ts:1-17` |
| 共享指标 descriptor + `buildIndicatorColumns` 泛型 builder | `indicatorColumnDefs.ts:1-124` |
| 列分组单一事实源 `COLUMN_KEY_GROUP` | `columnGroupMeta.ts:1-89` |
| AkShare `stock_us_daily` 支持 `adjust=` `""`(不复权)/`"qfq"`/`"hfq"`/`"qfq-factor"`/`"hfq-factor"`(复权因子)，裸 ticker，无需 token；v1 用 `""`+`"hfq-factor"`，`"qfq"` 作复权校验 ground truth（详见 [02](./02-akshare-interface.md)） | WebFetch/WebSearch akshare 官方文档 |

## 子文档清单（建议按序阅读）

1. [01-architecture-and-dataflow.md](./01-architecture-and-dataflow.md) — 总架构 / 数据流 ASCII / 进程边界 / `us_sync` run_type / 触发双路径 / 用户决策记录
2. [02-akshare-interface.md](./02-akshare-interface.md) — AkShare 美股接口：已核验事实 + 实现期必核项 + 复权因子语义校验策略
3. [03-data-model.md](./03-data-model.md) — `raw.us_*` 四表 schema / 实体双注册 / migration(.sql+.ps1) / us_symbol CSV 播种
4. [04-python-sync-pipeline.md](./04-python-sync-pipeline.md) — akshare_client / fetchers / qfq SQL / 指标计算 / CLI + worker runner / 空数据铁律 / 进度
5. [05-nestjs-module.md](./05-nestjs-module.md) — us-stocks 模块 / 控制器端点 / 服务 / run_type 白名单 / tracked 写 / sync 派 job 桥
6. [06-frontend-tab-panel.md](./06-frontend-tab-panel.md) — 第 4 Tab / UsStocksPanel 及子件 / 列系统复用 / 主题与口径筛选 / 偏好 scope 扩展点 / 同步与标的管理 UX
7. [07-tasks-testing-risks.md](./07-tasks-testing-risks.md) — 任务依赖顺序与文件域切分 / 测试计划 / 冒烟与真实灌数步骤 / 风险 / YAGNI

## 跨文档引用约定

统一相对路径 + 锚点，例：`[qfq 公式](./04-python-sync-pipeline.md#3-前复权与指标)`。代码位置一律 `file:line`。所有进硬断言/migration/SQL 的事实须落源头核验（含 AkShare 字段名、见 02）。

## 验证标准（总览，细则见 07）

- Python pytest：`akshare_client` 空数据双路径 warn + 0 行→`failed_items`；`us_daily` fetcher 幂等 upsert；指标 TS↔Python 抽样对拍在容差内。
- NestJS jest：us-stocks query（priceMode 选 qfq/raw 列、排序映射）、tracked toggle、sync enqueue 写对 run_type。
- 前端 vitest + **必跑 `pnpm --filter @cryptotrading/web build`**（SFC 编译，type-check 查不出）。
- 真机/CLI e2e：冒烟（1–2 只落库 + qfq/指标非空）→ 真实灌数（62 只、`[20250101,20260612]`，SPCX 进 failed_items）→ 面板渲染 + 口径切换 + 列偏好持久化后恢复默认。
- **改 NestJS 代码后必须重启**（`nest start` 无 watch）；本次真实灌数走 CLI 不依赖重启。
