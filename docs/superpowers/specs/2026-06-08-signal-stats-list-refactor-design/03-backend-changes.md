# 03 · 后端改动

[← 返回 index](./index.md) · [← 02 详情弹窗](./02-detail-modal.md)

## 已核对事实（进 SQL/硬断言前已落源头）

- 表 `signal_test_trade`：列 `ret numeric NOT NULL`、`run_id uuid`
  （`entities/strategy/signal-test-trade.entity.ts:15,36-37` + migration `:56-68`）。
- 表 `signal_test_run`：已有 `worst_trade_ret numeric`（nullable）
  （`entities/strategy/signal-test-run.entity.ts:55-56` + migration `:46`）。
- `calcSignalStats(rets, holdDays)` 已计算 `worstTradeRet = Math.min(...rets)`
  （`signal-stats.metrics.ts:87`），返回 `SignalStatsResult`（`:8-18`）。
- runner 落库点 `signal-stats.runner.ts:157-171` 的 `this.runRepo.update(runId, {...})`，
  numeric 列经 `numStr()` 转 string。
- `findAll()` 现为 `this.testRepo.find({ order: { createdAt: 'DESC' } })`
  （`signal-stats.service.ts:67-69`）。
- 控制器路由顺序硬约束：静态段 `runs/:runId/*` 必须先于 `/:id`
  （`signal-stats.controller.ts:30-45,90-94`）。

---

## 改动 A：新增「最佳单笔」`best_trade_ret`

### A.1 metrics 纯函数

`signal-stats.metrics.ts`：

- `SignalStatsResult` 接口加 `bestTradeRet: number | null;`（紧随 `worstTradeRet`）。
- N=0 的 early-return 块加 `bestTradeRet: null,`。
- 计算块加 `const bestTradeRet = Math.max(...rets);`（与第 87 行 `Math.min` 对称）。
- return 块加 `bestTradeRet,`。

### A.2 实体

`entities/strategy/signal-test-run.entity.ts`，在 `worstTradeRet`（:55-56）后加：

```ts
@Column({ type: 'numeric', nullable: true, name: 'best_trade_ret' })
bestTradeRet: string | null;
```

### A.3 runner 落库

`signal-stats.runner.ts:157-171` 的 `update({...})` 加一行（紧随 `worstTradeRet`）：

```ts
bestTradeRet: numStr(stats.bestTradeRet),
```

### A.4 migration（加列 + 回填存量）

新建 `migrations/20260608_signal_test_run_best_trade_ret.sql`（幂等）：

```sql
-- 加列（幂等）
ALTER TABLE signal_test_run ADD COLUMN IF NOT EXISTS best_trade_ret numeric;

-- 回填存量：从该 run 的逐笔明细取 max(ret)
-- test 一次性、不重跑，旧 run 必须回填否则「最佳单笔」永远 —
UPDATE signal_test_run r
   SET best_trade_ret = sub.max_ret
  FROM (
    SELECT run_id, max(ret) AS max_ret
      FROM signal_test_trade
     GROUP BY run_id
  ) sub
 WHERE r.id = sub.run_id
   AND r.best_trade_ret IS NULL;
```

配套 `20260608_signal_test_run_best_trade_ret.ps1`，沿用 `20260607_*.ps1` 模板：
`docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -`
执行，并 `Invoke-Scalar` 断言验证：

- 列存在：`SELECT count(*) FROM information_schema.columns WHERE table_name='signal_test_run' AND column_name='best_trade_ret';` = 1
- 回填一致：`SELECT count(*) FROM signal_test_run r WHERE EXISTS (SELECT 1 FROM signal_test_trade t WHERE t.run_id=r.id) AND r.best_trade_ret IS NULL;` = 0（有明细的 run 都已回填）

---

## 改动 B：`findAll` 补 latestRun

目标：列表接口每个方案带回**最新一次 run** 的完整聚合字段，避免前端 N+1。

**实现方式**：避开 TypeORM 同表 leftJoin + orderBy 已知坑（见 `.claude/rules/database-sql.md`），
用**两步查询 + JS 拼接**：

1. `const tests = await this.testRepo.find({ order: { createdAt: 'DESC' } });`（不变）
2. 取每个 test 的最新 run（`DISTINCT ON`）：

```ts
const latestRuns = await this.runRepo
  .createQueryBuilder('r')
  .distinctOn(['r.testId'])
  .orderBy('r.testId', 'ASC')
  .addOrderBy('r.createdAt', 'DESC')
  .getMany(); // 取全实体，按属性名水合（规则：禁用 .select(列名)）
```

3. JS 建 `Map<testId, run>`，给每个 test 附 `latestRun`，返回
   `(SignalTestEntity & { latestRun: SignalTestRunEntity | null })[]`。

