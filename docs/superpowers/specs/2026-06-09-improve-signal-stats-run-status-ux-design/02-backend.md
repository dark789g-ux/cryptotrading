# 02 · 后端改动

← 返回 [index.md](./index.md) ｜ 上一篇 [01-overview-and-data-flow.md](./01-overview-and-data-flow.md)

涉及 4 个源文件 + 1 对 migration。范围：实体加 `phase` 列、simulator 加进度回调、runner 三阶段节流上报、后端单测。**不改模拟/聚合口径**（zero-drift 不受影响）。

## 1. 实体：`signal-test-run.entity.ts`

在 `progress_total`（`:25-26`）后加一列：

```ts
@Column({ type: 'varchar', length: 16, nullable: true, name: 'phase' })
phase: 'scanning' | 'simulating' | 'writing' | null;
```

- 默认 `nullable`（存量行 = NULL = 无阶段信息，前端降级）。
- 该实体已在 `app.module` 根 `entities` 数组 + module `forFeature` 注册（加列不涉及新增实体，无双注册问题）。

## 2. Migration：`20260609_signal_test_run_phase.{sql,ps1}`

命名沿用近期风格（`20260608_signal_test_run_best_trade_ret.*`）。**无需回填**（phase 仅运行态有意义，存量 run 均已终态）。

### `20260609_signal_test_run_phase.sql`
```sql
-- =====================================================================
-- 20260609_signal_test_run_phase.sql
-- Add phase column to signal_test_run (running-state stage marker).
-- Idempotent: ADD COLUMN IF NOT EXISTS. No backfill (legacy runs are
-- all terminal; phase only matters while status='running').
-- =====================================================================
ALTER TABLE signal_test_run ADD COLUMN IF NOT EXISTS phase varchar(16);
```

### `20260609_signal_test_run_phase.ps1`
结构对齐 `20260608_signal_test_run_best_trade_ret.ps1`：`$ErrorActionPreference="Stop"` → `Get-Content -Raw -Encoding utf8 $sql | docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -` → 验证列存在（`information_schema.columns ... column_name='phase'` 应 =1）→ 断言失败则 `throw`。

> **schema 变更须重启 server**（`synchronize:false`，且后端 `dev` 无 `--watch`）：跑完 migration 后重启后端进程，新列才被实体识别。

## 3. simulator：`signal-stats.simulator.db.ts` 加进度回调

`BatchSimulateParams`（`:42-54`）加一个**可选同步回调**：

```ts
export interface BatchSimulateParams {
  // ...existing...
  /** 每个 tsCode 组模拟完成时回调，参数=该组信号数。用于上报模拟阶段进度（可选）。 */
  onGroupDone?: (groupSize: number) => void;
}
```

在 `perTsCode`（`:94-204`）**return 前**调用一次——两个 return 点（`:130` 全组无效信号早退、`:203` 正常产出）都要覆盖。最简：在 `perTsCode` 体首尾包一层，或在 `mapWithConcurrency` 的 `fn` 包装里调：

```ts
const perTsCodeWithProgress = async (tsCode: string): Promise<SimulationOutcome[]> => {
  const out = await perTsCode(tsCode);
  params.onGroupDone?.(groups.get(tsCode)!.length);  // 同步、纯内存，不 await DB
  return out;
};
const grouped = await mapWithConcurrency(tsCodes, concurrency, perTsCodeWithProgress);
```

- **纯同步回调**，不在此处碰 DB（DB 节流上报由 runner 负责），故**不引入并发 update 乱序、不改模拟口径**。
- `mapWithConcurrency` 本身**不动**（回调挂在传入的 `fn` 里）。

## 4. runner：三阶段节流上报

`doExecute`（`:77-202`）按下述改造。新增一个**节流封装**避免高频 `runRepo.update`。

