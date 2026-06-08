# 提升信号前向统计「出场模拟」阶段的速度

## 一句话目标

把 signal-stats run 的**出场模拟阶段**（`simulateSignal` 逐信号出场）从小时级降到分钟级。当前长区间 run（3.5 年、全市场、百万级信号）枚举只要 ~4 分钟，**出场模拟却要数十分钟甚至小时级**——瓶颈是逐信号 N+1 DB 查询。

> ⚠️ **交接文档，非已实现**。接手先 `/brainstorming` 敲定优化范围与口径取舍，再 `/test-driven-development`（先锁回归基线）+ 实现。**这是有数值风险的优化，必须 zero-drift 回归验证**——别直接动手。

## 问题量化（实测）

一次真实 run（J<20、3.5 年、~128 万信号）：枚举 814 个交易日用 4 分钟完成，之后出场模拟阶段 4 个并发 run 中跑了 50+ 分钟仍 3 个未完成。**出场模拟是绝对瓶颈，枚举不是。**

## 现状摸底（file:line 为证，别凭模块名猜）

出场阶段调用链：`runner.ts` 逐信号循环 → `simulator.db.ts` 每信号发多条 DB 查询 → `simulator.ts` 纯函数算结果。

### 瓶颈点

1. **逐信号串行循环（N+1 的 N）**
   - `apps/server/src/strategy-conditions/signal-stats/signal-stats.runner.ts:123-139`：`for (const signal of signals) { await this.simulator.simulateSignal(...) }`——**完全串行**，signals 量 = 百万级。

2. **每个 `simulateSignal` 串行发 3~4 条 DB 查询（N+1 的 +1，且无并发）**
   - `signal-stats.simulator.db.ts:87` `fetchQuotes`（daily_quote）
   - `:88` `fetchLimits`（stk_limit）
   - `:98` `fetchSymbol`（a_share_symbols，**静态元数据**）
   - `:94`（strategy 模式）`fetchExitSignalHits`（daily_indicator 多表 join）
   - 三/四条是**顺序 `await`，没有 `Promise.all`**。百万信号 × 3 ≈ 数百万条 SQL 串行往返。

3. **持有窗口过取（单查数据量爆炸）**
   - `signal-stats.simulator.db.ts:81`：`windowDates = sseCalendar.slice(buyIdx).filter(d => d <= dateEnd)`——**从买入日一直取到 dateEnd 的所有 SSE 交易日**（一个 2023 初的信号窗口可达 ~800 天），`fetchQuotes`/`fetchLimits` 用 `trade_date = ANY($2)` 全查回来。但 `fixed_n=1` 持有 1 天实际只用前 1~2 个可交易日（见纯函数 `decideFixedN`）。**几百倍浪费。**

4. **静态表重复查**
   - `:98` + `:203-214` `fetchSymbol` 每信号查一次 `a_share_symbols`（list_date/delist_date）。tsCode 在百万信号里大量重复，全市场只有 ~5000 个标的——**同一行被查上百次**。

### 口径基准（决定哪些优化"零漂移"安全）

纯函数 `simulator.ts:123 simulateTradeCore` 只吃「持有窗口快照序列 `days[]` + daysSinceList + delistDate + exit」，**不碰 DB**。
- `decideFixedN`（`:220-248`）：从 `days[1]` 起，遇 `hasQuote` 日 +1，数到第 N 个出场；**停牌日跳过不计额度**；推进中遇 `calDate >= delistDate` 走退市强平（`:231-238`）；窗口耗尽未凑满 → `null`（insufficient_data）。
- `decideStrategy`（`:259-288`）：同上，外加逐日 `exitSignalHit` 判定。
- **含义**：只要喂给纯函数的 `days[]` 序列与现状逐元素一致，输出 byte-identical。**改"怎么取数"而不改"取到的窗口序列" = 零口径漂移。**

## 优化方向 + 权衡（供 brainstorming）

- **方向 A（零口径漂移，强烈推荐主线）：按 ts_code 批量预取 + 内存切窗**
  1. runner 拿到 `signals` 后**按 tsCode 分组**（`signal.tsCode`/`signal.signalDate` 已具备，`runner.ts:123-131`）。
  2. 每个 tsCode **一次性**查它在 `[该 tsCode 最早 buyDate, dateEnd]` 区间的全部 `daily_quote`(qfq_open/qfq_close/open) + `stk_limit`(up_limit)，建 `Map<calDate, snapshot>`。
  3. `a_share_symbols` 全表预取一次 `Map<tsCode, {listDate, delistDate}>`（方向 D，A 的子步骤）。
  4. strategy 模式 `exitSignalHit`：按 tsCode 一次查整区间命中日集合（现 `fetchExitSignalHits:174-200` 已是单条跨日 SQL，把粒度从 per-signal 提到 per-tsCode）。
  5. `simulateSignal` 改纯内存：从预取 Map 切 `windowDates` 喂 `simulateTradeCore`，**窗口序列不变 → 结果不变**。
  - 效果：DB 查询从 `O(信号 ~128万 × 3~4)` 降到 `O(标的 ~5000 × 2~3)`，降几百倍。
  - 内存：按 tsCode 分组、处理完即释放，峰值 = 单标的一个区间的 quote（~800 行 × 几列，极小）。

- **方向 D（零漂移，A 的最小子步骤，可先独立落地）**：仅把 `fetchSymbol` 改成全表预取 Map 复用（像 `sseCalendar` 那样，`runner.ts:88` 已有预取范式）。改动最小、立竿见影去掉一条 per-signal 查询。

