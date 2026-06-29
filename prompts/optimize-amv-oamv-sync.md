# 优化一键同步的 AMV/0AMV 计算（性能 + 架构一致性 + 清理）

> 自包含交接提示词。整段贴给全新会话 / agent 即可接手，不依赖上一会话上下文。
> **前序进度**：方案已设计完成，所有改造点已核实到 `file:line`；**代码零改动**。接手从 PR-1 开始执行。

## 一句话目标

一键同步里 AMV/0AMV（活跃市值派生指标）有性能瓶颈 + 架构不一致 + 技术债，分 **8 项优化、7 个 PR** 系统消除：个股 AMV 提速（窗口读取+多线程+增量 dirty）、0AMV 纳入统一行情管线、派生指标架构判据文档化、清理命名/文案/待核实 bug。

## 三类问题（动机）

1. **性能瓶颈**：个股 AMV（Step6）4000 股——逐股串行（无多线程）、每次全量重算目标段（不复用）、读该股全部历史进内存（只为取最后窗口）。规模相当的个股技术指标已用 worker_threads + 增量 dirty 续算，AMV 两者都没用。
2. **架构不一致**：0AMV（Step10）自连 Tushare 拉 `930903.CSI`，与统一行情管线脱节；个股 AMV 满足「嵌入行情 step」判据却独立成 step。
3. **技术债**：AMV 公式入参 `volume` 实际装成交额（命名误导）、多处步数文案写 8/10 实为 11、`ths_daily` 市值单位换算待核实（疑似 bug）。

## 项目上下文（必读）

- **monorepo**：`apps/server`（NestJS 10 + TypeORM + PostgreSQL）、`apps/web`（Vue3+Vite+Naive UI）、`apps/quant-pipeline`（Python）。详见 `CLAUDE.md`。
- **一键同步**：11 步串行编排，代码在 `apps/server/src/market-data/one-click-sync/`（`types.ts` 的 `STEP_ORDER` 是权威步骤清单）。
- **关键命令**：
  - 后端单测：`pnpm --filter @cryptotrading/server exec jest <pattern>`
  - 后端构建：`pnpm --filter @cryptotrading/server build`
  - 前端：`pnpm --filter @cryptotrading/web type-check` / `build`（动 `.vue` 必须跑 `build`，type-check 不等于 SFC 编译）
  - 查 DB（只读）：`docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "..."`
  - 起开发：`pnpm dev`（DB + server:3000 + web:5173，不含 quant worker）
- **硬规则**（`CLAUDE.md` + `.claude/rules/`）：
  - **后端 dev 是 `nest start` 无 watch**：改 `apps/server` 代码后**必须重启后端进程**才生效；e2e 前确认后端跑最新代码。
  - **Tushare 任何问题必先查 `tushare-sync-dev` skill**（接口名/字段单位/积分），禁凭记忆/历史代码推断。
  - **查 DB 用 `db-inspect` skill**（先匹配 `doc/db/quick-guide/`）。
  - **data-integrity**：进 fail-fast 断言/硬编码/migration 的事实必须落源头验证（实体/官方文档/真 DB），子代理报告 = 二手信息，不得直接进硬断言。
  - **migration**：`apps/server/src/migration/*.sql` + 同名 `.ps1` 配对（PS1 内置 docker exec，`$PSScriptRoot` 引同目录 SQL）。
  - **编码**：源文件 UTF-8；PowerShell 终端 GBK，对象键名用英文，SQL 别名用英文防乱码。
  - 单文件 ≤500 行（`apps/web/src/views/quant`、`components/quant` 由 `lint:quant-lines` 强制）。

## PR 划分 + 依赖图

```
PR-1 清理(⑦⑧⑥) ──┐
PR-2 单位核实(⑤) ──┼─ 可并行（零/低风险，互不依赖）
PR-3 窗口读取(①) ──┘
        ▼
PR-4 0AMV读本地(④) ─┐ 独立，可并行
PR-5 AMV多线程(②) ──┘
        ▼  （③ 依赖 ① 窗口模式 + ② worker pool）
PR-6 AMV增量dirty(③-a 核心算法)
        ▼  （高影响，可选决策）
PR-7 并入Step1+删Step6(③-b)
```

---

## PR-1：清理（⑦ 命名 + ⑧ 步数文案 + ⑥ 架构文档）· 零风险

