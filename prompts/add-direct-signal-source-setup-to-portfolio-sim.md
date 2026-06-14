# 让「组合模拟」新建界面能直接设置信号源(而非只从「信号前向统计」复制 runId)

> 交接提示词(handoff)。可整段贴给全新会话直接接手,不依赖上一会话上下文。
> 项目:cryptotrading(量化回测)。工作目录 `C:\codes\cryptotrading`,Windows + PowerShell(禁 `&&`,用 `;` 或分步)。中文思考与回答。
> 现状摸底里的 file:line 截至 2026-06-14;**这些是二手摸底,接手后凡要进硬断言/改的点请自己再核一遍真码**([.claude/rules/data-integrity.md](../.claude/rules/data-integrity.md))。
> 接手第一步走 `/brainstorming`:先与用户敲定下方开放问题,**得到设计批准前别写实现代码**。

## 一句话目标

让「组合模拟 portfolio-sim」的新建方案界面**能直接设置/定义信号源**,而不是逼用户先去「信号前向统计 signal-stats」跑出一个 run、再把 `runId` 复制粘贴回来。

## 先读这个:需求框架已被摸底纠正(别照字面重造)

字面需求是「能直接设置信号源,而不只是从信号前向统计复制」。但**摸底发现:组合模拟的信号源下拉选择器其实已经存在**——所以「复制 runId」只是兜底,不是唯一方式。真正的缺口有两个,接手时**先与用户确认他指的是哪个**(很可能是后者或两者):

1. **选择粒度不够**:现有下拉只能选「某方案的**最新** completed run」;想用某次**历史 run**(不是最新那次)就只能切「高级模式」手填 uuid。
2. **不能内联定义新信号**:想测一个**全新的入场条件**时,仍得离开组合模拟、去 signal-stats 建方案+跑 run、再回来填 runId——无法在组合模拟里一站式「定义条件 → 生成源」。

> ⚠️ **别重造已有的选择器**。先把现状(下方 A 节)看明白,再决定是「增强选择粒度」还是「加内联定义」还是两者。

## 现状摸底(file:line 为证)

### A. portfolio-sim 现在怎么设/校验信号源

- **源行 UI** `apps/web/src/components/portfolio-sim/PortfolioSimSourceRow.vue`:
  - **普通模式(已存在的选择器)** `:34-47`:`n-select` 绑 `schemeId`,选中调 `onSchemeChange`(`:252-256`)→ 从 `props.schemes` 找 `completedRunId` → `patch({ runId })`。
  - **高级模式** `:48-56`:`n-input` 手填 uuid → `patch({ runId: v.trim() })`(这就是「复制粘贴」那条路)。
  - 源行其它字段:`label / positionRatio / maxPositions / exposureCap / rankField / rankDir`,以及可选 `rankSpec({factors[]}) / sizing(SizingConfig)`。
- **新建弹窗** `apps/web/src/components/portfolio-sim/PortfolioSimCreateModal.vue`:
  - `loadSchemes()` `:204-217`:打开弹窗时调 `signalStatsApi.findAll()` → 映射成 `SchemeOption[]`(每条 `{label, value=testId, completedRunId}`,`latestRun.status==='completed'` 才填 `completedRunId`)。**所以现有下拉的数据源 = 所有方案 + 各自最新 run**。
  - `addSource()` `:245-248`:push `freshSource()`(默认 `runId:''`);`freshSource` 默认值在 `:187-197`。
- **后端校验/装载**:
  - `portfolio-sim.service.ts` validateCreateDto `:246`:仅校验 `runId` 是合法 uuid;**存在/completed/trades>0** 的三查在触发运行时 `validateSourceRuns()` `:494-521`(原生 SQL 查 `signal_test_run.status` `:499`、`count(signal_test_trade) WHERE run_id` `:512`)。
  - `portfolio-sim.loader.ts` `loadSourceTrades` `:153-195`:用 runId 从 `signal_test_trade WHERE run_id=$1` 取逐笔(`:169`);0 行抛错不静默(`:83-88`)。

