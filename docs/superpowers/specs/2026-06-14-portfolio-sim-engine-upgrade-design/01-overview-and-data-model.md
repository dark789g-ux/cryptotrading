# 01 · 总路线与数据模型

## 总路线(一句话)

把排序统一收敛到一个 **`rankSpec`(因子注册表驱动的多因子加权)** 契约——单因子是它的退化情形、
composite 是主形态、`none` 是空数组;动态仓位(`sizing`)和熔断(`circuitBreaker`)作为
**默认关闭的 engine 旁路层**叠加;`anchorMode` 下三者全停用以守住代数恒等。**全程仅一条 migration**
(给 fill 加 `factor_values jsonb` + `rank_score numeric` 做逐因子透明)。

## 分层与改动落点

```text
前端  PortfolioSimSourceRow.vue ── 拆出 RankSpecEditor / SizingFields
      PortfolioSimCreateModal.vue ── 账户级熔断面板 CircuitBreakerPanel
      PortfolioSimFillsTable.vue ── rank_score 列 + 逐因子展开 + 新 skipReason 标签
      portfolioSim.ts(类型镜像) · portfolioSimPresets.ts(选项/标签)
        │ POST config(jsonb,含 rankSpec/sizing/circuitBreaker)
        ▼
service  validateCreateDto ── rankSpec/sizing/熔断 白名单+范围校验
         list-fills-options ── VALID_SKIP_REASONS 加 3 新原因(读路径白名单)
loader   ── 因子注册表驱动多表 LEFT JOIN → EngineTrade.factorValues
engine   ── ① 排序  rankAndScore(sortByRankingScore 移植 + 质量分位 q)
            ② 仓位  computeAlloc(fixed/signal_weighted/source_kelly)
            ③ 熔断  cooldown 移植 + drawdown 双触发
纯函数核(新)  portfolio-sim.ranking.ts · .sizing.ts · .cooldown.ts
注册表(新)    portfolio-sim.factor-registry.ts
持久化   portfolio_sim_fill +factor_values jsonb +rank_score numeric / runner 落库
```

## 配置契约(`portfolio-sim.types.ts` 扩展)

### 排序:rankSpec 统一,保留 legacy 字段

```text
PortfolioSimSource {
  runId, label, positionRatio, maxPositions, exposureCap   // 不变
  rankField: 'pos_120' | 'circ_mv' | 'none'                // 【保留】legacy 单字段
  rankDir:   'asc' | 'desc'                                 // 【保留】legacy 方向
  rankSpec?: RankSpec                                       // 【新增】存在且 factors 非空 → 接管排序
  sizing?:   SizingConfig                                   // 【新增】Phase 2,缺省 = fixed
}

RankSpec   = { factors: RankFactor[] }            // []=none, len1=单因子, len>1=composite
RankFactor = { factor: RankFactorKey; weight: number; dir: 'asc' | 'desc' }
```

- `RankFactorKey` 是注册表 keys 的联合类型(9 值),随 [02](./02-factor-registry.md) 的注册表派生。
- **引擎统一读 `rankSpec`**(经下文适配器),不再直接读 `rankField`。

### 仓位:SizingConfig(Phase 2)

```text
SizingConfig {
  mode: 'fixed' | 'signal_weighted' | 'source_kelly'   // 缺省 'fixed'
  floorMult: number    // signal_weighted 最差信号乘子,默认 0.5(须 >0)
  capMult:   number    // signal_weighted 最优信号乘子,默认 1.5(须 ≥ floorMult)
  kellyFraction: number  // source_kelly half-kelly 系数,默认 0.5,范围 (0,1]
  kellyMaxMult:  number  // source_kelly 乘子上限,默认 1.0,范围 (0,∞)
}
```

详见 [04-engine-sizing.md](./04-engine-sizing.md)。`fixed` 不读其余字段。

### 熔断:CircuitBreaker(Phase 3,挂 PortfolioSimConfig,账户级)

