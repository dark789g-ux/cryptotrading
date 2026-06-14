# 03 · 后端、契约与不变量

返回:[index.md](./index.md)

## 1. 后端零改动(明确不动)

本特性**不新增 endpoint、不改 schema、不改 portfolio DTO**。所需后端能力全部已就绪并已核实路由:

| 能力 | 路由(已核实 file:line) | 备注 |
|------|------------------------|------|
| 建方案 | `POST /api/signal-tests` — `signal-stats.controller.ts:83` | body=`CreateSignalTestDto` |
| 触发 run(异步) | `POST /api/signal-tests/:id/run` — `:100`(`id`=testId) | `service.triggerRun` 不 await runner,立即返回 `{runId}` |
| run 进度 | `GET /api/signal-tests/:id/run/progress` — `:109`(**`id`=testId**) | 返回当前/最近一次 run 实体(含 status/phase/progress*) |
| 历史 run 列表 | `GET /api/signal-tests/:id/runs` — `:118`(**`id`=testId**) | 返回 `SignalTestRun[]`,createdAt 倒序,**无 name** |
| 方案+最新run | `GET /api/signal-tests` — `:89` | 返回 `SignalTestWithLatestRun[]`,含方案条件字段 |
| 组合源校验 | `validateSourceRuns` — `portfolio-sim.service.ts:494-521` | 拦 不存在/非completed/trades≤0 |

> ⚠️ 关键修正(已落源头):`getRunProgress`、`listRuns` 的路由参数**都是 testId**(`:id` = signal_test.id),
> **不是 runId**。前端 `signalStatsApi.getRunProgress(id)` / `listRuns(id)` 的 `id` 同为 testId
> (`signalStats.ts:170-177`)。故源行须**同时持有 runId(契约)与 testId(查 run/轮询)**。

> ⚠️ 已核实事实(进硬判断前必须按此写):`SignalTestRun.status` 枚举 = **`'running' | 'completed' | 'failed'`**
> ——三处源头一致:`signal-test-run.entity.ts:20`、`signal-stats.runner.ts:104`(异常分支写 `status:'failed'`)、
> 前端类型 `signalStats.ts:69`。**失败态是 `'failed'` 不是 `'error'`**;轮询停止/错误展示一律按 `{completed, failed}`。
> 进度字段 `status/phase/progressScanned/progressTotal/sampleCount/winRate` 均已核实(`signalStats.ts:66-87`)。

> 触发边界:同一 test 已有 `running` run 时再 `triggerRun` 抛 **409 ConflictException**
> (`signal-stats.service.ts:264-269`,「该方案已有运行中的任务」)。B 每次新建独立 test 故首次触发不会撞;
> 但**重复点「创建并运行」/对同 testId 再触发**会 409 —— 见 [04 错误表](./04-errors-and-edge-cases.md)。

条件快照存「方案(`signal_test`)」层(`signal-test.entity.ts`:buyConditions/exitMode/universe/dateStart/dateEnd),
run 实体(`signal-test-run.entity.ts`)只有 testId(FK)+status+进度+统计。→ 条件摘要走 run→testId→方案,
而 `findAll()` 已带全部方案条件,弹窗已在调,无需额外接口。

## 2. 数据流(方案 → run → runId → 逐笔)

```text
[A] 选方案 ─▶ listRuns(testId) ─▶ 选 completed run ─┐
[B] 子弹窗 ─▶ create(dto)=testId ─▶ triggerRun(testId)=runId ─▶ 轮询 getRunProgress(testId) ─┤
[手填] 直接输入 uuid ───────────────────────────────────────────────────────────────────┘
   ▼
源.runId(uuid) 进 CreatePortfolioSimDto
   ▼
portfolio create → validateCreateDto 中对 runId 做 UUID 格式校验(portfolio-sim.service.ts:246)
                   (该方法另含 name/sources 长度/label 唯一/仓位/rankSpec/sizing 等校验,非仅 uuid)
   ▼
portfolio triggerRun → validateSourceRuns(存在/completed/trades>0) → runner → loader
   ▼
loader.loadSourceTrades:用 runId 查 signal_test_trade(loader 内,run_id=$1) → 逐笔 → 引擎回放
```

## 3. 契约与不变量(不得破坏)

- **源最终仍只提交 `runId`**:`PortfolioSimSource.runId` 字段与 `CreatePortfolioSimDto` 结构不变。
- **loader / engine 不动**:`loadSourceTrades` 仍 `WHERE run_id=$1`;0 行抛错(双保险,`load():81`)保留。
- **anchorMode 代数恒等**等组合模拟既有不变量不动。
- **`validateSourceRuns` 闸门不动**:正是它让「非阻塞草稿」成立——源 run 未 completed 时组合运行被自然拦截。
- **三种来源方式产物同构**:无论 A/B/手填,最终都只是一个合法 `runId`,后端无从区分、也无需区分。

## 4. B 流程对后端的调用次序(全用现有接口)

```text
子弹窗提交
  → POST /api/signal-tests            (create)         ← 得 testId
  → POST /api/signal-tests/:testId/run (triggerRun)    ← 得 runId(异步)
  → GET  /api/signal-tests/:testId/run/progress (轮询) ← 至 status=completed/failed
组合保存/运行 沿用既有 portfolio create / triggerRun,无新增。
```
