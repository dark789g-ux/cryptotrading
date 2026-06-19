# 阶段 2：加密 K 线信息面板（补建 pct_chg 列的后端改造）

- **日期**：2026-06-20
- **前置 spec**：`docs/superpowers/specs/2026-06-19-kline-info-panel-design/`（阶段 1 A 股 + 美股已实现并合入，本任务为该 spec 的阶段 2）
- **分支建议**：从 `main`（或阶段 1 合入后的分支）切 `feat/crypto-kline-info-panel`

## 一句话目标

让加密标的详情面板也能显示信息侧栏（现价/涨跌幅/成交量/成交额 4 字段）。因加密 klines 表无 `pct_chg` 列（币安 K 线不含涨跌幅），需先在**后端补建该列 + 同步逻辑 + 历史回填**，再做前端加密面板。

## 现状摸底（file:line 为证，别凭模块名猜）

### 阶段 1 已交付（本任务要复用 / 对齐）

- `apps/web/src/components/symbols/KlineWithInfoPanel.vue` —— 共享布局组件（K 线 + 可折叠侧栏），`storageKey` / `infoTitle` 两个 props + `kline`/`info` 两个 slot
- `apps/web/src/components/symbols/InfoRow.vue` —— 单行展示，`trend` prop 接受 CSS class 字符串（`'trend-up'`/`'trend-down'`/`''`，直接取自 `trendClass()` 返回值）
- `apps/web/src/components/symbols/a-shares/AStockInfoFields.vue` / `us-stocks/UsStockInfoFields.vue` —— 阶段 1 的两个字段组件，**加密照此模式新建 `crypto/CryptoInfoFields.vue`**
- `apps/web/src/components/symbols/crypto/CryptoSymbolDetailPanel.vue` —— 加密详情面板，阶段 1 **未改动**，本任务要像 A 股/美股那样用 `KlineWithInfoPanel` 包裹其 `<kline-chart>`
- 格式化函数全部复用：`aSharesFormatters.ts`（`formatNumber`/`formatPercent`/`formatAmount`/`trendClass`）+ `klineChartUtils.ts` 的 `fmtCompact`

### 加密 klines 表列结构（权威：实体定义）

`apps/server/src/entities/symbol/kline.entity.ts`（`@Entity('klines')`）：

- OHLCV：`open` `high` `low` `close`(L31) `volume`(L34) ✓ 都有
- 成交额语义：`quote_volume`(L39) —— **这才是加密的"成交额"**，不是 `amount`（klines 表无 amount 列）
- **`pct_chg` ❌ 不存在**（A 股 `a_share_daily_quotes` 表有，加密没有）
- 指标列：`ma5/ma30/.../dif/dea/macd/kdj_k/...` 等，由 `calcIndicators` 实时算

### klines 表写入流程（补建 pct_chg 必须改的链路）

| 角色 | 文件 | 关键位置 |
|---|---|---|
| 拉币安 + 字段映射 + 调 upsert | `apps/server/src/market-data/sync/sync.service.ts` | `syncSymbolKlines()` L202–307；币安字段映射 L244–258；指标计算入口 L268 `calcIndicators(klineRows)`；实体映射 L271–304；写入 L306 |
| 实际 `INSERT ... ON CONFLICT` | `apps/server/src/market-data/klines/klines.service.ts` | `upsertKlines()` L110–130；`orUpdate` 列表 L118–126（**必须加 `'pct_chg'`**） |
| 指标计算函数 | `apps/server/src/indicators/indicators.ts` | `calcIndicators()` L117，**当前不输出 pct_chg**（返回对象 L185–206 无此字段） |

**数据来源**：币安公开 REST `/api/v3/klines`（`sync.service.ts:239`），**唯一运行时入口**。无其它写 klines 的路径（`one-click-sync`/`base-data-sync` 不写 klines）。

**增量同步状态**：加密**无独立状态表**（A 股有 `a_share_incremental_sync_state`，加密没有）。增量从 klines 表自身 `MAX(open_time)` 派生，回溯 `UPDATE_LOOKBACK_DAYS = 30` 天（`sync.service.ts:34, 217–229`）。

### pct_chg 计算口径（项目内已有先例）

- **口径**：`(close - prev_close) / prev_close * 100`，prev_close = 同 symbol 同 interval 上一根 K 线 close
- **先例**：`apps/web/src/composables/kline/klineChartTooltip.ts:125–127` 前端已实时算同样的 pct
- **首根 K 线**：无前值 → 库里记 `NULL`（参照 MA5 首值 NULL 的处理 `indicators.ts:63–74`）
- A 股 pct_chg 是 Tushare 给的原值（`daily-quote.entity.ts:35`），**不在项目内算**；加密需自算