### B. signal-stats(信号前向统计)怎么「定义条件 + 建 run + 列 run」——这是要复用的机制

- **条件构建器(可复用)**:页面 `apps/web/src/views/strategy/SignalStatsView.vue`;表单 `apps/web/src/views/strategy/SignalTestForm.vue`,其入场条件用 `<ConditionRows>`(`:10-13`,组件 `apps/web/src/components/strategy-conditions/ConditionRows.vue`,`v-model:conditions="form.buyConditions"`,类型 `StrategyConditionItem[]`)。**SignalTestForm + ConditionRows 可被组合模拟复用做内联定义。**
- **建+跑的 API**(后端 `apps/server/src/strategy-conditions/signal-stats/signal-stats.controller.ts`):
  - `POST /api/signal-tests` 建方案 `:83`;`POST /api/signal-tests/:id/run` 触发(**异步**,`service.triggerRun` `:261-289`,后台 `runner.executeRun` 跑完写 `signal_test_trade`,立即返回 `{runId}`);`GET /api/signal-tests` findAll `:89`(返回方案+最新run);`GET /api/signal-tests/:id/runs` 列该方案全部 run `:116`。
  - 建方案 DTO `create-signal-test.dto.ts:10-89`:`{name, buyConditions[], exitMode('fixed_n'|'strategy'|'trailing_lock'|'phase_lock'), horizonN?/exitConditions?/maxHold?/stop·floor·ma5/initFactor·lockFactor·lookback?, universe({type:'all'}|{type:'list',tsCodes[]}), dateStart, dateEnd}`。
- **列 run 接口(已完备,可直接用于二级选择)**:`GET /api/signal-tests/:id/runs` → `service.listRuns` `:307-313`,返回该方案全部 run(createdAt DESC),字段含 `id/status/sampleCount/winRate/kellyF/createdAt/completedAt`——**但无 name**(name 在方案层)。前端封装 `signalStatsApi.listRuns(id)`(`apps/web/src/api/modules/strategy/signalStats.ts:175-177`),**当前没有 UI 渲染多 run 列表**(SignalStatsTable 只显 latestRun)。

### C. 关键判断(决定路径)

- **条件快照存在「方案」层不在「run」层**:`signal-test.entity.ts` 存 `buyConditions/exitMode/exitConditions/bandLockParams/phaseLockParams/universe/dateStart/dateEnd`(jsonb);`signal-test-run.entity.ts` 只有 `testId(FK)+status+统计`,不存条件。→ 要展示「这个源是什么条件」须 run→testId→方案条件;`GET /api/signal-tests` 已带全部条件信息(CreateModal 已在调)。
- **历史 run 选择**:`GET /api/signal-tests/:id/runs` 已能列某方案全部历史 run,后端无需改动。
- **内联建新源**:可复用 `SignalTestForm`+`ConditionRows`+`POST /api/signal-tests`+`:id/run`;难点是 run **异步**,要轮询等 completed 才拿到可用 runId,会拉长组合模拟新建流程。

## 已定方向 + 待 brainstorming 敲定的开放问题(附推荐)

**三条候选路径**(摸底已验,后端基本无需改):

- **路径 A —— 选历史 run(增强现有选择器)**:在源行方案选中后,加一个二级「历史 run」选择器(调 `signalStatsApi.listRuns(testId)`,展示 createdAt/sampleCount/status,仅 completed 可选)。改动小、后端零改、补齐「不能选非最新 run」缺口。
- **路径 B —— 内联定义新信号源**:在组合模拟新建里嵌精简版 `SignalTestForm`(复用 ConditionRows),提交走 `create + triggerRun + 轮询 completed` 再回填 runId。复用现成组件/接口,但**异步 UX 复杂**(要进度/轮询/失败处理)。
- **路径 C(推荐)—— A + B 并存**:默认选已有方案 + 历史 run 二级选择(A);另给「新建并运行信号源」入口,内嵌 SignalTestForm 闭环(B)。