```text
PortfolioSimConfig {
  sources, initialCapital, cost, anchorMode      // 不变
  circuitBreaker?: CircuitBreaker                // 【新增】缺省 = 全关
}

CircuitBreaker {
  enableCooldown: boolean                        // 连亏熔断(移植 cooldown.ts)
  consecutiveLossesThreshold: number             // 连亏 N 笔触发,正整数
  baseCooldownDays: number                       // 基础冷却交易日数
  maxCooldownDays: number                        // 冷却上限(≥ base)
  extendOnLoss: number                           // 每次亏损延长天数(非负整数)
  reduceOnProfit: number                         // 每次盈利缩短天数(非负整数)
  enableDrawdownHalt: boolean                    // 回撤熔断
  drawdownHaltPct: number                        // 自峰值回撤 ≥ 此值停开仓,如 0.15
  drawdownResumePct: number                      // 回升到回撤 ≤ 此值恢复(滞回),须 ≤ haltPct
}
```

详见 [05-engine-circuit-breaker.md](./05-engine-circuit-breaker.md)。

## 引擎对象扩展(本节为类型单一真相)

```text
EngineTrade  +factorValues?: Record<RankFactorKey, number | null>   // composite 用;loader 装载
EngineFill   +rankScore?:    number | null                          // composite 综合分/单因子值(落 rank_score)
             +factorValues?: Record<RankFactorKey, number | null>   // 逐因子透明(落 factor_values jsonb)
SkipReason   新增 'cooldown' | 'drawdown_halt'   // Phase 3 熔断冻结
             新增 'sized_out'                     // Phase 2 source_kelly 负期望源 alloc≈0
```

- **rankValue 写入路径(更正一致性)**:`EngineTrade.rankValue`(现存 `number|null`)**仅作兼容保留**,
  新流程**不再由 loader 预写**(loader 统一 `rankValue:null`,见 [06](./06-loader-multifactor.md));
  综合分/单因子值由**引擎** `rankAndScore` 写入 `fill.rankScore`,runner 据 `rankScore` 落 `rank_value`/`rank_score`。
  老 run 重放时 `fill.rankValue` 才可能非 null(纯兜底)。
- **factorValues 透传时机**:在 fills 初始化阶段(`engine.ts:135-142`)即把 `trade.factorValues` 透传到
  `fill.factorValues`,**与开仓路径解耦**——使**熔断冻结日被 skip 的 fill 也带 factorValues**
  (满足「taken/skipped 都带」承诺,见 [05](./05-engine-circuit-breaker.md));`fill.rankScore` 在
  `rankAndScore` 时写(冻结日仍跑 rankAndScore 算分,只是不开仓)。
- **weightEntry 语义(更正)**:taken 时 `fill.weightEntry = alloc / navRef`(**有效权重** = `positionRatio×mult`),
  而非基线 `positionRatio`——使前端「权重」列与实际下注一致(见 [04](./04-engine-sizing.md)/[07](./07-service-and-frontend.md))。

## 向后兼容适配器(legacy rankField → rankSpec)

引擎与 loader 内部统一消费 `rankSpec`。装载/排序前经一个纯函数适配:

```text
resolveRankSpec(source): RankFactor[]
  if source.rankSpec?.factors?.length:  return source.rankSpec.factors      // 新配置优先
  if source.rankField === 'none':       return []                           // legacy none
  else: return [{ factor: source.rankField, weight: 1, dir: source.rankDir }] // legacy 单因子
```

效果:**老 run(只有 rankField/rankDir,无 rankSpec)一行不改照样跑、anchorMode 对账不破**;
`pos_120`/`circ_mv` 因已在注册表中,legacy 路径自然落到单因子分支。**runner 落库 `rank_field` 亦经此
适配派生**(见 [08](./08-persistence-and-migration.md))。

## anchorMode 不变量(全 spec 守住)

`anchorMode=true` 时(资金无限 + 无成本 + 全约束停用,见 `portfolio-sim.engine.ts:113-125`):

- **Phase 2 sizing 强制走 `fixed`**:`computeAlloc` 见 anchorMode 即返回 `positionRatio × navRef`。
- **Phase 3 熔断强制全旁路**:`enableCooldown` / `enableDrawdownHalt` 视为 false,闸门永不触发。
- 结果:每笔信号必 taken、`realizedRetNet ≡ ret`(代数恒等),既有 `engine.spec.ts` 锚点测试**零漂移**。

> 硬约束:任何 Phase 2/3 代码路径在 anchorMode 下都不得改变 taken 集合或 alloc 公式。
> 对应单测见 [09-tasks-and-validation.md](./09-tasks-and-validation.md#测试计划)。