### 指标回填脚本参考范式（pct_chg 历史回填照抄）

**最贴切范式**：`apps/server/src/migration/a-share-brick-backfill.ts` —— 本地纯计算 + 按 symbol 循环 + 读 OHLC + 批量 `UPDATE ... FROM (VALUES) WHERE target IS NULL` + chunk 1000。pct_chg 同样是本地纯计算（不依赖外部 API）。

另一个范式：`daily-basic-pe-ttm-backfill.ts`（`updatePeTtm` L178–202），"单列幂等 WHERE IS NULL + 分块"骨架。

**⚠️ 陷阱**：`apps/server/src/migration/a-share-indicators-backfill.ts` 是**孤立/遗留脚本**（无 `package.json` 脚本登记、AGENTS.md 未提及），**别当参考范式**。官方登记的回填脚本在 `apps/server/package.json:9-11` 的 `migration:*` 三个：`csv-import` / `a-share-brick-backfill` / `daily-basic-pe-ttm-backfill`。

**CSV 导入**：`csv-import.ts`（L92–136）是历史遗留路径，实际数据走实时同步。CSV 路径 `orUpdate`（L133–135）本就比实时路径简陋（缺 close_time/trades/taker_*）。若仍可能被手动触发，理论需同步加 pct_chg，但优先级低。

## 待办清单（5 处后端 + 前端面板）

### 后端（核心，缺一则新数据/历史数据/接口任一环空值）

1. **migration 建列**：在 `apps/server/src/migration/` 新增 `*.sql` + 同名 `.ps1`（PS1 内置 docker exec，用 `$PSScriptRoot` 引同目录 SQL，参考现有 migration 对）。列定义对齐实体：`pct_chg double precision` nullable。

2. **实体加列**：`apps/server/src/entities/symbol/kline.entity.ts` 加 `@Column({ name: 'pct_chg', type: 'double precision', nullable: true }) pctChg: number | null`

3. **同步代码计算 pct_chg（关键，否则新同步数据空值）**：`sync.service.ts` 的 `syncSymbolKlines`，在 `calcIndicators` 之后/实体映射处，按 close 序列算 pct_chg 填入实体。注意：币安返回的 klineRows 按 open_time 升序，prev_close = 前一根 close；首根记 NULL。可在 `indicators.ts` 的 `calcIndicators` 里加，或在 `sync.service.ts` 单独算——**建议在 `calcIndicators` 加**（与现有指标同源，统一管理）。

4. **upsert 列表加 pct_chg（否则写不进库）**：`apps/server/src/market-data/klines/klines.service.ts:118–126` 的 `orUpdate` 数组加 `'pct_chg'`。

5. **历史数据回填脚本**：仿 `a-share-brick-backfill.ts` 新增 `apps/server/src/migration/crypto-pct-chg-backfill.ts`，按 (symbol, interval) 循环、读 close 序列、算 pct_chg、`UPDATE ... WHERE pct_chg IS NULL` 分块。在 `apps/server/package.json` 登记 `migration:crypto-pct-chg-backfill` 脚本（ts-node 直跑，参考现有三个 `migration:*` 脚本写法）。

### 后端接口透出（信息面板所需）

6. **后端 SELECT 补列**：`apps/server/src/catalog/symbols/symbols.service.ts:105–121` 的 `querySymbols` SQL 补 `k.pct_chg AS "pctChg"`（`close` 已有，`volume`/`quote_volume` 也要补——见下）。

   > **注意 amount 的语义**：klines 表无 `amount` 列，加密"成交额"对应 `quote_volume`。SQL 应写 `k.quote_volume AS "amount"`，与项目既有约定 `CRYPTO_FIELD_COL_MAP`（`strategy-conditions.types.ts:69–90`）的 `amount → k.quote_volume` 一致。`volume` 直接 `k.volume`。

7. **前端类型补字段**：`apps/web/src/api/modules/market/symbols.ts:94–98` 的 `SymbolRow` 补 `close`/`pctChg`/`volume`/`amount`（均 `string | null`）。

### 前端加密面板（对齐阶段 1 模式）