### ⑦ `volume` → `amountInYuan`
`AmvSeriesInput.volume`（`apps/server/src/market-data/active-mv/active-mv.types.ts:14`）实际装成交额 `amount×1000`，命名误导。10 文件 ~20 处，纯后端（前端不引用）。
- 改名 `amountInYuan`（避免与 `amount` 冲突，表明已换算到元）。
- 涉及：`active-mv.types.ts`、`amv-formula.ts`（`:120,127,131,134`）、`stock-amv.service.ts:220,226`、`industry-amv.service.ts:394,404,413`、`sw-amv.service.ts:195,205,213`、`amv-formula.spec.ts`（多处）。

### ⑧ 步数文案 8/10 → 11
`STEP_ORDER` 实际 11 步，8 处硬编码：
- `one-click-sync/step-runners.ts:1`（10步→11）、`:3`（8个service→11）
- `one-click-sync/one-click-sync-orchestrator.service.ts:7,12,366`（10步/8步→11）
- `apps/web/src/components/sync/useOneClickSync.ts:40`（8步→11）
- `apps/web/src/api/modules/market/one-click-sync.ts:31`（0..7→0..10）、`:33`（长8→长11）
- `OneClickSyncPanel.vue:172-173` 副标题无数字错误，可保留。
- ⚠️ 若执行 PR-7，步骤数变 10，⑧ 需二次对齐（11→10）。

### ⑥ 架构判据文档
新建 `.claude/rules/derived-metrics.md`（格式参照 `.claude/rules/code-organization.md`：一级 `#`、二级 `##` 祈使句、可选 `**教训**`、无 frontmatter）。内容：派生指标何时**嵌入**行情同步收尾（单源+1:1 行级绑定+可增量，如 MA/MACD）；任一不满足（多源聚合/自拉/需全量重算）→ **独立**成 step 排在源 step 之后（如行业/概念/申万 AMV、0AMV）；同族指标可统一成组。

---

## PR-2：ths_daily 市值单位核实（⑤）· 待查证

换算点 `ths-index-daily-sync.service.ts:190-191`：`total_mv/float_mv` 按 `÷10000` → `totalMvWan/floatMvWan`（万元）。单测假设原单位是「元」，但单测假设 ≠ Tushare 真实单位。
- **必须先触发 `tushare-sync-dev` skill** 查 `ths_daily` 文档确认 `total_mv/float_mv` 原始单位。
- 是「元」→ 当前正确，PR 仅补注释/spec 澄清；是「万元」→ 多除一次（市值显示缩 10000 倍），修 `:190-191` 去掉 ÷10000 + 同步 spec。
- 影响面：前端 `formatMarketCap`（`apps/web/src/components/symbols/a-shares-index/aSharesIndexColumns.ts:142`）假设万元输入；`index_daily_quotes` 的 industry/concept 行。

---

## PR-3：个股 AMV 窗口读取优化（①）· 零风险

`stock-amv.service.ts:202` `find({tradeDate <= endDate})` 无 limit，读该股全部历史进内存，再 `slice(warmupStart)` 取最后窗口。
- 照搬 `industry-amv.service.ts:504-517` 的 `resolveWarmupStart` + SQL 窗口：新增 `resolveWarmupStart(tsCode, startDate)`（查 `raw.daily_quote` 的 `tradeDate < startDate` DESC 取前 90 行，返回最早日作 `fetchStart`）；`computeStock` 改查 `WHERE ts_code=? AND trade_date >= fetchStart AND trade_date <= endDate ORDER BY trade_date ASC`。
- **结果逐位不变**（window 等价），纯省 IO。

---

## PR-4：0AMV 改读本地（④）

### Step5 加固定源 930903.CSI
`market-index-sync.service.ts:92`：`scopeRows`（type='M'）之后合并固定额外源：
```ts
const EXTRA_OAMV_CODES = ['930903.CSI'];
const allTsCodes = [...new Set([...scopeRows.map(r=>r.tsCode), ...EXTRA_OAMV_CODES])];
// for (const tsCode of allTsCodes) { ... }
```
- **不进 `type='M'`**（避免触发 `index-weight-sync`，930903.CSI 不需权重）。
- 落库 `category='market'`，靠 `ts_code` 过滤，与现有 8 个大盘指数同表不混淆（已核实 `index_daily_quotes` 有 `amount`(千元)+OHLC，字段单位全匹配）。
- `:181` 的 `indicatorService.recalculateForSymbols` 对 930903.CSI **跳过**（0AMV 有自己的 `recomputeIndicatorsAll`）。

