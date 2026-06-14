# 03 · 引擎排序段(composite 多因子加权)

新文件 `portfolio-sim.ranking.ts`(纯函数,不依赖 DB/NestJS);`portfolio-sim.engine.ts` 排序处接入。

## 逐日循环里排序的位置(不改既有顺序)

既有顺序「① 出场 → ② 开仓 → ③ 盯市 → ④ 记录」**不变**。排序在 ② 开仓内,
`portfolio-sim.engine.ts:168-173` 处——按 (天 × source) 对当日同源候选集调用。**关键已核**:
`sortCandidates` 当前就是按 (天,source) 调用(`engine.ts:170`),所以 composite「日内独立排名」
横截面 = 当日该源候选集,粒度天然正确。

```text
② 开仓(per d,未冻结):
   for s in sources:
     dayCands = dayBuys.filter(sourceIdx===s)
     { sorted, scoreByTrade, qualityByTrade } = rankAndScore(dayCands, source)   ← 本文件
     for trade in sorted:
       trade.fill.rankScore = scoreByTrade.get(trade) ?? null   // 落 rank_value/rank_score
       // fill.factorValues 已在 fills 初始化阶段透传(见 01,frozen 日也带)
       alloc = computeAlloc(trade, source, navRef,
                            { anchorMode, qualityByTrade, sourceKellyMult: sourceKellyMult[s] })  // ← 04
       checkSkip(... 同一 alloc ...) → 开仓
```

> `rankAndScore` **取代**现 `sortCandidates`(后者可保留为薄包装减小 diff,或直接替换——见任务 T2)。
> **熔断冻结日**:仍调 `rankAndScore` 写 `fill.rankScore`(透明),但跳过开仓循环(见 [05](./05-engine-circuit-breaker.md))。

## rankAndScore 契约

```text
rankAndScore(trades: EngineTrade[], source: PortfolioSimSource): {
  sorted:        EngineTrade[]                 // 已排序候选(开仓遍历顺序;最优在前)
  scoreByTrade:  Map<EngineTrade, number|null> // 综合分(composite)/单因子值(single)/null(none)
  qualityByTrade:Map<EngineTrade, number>      // 日内质量分位 ∈[0,1],1=最优(供 signal_weighted sizing)
}
```

- `factors = resolveRankSpec(source)`(见 [01](./01-overview-and-data-model.md#向后兼容适配器legacy-rankfield--rankspec))。
- `factors.length === 0`(none):`sorted` = 按 ts_code 升序;`scoreByTrade` 全 null;`qualityByTrade` 全 0.5。
- `factors.length === 1`(单因子):退化路径,见下。
- `factors.length > 1`(composite):`sortByRankingScore` 移植,见下。

## 质量分位 qualityByTrade(钉死公式)

`signal_weighted` 仓位 `mult = floor + (cap−floor)×q` 的唯一输入。**基于最终 `sorted` 的名次**
(与 `scoreByTrade` 解耦,避免量纲/异常值干扰):

```text
对 sorted(最优在 index 0)中第 rankIndex 个候选:
  q = (sorted.length > 1) ? (n - 1 - rankIndex) / (n - 1) : 1.0     # n = sorted.length
  # 最优 rankIndex=0 → q=1;最差 rankIndex=n-1 → q=0;单候选 n=1 → q=1.0(约定满分)
  none 模式(factors 为空):q 全 = 0.5(中性;且 signal_weighted 对 none 直接退化 mult=1,见 04)
```

- `sorted` 经下文「平名次处置」后对平局用 ts_code 二级键确定排位 → `rankIndex` 确定 → q 确定可复现。
- null 殿后的候选自然落在 `sorted` 末段 → q 趋近 0(合理:缺质量信息者少配)。

## 单因子退化(等价现行为)

读 `factors[0] = {factor, weight, dir}`,候选的因子值取 `trade.factorValues[factor]`:

- 有值排前、按 `dir`(asc/desc)排序、平局 ts_code 升序、**null 殿后**。与现 `sortCandidates`
  (`engine.ts:74-94`)逐位一致 → 既有单因子用例零行为漂移(回归测试守)。
- `scoreByTrade` = 该因子值(null 保留 null);`qualityByTrade` = 上述名次分位。

## composite:sortByRankingScore 移植(确定性版)

移植 `backtest/engine/signal-scanner.ts:87-119`,**修正平名次/ null 计分的非确定性**:

```text
sortByRankingScore(cands, factors):
  n = cands.length;  if n<=1: trivial
  totalWeight = Σ factors.weight;  if totalWeight<=0: 退化为 ts_code 序
  score = Map<trade, number> init 0
  for f in factors:
    # 1) 该因子独立排名:有值者按 (f.dir, 再 ts_code asc) 排;null 者全部并列殿后
    valued  = cands.filter(c => c.factorValues[f.factor] != null)
                   .sort((a,b) => byValue(a,b,f.dir) || tsCodeAsc(a,b))   # ts_code 二级键 → 确定
    nullish = cands.filter(c => c.factorValues[f.factor] == null)
    # 2) 计分:同值(含全部 null)并列 → 用「组首名次」统一计分,而非按数组位置给相异分
    assignGroupRankScore(valued, score, f.weight, n)   # 见下「并列同分」
    nullScore = (n - valuedCount) * f.weight           # null 组并列最低档(殿后同一分)
    nullish.forEach(c => score[c] += nullScore)
  # 3) 综合分降序(归一 ÷ totalWeight),平局 ts_code 升序
  sorted = [...cands].sort((a,b) => (score[b]-score[a]) || tsCodeAsc)
  scoreByTrade = score[c] / totalWeight
```

### null 与平名次处置(并列同分)

- `assignGroupRankScore`:遍历已排序的 `valued`,**因子值相等的连续段视为一组**,组内所有成员赋同一
  `(n − groupStartRank)` 分(组首名次),而非按数组位置递减——保证同值候选同分、不受输入顺序影响。
- `nullish` 全部并列,赋同一最低档 `(n − valuedCount)`(排在所有有值者之后)。
- 若某候选**全部因子皆 null**:每因子都拿 null 组分 → 综合分最低 → 排在末位(合理且确定)。

## 输出落库映射

| 引擎字段 | 落库列(portfolio_sim_fill) | 取值 |
|---|---|---|
| `fill.rankScore` | `rank_score`(新列,见 [08](./08-persistence-and-migration.md)) | composite 综合分 / 单因子值 / null |
| `fill.rankValue`(现存) | `rank_value` | runner 写 `fill.rankScore`(兼容旧列;不再由 loader 预写) |
| `fill.factorValues` | `factor_values`(新 jsonb 列) | `{factorKey: value\|null, ...}`(fills 初始化即透传) |
| `rank_field`(现列) | `rank_field` | composite→`'composite'`;单因子→factor key;none→`'none'`(runner 经 resolveRankSpec 派生) |

## 单测要点(见 [09](./09-tasks-and-validation.md#测试计划))

- composite 三因子构造集:手算综合分,断言排序与 `scoreByTrade`。
- **平名次/ null 确定性**:构造同值因子 + 同 null 候选,断言其 `scoreByTrade` 相等、两次运行结果一致(对照按位给分的反例)。
- **全因子 null 候选**:排末位、综合分最低。
- **质量分位**:`q`(最优=1、最差=0、n=1=1.0、none=0.5)。
- 单因子退化 == 现 `sortCandidates` 输出(同输入逐位等价);none:纯 ts_code 序、score 全 null。
