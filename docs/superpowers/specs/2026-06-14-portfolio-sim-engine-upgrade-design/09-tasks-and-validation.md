# 09 · 任务切分、分期交付与验证

## 任务切分(预切互不相交文件域,避免并行覆盖)

| ID | 任务 | 主要文件(域) | 依赖 |
|---|---|---|---|
| T0 | 预检(落DB核) | —(只读 SQL) | 先做,阻塞 |
| T1 | 共享类型契约 | `portfolio-sim.types.ts` | 先合,后续全依赖 |
| T2 | 注册表 + 排序 + engine 排序段 | `factor-registry.ts`(新)+ `ranking.ts`(新)+ `engine.ts`(排序处) | T1 |
| T3 | 仓位 | `sizing.ts`(新)+ `engine.ts`(仓位处) | T1 |
| T4 | 熔断 | `cooldown.ts`(新)+ `engine.ts`(循环闸门) | T1 |
| T5 | loader 多因子 | `loader.ts` | T1,T2 |
| T6 | service 校验 + dto + **fills 读路径白名单** | `service.ts`, `dto/create-portfolio-sim.dto.ts`, `list-fills-options.ts`(VALID_SKIP_REASONS) | T1,T2 |
| T7 | migration + 实体 + runner 落库 | `migrations/*.sql`+`.ps1`, `portfolio-sim-fill.entity.ts`, `runner.ts` | T1 |
| T8 | 前端 | `portfolioSim.ts`, `portfolioSimPresets.ts`, `RankSpecEditor`/`SizingFields`/`CircuitBreakerPanel`/`FillFactorDetail.vue`(新), `PortfolioSimSourceRow`/`CreateModal`/`FillsTable.vue`, **`check-quant-vue-line-count.mjs`(ROOTS)** | T1 |
| T9 | 单测 | `*.spec.ts`(ranking/sizing/cooldown/engine 恒等/loader/service/list-fills) | T2–T7 |

- **T2/T3/T4 都改 `portfolio-sim.engine.ts` 同一文件** → 这三个**不并行写**,由主会话串行合并(或一个 agent
  连做引擎三段)。其余(T5 loader / T6 service / T7 持久化 / T8 前端)文件域互不相交,可并行。
- **派 agent 禁用 worktree 隔离**(brainstorming 规范):全在主工作目录改,主会话统一合并提交。

## T0 预检(必须先做,已全部完成)

