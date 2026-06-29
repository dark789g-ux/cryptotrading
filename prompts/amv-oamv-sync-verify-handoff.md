# AMV/0AMV 同步优化 — 真机验证 + 剩余交接（PR-1~6 → PR-7）

> 自包含交接提示词。`optimize-amv-oamv-sync.md` 的执行进度：**PR-1~5 全部完成 + PR-6 基础设施完成**，代码 + 单测 + schema 就绪；剩余 PR-6 的 syncStock 接入 + PR-7 + 端到端真机验证。
> 接手者先跑「真机验证清单」确认 PR-1~5 + PR-6 基础设施，再做「剩余工作」。

## 一句话状态

PR-1（清理）、PR-2（单位核实）、PR-3（窗口读取）、PR-4（0AMV 读本地）、PR-5（多线程）**代码 + 单测完成**；PR-6 dirty 基础设施（migration 已执行 / entity / markDirtyRanges 两段 / amv-stream 逐行等价 / recalculateDirtyAmvForSymbols）完成，但 **syncStock 改调 dirty 的接入未做**（文档要求），recalculateDirtyAmvForSymbols 当前 orphan。PR-7 待 PR-6 完整后定。

## 已完成清单（代码层）

| PR | 改动 | 验证 |
|---|---|---|
| PR-1 | ⑦ `volume→amountInYuan`（6 文件，grep 0 残留）；⑧ 步数文案 8/10→11（纠正：step-runners:3「8 个 service」实测 8 个不改、SSE 0-5→0-4、普通 5-9→5-10）；⑥ 新建 `.claude/rules/derived-metrics.md` | build ✓ / active-mv 44 测试 ✓ / 前端 type-check ✓ |
| PR-2 | `tushare-sync-dev` 查证 `ths_daily` total_mv/float_mv 单位为**元**，÷10000 换算正确，补核实注释（doc 260） | — |
| PR-3 | `stock-amv.resolveWarmupStart` + `Between(fetchStart,endDate)`，去全量读+内存 slice | build ✓ / 44 测试 ✓（逻辑等价，真机 full outer join 待验） |
| PR-4 | Step5 `market-index-sync` 加 `EXTRA_OAMV_CODES=['930903.CSI']`（不进 type='M'，落 category='market'，indicator 重算跳过）；`OamvService` 删 TushareClientService 改注入 `IndexDailyQuoteEntity`，读本地 `index_daily_quotes`；OamvModule forFeature + 删 TushareClientService provider | build ✓ / oamv 22 测试 ✓ |
| PR-5 | 新建 `indicators/amv-worker.ts` + `amv-worker-pool.ts`（镜像 indicator-worker）；`active-mv/amv-stream.ts`（AmvCalcState/calcAmvStreaming/normalizeAmvCalcState，与数组版逐行等价）；`stock-amv.syncStock` 改 batch Promise.all 并发 + AmvWorkerPool；computeStock 用 pool.run | build ✓ / **amv-stream 12 测试逐行等价（全量+seed+JSON往返）✓** / amv 101 测试 ✓ |
| PR-6 基础设施 | migration `20260629120000-add-a-share-amv-sync-state`（加 amv_dirty_from_date/amv_calculated_to_date）+ `20260629120100-create-amv-calc-state`（raw.amv_calc_state）**已执行，schema 就位**；entity AmvCalcStateEntity + a-share-sync-state 加列；`a-shares-sync-dirty-ranges.ts` markDirtyRanges **两段**都加 amv_dirty_from_date（CASE 传导）；stock-amv `recalculateDirtyAmvForSymbols`+`recalculateDirtyAmvForSymbol`+`loadAmvQuoteRows`（镜像 indicator dirty）；ActiveMvModule forFeature AmvCalcStateEntity | build ✓ / amv 101 测试 ✓ / stock-amv 465 行（<500） |

## 真机验证清单（自己跑）

**准备**：DB 已起（crypto-postgres healthy）；PR-6 migration 已执行；`pnpm dev`（DB+server:3000+web:5173；后端 nest start 无 watch，当前代码已是最新，直接起即可）。

### V1：PR-5 worker + PR-3 数值等价（个股 AMV）
- **操作**：前端「个股 AMV 同步」选 3-5 只股，增量同步近期（如近 5 交易日）。或 `POST /api/active-mv/stock/sync {tsCodes:[...], startDate, endDate, syncMode:'incremental'}`。
- **后端日志预期**：`syncStock 开始：N 股，mode=incremental` → 无 worker error/unhandled rejection → `syncStock 完成：落库 X 行`。
- **DB 对比改前基线**（stock_amv_daily 原 1421518 行）：
  ```sql
  SELECT ts_code, trade_date, amv_close, amv_dif, amv_dea, amv_macd, signal
    FROM stock_amv_daily WHERE ts_code IN ('000001.SZ','600000.SH')
    ORDER BY trade_date DESC LIMIT 10;
  ```
- **判据**：数值与改前基线逐位一致（PR-3 窗口等价）。**不一致 → PR-3/5 bug，优先排查 amv-stream 与 resolveWarmupStart**。

### V2：PR-4 0AMV 读本地（关键前提：先同步 930903.CSI）
- **前提**：当前 `index_daily_quotes` 的 930903.CSI = **0 行**，必须先 Step5 同步。
- **操作**：一键同步跑到 Step5（market-index-daily，已加 EXTRA_OAMV_CODES）。然后 Step10（oamv）。
- **DB 检查**：
  ```sql
  SELECT count(*), min(trade_date), max(trade_date) FROM index_daily_quotes WHERE ts_code='930903.CSI';  -- 预期 >0
  SELECT count(*), max(trade_date) FROM oamv_daily;  -- 预期更新到最新交易日
  ```