### 4a. 节流封装（runner 私有方法）
```ts
/** 每个阶段一个。report() 仅记内存；start() 起 ~1.5s 节流 flush；stop() 清 timer + 最终矫正。 */
private makePhaseProgress(runId: string, intervalMs = 1500) {
  let current = 0;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const flush = async () => {
    if (inFlight) return;            // 防上一个 update 未完又起
    inFlight = true;
    try { await this.runRepo.update(runId, { progressScanned: current }); }
    finally { inFlight = false; }
  };
  return {
    bump: (n: number) => { current += n; },
    start: () => { timer = setInterval(() => { void flush(); }, intervalMs); },
    stop: async () => { if (timer) clearInterval(timer); await this.runRepo.update(runId, { progressScanned: current }); },
  };
}
```
> `Date.now()`/`setInterval` 在 NestJS 运行时正常可用（Workflow 脚本的限制不适用于业务代码）。
>
> **已知权衡（无需实现者修复，别过度设计）**：① 若某次 `update` 耗时 > `intervalMs`，下一轮 flush 因 `inFlight` 被跳过、再下一轮补上（进度短暂停跳，最终矫正）；② `stop()` 的 `clearInterval` 不取消已在途的 flush，故 `stop()` 的最终 `update` 可能与最后一次在途 flush **并发写同一列 `progressScanned`**——两者写同一字段、`stop()` 写的是阶段终值（= 该阶段 total），最终一致、无逻辑错误。接受此权衡，不要为它加锁/队列。

### 4b. 三阶段接线（doExecute 内）
- **step1 起**（`:80-83` 之后）：`await this.runRepo.update(runId, { phase: 'scanning' });`（`progressTotal` 已设交易日数）。
- **step5 前**（`:135` 处）：
  ```ts
  await this.runRepo.update(runId, { phase: 'simulating', progressTotal: signals.length, progressScanned: 0 });
  const sim = this.makePhaseProgress(runId);
  sim.start();
  let outcomes: SimulationOutcome[];
  try {
    outcomes = await this.simulator.simulateSignalsBatched({
      signals, exit,
      exitConditions: exitMode === 'strategy' ? (exitConditions ?? []) : null,
      sseCalendar, dateEnd,
      onGroupDone: (groupSize) => sim.bump(groupSize),
    });
  } finally {
    await sim.stop();          // 清 timer + 最终矫正到 signals.length
  }
  ```
- **step7 前**（`:171` 处）：进入写库阶段，把行数当 done/total。改 `insertTradesBatched` 让它上报：
  ```ts
  if (trades.length > 0) {
    await this.runRepo.update(runId, { phase: 'writing', progressTotal: trades.length, progressScanned: 0 });
    await this.insertTradesBatched(runId, trades);   // 内部每 N 批 update progressScanned
  }
  ```
  `insertTradesBatched`（`:205-225`）循环里累加并节流上报（写库批数有限，直接每 `FLUSH_EVERY` 批 `await update` 即可，无需 setInterval）：
  ```ts
  const BATCH = 200, FLUSH_EVERY = 10;   // 每 2000 行 flush 一次
  let written = 0, batchNo = 0;
  for (let i = 0; i < trades.length; i += BATCH) {
    // ...create + save（不变）...
    written += slice.length;
    if (++batchNo % FLUSH_EVERY === 0) await this.runRepo.update(runId, { progressScanned: written });
  }
  await this.runRepo.update(runId, { progressScanned: written });   // 末批矫正
  ```
- **step8**（`:181-196`）：completed 时 `progressScanned: total`（现有逻辑保留）。**可选**把 phase 一并清/置（前端不读，留值亦无害；建议不动以最小化 diff）。
- **空数据早退分支**（`:85-94` total=0、`:110-120` 0 信号）：不进 step5/7，phase 停在 `scanning` 直接 completed，无碍（前端只在 running 读 phase）。
- **失败路径**（`executeRun` catch `:59-74`）：phase 不必特殊处理（status=failed 后前端不读 phase）。

## 5. 后端单测

`signal-stats.runner.spec.ts` / `signal-stats.simulator*.spec.ts`（既有）补：
1. **phase 按序写入**：mock `runRepo.update`，断言调用序列含 `phase:'scanning'` → `phase:'simulating'`（且带 `progressTotal=signals.length`）→ `phase:'writing'`（带 `progressTotal=trades.length`）→ `status:'completed'`，顺序正确。
2. **simulator onGroupDone 累加**：给 `simulateSignalsBatched` 传桩 `onGroupDone`，断言被调用次数=tsCode 组数、累加和=signals.length。
3. **既有顺序断言不回归**：insert 仍在标 completed 之前（原有 case）。
4. **既有 zero-drift / 批等价单测全绿**（`batch-equivalence.spec.ts` 等）——证明加回调不改口径。

构建：`pnpm --filter @cryptotrading/server build` 绿 + **重启后端进程**。

→ 前端改动见 [03-frontend.md](./03-frontend.md)；验证标准见 [04-testing-and-tasks.md](./04-testing-and-tasks.md)。