| 项 | 状态 | 结论 |
|---|---|---|
| ml.scores_daily model_version 数 / 唯一性 | ✅ 已核 | **2 个 model_version**;跨模型重复、单模型内唯一 → JOIN `DISTINCT ON ... model_version DESC`(见 [06](./06-loader-multifactor.md#ml_score-去重-join已核-db)) |
| portfolio_sim_fill 有无 CHECK | ✅ 已核 | 无 → 新 skipReason/列直接加([08](./08-persistence-and-migration.md)) |
| 注册表各列真实名(risk_reward_ratio/ma60/atr_14/pos_60/…) | ✅ 已核(2026-06-14) | 见 [02](./02-factor-registry.md) 表 |
| `calcSignalStats` kellyF=null 触发条件 | ✅ 已核 metrics.ts:62-83 | 全胜/全亏/全平/样本不足均 null → source_kelly 按 avgWin/avgLoss 分流(全亏→mult=0、其余 null→mult=1),见 [04](./04-engine-sizing.md) |
| V10 测试床 run 在库 | ✅ 已核 | `14ecdbdf`/`75766fb8` 各 28,873 笔,2022-07-07~2026-02-25 |
| `components/portfolio-sim`/`views/strategy` 是否在 lint:quant-lines ROOTS | ✅ 已核 | **不在** → T8 把这两目录加进 `check-quant-vue-line-count.mjs` ROOTS([07](./07-service-and-frontend.md)) |

## 分期交付与验证顺序(ROI 优先)

```text
Phase 1(核心) → 在 V10 测试床即时验证「质量择优能否把年化转正」← 成败判据
   T1 → T2 → T5 → T6 → T7 → T8(排序/展示部分)→ e2e
Phase 2(动态仓位)  T3 + T8(sizing 部分)→ 与 Phase1 对比扫
Phase 3(熔断)      T4 + T8(熔断部分)→ 叠加验证
```

> **Phase 1 打通后第一件事**:在 `14ecdbdf`(E7)/`75766fb8`(fixed1)上,用 composite 质量排序 vs
> `none`/`pos_120` **同容量**对比,看:① 被 taken 那批信号质量是否更高(factor_values 可查);
> ② **年化是否从 ≈−1% 转正**;③ 信号数/skip 逐位可解释。

## 测试计划

### 单测(jest,`pnpm --filter @cryptotrading/server exec jest <pattern>`)

- **ranking**(T2):composite 综合分手算对拍;**平名次/ null 确定性**(同值/同 null 候选 scoreByTrade 相等、
  两次运行一致);**全因子 null 候选**排末位;**质量分位 q**(最优=1/最差=0/n=1=1.0/none=0.5);
  单因子退化 == 现 `sortCandidates`;none 纯 ts_code。
- **sizing**(T3):fixed 零漂移;signal_weighted q=0/0.5/1 + **none→mult=1**;source_kelly mult=clamp(kf·frac,0,max)、
  **全胜源(avgLoss=null)→mult=1**、**全亏源(avgWin=null)→mult=0 且 sized_out**、**负期望 kellyF<0→mult=0 且 sized_out(alloc<MIN)**;
  weightEntry==alloc/navRef;checkSkip 与开仓用同一 alloc。
- **cooldown**(T4):本地副本 vs `backtest/engine/cooldown.ts` **对拍同轨迹**;连亏触发/盈利缩短/到期解除;
  **同日 round-trip 连亏计入**(第二个收口点);**win 口径**(ret>0 但 net≤0 计亏);drawdown 滞回(停/维持/复)。
- **engine 恒等**(贯穿):**anchorMode 下任意 rankSpec/sizing/circuitBreaker 配置,`realizedRetNet≡ret`、
  taken 集合不变**——既有 `engine.spec.ts` 锚点用例零漂移 + 新增三参数恒等用例。
- **熔断透明**:冻结日全候选 skipped 且 **fill 仍带 factor_values/rank_score**。
- **loader**(T5):单因子取值/缺失 null(零漂移);多因子同表只 JOIN 一次;**ml_score pin 单模型去重不翻倍**;
  momentum 三表+compute(atr=0→null,且经排序 null 殿后)。
- **service / list-fills**(T6):rankSpec 各非法(因子不在注册表/weight≤0/dir 非法)400;sizing/circuitBreaker
  范围;ml_score 选中 warn;**按新 skipReason 筛选 fills 命中**(VALID_SKIP_REASONS 含 3 新值)。

### 真机 e2e(核心,见上「Phase 1 打通后」)

- 后端改完**必须重启 server/worker**(`dev` 无 watch)再验,避免撞旧代码假象。
- loader 多因子 JOIN 因 mock 验不出水合(database-sql.md 教训)→ **必须真机/集成**:建一个含 momentum+risk_reward
  的 composite run,查 fill.factor_values 非空且数值合理、前端逐因子展开可见。
- 锚点对账:anchorMode run 的 `anchor_check.pass=true`(realizedRetNet≡ret)。

## 门禁(全绿才算完)

```text
pnpm --filter @cryptotrading/server build
pnpm --filter @cryptotrading/server exec jest <相关 spec>
pnpm --filter @cryptotrading/web type-check
pnpm --filter @cryptotrading/web lint:quant-lines     # T8 已把 portfolio-sim/strategy 纳入 ROOTS
```

## 诚实标注边界

- 若质量排序仍救不回正:**如实报告**「Q2-V10 在容量+成本下确实不可部署」,不粉饰。
- 若救回:给出最优排序因子组合 + 容量(maxPositions/positionRatio)+ 净年化/回撤/卡玛。
- 容量曲线扫描(maxPositions/positionRatio sweep)不作为本期新功能,通过**多建 run 对比**完成(研究动作,非代码)。
