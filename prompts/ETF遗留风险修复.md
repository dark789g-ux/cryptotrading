# ETF 功能遗留风险修复（跨会话交接）

> 本文档自包含，可直接贴给新会话 / agent 接手执行，不依赖上一会话上下文。

## 你的任务

cryptotrading 项目刚实施完「ETF 数据采集与列表」功能，opus 评审后留下 7 个遗留风险（R1–R7）。请按优先级修复 **R2 → R4 → R7 → R1**（R3/R5/R6 暂不动），每项修完跑验证。

## 背景

- **功能**：沪深 ETF 的 PCF（申购赎回清单）+ 日线行情 + 技术指标（K线 MA/MACD/KDJ、AMV 活跃市值、MF 资金净流入）采集；前端在「A 股指数」下新增「ETF」tab，展示列表 + 行点击弹窗（K线 + PCF 成分股明细）。一键同步点击触发，盘后日频，沪深全市场。
- **已批准 plan**：`C:\Users\Lucifer\.claude\plans\pcf-nested-leaf.md`（先读它理解全貌、字段映射、架构决策）
- **接口文档**：`doc\数据源\沪深交易所-ETF-PCF接口.md`
- **实施状态**：两个 sonnet agent 已完成后端 + 前端；opus agent 评审并**已修复 6 个 critical correctness bug（全绿，不要再碰）**。下面 R1–R7 是遗留风险。

## 已实施产出（修复范围限于这些文件）

**后端** `apps/server/src/`：
- `market-data/etf/`：`etf.module.ts` / `etf.service.ts`（主编排）/ `etf.types.ts` / `etf-catalog.service.ts`（ETF 目录）/ `etf-fund-daily.service.ts`（fund_daily+fund_adj+qfq）/ `etf-pcf.client.ts`（沪深 PCF 抓取）/ `etf-pcf.service.ts`（PCF 落库）/ `etf-indicator.service.ts`（K线指标）/ `etf-amv.service.ts`（AMV）/ `etf-mf.service.ts`（MF）/ `etf-query.service.ts`（查询API）/ `etf.controller.ts`
- `entities/raw/etf-{symbol,pcf,fund-daily,fund-daily-indicator,fund-amv-daily}.entity.ts` + `entities/money-flow/money-flow-etf.entity.ts`
- `migration/20260701100000-create-etf-tables.sql` + `.ps1`（6 张表已建）
- `market-data/one-click-sync/step-runners-etf.ts` + 改 `one-click-sync/{types.ts, step-runners.ts, one-click-sync-orchestrator.service.ts, one-click-sync.module.ts}`、`app.module.ts`

**前端** `apps/web/src/`：
- `components/symbols/a-shares-index/`：`etf.types.ts` / `useEtfQuery.ts` / `etfColumns.ts` / `pcfColumns.ts` / `EtfKlineModal.vue` / `ASharesIndexEtfPanel.vue`
- 改 `components/symbols/a-shares-index/ASharesIndexPanel.vue`、`components/sync/oneClickSync.types.ts`、`views/sync/SyncView.vue`、`components/symbols/a-shares/{useASharesQuery.ts, ASharesFilters.vue, ASharesTabsContainer.vue}`

---

## 遗留风险（按优先级）

### 🔴 R2 — MF 聚合未 PIT 匹配成分股【correctness，最优先】