### OamvService 改读本地（`apps/server/src/market-data/oamv/oamv.service.ts`）
- 删 `TushareClientService` 注入（`:11,32`），加 `IndexDailyQuoteEntity` repo。
- `:163-185` 自拉 Tushare → 改查 `index_daily_quotes WHERE tsCode='930903.CSI' AND tradeDate>=fetchStartDate AND <=endDate ORDER BY tradeDate ASC`，映射成 `TushareIndexDaily[]`。
- **热身窗口（`:157-160` WARMUP_DAYS=30）保留**（算法层面 SMA/EMA 递推仍需预热）；`calc0amv` 的 `amount*1000`（`:101`）**不变**（本地 amount 也是千元）；`recomputeIndicatorsAll`（`:236`）不变。
- 数据连续性：首跑前确保 Step5 已同步 930903.CSI 历史段；保留本地无数据 warn。

---

## PR-5：个股 AMV 多线程（②）

新建 `apps/server/src/indicators/amv-worker-pool.ts` + `amv-worker.ts`（镜像 `indicator-worker-pool.ts` / `indicator-worker.ts`）。
- **新建优于泛化**：`IndicatorWorkerPool` 类型/worker 入口写死 `calcIndicatorsStreaming`，AMV 公式不同；泛化污染面更大。pool 调度（idle/busy/queue/drain/retire/自动重建）几乎照抄。
- `amv-worker.ts`：收 `{rows, seedState}` → `normalizeAmvCalcState` → `calcAmvStreaming` → postMessage；`amount×1000` 换算**在 worker 内做**（service 传原始 amount，避双换算）。
- `stock-amv.service.ts` 逐股串行 → 改用 `AmvWorkerPool.run`（并发 ≤4）。

---

## PR-6：个股 AMV 增量 dirty 续算（③-a）· 高风险核心

镜像 `apps/server/src/market-data/a-shares/services/a-shares-indicator.service.ts:74-145`（`recalculateDirtyIndicatorsForSymbol`）的 dirty+seed 模式。

### Migration（2 个，同 PR 无先后；`.sql`+`.ps1` 对）
- **A 加列** `migration/20260629XXXXXX-add-a-share-amv-sync-state.sql`：
  ```sql
  ALTER TABLE a_share_sync_states
    ADD COLUMN IF NOT EXISTS amv_dirty_from_date varchar(8),
    ADD COLUMN IF NOT EXISTS amv_calculated_to_date varchar(8);
  ```
- **B 新表** `migration/20260629XXXXXX-create-amv-calc-state.sql`（镜像 `raw.indicator_calc_state`）：
  ```sql
  CREATE TABLE IF NOT EXISTS raw.amv_calc_state (
    id bigserial PRIMARY KEY, ts_code varchar NOT NULL,
    trade_date varchar(8) NOT NULL, state jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_amv_calc_state UNIQUE (ts_code, trade_date));
  CREATE INDEX idx_amv_calc_state_ts_code ON raw.amv_calc_state(ts_code);
  ```
- 新建 `entities/raw/amv-calc-state.entity.ts`（镜像 `indicator-calc-state.entity.ts`）；`entities/a-share/a-share-sync-state.entity.ts` 加 `amvDirtyFromDate`/`amvCalculatedToDate`。

### markDirtyRanges 两段都要改（关键！漏改则 AMV 拿不到脏信号）
AMV 依赖 qfq 价，脏标记流向必须跟 indicator 完全一致。亲读确认 `a-shares/sync/a-shares-sync-dirty-ranges.ts` 两段：
- **第一段 `markDirtyRanges`（`:28-48`）**：`VALUES ($1,$2,$2)` 中 qfq/indicator 共用同一 dirtyFrom（复权因子变→全历史脏）。INSERT 列 + VALUES + ON CONFLICT 的 CASE WHEN 三处都加 `amv_dirty_from_date`（值同 `$2`）。
- **第二段 `recalculateDirtyQfqQuotesForSymbol`（`:134-156`）**：qfq 回算后清 qfq_dirty，把 dirtyFrom **传导**给 indicator/signal_rolling。同样三处加 `amv_dirty_from_date`（VALUES 用 `$2`，ON CONFLICT 用同款 CASE WHEN 传导）。