**开放问题(接手先与用户敲定)**:
1. **用户到底要哪个**:仅 A(选历史 run)/ 仅 B(内联定义新条件)/ C(两者)?(字面需求更像 B 或 C;**务必先确认**,别只做 A 就交差,也别在用户只要 A 时上 B 的异步复杂度。)
2. **若做 B 的异步流程**:组合模拟新建里触发一个长跑 signal-stats run,等它跑完——是「建源时同步等(带进度)」还是「先存草稿、源 run 完成后再可运行组合」?异步等待 UX 怎么设计(轮询/SSE/进度条)、失败/超时怎么处理?
3. **复用边界**:直接内嵌整个 `SignalTestForm`(含 exitMode/trailing_lock/phase_lock 等全套出场配置)还是抽一个精简「只定义买入条件 + universe + 区间」的子集?组合模拟只消费逐笔 ret,出场模式仍是 signal-stats 方案的属性,不能省。
4. **选择器语义**:现有下拉绑「方案(testId)」取最新 run;改成可显式选 run 后,源上存的仍是 runId(契约不变),但 UI 要让「方案 → run」两级清晰(并显示该 run 的条件/样本数/胜率辅助决策)。
5. **是否要在组合模拟里展示「这个源是什么条件」**:run→testId→方案 buyConditions 的只读摘要,帮用户确认选对了源。

## 硬约束 / 项目规范(务必遵守)

- **改后端必重启 server/worker**(CLAUDE.md:`dev` 是 `nest start` 无 watch);前端 vite 有 HMR。端到端验证前确认后端跑最新代码。**要重启用户正在跑的环境前先问一句**,别擅自 kill。
- **前端改 `.vue` 合并前必跑 `vite build`**(`type-check` ≠ SFC 编译,见 [.claude/rules/vue3-frontend.md](../.claude/rules/vue3-frontend.md));动到懒加载路由/共享组件再真机点开确认不白屏。Vue 单文件 ≤500 行;PortfolioSimSourceRow 现 ~370 行、CreateModal ~425 行,加内联表单极可能顶破 500 → 抽子组件。
- **复用而非另造**:signal-stats 的 ConditionRows/SignalTestForm/各 API 已完备,优先复用;`signalStatsApi.listRuns` 已有封装。后端若确实无需改动就别动后端。
- **前后端类型镜像同步**;源文件 UTF-8;动态 SQL 列名走白名单。
- **不破坏组合模拟既有契约**:源最终仍提交 `runId`(loader/engine 不变);anchorMode 代数恒等等既有不变量不得动。

## 验证标准

1. **真机 e2e(核心)**:在组合模拟新建界面**不离开页面**完成「设置信号源」——按敲定的路径:能选某方案的指定历史 run(A)/ 内联定义条件并生成可用源(B)——最终建出的组合模拟能正常运行、拿到 annualRet、逐笔明细有数据。
2. 若做 B:异步 run 等待/进度/失败路径都验到;源 run 跑完后组合模拟能正确消费其 runId。
3. **回归**:现有「选方案(最新 run)」「高级模式手填 uuid」两条老路不破。
4. **门禁**:`pnpm --filter @cryptotrading/web type-check`、`pnpm --filter @cryptotrading/web build`(vite)、`lint:quant-lines`、相关后端 jest(若动后端)全绿。

## 前序进度 / 待续

- ✅ 组合模拟三期改造(composite 排序/动态仓位/双触发熔断)已实现合入本地 main、V10 e2e 通过(momentum_60 desc 把年化 −1.07%→+3.18%)。本需求是其后续 UX 改进。
- ✅ 现状摸底已完成(本文件 A/B/C 节);**关键结论:信号源选择器已存在,缺口是历史 run 选择 + 内联定义**。
- ⏭ **接手第一步**:`/brainstorming` 与用户敲定开放问题 1(到底要 A/B/C 哪个),再据此设计。

相关:[doc/使用指南/组合模拟使用指南.md](../doc/使用指南/组合模拟使用指南.md)(组合模拟用法)、`project_portfolio_sim_engine_upgrade`(三期改造全史)、`project_signal_forward_stats`(signal-stats 来源)、[.claude/rules/vue3-frontend.md](../.claude/rules/vue3-frontend.md)。