- **位置**：`apps/server/src/market-data/etf/etf-mf.service.ts`（约 :107，取成分股处）
- **问题**：取成分股用了跨全部交易日的 `conCodes` 并集（`Set(pcfRows.map(conCode))` 之类），对每个 `tradeDate` 都聚合整个并集，**而不是当日 PCF 的成分股**。
- **影响**：ETF 季度调样时，旧日期会错误纳入未来成分股、新日期纳入历史成分股 → 资金净流入数据错误。这是 plan 明确要求 PIT 但实现漏掉的 correctness 问题。
- **修复方案**：仿 `apps/server/src/market-data/custom-index/compute/custom-index-money-flow.service.ts` 的 `aggregateMoneyFlowFromRows`——用 `resolvePitMembers(versions, tradeDate)` 逐日 PIT 匹配当日成分股，再聚合 `money_flow_stocks` 的 `net_amount`/`buy_lg/md/sm_amount`。ETF 的"成分股版本"来自 `raw.etf_pcf`（每个 trade_date 一份成分股清单）。
- **验证**：
  - 新增 jest 单测：构造"调样日前后成分股变化"的 fixture，断言每个 tradeDate 用各自当日成分股聚合。
  - `pnpm --filter @cryptotrading/server exec jest` 全绿。
  - `docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT ts_code, trade_date, net_amount FROM money_flow_etf ORDER BY 1,2 LIMIT 20;"` 抽查。

### 🟡 R4 — fund_type 分类不一致【体验，需先做设计决策】

- **位置**：`etf-catalog.service.ts` 的 `normalizeFundType`（把所有含 ETF 的归一为 `'ETF'`）、`etf-pcf.*`（PCF 存交易所原始串：上交所 `ETF_TYPE` 如「单市场股票ETF」、深交所硬编码 `'股票型'`）、前端 `etf.types.ts` 的 `EtfFundType`（期望枚举 `single-market/cross-market/cross-border/currency/bond/commodity`）+ `etfColumns.ts` 的 `FUND_TYPE_LABEL`。
- **问题**：catalog 存 `'ETF'`、PCF 存交易所原文、前端期望枚举 → `FUND_TYPE_LABEL` 查不到 → fallback 显示原始串。结果：类型列要么全显「ETF」、要么「股票型」、要么交易所原文；**前端筛选 radio（单市场/跨市场/跨境/…）基本无匹配数据**。
- **决策（二选一，建议先定再做）**：
  - **方案 A（映射表，推荐）**：实现 fund_type → 枚举的映射。先查 Tushare `fund_basic` 的 `fund_type` 字段口径（**用 `tushare-sync-dev` skill 查文档**，别凭记忆），在 catalog 归一时映射到 `single-market/cross-market/cross-border/currency/bond/commodity`。
  - **方案 B（降级 UI）**：去掉基金类型 radio，改文本筛选（前端 `ASharesIndexEtfPanel.vue` + `etfColumns.ts` 调整，后端不改）。
- **验证**：前端 `pnpm --filter @cryptotrading/web test` + `type-check`；真数据抽查类型列分布合理。

### 🟢 R7 — ETF K 线 Modal 无 AMV 副图【功能未接全，小】

- **位置**：`apps/web/src/components/symbols/a-shares-index/EtfKlineModal.vue`（约 :97，注释"ETF 独有 AMV 副图暂不启用"）。
- **问题**：`etf-amv` step 已把数据落进 `raw.fund_amv_daily`，但 K 线弹窗副图仍只有 VOL/KDJ/MACD，没有 AMV 副图。
- **修复**：`EtfKlineModal` 的 KlineChart 配置加 AMV 副图，复用现有指数 K 线的 AMV 副图配置模式。若 `GET /api/etf/kline` 未返回 AMV 字段，先在 `etf-query.service.ts` 的 kline 查询里 join `raw.fund_amv_daily` 返回 `amv_open/high/low/close` 等。
- **验证**：前端 `vitest` + `type-check` + `lint:quant-lines`。

### 🟢 R1 — 前后端 step 不逐字镜像【tech debt，预先存在，非本次回归】