### 新建 streaming（`active-mv/amv-stream.ts`，镜像 `indicators/indicators-stream.ts`）
`AmvCalcState`（对照 `amv-formula.ts` 公式设计，已验证）：
```ts
interface AmvCalcState {
  count: number;            // seed 有效性判据（normalize count<0→null）+ 首行判断
  v1Prev: number;           // tdSma(volume,10,1) 递推前值
  recentCloses: number[];   // 最近5个close，供 v3=MA5(REF(close,1))
  emaFastPrev: number;      // tdEma(amvClose,12) 前值（DIF fast）
  emaSlowPrev: number;      // tdEma(amvClose,26) 前值（DIF slow）
  deaPrev: number;          // tdEma(DIF,9) 前值（DEA）
  prevAmvClose: number | null; // zdf[t] 需 t-1 的 amvClose
}
```
- `AmvStreamCalculator` 类（`next(row)` 推进状态，镜像 `IndicatorStreamCalculator` `:72-203`）+ `calcAmvStreaming(rows, seed)` + `normalizeAmvCalcState`（count 校验 + `num()`/`arr()` 兜底，镜像 `:46-70`）。
- **streaming 版独立实现递推**，单测保证与 `calcAmvSeries`（数组版）逐行等价。

### StockAmvService 加 dirty 入口
新增 `recalculateDirtyAmvForSymbols(tsCodes, onProgress)`（镜像 `recalculateDirtyIndicatorsForSymbols`，含 worker pool 并发）：读 `amv_dirty_from_date` → 取 `raw.amv_calc_state` 中 `trade_date < dirtyFrom` 的最后一行 seed → 窗口加载（复用 ①）→ `calcAmvStreaming` 续算 → 只保留 `>= dirtyFrom` 的行 upsert `stock_amv_daily` + 稀疏 checkpoint 写 `amv_calc_state` → 清 `amv_dirty_from_date`、更新 `amv_calculated_to_date`。复用 `a-shares-indicator.service.ts` 的 `upsertInChunks`/`createSparseCalcStateEntities` 模式。

> 此 PR **不改步骤结构**：Step6 仍在，内部 `syncStock` 改调 `recalculateDirtyAmvForSymbols`（全量回填=所有股脏；增量=只算脏股）。

---

## PR-7：并入 Step1 + 删 Step6（③-b）· 高影响，可选决策

**建议 PR-6 验证 dirty 算法正确后再决定。**
- **并入理由**：③ 完成后个股 AMV 的 dirty 信号同源于 `a_share_sync_states`（daily_quote 变动），与 indicators/signal_rolling 同源，满足⑥判据「嵌入」三条件。Step6 独立反而违背判据。
- **接入**：`a-shares-sync.service.ts:251`（indicator dirty 重算后、signal_rolling 前）插入 `await this.stockAmvService.recalculateDirtyAmvForSymbols([...changedRanges.keys()])`，注入 `StockAmvService`。
- **删 Step6**：`one-click-sync/types.ts`（`OneClickStepKey`/`STEP_ORDER` 移除 `'stock-amv'`）、`step-runners.ts`（删 `runStockAmv`）、`orchestrator.service.ts`（`STEP_RUNNERS` 移除，11→10）、`orchestrator.service.spec.ts`（索引修正）、前端 `useOneClickSync.ts`。⑧ 文案二次对齐（11→10）。
- 保守选项：保留 Step6 内部转调 dirty（即 PR-6 形态），跳过 PR-7。

---

## 复用的现有设施（带路径，禁重复造轮子）