8. **新建 `apps/web/src/components/symbols/crypto/CryptoInfoFields.vue`**：照 `UsStockInfoFields.vue` 模式，4 字段（spec §3.3）：

   | label | 字段 | formatter |
   |---|---|---|
   | 现价(USDT) | `close` | `formatNumber(v,2)` |
   | 涨跌幅(%) | `pctChg` | `formatPercent` + `:trend="trendClass(row.pctChg)"` |
   | 成交量 | `volume` | `fmtCompact`（复用 klineChartUtils） |
   | 成交额 | `amount` | `formatAmount` |

   不显示 base/quote asset（quote 恒为 USDT，信息量低）。`row` 为 null 时显示 `<n-empty description="未选择标的" />`（与 A 股/美股组件一致）。

9. **新建 `CryptoInfoFields.spec.ts`**：照 `UsStockInfoFields.spec.ts`，6 用例左右（字段数/label/成交量走 fmtCompact/成交额走 formatAmount/涨跌幅着色/row null/单字段 null）。

10. **集成 `CryptoSymbolDetailPanel.vue`**：照 `UsStockDetailPanel.vue` 用 `<KlineWithInfoPanel storage-key="kline_info_panel_expanded_crypto" info-title="标的信息">` 包裹 `<kline-chart>`，info slot 注入 `<CryptoInfoFields :row="row" />`。注意加密面板结构比 A 股/美股更简单（无 `.chart-panel`/caption 层，根元素直接包 kline-chart）——读当前模板确认后再改。

## 硬约束 / 项目规范

- **Windows 11 + PowerShell**，命令禁用 `&&`，用 `;` 或多行
- **终端编码 GBK，源文件 UTF-8**：文件 I/O 显式 `encoding='utf-8'`，对象键名用英文
- **后端 `dev` 是 `nest start`（无 `--watch`，不热加载）**：改 `apps/server` 代码后**必须重启后端进程**，新改动才生效。端到端验证前确认后端跑最新代码
- **migration 格式**：`*.sql` + 同名 `.ps1` 配对（PS1 内置 `docker exec crypto-postgres psql -U cryptouser -d cryptodb`，用 `$PSScriptRoot` 引同目录 SQL）
- **回填脚本**：`ts-node` 直跑，登记到 `apps/server/package.json` 的 `migration:*` 脚本，参考现有三个
- **Vue 单文件 ≤500 行**：`pnpm --filter @cryptotrading/web lint:quant-lines`
- **子代理派发禁用 git worktree 隔离**（Windows node_modules 文件锁致 worktree remove 失败）
- **空值约定**：数值类 null 统一 `'-'`（formatter 内置）

## 验证标准

- [ ] migration 执行成功，klines 表有 `pct_chg` 列
- [ ] 同步一个加密 symbol 后，新 K 线的 pct_chg 有值（非全 NULL，首根除外）
- [ ] 历史回填脚本跑完，存量 K 线 pct_chg 有值（首根 NULL 合理）
- [ ] `GET /api/symbols/query` 返回的行含 `pctChg`/`volume`/`amount` 字段
- [ ] 加密详情面板显示信息侧栏，4 字段数字正确（非全 '-'）
- [ ] 折叠/展开、localStorage 持久化、窄屏守卫沿用 KlineWithInfoPanel（阶段 1 已实现，无需重做）
- [ ] 后端单测：`pnpm --filter @cryptotrading/server exec jest symbols`（若有 spec）+ indicators 相关
- [ ] 前端：`pnpm --filter @cryptotrading/web test` 全过、`type-check` 过、`lint:quant-lines` 过

## 前序进度 / 待续

- **阶段 1（A 股 + 美股）已完成并提交**：分支 `feat/kline-info-panel`，commit 见 `feat(symbols): K线右侧可折叠标的信息面板（A股+美股）`。共享组件 `KlineWithInfoPanel`/`InfoRow` + 两个 `*InfoFields` 已就绪，本阶段直接复用。
- **阶段 1 代码审查遗留的 Minor 项**（与本阶段无关，可独立处理）：触发按钮与 K 线 toolbar 齿轮按钮的视觉布局需真实浏览器手测确认。
- **本阶段未决问题**（开工前可自行定夺，影响小）：
  - pct_chg 计算放 `calcIndicators` 还是 `sync.service.ts` 独立算？（建议 `calcIndicators`，与现有指标同源）
  - 是否顺带给 `CRYPTO_FIELD_COL_MAP` 加 `pct_chg` 条目（让策略条件扫描支持加密涨跌幅过滤）？属增强，非本任务必需，看 scope。
