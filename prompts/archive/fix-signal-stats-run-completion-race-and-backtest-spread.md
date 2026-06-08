# 收尾：signal-stats run「完成早于落库」竞态 + backtest report 大数组 spread 防御

## 一句话目标

处理 2026-06-09 signal-stats 栈溢出 hotfix（commit `6a3bd7e`）当时**有意未做**的两条尾巴：
- **任务 A（主，值得做）**：`signal-stats.runner.ts` 把 run 标 `completed` 排在「分批插 40 万逐笔 trade」**之前**，导致 run 标完成的瞬间 `signal_test_trade` 仍在写——刚完成就开详情会读到**部分** trade / 部分直方图；且插入中途失败还会把已 `completed` 的 run **翻成 `failed`**。
- **任务 B（次，防御性、实际不可达）**：`backtest/engine/report.ts:196-197` 有与已修 bug 同款的 `Math.max/min(...returns)` spread 反模式，但 `returns` 是**单只标的**的持仓收益数组，规模极小、实际触不到 V8 实参上限；修它纯为一致性 + 杜绝未来踩坑。

两条互相独立，可分别做 / 分别跳过，也可分别提交。**别把 B 的低危说成高危**——它不是活跃 bug。

## 背景（怎么来的）

2026-06-09 用 `/systematic-debugging` 修了 signal-stats 大样本聚合/直方图 `Math.min/max(...rets)` 栈溢出（两处改 for 线性扫描，commit `6a3bd7e`；真机 e2e 全过，run `18fab52f` 跑通 402257 样本）。修复过程中**全局复扫**额外发现这两处，按「不捆绑无关改动」原则当时未动，落此交接。原始 bug 交接已在 `prompts/archive/fix-signal-stats-metrics-histogram-stack-overflow.md`。

---

## 任务 A：run「完成早于落库」竞态

### 现状摸底（file:line 为证，已核对真代码）

`apps/server/src/strategy-conditions/signal-stats/signal-stats.runner.ts`，`doExecute` 主路径（**非空数据**分支）：

1. `:150-153` 聚合：`const rets = trades.map(t=>t.ret)` → `calcSignalStats(rets, holdDays)`。
2. `:157-172` **先**落库标完成：
   ```ts
   await this.runRepo.update(runId, {
     status: 'completed',
     progressScanned: total,
     sampleCount: stats.sampleCount,   // 402257
     winRate: ..., bestTradeRet: ..., worstTradeRet: ...,
     filteredCount, completedAt: new Date(),
   });
   ```
3. `:175-177` **后**才插逐笔：`if (trades.length > 0) await this.insertTradesBatched(runId, trades);`
4. `:186-206` `insertTradesBatched`：`BATCH=200`，逐批 `tradeRepo.save(entities)`（40 万 ≈ 2011 批，串行往返，实测要数十秒）。

### 两个具体危害（本会话真机实测到）

1. **详情读部分数据**：run 在 `:157` 即变 `completed`；前端 store 轮询 `GET /:id/run/progress`（`signal-stats.controller.ts:89`）见 `completed` 就停轮询、读 `latestRun`、详情再拉 `ret-histogram` / `trades`。这些接口都从 `signal_test_trade` 现读，插入未完即返回**部分**结果。
   - 本会话证据：run 标 `completed` 后某瞬间 `signal_test_trade` 仅 226600 行、`ret-histogram` 返 `sampleCount=238600`（均 < run 行 `sample_count=402257`），待插完才稳定到 402257、直方图 range 才扩到含 best=72.7%。
2. **late-insert 失败会把 completed 翻 failed**：`insertTradesBatched` 在 `executeRun` 的 try 内（`:56-66`）。若插入中途抛错（DB/连接），catch 会 `runRepo.update(runId, {status:'failed', errorMessage})`——但此时 run 已是 `completed`（`:157` 写过）。于是「已完成」的 run 莫名变「失败」，且已有部分 trade 残留。

### 已定方向（reorder，待 brainstorming 敲细节）

**核心**：把「插 trade」挪到「标 completed」**之前**，让 `completed` 成为「数据已全部落库」的真信号。metrics 与 trade 之间无依赖，reorder 安全。reorder 同时消灭危害 2（插入失败时 run 仍是 `running`，catch 再标 `failed`，不会出现 completed→failed 跳变）。

最小改法（示意，非强制）：
```ts
// 6. 聚合（不变）
const stats = calcSignalStats(rets, holdDays);
// 7. 先插逐笔（原 :175-177 提前）
if (trades.length > 0) await this.insertTradesBatched(runId, trades);
// 8. 再标完成 + 落 metrics（原 :157-172 后移）
await this.runRepo.update(runId, { status:'completed', sampleCount: ..., ...metrics, completedAt: new Date() });
```

### 待敲定的开放问题（建议先 brainstorming）

1. **「running」尾巴变长可接受吗**：reorder 后，枚举+模拟到 `822/822` 后还要等数十秒插完才翻 `completed`，这段 run 一直显示 `running`/`822/822`。是否要给插入加**子进度**（如新增 `progress_inserted` 或复用某字段，前端显示「正在写入明细 X/Y」），还是「多等几十秒、状态更诚实」即可、不加 UI？倾向后者（最简），但要确认产品口径。
2. **原子性要到什么程度**：是否需要把「插 trade + 标 completed」包进一个 DB 事务（`queryRunner.startTransaction`），保证「completed ⇔ 全量 trade 在库」严格成立？还是 reorder 的「先插后标」已够（completed 时 trade 必全在，唯一残留是 failed 时的部分 trade，可在 catch 里顺手 `DELETE FROM signal_test_trade WHERE run_id=:id` 清理）？倾向「reorder + catch 清理残留」，事务对 40 万行批量插入可能放大锁/回滚成本——需权衡。
3. **前端是否需要任何配合**：reorder 后理论上无需动前端（completed 时数据已齐）。但要**真机复核**前端轮询/拉取时序确无别的早读路径（如详情弹窗有没有在 `running` 态也允许打开读 trade）。