> 若 `distinctOn` 在当前 TypeORM 版本不稳，退化为原生 SQL：
> `SELECT DISTINCT ON (test_id) * FROM signal_test_run ORDER BY test_id, created_at DESC`，
> 再用 `runRepo.create()` 水合或手动映射 numeric→string。实现时择一，以真机返回字段齐全为准。

**返回类型**：`findAll(): Promise<SignalTestWithLatestRun[]>`，其中
`type SignalTestWithLatestRun = SignalTestEntity & { latestRun: SignalTestRunEntity | null }`。
controller `findAll()` 透传即可。

---

## 改动 C：ret-histogram 接口

### C.1 路由

`signal-stats.controller.ts`，在 `listTrades`（:36-45）**之后、`/:id` 系列之前**的静态段区加：

```ts
/**
 * GET /api/signal-tests/runs/:runId/ret-histogram?bins=25
 * 收益率分档（0 对齐定宽），用于详情直方图。
 */
@Get('runs/:runId/ret-histogram')
getRetHistogram(
  @Param('runId') runId: string,
  @Query('bins') bins?: string,
) {
  const b = parseInt(bins ?? '25', 10);
  return this.service.getRetHistogram(runId, b);
}
```

### C.2 service + 纯函数分档（算法落 JS，可单测）

**分档逻辑全部放纯函数**，service 只负责 run 存在校验 + 取数 + 调纯函数。这样守恒/补空档/
全胜全亏/0 对齐全部可不依赖 DB 单测（呼应 `.claude/rules/database-sql.md`「mock QueryBuilder
验不出水合，靠真机」教训——这里干脆把可测逻辑搬离 SQL）。

**service `getRetHistogram(runId, bins)`**：

1. 确认 run 存在（`runRepo.findOne`），否则 404（同 `listTrades:180-181`）。
2. 取该 run 全部 `ret`（单列，纯数字，与样本量解耦的小列）：
   ```sql
   SELECT ret FROM signal_test_trade WHERE run_id = $1
   ```
   `numeric` 以 string 返回，`const rets = rows.map(r => Number(r.ret))`。
3. `return buildRetHistogram(runId, rets, bins)`（纯函数，见下）。

**纯函数 `buildRetHistogram(runId, rets, bins)`**（新建 `signal-stats.histogram.ts`，无副作用、
不读 DB、不 import NestJS，仿 `signal-stats.metrics.ts` 的纯函数风格）：

1. `rets.length === 0` → `{ runId, sampleCount: 0, binWidth: null, bins: [] }`。
2. `lo = min(rets)`，`hi = max(rets)`，`range = hi - lo`。
3. 定步长（0 对齐 + 取整到「好看」步长）：
   - `range === 0`（全部 ret 相等）→ `binWidth = 0.01`（单档兜底）。
   - 否则 `raw = range / clampedBins`（`clampedBins = min(max(bins,5),60)`）；
     `binWidth = niceStep(raw)`，`niceStep` 取 `{1,2,2.5,5}×10^k` 中 ≥ raw 的最小值。
4. 分桶计数：对每个 ret，`bucket = Math.floor(ret / w)`，累加计数到 `Map<bucket,count>`。
   - **浮点护栏**：`Math.floor(ret / w)` 在 ret 恰落桶边界时可能因二进制浮点末位偏移（经典
     `0.06/0.02→2.999..→2`）。实现时对 `ret / w` 先 `+1e-9` 再 floor，或把 ret、w 统一放大到
     整数分（按 binWidth 的有效位）再整除，确保边界归属确定。单测须含边界用例锁定。
5. 补齐空档：从 `Math.floor(lo/w)` 到 `Math.floor(hi/w)` 连续遍历，缺失 bucket 填 `count=0`。
6. 每档：`lo = bucket*w`，`hi = (bucket+1)*w`，`sign = lo >= 0 ? 'win' : 'loss'`。
   - 0 必为某桶（bucket 0）的精确下边界 → 无 `lo<0 && hi>0` 的跨色桶。
7. `sampleCount = Σ count`（应 === `run.sampleCount`），返回 `RetHistogramResult`。

### C.3 返回结构

```ts
interface RetHistogramBin {
  lo: number;          // 档下界（含）
  hi: number;          // 档上界（不含）
  count: number;       // 频数 ≥ 0
  sign: 'win' | 'loss';
}
interface RetHistogramResult {
  runId: string;
  sampleCount: number; // = Σ count，应等于 run.sampleCount
  binWidth: number | null;
  bins: RetHistogramBin[];
}
```

### C.4 边界与约束

- 只有 `completed` run 才有 trade；`running`/`failed` run → `bins: []`（前端显「暂无数据」）。
- 分档（`binWidth`、桶归属）一律后端纯函数定，**前端不重新分档**，直接按 `bins` 画。
- numeric→number 仅在 service 取数处一次性转换（`Number(r.ret)`）；纯函数全程 number，返回
  JSON number；浮点边界护栏见 C.2 第 4 步。

下一篇：[04 · 前端改动](./04-frontend-changes.md)