| 设施 | 路径 | 用于 |
|---|---|---|
| `IndicatorWorkerPool` 调度模式 | `apps/server/src/indicators/indicator-worker-pool.ts` | ② AmvWorkerPool 镜像 |
| `calcIndicatorsStreaming`/`IndicatorStreamCalculator`/`normalizeIndicatorCalcState` | `apps/server/src/indicators/indicators-stream.ts` | ③ streaming 镜像 |
| `recalculateDirtyIndicatorsForSymbol` 模板 | `apps/server/src/market-data/a-shares/services/a-shares-indicator.service.ts:74-145` | ③ dirty 续算照搬 |
| `resolveWarmupStart` + SQL 窗口 | `apps/server/src/market-data/active-mv/industry-amv.service.ts:504-517` | ① 窗口读取 |
| `markDirtyRanges` 两段脏标记 | `apps/server/src/market-data/a-shares/sync/a-shares-sync-dirty-ranges.ts:19-50,134-156` | ③ 扩展 amv_dirty |
| `raw.indicator_calc_state` 表结构 | `apps/server/src/entities/raw/indicator-calc-state.entity.ts` | ③ raw.amv_calc_state 镜像 |
| `upsertInChunks`/稀疏 checkpoint | `a-shares-indicator.service.ts:271-299,255-269` | ③ 落库 |
| `calcAmvSeries/calcMacd/calcSignal/calcZdf` | `apps/server/src/market-data/active-mv/amv-formula.ts` | 公式内核（streaming 据此实现） |

## 风险点

| 风险 | 缓解 |
|---|---|
| ③ 递推 state 正确性 → AMV 数值与全量不等 | 单测：`calcAmvStreaming(全量)` == `calcAmvSeries(全量)` 逐行；seed 续算 == 全量切片；改前改后 DB full outer join 逐位 0 差异 |
| markDirtyRanges 两段漏改 → qfq 回算后 AMV 拿不到脏信号 | grep 确认两段 SQL 都加 amv_dirty；真机触发复权变动验证 AMV 随之更新 |
| PR-7 改 11→10 步结构 → 索引错位/spec 失败/前后端不一致 | PR-7 同步改后端 types/orchestrator/step-runners + 前端 + spec；⑧ 二次对齐 |
| ④ 0AMV 改读本地数据连续性 | 首跑前确保 Step5 已同步 930903.CSI；保留本地无数据 warn |
| ⑤ 单位 bug | tushare-sync-dev 查证后定方案 |
| ⑦ 改名漏改 → 编译失败 | 全量 grep + `pnpm --filter @cryptotrading/server build` + active-mv spec |
| amv-worker 内 amount×1000 双换算 | worker 内统一换算，service 传原始 amount，单测固化 |

## 验证标准（端到端）

每个 PR 合并前至少跑对应验证；后端改动**必须重启后端进程**才生效。

- **PR-3/①（数值等价，关键）**：改前全市场同步导出 `stock_amv_daily`，改后再跑，双方 full outer join 断言所有列（amvOpen/High/Low/Close/Dif/Dea/Macd/Zdf/signal）逐位相等。
- **PR-6/③（最严格）**：
  - 单测：`calcAmvStreaming(rows[0..N])` 全量 vs `calcAmvStreaming(rows[k..N], seed=state[k-1])` 逐行 row 相等；`normalizeAmvCalcState(null)===null`、`{count:-1}===null`。
  - DB 等价：改前（全量）跑一次导出，改后（dirty）跑一次，full outer join **0 差异**才通过。
  - 真机：触发 daily_quote 小范围改动，确认只重算 dirty 范围（日志 `K symbols, dirty from T`），`amv_calc_state` 有新 checkpoint。
- **PR-4/④**：改前 Tushare 跑一次导出 `oamv_daily`，改后读本地再算，逐位对比；`SELECT count(*) FROM index_daily_quotes WHERE ts_code='930903.CSI'` > 0；一键同步 Step5→Step10 正常产出。
- **PR-2/⑤**：tushare-sync-dev 查文档；取一个行业指数对比 Tushare 原始返回与 `index_daily_quotes.total_mv_wan`。
- **真机一键同步**（PR-5/⑥/⑦ 后）：`pnpm dev`，前端「一键同步」跑一轮，观察各 step 进度/耗时/成功率；DB 抽查 `stock_amv_daily`/`oamv_daily`/`amv_calc_state` 落库正常。

## 前序进度

- 方案设计完成；所有改造点已核实到 `file:line`（含 `markDirtyRanges` 两段 SQL、`AmvCalcState` 结构、`index_daily_quotes` 字段单位）。
- **代码零改动**。
- 关联：原计划文件 `C:\Users\Lucifer\.claude\plans\virtual-jingling-donut.md`（同内容，本 handoff 的来源）。
- 建议执行顺序：PR-1 → (PR-2/3/4 并行) → PR-5 → PR-6 → PR-7。