- **方向 C（治标，可与 A 叠加）**：runner 循环改有界并发（分批 `Promise.all`，并发度匹配 PG 连接池）；`simulateSignal` 内 3~4 查询改 `Promise.all` 并行。见效快但仍 N+1；可作为 A 落地前的过渡，或 A 之后按 tsCode 再并发。

- **方向 B（可能口径漂移，需 hash 回归才可用）：持有窗口收窄**
  - `fixed_n=N` 只取 `buyIdx` 起 `N + BUFFER` 个 SSE 交易日（BUFFER 覆盖停牌顺延）。
  - **风险**：买入后长期停牌直至退市的极端标的，收窄会把本应 `delist` 强平或正常出场的结果改成 `insufficient_data`。必须逐 bit 回归 + 选足够大的 BUFFER 让差异为零，或明确接受可解释的极端边界差异。
  - 注：方向 A 落地后，窗口大小只影响**内存切片**（极便宜），DB 不再按窗口大小付费，**B 的收益基本被 A 吃掉**——优先 A，B 多半不必做。

**推荐主线**：A（含 D），按需叠加 C。B 列为可选、默认不做。

## 开放问题（接手先与用户敲定）

1. 主线选 A（彻底批量、零漂移）还是先上 C（并发，快但治标）？两者是否都要？
2. strategy 模式（`exitSignalHit` 多表 join）是否一并按 tsCode 批量化？当前线上 run 多为 fixed_n，但模块支持 strategy。
3. 内存上界：百万信号分组后，是否需要限制"同时在内存的 tsCode 数"（流式分批）以防峰值？
4. 是否接受方向 B 的极端停牌边界差异（若要用 B）？还是坚持 zero-drift 只走 A？
5. 并发度（方向 C / A 内并行）取多少？需对齐 TypeORM 连接池大小，避免连接耗尽。

## 硬约束 / 项目规范

- **zero-drift 回归是验收前提**：方向 A/C/D 改的是"取数方式"，输出必须与优化前 byte-identical。先用 `test-driven-development` 锁基线（见验证标准），再改。
- **列名/表名以真 DB 为准**（`.claude/rules/data-integrity.md`）：`raw.daily_quote(qfq_open,qfq_close,open)`、`raw.stk_limit(up_limit)`、`public.a_share_symbols(list_date,delist_date)`、`raw.daily_indicator`（strategy join）——`simulator.ts:13-15` 注释已核实，但进 SQL 前自查真 DB 一条样本，别采信转述。
- **后端 `dev` 无 `--watch`**：改 `apps/server` 必须重启后端进程才生效；端到端前确认跑的是最新代码。
- **单文件 ≤500 行**：`simulator.db.ts` 223 行、`runner.ts` 207 行，有余量；批量预取逻辑若膨胀考虑拆 helper。
- **保护纯函数单测**：`simulateTradeCore`/`decideFixedN`/`decideStrategy` 有单测（spec 05 §5.2），优化不得改纯函数签名/语义。
- **不静默吞错**（`.claude/rules/data-integrity.md`）：批量查询返回空/缺行的处理要显式，别 `.catch(()=>[])`。

## 验证标准

1. **zero-drift 回归（核心验收）**：对同一方案，优化前后各跑一次 run，`signal_test_trade` 逐行 diff（按 ts_code+signal_date 排序对齐 ret/buyDate/exitDate/exitReason/holdDays）必须**完全一致**；聚合指标（win_rate/payoff/PF/kelly/filtered_count）逐字段相等。
   - 现成金标准基线：本次 4 个长区间 run 的 trade 输出（`kdj_j_lt_-10_2023-2026` 已完成，可直接做对照）。
2. **性能**：出场模拟阶段耗时数量级下降（小时/数十分钟 → 分钟级）；记录优化前后 wall-clock。
3. `pnpm --filter @cryptotrading/server build` 通过 + 重启；`pnpm --filter @cryptotrading/server exec jest signal-stats` 纯函数单测全绿。

## 前序进度 / 复现素材

- 本需求源于一次真实长 run：4 个方案（`kdj_j_lt_-10/0/10/20_2023-2026`，全市场、T+1 持有 1 天、区间 `20230101~20260531`，814 个 SSE 交易日）并发触发，出场模拟阶段 50+ 分钟仍未全部完成——即本文档要解决的瓶颈现场。
- 信号量梯度（复现/压测用）：J<-10 ≈ 9 万、J<0 ≈ 44 万、J<10 ≈ 88 万、J<20 ≈ 128 万信号；J<20 最重，适合做性能对照。
- 查 run 耗时：`docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT t.name, r.status, r.sample_count, r.created_at, r.completed_at, EXTRACT(EPOCH FROM (r.completed_at - r.created_at)) sec FROM signal_test_run r JOIN signal_test t ON t.id=r.test_id WHERE t.date_end='20260531' ORDER BY (t.buy_conditions->0->>'value')::numeric;"`
- 相关：前端运行状态同步问题另见 `prompts/sync-signal-stats-run-status.md`（独立需求，可并行推进）。

## 待续

接手 → `/brainstorming` 敲定 A vs C 范围与口径取舍 → `/test-driven-development` 锁 zero-drift 基线 → 实现（按 tsCode 批量预取 + 内存切窗）→ 回归 diff + 性能对照 → 完成后本文档移入 `prompts/archive/`。
