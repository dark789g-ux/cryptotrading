# 07 · 阶段拆分、文件域与验证门禁

[← 返回总入口](./index.md)

## 7.1 M0–M5 阶段与文件域

按「独立文件域 / 互不相交修改范围」切分，便于多 agent 并行（不用 worktree）。

```text
M0  Schema 迁移（两套系统,可并行）
  ├ A: apps/server/migrations/2026-06-14-signaltest-minibacktest.{sql,ps1}
  │    + signal-test.entity.ts / signal-test-run.entity.ts / 新 signal-test-equity.entity.ts
  │    + app.module 根 entities 双注册
  └ B: apps/quant-pipeline alembic 新 migration(ck_jobs_status 加 draft) + ml-job.entity.ts 类型

M1  Part A 后端引擎接线（依赖 M0-A）
  ├ signal-stats.runner.ts(doExecute 插 ⑤⑥⑦,独立错误边界) + 复用 PortfolioSimLoader.load(单源 config)
  ├ signal-stats.service.ts + dto(backtestConfig 校验)
  ├ import runPortfolioSim(不改 portfolio-sim.engine.ts)
  └ 新只读 GET /signal-tests/:id/runs/:runId/equity

M2  Part B 后端（依赖 M0-B，与 M1 并行）
  └ quant-jobs.controller/service(as_draft + dispatch + cancel draft) + create-job.dto

M3  Part A 前端（依赖 M1 接口）
  ├ SignalTestForm 拆 n-tabs + 各 section 子组件 + useSignalTestForm
  └ SignalStatsResult 加回测视图 + 净值曲线 ECharts

M4  Part B 前端 + 移除内联源（与 M3 并行，文件域不交）
  ├ QuantTrainTriggerModal/PrepareModal/KellySweepView(保存草稿) + QuantJobsView(运行按钮) + quant.ts(dispatchJob)
  └ 删 PortfolioSimNewSourceModal + 改 PortfolioSimSourceRunPicker(收两态) + usePortfolioSimSourceRuns 裁剪

M5  e2e + 对拍（依赖全部）
  └ 见 §7.3
```

依赖关系：M0 是地基；M1/M2 各依赖 M0 的一半且彼此独立；M3 依赖 M1；M4 与 M3 文件域不交可并行；M5 收口。

## 7.2 门禁（每阶段合并前）

| 检查 | 命令 |
|------|------|
| 后端构建 | `pnpm --filter @cryptotrading/server build` |
| 后端单测 | `pnpm --filter @cryptotrading/server exec jest <pattern>` |
| 前端类型 | `pnpm --filter @cryptotrading/web type-check` |
| 前端构建（动 .vue 必跑） | `pnpm --filter @cryptotrading/web build` |
| 前端单测 | `pnpm --filter @cryptotrading/web test` |
| Vue ≤500 行 | `pnpm --filter @cryptotrading/web lint:quant-lines`（注：signal_test 表单在 views/strategy，非 quant 域；≤500 仍按 code-organization 通则人工把关） |
| migration 真 DB | `docker exec crypto-postgres psql ...` 应用并核实 |

> 后端 `dev` 无 watch：改 `apps/server` 后**重启进程**再做端到端，否则撞 404 / 旧行为假象。

## 7.3 M5 验证剧本

### Part A 对拍恒等（硬门禁）

```text
建一个 signal_test，backtest_config.anchorMode=true（单源,约束停,费率0）→ 运行
  断言①: 每笔 taken realizedRetNet ≡ trade.ret（逐笔）
  断言②: 把 taken realizedRetNet 序列喂 calcSignalStats，
          其 win_rate/kelly_f/sample_count == signal_test_run 既有聚合列（逐位相等,零漂移）
  断言③: signal_test_equity 每日 cash+Σmv ≈ nav；nav(d)=nav(d-1)×(1+daily_ret(d))
```

### Part A 真实约束 run

```text
backtest_config 设 positionRatio/maxPositions/exposureCap/cost/熔断 → 运行
  断言: final_nav/total_ret/max_drawdown/sharpe 落库非空且自洽；
        净值曲线 endpoint 返回升序日序列；详情页回测视图渲染（canvas 出现）；
        backtest_config=null 的旧 run 详情页不显回测视图（零回归）
```

### Part A 移除内联源回归

```text
组合源选择器只剩「选已有方案」「手填uuid」两态；空态文案跳转「信号统计」可达；
新建组合模拟全流程仍可正常选历史 run 当源、运行出净值（不回归）
```

### Part B

```text
三入口各「保存草稿」→ jobs 列表见 draft 行(worker 不拾取,保持 draft)
点「运行」→ dispatch → running → 正常 success
draft 行「取消」→ cancelled
dispatch 已 running/已终态 job → 409 中文透出
```

## 7.4 风险与回滚

- **零漂移保证**：`backtest_config IS NULL` ⇒ 不走回测层，signal_test 行为同今日；`as_draft` 默认 false ⇒ ml.jobs 默认仍 pending。两改均「默认不变、显式才启用」，回滚面小。
- **引擎漂移**：迷你回测复用 `runPortfolioSim`，若 portfolio-sim 引擎未来改口径，signal_test 回测口径随动——这是「单一引擎真源」的收益（避免三套漂移），但需在引擎改动时同跑本 spec 的对拍恒等。
- **因子取数耦合**：排序因子 SQL 与 portfolio-sim loader 共用真源；`RankFactorKey` 9 值进硬断言前核 `portfolio-sim.factor-registry.ts`，禁二手转述。
- **migration 失败**：A 套（NestJS）与 B 套（alembic）分别幂等（`IF NOT EXISTS` / alembic 版本）；B 套先 `alembic current` 对齐再 upgrade。

## 7.5 未决 / 后续（不阻塞本期）

- 引擎 `fills` 是否落 signal_test 专表（本期复用 signal_test_trade，不落 fills）。
- 多源迷你回测（本期固定单源；多源即用现成 portfolio-sim，无需在 signal_test 重复）。
- `useQuantJobSubmit()` composable 收敛三入口（本期各自透传 as_draft，非必须）。