- **日志预期**：`从本地 index_daily_quotes 读到 N 条 930903.CSI 数据`；**无** `0AMV 本地无数据` warn。
- **判据**：oamv_daily 有新数据；与改前 Tushare 直拉的 0AMV（若有基线）逐位对比。

### V3：PR-6 基础设施（表 + markDirtyRanges 标脏）
- **表/列**（migration 已执行，应就位）：
  ```sql
  SELECT count(*) FROM raw.amv_calc_state;  -- 0（dirty 首跑前）
  SELECT count(*) FROM a_share_sync_states WHERE amv_dirty_from_date IS NOT NULL;  -- 0（无复权变动前）
  ```
- **markDirtyRanges 标脏**（触发复权因子变动：跑 a-shares 同步 + 某股 adj_factor 变动）：
  ```sql
  SELECT ts_code, amv_dirty_from_date, indicator_dirty_from_date FROM a_share_sync_states
    WHERE amv_dirty_from_date IS NOT NULL LIMIT 10;
  ```
- **判据**：复权变动的股 amv_dirty_from_date 与 indicator_dirty_from_date **同源同值**（markDirtyRanges 两段都加了 amv_dirty）。
- **dirty 触发**：syncStock incremental 已走 `recalculateDirtyAmvForSymbols`（剩余 1 完成）。一键同步流：Step1(a-shares) 的 markDirtyRanges 标 amv_dirty → Step6(syncStock incremental) 续算。独立调 syncStock incremental 时需先有 amv_dirty 标记（跑过 a-shares 同步）。

## 剩余工作

### ✅ 剩余 1：PR-6 syncStock 接入（已完成）
`stock-amv.syncStock` 已接入 dirty（**保留方案**，未删 PR-3/5）：
- **全量（overwrite）**：`computeStock`（PR-3① 窗口 + PR-5② pool），所有股重算覆盖。
- **增量（incremental）**：`recalculateDirtyAmvForSymbols(tsCodes)`（PR-6③-a dirty 续算，只算 amv_dirty_from_date 非空）。
- **data-integrity**：`recalculateDirtyAmvForSymbol` 返回 `{count, status:'synced'|'empty'|'not_dirty'}`；`recalculateDirtyAmvForSymbols` 返回 `{synced, failedItems}`（单股 catch 透出，不拖垮整批）；syncStock 对齐 AmvSyncResult。
- 验证：build ✓ / amv 101 测试 ✓ / stock-amv 472 行。syncStock 无单测，靠真机 V1/V3。

### ✅ 剩余 2：PR-7（已完成）
用户决定直接做（跳过真机预验证，风险已知）。实际改动：
- **接入**：`ActiveMvService` 加 `recalculateDirtyStockAmv` 委托；`a-shares-sync.service.ts` 注入 `ActiveMvService`，在 indicator/signal_rolling dirty 后调 `recalculateDirtyStockAmv([...changedRanges.keys()])`（catch → `amv_recalculate` failedItem）；`a-shares.module.ts` import `ActiveMvModule`（无循环依赖）。
- **删 Step6**：`types.ts`（STEP_ORDER/OneClickStepKey 移除 'stock-amv'，11→10）、`step-runners.ts`（删 runStockAmv + Step6-8 注释改）、`orchestrator.service.ts`（STEP_RUNNERS/import 移除）、`orchestrator.service.spec.ts`（新 Step6=industry-amv / Step9=oamv；"普通步骤抛错" test 改用 syncIndustry；多处 11→10 / statuses[10]→[9] / Array(10)→Array(9)）。
- **⑧ 二次对齐 11→10**：step-runners / orchestrator / useOneClickSync / one-click-sync 全部。
- 验证：build ✓ / orchestrator 15 测试 ✓ / 前端 type-check ✓。
- ⚠️ **真机待验（V4）**：一键同步跑 10 步（无 Step6）+ Step1(a-shares) 收尾触发 AMV dirty（`SELECT count(*) FROM raw.amv_calc_state` 增长 + stock_amv_daily 更新 + amv_dirty_from_date 清 NULL）+ 前端面板显示 10 步。

## 复用设施（带路径，禁重复造轮子）

| 设施 | 路径 | 用于 |
|---|---|---|
| `recalculateDirtyIndicatorsForSymbol` 模板 | `a-shares/services/a-shares-indicator.service.ts:74-145` | 剩余 1 syncStock dirty 接入 |
| `IndicatorWorkerPool` 调度 | `indicators/indicator-worker-pool.ts` | 已镜像为 AmvWorkerPool |
| `calcAmvStreaming`/`normalizeAmvCalcState` | `active-mv/amv-stream.ts` | streaming 逐行等价已锁 |
| markDirtyRanges 两段 | `a-shares/sync/a-shares-sync-dirty-ranges.ts:19-50,65-157` | 已加 amv_dirty |

## 风险点（真机重点观察）

| 风险 | 验证 |
|---|---|
| PR-5 worker 运行时（pool 调度/通信/NaN 序列化）崩溃 | V1 日志无 worker error |
| PR-3 窗口数值偏 | V1 对比基线逐位 |
| PR-4 930903.CSI 未同步 → 0AMV 读空 | V2 先 Step5 |
| PR-6 markDirtyRanges 两段漏 amv_dirty | V3 复权变动后 amv_dirty 非空 |
| amv-stream 与数组版不等价 | **已由 amv-stream.spec 12 测试锁死（全量+seed+JSON 往返）** |

## 关联

- 原计划：`prompts/optimize-amv-oamv-sync.md`（本 handoff 的来源 + 完整 PR 划分）。
- 核心规范：`CLAUDE.md` + `.claude/rules/`（data-integrity、derived-metrics⑥）。