### 验证标准（任务 A）

1. 后端单测：runner spec（`signal-stats.runner.spec.ts`）加 case 断言 `insertTradesBatched` 在 `runRepo.update({status:'completed'})` **之前**被调用（mock 调用顺序断言）。原有 runner 单测全绿。
2. `pnpm --filter @cryptotrading/server build` 绿。
3. **重启后端**后真机重跑大样本（可复用方案 `kdj_j_lt_0_e2e_long`，testId `15c7a18e-cfc0-42f3-ae89-dcdba15f52d8`；或新建同档区间方案，**别覆盖金标准**见下）：在 run 刚翻 `completed` 的**第一时间**查 `SELECT count(*) FROM signal_test_trade WHERE run_id=<新runId>` —— 应**当场等于** `sample_count`，不再出现「completed 但 trade 还在涨」。
4. 故障注入（可选但推荐）：临时让某批 insert 抛错，确认 run 落 `failed`（而非先 completed 再翻 failed），且无半截 trade 残留（若采纳 catch 清理）。

---

## 任务 B：backtest report 大数组 spread 防御（低优先级）

### 现状摸底（file:line 为证，已核对真代码）

`apps/server/src/backtest/engine/report.ts`，按标的聚合 `symList` 的循环内：
- `:194` `const returns = positions.map((p) => p.returnPct);` —— `positions` 是 `symDict.get(symbol)`，即**单只标的**的持仓汇总数组。
- `:196-197`
  ```ts
  const bestReturn = returns.length ? Math.max(...returns) : 0;
  const worstReturn = returns.length ? Math.min(...returns) : 0;
  ```

### 风险评估（诚实定性：实际不可达）

`returns` 已按 `symbol` 分组，长度 = 单只标的在一次回测里的**持仓笔数**。单标的持仓数破 ~12.5 万（V8 实参上限）实际不可能（等于一只股票被开平仓 12 万次）。**这不是活跃 bug**，与 signal-stats 那处「全市场 44 万逐笔一把 spread」性质不同。修它的价值仅在：① 与 `6a3bd7e` 的修法保持一致；② 杜绝未来若有人改成「全标的 returns 一把 max」时踩坑。

### 已定方向

两处改 for 线性扫描（同 `6a3bd7e` 的 metrics/histogram 改法）。`returns.length` 已有三元 guard，`returns[0]` 在非空分支必存在。

### 顺带要做（比改这两行更重要）

**全局复扫 `apps/server/src/backtest/`**（乃至全 `src/`）确认没有真正 O(trades/positions) 量级的 spread 漏网。本会话已扫过一轮、结论是 backtest 里 `push(...arr)`（`engine.ts` / `position-handler.ts` / `engine.position-processing.ts` 多处）的 arr 均为**单 bar / 单持仓**量级有界小数组、安全；但接手后请**自己再扫一遍**确认（pattern：`Math.max/min(...`、`.push(...`、`.apply(`、`.concat(...`、`fromCharCode(...`），任何对「O(回测全量 trade)」数组 spread 进函数的写法才是真隐患。

### 验证标准（任务 B）

1. 复扫无遗漏（贴出 grep 命中与逐条「有界/无界」判定）。
2. report.ts 两处改 for 后，回测相关单测全绿（`pnpm --filter @cryptotrading/server exec jest backtest`）。
3. `pnpm --filter @cryptotrading/server build` 绿。
4.（可选）跑一次正常回测，确认 `bestReturn/worstReturn` 数值与改前一致。

---

## 硬约束 / 项目规范（两任务通用）

- **改后端必须重启后端**：`pnpm dev` 的后端是 `nest start`（**无 `--watch`**），改完不重启则旧逻辑仍在跑，真机验证会假象未生效。当前后端是上一会话手动起的 `node dist/.../main` 后台进程，按需重启。
- **源文件 UTF-8**；对象键名用英文（防 PowerShell GBK 裸中文键名报错）。
- **single-file ≤500 行**：两处都只改函数体 / 调换语句顺序，不涉及拆分。
- **别覆盖金标准**：方案 `kdj_j_lt_-10_2023-2026` 的 run `06239e89-38b6-4189-8b98-4ef53220ae09`（80276 样本）是基准，勿重跑/覆盖。
- **别动孤儿 running**：`kdj_j_lt_20` / `kdj_j_lt_10`（`*_2023-2026`）卡「运行中」是另一交接 `sync-signal-stats-run-status.md` 的 DB 状态问题，与本任务无关。
- 单测：`pnpm --filter @cryptotrading/server exec jest signal-stats.runner`（A）/ `jest backtest`（B）。构建：`pnpm --filter @cryptotrading/server build`。
- 提交：A 用 `fix(signal-stats): …`，B 用 `fix(backtest): …` 或 `refactor(backtest): …`；**分开提交**（两任务独立）。

## 前序进度 / 现有数据

- signal-stats 栈溢出 hotfix 已合本地 main：`6a3bd7e`（代码）+ `6b9ce03`（交接归档）。**本地 main 领先 origin/main，未推 origin**。
- 可复用：方案 `kdj_j_lt_0_e2e_long`（testId `15c7a18e-cfc0-42f3-ae89-dcdba15f52d8`）已有成功 run `18fab52f-f20e-4776-bd12-f8f2d0fade5e`（402257 trade 在库）；任务 A 真机验证可直接对它再点「运行」复现/对比。
- 完成后将本文档移入 `prompts/archive/`。
