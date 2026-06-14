# 05 · 引擎熔断段(连亏 + 回撤双触发)

新文件 `portfolio-sim.cooldown.ts`(移植 `backtest/engine/cooldown.ts` 本地副本);
`portfolio-sim.engine.ts` 逐日循环接入。账户级(跨所有 source 合并),配置在
`PortfolioSimConfig.circuitBreaker`(见 [01](./01-overview-and-data-model.md#熔断circuitbreakerphase-3挂-portfoliosimconfig账户级))。

## 双触发闸门在循环里的位置

```text
peak = -Inf;  ddHalted = false   # 回撤熔断状态(滞回)
cooldown = initCooldown(base)    # 连亏熔断状态机
for (dayIdx, d) in enumerate(calendar):
   # ① 出场 exitDate==d:每笔 closePosition 收口后 recordExit(...)              ← 采集连亏(见下)
   # ── 开仓前账户级闸门(anchorMode 全跳过):
   frozenCooldown = cb.enableCooldown   && isInCooldown(cooldown, dayIdx)
   ddNow          = peak>0 ? prevNav/peak - 1 : 0        # prevNav = NAV(d-1)
   ddHalted       = updateDrawdownHalt(ddHalted, ddNow, cb)   # 滞回,见下
   frozenDD       = cb.enableDrawdownHalt && ddHalted
   if !anchorMode && (frozenCooldown || frozenDD):
       per source: rankAndScore(dayCands, source)        # 仍算 fill.rankScore(透明),只是不开仓
       当天所有 dayBuys 候选 → fill.status='skipped',
         skipReason = frozenCooldown ? 'cooldown' : 'drawdown_halt'   # 二者皆触发优先记 cooldown
       跳过 ② 开仓
   else:
       ② 开仓(排序/sizing/checkSkip 照常)
   # ② 内同日 round-trip(exitDate==buyDate)开仓后立即 closePosition 收口 → 也 recordExit  ← 见下
   # ③ 盯市  ④ 记录:更新 nav;peak = max(peak, nav)
```

- **回撤判定用 `prevNav`**(= NAV(d-1),`engine.ts:154` `navRef=prevNav`)与历史 `peak` 比;`peak` 在 ④
  记录用 `nav`(当日收盘)更新。即「昨日收盘回撤」驱动「今日是否开仓」,**无未来函数**。
- **冻结日仍跑 rankAndScore**:保证被冻结 skip 的 fill 也带 `rankScore`/`factorValues`(`factorValues`
  在 fills 初始化即透传,见 [01](./01-overview-and-data-model.md#引擎对象扩展本节为类型单一真相))→ 满足「taken/skipped 都带」承诺。

## recordExit 必须覆盖两处收口点(关键)

引擎现有**两处** `closePosition` 调用:① 跨日出场分支(`engine.ts:158-164`)、② 同日 round-trip
(`exitDate===buyDate`,开仓后立即收口,`engine.ts:212-219`)。**连亏采集必须两处都做**,否则当日开当日平
的笔盈亏漏记、连亏计数系统性偏差。

```text
recordExit(pos, dayIdx):                    # 紧跟在每个 closePosition 之后调用,恰一次
   isWin = pos.fill.realizedRetNet > 0      # 净收益口径(见下);closePosition 已写回 realizedRetNet
   if cb.enableCooldown && !anchorMode:
       registerExit(cooldown, isWin, /*isHalf*/false, dayIdx,
                    threshold, maxDays, extendOnLoss, reduceOnProfit)
```

- **实现建议**:把 `closePosition + recordExit` 收敛成一个内联块或 helper,确保两处收口点都触发、且每笔恰一次。
- 同日 round-trip 的 recordExit 发生在 ② 开仓块内(当日闸门已判过)→ 只影响**后续**交易日的冻结,语义一致。

## win 口径(统一为净收益,消除自相矛盾)

`isWin = pos.fill.realizedRetNet > 0`(**净收益,含买卖成本**),**两处伪码一致**(更正原 line14 的 `ret>0`)。
熔断应按净亏触发:毛赚但成本吞噬后净亏的笔(`ret>0` 但 `realizedRetNet≤0`)计为**亏损**。
故 `recordExit` 必须在 `closePosition` 写回 `fill.realizedRetNet` 之后调用。

## cooldown 移植(本地副本)

逐行移植 `backtest/engine/cooldown.ts`(K 线无关,纯状态机),**barIdx 语义换成「交易日序号 dayIdx」**:

```text
CooldownState { consecLosses; cooldownDuration; cooldownUntilBarIdx: number|null }
initCooldown(baseCooldownDays) -> CooldownState
registerExit(state, isWin, isHalf, dayIdx, threshold, maxDays, extendOnLoss, reduceOnProfit) -> void
isInCooldown(state, dayIdx) -> boolean      # 到期自动解除(清 consecLosses / until)
```

- 配置映射:`baseCooldownCandles→baseCooldownDays`、`maxCooldownCandles→maxCooldownDays`,其余同名。
- **`isHalf` 恒 false**:portfolio-sim 无半仓概念,每笔出场整笔。
- **账户级合并**:跨所有 source 的出场共用一个 `cooldown` state(组合级熔断,非 per-source)。
- **不直接 import backtest 的 cooldown.ts**(跨市场模块耦合不当);复制为本地副本,算法逐行对齐 +
  单测对拍(见 [09](./09-tasks-and-validation.md))。

## 回撤熔断(滞回)

```text
updateDrawdownHalt(prevHalted, ddNow, cb): boolean
  # ddNow ≤ 0(回撤为负值);drawdownHaltPct/ResumePct 为正
  if !prevHalted && ddNow <= -cb.drawdownHaltPct:    return true    # 跌破触发线 → 停
  if  prevHalted && ddNow >= -cb.drawdownResumePct:  return false   # 回升到恢复线内 → 复
  return prevHalted                                                 # 滞回区维持原态
```

- 默认 `drawdownHaltPct=0.15`(自峰值 -15% 停)、`drawdownResumePct=0.10`(回升到 -10% 内复)。
- **滞回**避免阈值附近反复抖动;`Resume ≤ Halt` 由 service 校验保证。

## 新 skipReason

`SkipReason` 增 `'cooldown' | 'drawdown_halt'`(进现有 `portfolio_sim_fill.skip_reason` varchar(16),
已核**无 CHECK 约束**;`'drawdown_halt'` 13 字 ≤ 16)。这两值连同 Phase 2 的 `'sized_out'` 须同步登记到
后端 `VALID_SKIP_REASONS` 读路径白名单与前端中文标签(见 [07](./07-service-and-frontend.md))。

## anchorMode 不变量

`if !anchorMode && (frozenCooldown||frozenDD)`、`recordExit` 内 `!anchorMode` ——anchorMode 下闸门
**永不触发**、连亏也不采集,每笔必 taken、`realizedRetNet≡ret` 守住。

## 单测要点

- cooldown 本地副本 vs `backtest/engine/cooldown.ts` 原版**对拍**:同输入序列产出同 state 轨迹。
- 连亏 N 笔→冻结后续 dayIdx;盈利缩短;自然到期解除。
- **同日 round-trip 连亏**:含 `exitDate===buyDate` 亏损笔的序列,断言其计入连亏(覆盖第二个收口点)。
- **win 口径**:`ret>0` 但 `realizedRetNet≤0` 的临界笔按**亏损**计。
- drawdown:跌破 haltPct 停、滞回区维持、回升到 resumePct 复;`peak` 用 nav 推进。
- 双触发:两者皆 true 记 `cooldown`;**冻结日全候选 skipped 且 fill 仍带 factorValues/rankScore**。
- anchorMode:任意 circuitBreaker 配置下 taken 集合不变(恒等测试)。
