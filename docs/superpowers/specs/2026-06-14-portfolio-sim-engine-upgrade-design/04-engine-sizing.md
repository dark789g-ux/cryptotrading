# 04 · 引擎仓位段(动态仓位三模式)

新文件 `portfolio-sim.sizing.ts`(纯函数);`portfolio-sim.engine.ts` 仓位处接入。

## 为什么不能照搬 backtest per-trade 凯利

backtest 是**单策略串行**下注,凯利 `(b*p−q)/b` 给单笔仓位无虞。portfolio-sim 是**一天上百并发信号**:
若每笔押 13%,几百个并发 = 几百倍杠杆,毫无意义。所以组合级 sizing 重新定义为「**在 positionRatio
基线上乘一个 [0, cap] 的乘子**」,总敞口仍受 `exposureCap`/`maxPositions`/`cash_short` 卡死——
sizing 只决定**单票相对大小**,不放大总杠杆。

## computeAlloc 纯函数契约

现状:`alloc = source.positionRatio * navRef` 在**两处**算(`engine.ts:186` 开仓 + `engine.ts:328`
checkSkip)。**必须抽成单一纯函数**让两处共用同一 alloc,否则 exposure/cash 判定与实际下注脱节。
**第 4 参为 ctx 对象**(与调用点一致,见 [03](./03-engine-ranking.md#逐日循环里排序的位置不改既有顺序)):

```text
computeAlloc(trade, source, navRef, ctx): number
  ctx = { anchorMode: boolean; qualityByTrade: Map<EngineTrade, number>; sourceKellyMult?: number }
  if ctx.anchorMode:  return source.positionRatio * navRef        // 不变量:anchorMode 强制 fixed
  mode    = source.sizing?.mode ?? 'fixed'
  base    = source.positionRatio
  factors = resolveRankSpec(source)            // 判 none(空)
  switch mode:
    'fixed':           mult = 1
    'signal_weighted': mult = (factors.length === 0) ? 1                              // none → 真 fixed
                              : floorMult + (capMult - floorMult) * (qualityByTrade.get(trade) ?? 0.5)
    'source_kelly':    mult = ctx.sourceKellyMult ?? 1            // 预算一次,见下
  return base * mult * navRef
```

- **checkSkip 与开仓必须传入完全相同的 `computeAlloc` 结果**(任务 T3:把 alloc 提到调用点算一次,
  传给 checkSkip 和开仓块,删除 checkSkip 内重复计算)。

## fixed(默认,零漂移)

`mult = 1` → `alloc = positionRatio × navRef`,与现状逐位一致。未配置 `sizing` 时走此路 → 既有 run 零漂移。

## signal_weighted(信号强度加权)

```text
q    = qualityByTrade.get(trade)        # 日内质量分位 ∈[0,1],1=最优(来自 rankAndScore,见 03)
mult = floorMult + (capMult - floorMult) * q     # 最差→floorMult,最优→capMult
alloc= positionRatio * mult * navRef
```

- 默认 `floorMult=0.5, capMult=1.5`:最优信号 1.5× 基线、最差 0.5×。好信号抢更多容量、差信号让位。
- 总敞口安全:`exposureCap`/`slots`/`cash_short` 仍在 `computeAlloc` 之后照常判定(用同一 alloc)。
- **`none` 排序时强制 `mult=1`**(显式 fixed),**不**走 `(floor+cap)/2`——否则非对称 floor/cap 会让
  「不排序」整体放大/缩小,与用户意图相悖(审阅指出的参数依赖巧合)。
- `floorMult>0`(校验保证)→ signal_weighted 的 `mult ≥ floor > 0`,**永不产生 alloc=0**。

## source_kelly(源级历史凯利,一源一标量)

每个 source 用**自身全逐笔 `ret`** 离线算一个静态凯利乘子(非 per-trade),装载期预算一次:

```text
# 引擎 init 阶段,per source(sizing.mode==='source_kelly'):
rets  = trades.filter(sourceIdx===s).map(t => t.ret)
stats = calcSignalStats(rets, rets.map(()=>1))      # 复用现成函数(engine.ts:21 已 import)
kf    = stats.kellyF
# kellyF=null 有三类来源(已核 metrics.ts:62-83:kellyF=null ⟺ payoffRatio=null ⟺
#   avgWin=null 无盈利样本(全亏/全平) 或 avgLoss=null 无亏损样本(全胜/全平));
#   必须按 avgWin/avgLoss 分流,不能一律当"优质"(全亏源也 kellyF=null!):
if kf != null:
    mult = (kf <= 0) ? 0 : clamp(kf * kellyFraction, 0, kellyMaxMult)   # 负期望→0(sized_out);正→clamp
else:                                                                    # kellyF 未定义
    if stats.avgWin == null && stats.avgLoss != null:                    # 全亏源(有亏无盈)→ 最差
        mult = 0                                                         # → alloc≈0 → sized_out
    else:                                                                # 全胜/全平/样本不足 → 无法定凯利
        mult = 1; logger.warn(`source #${s} kellyF=null(全胜/全平/样本不足),source_kelly 退化 fixed`)
sourceKellyMult[s] = mult
```

- 复用 `calcSignalStats(...).kellyF`,不重造凯利公式。`ret===0` 的笔在 calcSignalStats 里既不计 win 也
  不计 loss(`r>0`/`r<0` 过滤)——口径透传,不另处理。
- **`kellyF=null` 须再分流**(它由「全胜=avgLoss 空」「全亏=avgWin 空」「全平/样本不足」三类共同触发,
  **不可一律当优质**):**全亏源**(`avgWin==null && avgLoss!=null`,最差)→ `mult=0`(sized_out);
  **全胜/全平/样本不足**(无法定凯利)→ `mult=1`(中性 fixed,**不惩罚**) + warn。仅此分流后,
  「`mult=0` ⟺ 真负期望(`kellyF<0`)或全亏源」才成立。
- 一源一标量 → 无并发杠杆问题;`kellyFraction`(默认 0.5)、`kellyMaxMult`(默认 1.0)双重 clamp。

### alloc≈0 → skipReason `sized_out`

只有 source_kelly 的 `mult=0`(真负期望源)会产生 `alloc≈0`。**定稿**(删除原「待确认」):

```text
MIN_ALLOC_YUAN = 1            // 最小有效下注(元)
开仓块:若 !anchorMode 且 alloc < MIN_ALLOC_YUAN → fill.status='skipped', skipReason='sized_out'
```

- 新增 `SkipReason 'sized_out'`(9 字,进 varchar(16),无 CHECK;登记于 [01](./01-overview-and-data-model.md#引擎对象扩展本节为类型单一真相)
  类型、[07](./07-service-and-frontend.md) 校验+前端标签+`VALID_SKIP_REASONS`、[08](./08-persistence-and-migration.md) 实体、[09](./09-tasks-and-validation.md) 测试)。
- fill 记 `alloc=0`(可辨识),不参与持仓/盯市。
- signal_weighted 因 `mult≥floor>0` 永不触发 `sized_out`,故该分支只 source_kelly 可达。

## weightEntry 语义(更正)

taken 时 `fill.weightEntry = alloc / navRef`(**有效权重** = `positionRatio×mult`),取代现
`engine.ts:193` 的 `source.positionRatio`。使前端「权重」列(`PortfolioSimFillsTable.vue` 按 `weightEntry×100%`
渲染)与实际下注一致,且 `weightEntry×navRef ≡ alloc`(逐因子透明面板自洽)。

## anchorMode 不变量

`computeAlloc` 首行 `if anchorMode: return positionRatio*navRef`——sizing 任何模式在 anchorMode 下
都短路为 fixed,`realizedRetNet ≡ ret` 守住(见 [01](./01-overview-and-data-model.md#anchormode-不变量全-spec-守住))。

## 单测要点

- fixed:输出 == 现 `positionRatio*navRef`(零漂移回归)。
- signal_weighted:q=0→floorMult、q=1→capMult、q=0.5→中点;**none→mult=1**;checkSkip 用同一 alloc。
- source_kelly:已知 p/b 的 rets → mult==clamp(kf·frac,0,max);**全胜源(avgLoss=null)→mult=1**;
  **全亏源(avgWin=null)→mult=0 且 sized_out**;**负期望 kellyF<0→mult=0 且信号 sized_out**(alloc<MIN)。
- weightEntry:taken 时 == alloc/navRef(非基线 positionRatio)。
- anchorMode:任意 sizing.mode 下 alloc 都 == fixed(恒等测试)。
