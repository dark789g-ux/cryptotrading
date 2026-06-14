# portfolio-sim 引擎三期改造 — 设计总入口

> 设计日期 2026-06-14。把「策略回测 backtest」引擎里 portfolio-sim **没有**的三项能力——
> **多因子信号质量排序、动态仓位、回撤熔断**——按需移植到「组合模拟 portfolio-sim」。
> 交接来源:[prompts/optimize-portfolio-sim-from-backtest.md](../../../../prompts/optimize-portfolio-sim-from-backtest.md)。

## 背景与目标(摘要)

上一会话用 portfolio-sim 对一个真实有 gross edge 的 A 股策略(0AMV-Q2 的 V10:入场
`kdj_j<-5 且 ma5>ma60`)做组合级真实回测:逐笔前向 gross kelly **+0.13**(5 年无深亏),
但真组合回测(20~50 仓 + A 股真成本)**年化 ≈ −1.1% ~ −16%**,全亏。两个杀手:**容量碾压**
(每天 ~147 信号,组合只吃得下 1.3%~3.3%)与**成本吞噬**。最致命的是:被丢弃 97% 后「挑哪 3%」
由排序字段决定,而 portfolio-sim 只有 `pos_120 / circ_mv / none` 三档,**没有任何「信号质量」维度**。

**本次任务的成败判据**(贯穿全 spec):在 V10 测试床上,用**新质量排序**择优挑那 3%,能否把
**年化从 ≈−1% 转正**。若救不回,如实报告「Q2-V10 容量+成本下不可部署」,不粉饰。

**范围(用户已定)**:Phase 1+2+3 全做。
- **Phase 1(核心)**:composite 多因子加权质量排序(engine 改造,最贴 backtest `sortByRankingScore`)。
- **Phase 2**:动态仓位,三模式 `fixed / signal_weighted / source_kelly` 全提供,默认 `fixed`。
- **Phase 3**:熔断,**连亏熔断 + 回撤熔断双触发**。

**关键约束**:`anchorMode` 代数恒等(`realizedRetNet ≡ ret`、每笔必 taken)是对账基石,
Phase 2/3 在 anchorMode 下**必须全旁路**。配置走 `portfolio_sim_run.config`(jsonb,无需迁移);
为「逐因子透明」给 `portfolio_sim_fill` **加两列 `factor_values jsonb` + `rank_score numeric`**(一条 migration)。

## 子文档清单(阅读顺序)

按下列顺序读,后文依赖前文的类型契约:

1. [01-overview-and-data-model.md](./01-overview-and-data-model.md) — 总路线、分层图、**全部配置/引擎类型契约**、向后兼容适配、anchorMode 不变量。
2. [02-factor-registry.md](./02-factor-registry.md) — **因子注册表(白名单)**:9 因子来源/方向、momentum 现算、ml_score 去重 JOIN、null 处置。
3. [03-engine-ranking.md](./03-engine-ranking.md) — 排序段:`rankAndScore` 契约、`sortByRankingScore` 移植、**质量分位 q**、单因子退化。
4. [04-engine-sizing.md](./04-engine-sizing.md) — 仓位段:`computeAlloc` 纯函数、三模式公式、source_kelly 复用 `calcSignalStats`、`sized_out`。
5. [05-engine-circuit-breaker.md](./05-engine-circuit-breaker.md) — 熔断段:`cooldown` 移植 + drawdown 滞回、双触发闸门、新 skipReason。
6. [06-loader-multifactor.md](./06-loader-multifactor.md) — loader 多表 JOIN(注册表驱动)、momentum 三表、ml_score `DISTINCT ON` pin 单模型。
7. [07-service-and-frontend.md](./07-service-and-frontend.md) — service 校验、dto、后端 fills 白名单、前端类型/标签/编辑器、≤500 行管理。
8. [08-persistence-and-migration.md](./08-persistence-and-migration.md) — migration(两列)、实体更新、runner 落库、已核 DB 事实。
9. [09-tasks-and-validation.md](./09-tasks-and-validation.md) — 任务切分(互不相交文件域)、分期交付、T0 预检、测试与 e2e 验证、门禁。

## 跨文档引用约定

- 文档间引用一律用**相对路径 + 锚点**,例:`[computeAlloc](./04-engine-sizing.md#computealloc-纯函数契约)`。
- 代码位置引用用 `file:line`,例:`portfolio-sim.engine.ts:170`(以仓库现状为准,设计期已核 2026-06-14)。
- 类型名(`RankSpec` / `SizingConfig` / `CircuitBreaker` / `RankFactorKey` / `SkipReason`)全 spec 统一,
  权威定义见 [01](./01-overview-and-data-model.md);后续文档只引用不重定义。

## 已落源头核实的 DB 事实(2026-06-14,进硬断言/migration)

| 事实 | 结论 | 影响 |
|---|---|---|
| `ml.scores_daily` model_version 数 | **2 个**(`...20260521-seed42` 全2天 / `...20260607-seed42` 仅 20260515);20260515 两模型并存致重复;**单模型内 (date,ts_code) 唯一**(dup=0) | ml_score JOIN **必须 pin 单模型再去重**(`DISTINCT ON ... ORDER BY model_version DESC`),不可跨模型混 rank(见 [02](./02-factor-registry.md)/[06](./06-loader-multifactor.md)) |
| `portfolio_sim_fill` 约束 | 只有 PK + FK,**无 CHECK** | 新 skipReason(`cooldown`/`drawdown_halt`/`sized_out`)直接进 varchar(16);migration 仅 `ADD COLUMN`(见 [08](./08-persistence-and-migration.md)) |
| `ml.scores_daily` 历史覆盖 | 仅 `20260515` / `20260528` 两天 | ml_score **禁历史回测**,前端/校验须 warn(见 [02](./02-factor-registry.md)) |
| `close` 列位置 | 在 `raw.daily_quote`(非 `daily_indicator`) | momentum 现算需三表 JOIN(见 [06](./06-loader-multifactor.md)) |
| `raw.daily_indicator.ma240` | 2022 全年 NULL | momentum 用 **ma60**,不用 ma240 |
| `calcSignalStats` kellyF=null | 由**全胜(avgLoss空)/全亏(avgWin空)/全平/样本不足**共同触发(已核 metrics.ts:62-83) | source_kelly 须按 avgWin/avgLoss 分流:**全亏→mult=0(sized_out)**、全胜/全平/不足→mult=1、`kellyF<0`→mult=0(见 [04](./04-engine-sizing.md)) |