- **位置**：前端 `apps/web/src/components/sync/oneClickSync.types.ts`（含 `stock-amv`，14 步）vs 后端 `apps/server/src/market-data/one-click-sync/types.ts`（`STEP_ORDER`/`OneClickStepKey` 无 `stock-amv`，13 步——`stock-amv` 在更早的 PR 里已并入 `a-shares` step 收尾）。
- **问题**：前端 `buildInitialSteps()` fallback 顺序多一行 `stock-amv`（死代码，后端永不产生该 step）。
- **影响**：**非功能性**——前端按 step key 渲染（`withLabel` 查 `STEP_LABELS`），ETF 三步（`etf`/`etf-amv`/`etf-mf`）两边都有且 label 都有，渲染正确。只是 fallback 多一行死代码。
- **修复**：删前端 `oneClickSync.types.ts` 里 `buildInitialSteps` 的 `stock-amv` 行（确认 active-mv 重构确实不再需要它）。**注意**：这是 active-mv 重构遗留 tech debt，改前确认不破坏 active-mv 其他逻辑。
- **验证**：前端 `type-check` + `vitest` + 手动确认一键同步面板 step 列表正常。

### ⚪ R3 / R5 / R6 — 暂不动（记录在案）

- **R3（AMV 聚合非 PIT）**：`etf-amv.service.ts`（约 :96）取成分股并集而非逐日 PIT。但参考 `active-mv/sw-amv.service.ts`（约 :151）也是单一扁平成分股快照（`index_member` 当前快照），**与既有架构对齐，非回归**。若要修，与 R2 同步改逐日 PIT；否则暂不动。
- **R5（money_flow_etf 3 列永远 NULL）**：表有 `pct_change`/`net_buy_amount`/`net_sell_amount`（同构 `money_flow_industries`），但 `etf-mf.service.ts` 只写 `net`/`buy_lg`/`buy_md`/`buy_sm`。与 industry 表对齐（industry 也未必填），非崩溃。可在 R2 修复时顺手填（若有数据源）。
- **R6（ETF 指标全量重算）**：`etf-indicator.service.ts` 按 ts_code 全量重算（plan 写"dirty 续算仿 a-shares-indicator.service.ts"，实现是全量重算）。**判断：合理**——ETF 历史短（多数 ≤10 年日线）、只一键同步触发（非高频）、无 `a_share_sync_states` 等价 dirty 表，全量重算成本可接受。无需改；若后续 ETF 数量剧增（>2000 只）再评估加 dirty 机制。

---

## 建议执行顺序

1. **R2**（correctness，最优先）
2. **R4**（体验；先定方案 A/B 再做）
3. **R7**（小，收尾）
4. **R1**（tech debt，单独）
5. R3 / R5 / R6 暂不动

## 硬约束（CLAUDE.md + `.claude/rules/`）

- 所有源文件 **UTF-8**，文件 I/O 显式 `encoding='utf-8'`
- **单文件 ≤500 行**，超限拆分成独立文件/函数/组件，**不要为压行数把代码写平**
- 接口名 / 字段 / 积分必须查官方文档（Tushare 用 `tushare-sync-dev` skill），**禁止凭变量名/注释/历史代码/子代理转述推断**——进硬断言前亲查实体/官方文档/真 DB
- 空数据三路径 warn（`data_null`/`items_empty`/`code_nonzero`）；fetcher 返回 0 行必须显式 `failedItems`（apiName 标 `xxx_empty`）；禁止 `.catch(()=>[])` 静默吞错
- 复用现有工具：`custom-index-money-flow` 的 `aggregateMoneyFlowFromRows`/`resolvePitMembers`、`active-mv/` 的 `amv-formula.ts`/`amv-sync-helpers.ts`、`indicators/indicators.ts`
- 前端配色：A 股约定（**绿涨红跌**），资金流用 `formatMoneyFlow` 万元口径

## 验证（每项修完都跑）

```powershell
pnpm --filter @cryptotrading/server build
pnpm --filter @cryptotrading/server exec jest
pnpm --filter @cryptotrading/web type-check
pnpm --filter @cryptotrading/web test
pnpm --filter @cryptotrading/web lint:quant-lines
# 涉及 DB 时：
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "<校验 SQL>"
```

不跑 e2e UI 测试（前端只单测 + lint + type-check）。改完确认：后端 build + jest 零回归、前端 type-check + vitest + lint 全绿。
