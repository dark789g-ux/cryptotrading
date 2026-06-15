# 不同市场 regime 下切换仓位设置 — 设计

> 日期：2026-06-15　|　状态：设计待实现　|　起点交接：[prompts/add-regime-conditional-position-sizing.md](../../../prompts/add-regime-conditional-position-sizing.md)

## 1. 目标与已定决策

给**组合模拟器**（`portfolio-sim`）+ **共用引擎的迷你回测**（`signal_test.backtestConfig`）加「按当日大盘 0AMV regime 切换仓位设置」：不同 regime 下用不同的 `maxPositions` + `positionRatio`。引擎/loader 共用，**一处实现两处受益**。

**Canonical 验收例子**（账户级两条规则）：

| 规则 | 条件（大盘 0AMV，AND） | maxPositions | positionRatio |
|---|---|---|---|
| 1 | `oamv_macd(柱) > 0` AND `oamv_dif > 0` | 2 | 0.45 |
| 2 | `oamv_macd(柱) < 0` AND `oamv_dif > 0` | 5 | 0.20 |

**brainstorming 已拍定的决策**（全部进设计，不再动摇）：

1. **自由条件列表**（非四象限）：regime = `RegimeRule[]`，每条 `{conditions, maxPositions, positionRatio}`，**按列表顺序首个全条件命中**生效。条件用 0AMV 字段（复用条件系统）。
2. **账户级**：一套 `regimes` 配在方案级，命中时覆盖**所有源**的 maxPositions/positionRatio。**消歧**：regime 的 `maxPositions` 对**每个源分别**生效（多源 → 最多 N×maxPositions 个仓，因引擎 slots_full 按 sourceIdx 过滤，engine.ts:438），**不是账户合计**；「整个组合最多 N 仓」是另一个更大的改动，不在本期范围。canonical 例子是单源，故此歧义不暴露。
3. **无匹配 / 缺数据 = 当天不开仓**（fail-closed 严格择时）：某日无 rule 命中、或 `oamv_daily` 当日缺行 / 引用列 NULL → 当天所有候选 skip、不开仓。
4. **regime 覆盖 base positionRatio**，`signal_weighted`/`source_kelly` 的 sizing mult **仍乘在其上**（fixed 时即 regime 比例直用）；regime 覆盖 `maxPositions`。`exposureCap`/`sizing`/`rankSpec` 仍取源配置。**regime 只换 base 比例，不额外 clamp**：`alloc = regimeRatio × mult × navRef`，mult 可 >1（capMult/kellyMaxMult），放大后是否超满仓交由既有 `exposureCap`/`cash_short` 兜底（与今天 sizing 放大同口径）。
5. **anchorMode 全旁路**（与现有约束一致），保 `realizedRetNet ≡ ret` 对拍恒等。
6. **零漂移**：`regimes` 空 / 缺省 → 完全走今天的路径（源静态 maxPositions/positionRatio），引擎逐位不变。这是合并门槛。

> ⚠️ **语义提醒**（已与用户确认）：配了 `regimes` 后，源行的静态 `maxPositions/positionRatio` 仅在「不配 regimes」时生效；配了之后匹配日用 regime 配置、未匹配日不开仓。即 regimes = 「择时闸门 + 调仓」二合一，必须覆盖所有想交易的市场状态。

## 2. 现状摸底（file:line 为证，已核实）

> 路径前缀：本节所有 `portfolio-sim.*.ts` 裸文件名均在 **`apps/server/src/strategy-conditions/portfolio-sim/`** 下（**不是** `strategies/`）；`signal-stats.*.ts` 在 `apps/server/src/strategy-conditions/signal-stats/`。

- **仓位单点** `computeAlloc`（`portfolio-sim.sizing.ts:47`）：`alloc = base × mult × navRef`；anchorMode 首行短路（:54-56，`return source.positionRatio × navRef`）。三 sizing 模式 fixed/signal_weighted/source_kelly。
- **maxPositions 执行点** `checkSkip`（`portfolio-sim.engine.ts:414-460`）：slots_full 分支（:437-441）`ownPositions = positions.filter(sourceIdx)` **纯按源卡**，无账户级。检查顺序 already_held→slots_full→exposure_cap→cash_short，均 `!anchorMode` 短路。
- **逐日主循环**（`engine.ts:212-355`）：① 出场（:216）② 熔断判定（`frozen` 在 :234 算完）③ 开仓（:238 起，`for s in sources` → `rankAndScore` → `for trade`：:248 `fill.rankScore=` → :250 `if(frozen)` skip → computeAlloc → checkSkip → 开仓/skip）④ 盯市 ⑤ 记录。**regime 解析天然位置 = :234 之后、:238 之前**。
- **anchorMode 旁路点**（6 处 `!anchorMode`）：费率清零(:131)、computeAlloc 短路、sized_out(:264)、checkSkip 四项、熔断闸门(:228-234)、registerExit(:197)。regime 必须同样包 `if(!anchorMode)`。
- **EngineInput**（`portfolio-sim.types.ts:214-219`）：`{config, trades, quotes, calendar}`，calendar 为唯一时间轴。**当前无大盘 0AMV 日序列**。`SkipReason` 是独立 union 在 **types.ts:278-285**（不在 EngineInput 块），`'regime_flat'` 加在此处。
- **oamv_daily**（真 DB 已核）：列 `trade_date varchar(8)`、`amv_dif / amv_dea / amv_macd / ma240`（均 `double precision` nullable）、`close/open/high/low`（`numeric(12,2)` NOT NULL）；**`amv_macd` 就是 0AMV MACD 柱(HIST)**；1155 行（20210901~20260612），**`amv_dif/amv_dea/amv_macd` 0 NULL，但 `ma240` 有 239 预热 NULL**（引用 `oamv_ma240` 的 rule 在预热段 fail-closed → no-open，与设计自洽）。
- **0AMV 字段映射** `ASHARE_MARKET_AMV_COL_MAP`（`strategy-conditions.types.ts:59`，:58 是 JSDoc）：`oamv_dif→oa.amv_dif / oamv_dea→oa.amv_dea / oamv_macd→oa.amv_macd / oamv_close→oa.close / oamv_ma240→oa.ma240`（**带 SQL 别名**）；大盘字段不支持 cross_above/below。注：本期 loader 直查 `oamv_daily` 裸列名（amv_dif…），**不复用此 map 取列**；map 只作「前端字段→列」白名单参照（求值器 OAMV_FIELD_MAP 用 §5 自己的映射）。
- **loader** `portfolio-sim.loader.ts`：`load()` 取 trades(:77)/quotes(:91)/calendar(:112)；`fetchSseCalendar`（:231-242）是「按日期范围单表取序列」的参照写法。
- **config jsonb 落库**：`portfolio_sim_run.config`（`portfolio-sim-run.entity.ts:39`）、`signal_test.backtest_config`（`signal-test.entity.ts:97-98`）。加 `regimes` 字段**免 migration**（宽 jsonb 加可选字段）。
- **signal_test 迷你回测复用 loader+引擎**：signal-stats runner 把 `backtestConfig` 组装成单源 `PortfolioSimConfig` 调 `portfolioSimLoader.load` + `runPortfolioSim`（见 memory `project_signaltest_minibacktest`）。故 loader/engine 改动自动惠及两处。
- **不复用 regime-engine service**：`classifyRegime`（`regime.classifier.ts:18`）是四象限纯函数，但本期走自由条件列表、不用它；regime-engine service 语义是「按象限选股」、且未 export，不引入耦合。
- **前端可复用**：`ConditionRows.vue`（条件构建器，`targetType='a-share'`）；`conditionFieldMeta.ts` A_SHARE_FIELDS 已含 0AMV 字段选项（`oamv_dif/oamv_dea/oamv_macd/oamv_close/oamv_ma240`，supportsCross=false）。

## 3. 数据流

```text
loader.load() 末尾新增第4步:
  fetchOamvSeries(minBuy, maxExit):
    SELECT trade_date, amv_dif, amv_dea, amv_macd, close, ma240
    FROM oamv_daily WHERE trade_date BETWEEN $1 AND $2 ORDER BY trade_date
  → EngineInput.oamvDaily: Map<tradeDate, OamvBar>

引擎逐日 d (engine.ts: 熔断判定后、开仓段前):
  regimeNoOpen = false; regimeOverride = null
  if (!anchorMode && config.regimes?.length) {
    bar = oamvDaily?.get(d) ?? null
    regimeOverride = resolveRegime(bar, config.regimes)   // 纯函数,首个全命中
    if (!regimeOverride) regimeNoOpen = true               // 无命中/缺数据
  }
  开仓 for s in sources / for trade:
    if (frozen)        → skip(cooldown/drawdown_halt)      // 既有,熔断优先
    else if (regimeNoOpen) → skip('regime_flat')           // 新增
    else:
      effMaxPositions  = regimeOverride?.maxPositions  ?? source.maxPositions
      effPositionRatio = regimeOverride?.positionRatio ?? source.positionRatio
      alloc = computeAlloc(trade, source, navRef, {...ctx, effectivePositionRatio: effPositionRatio})
      skip  = checkSkip(..., { ...opts, effectiveMaxPositions: effMaxPositions })
```

`regimes` 空/缺 → `regimeOverride=null, regimeNoOpen=false` → `eff* = source.*`（**今日行为逐位不变**）。

## 4. 配置与类型（`portfolio-sim.types.ts` 等）

```text
// 新增契约
interface OamvBar { amvDif: number|null; amvDea: number|null; amvMacd: number|null;
                    close: number|null; ma240: number|null }

interface RegimeRule {
  conditions: StrategyConditionItem[]   // 后端 {field,operator,value?,compareField?}(无 compareMode);0AMV-only,内部 AND;非空(校验)
  maxPositions: number                  // 正整数(有限,无 null「不限仓」档)
  positionRatio: number                 // (0,1]
}

// 扩展现有(均可选,缺省=零漂移)
PortfolioSimConfig.regimes?: RegimeRule[]
SignalTestBacktestConfig.regimes?: RegimeRule[]     // signal-test.entity.ts:28-47 接口
EngineInput.oamvDaily?: Map<string, OamvBar>
ComputeAllocCtx.effectivePositionRatio?: number     // 覆盖 base;缺=source.positionRatio
checkSkip opts.effectiveMaxPositions?: number|null  // 覆盖;缺=source.maxPositions
SkipReason 增 'regime_flat'  (types.ts:278-285)      // fills 标「regime 空仓」
```

> `computeAlloc` 用 `ctx.effectivePositionRatio ?? source.positionRatio` 作 base；**anchorMode 短路仍用 `source.positionRatio`**（regime 旁路）。`checkSkip` slots_full 用 `opts.effectiveMaxPositions ?? source.maxPositions`。两者缺省即今日值 → 零漂移。
> `portfolio_sim_fill.skip_reason` 是 `varchar(16)`，`'regime_flat'`（11 字符）天然容得下，**免列宽 migration**。

## 5. 求值器（新 `portfolio-sim.regime.ts`，纯函数）

```text
const OAMV_FIELD_MAP = { oamv_dif:'amvDif', oamv_dea:'amvDea',
                         oamv_macd:'amvMacd', oamv_close:'close', oamv_ma240:'ma240' }

evalOamvCondition(cond: StrategyConditionItem, bar: OamvBar): boolean
  // 后端 StrategyConditionItem = {field, operator, value?, compareField?}(无 compareMode!);
  // value vs 字段比较靠 compareField 是否存在区分(同 query-builder.ts:138 既有口径)
  lhs = bar[OAMV_FIELD_MAP[cond.field]]; 未知字段 / lhs==null → false (fail-closed)
  rhs = cond.compareField != null ? bar[OAMV_FIELD_MAP[cond.compareField]] : cond.value
        rhs==null / compareField 未知字段 → false (fail-closed)
  operator: gt/lt/gte/lte/eq/neq → 数值比较; 其它(cross_above/cross_below) → false (fail-closed)

resolveRegime(bar: OamvBar|null, regimes: RegimeRule[]): {maxPositions,positionRatio}|null
  if (!bar) return null                                  // 缺数据 → no-open
  for rule of regimes:
    if (rule.conditions.every(c => evalOamvCondition(c, bar)))   // 全 AND
      return { maxPositions: rule.maxPositions, positionRatio: rule.positionRatio }
  return null                                            // 无命中 → no-open
```

纯函数、零 DB、可单测。`conditions` 非空由校验保证（见 §7），故无「空条件 catch-all」。

## 6. loader / 引擎 / 迷你回测接线

- **loader**（`portfolio-sim.loader.ts`）：加 `fetchOamvSeries(start,end)`（照 `fetchSseCalendar` :231-242 写，单表按日期范围）。列类型混合：`close/open/high/low` 是 `numeric`（pg 驱动返回 **string**，须过既有 `parseNumericString`，loader-helpers:30），`amv_dif/amv_dea/amv_macd/ma240` 是 `double precision`（返回 **number**）；统一过 `parseNumericString` 对两者都安全，NULL 透传。**插入点**：`minBuy/maxExit` 在 `load()` :113-118 已算好（step3 之前），在 :118 之后调 `fetchOamvSeries(minBuy,maxExit)`，并把 `oamvDaily` 加进 :129-133 return 的 `input` 字面量（:130）。
  > calendar 尾部补齐（`extendCalendarTail`，loader.ts:120-127）可能在 maxExit 之后追加交易日，这些 appended 尾日落在 oamv 窗口 [minBuy,maxExit] 外、`oamvDaily.get(d)` 必 undefined；但 appended 尾日**无新买入**（买入都在 [minBuy,maxExit] 内），开仓段无候选，regime 解析在那些日**无影响**——故 oamv 窗口无需跟着补尾。
- **引擎**（`engine.ts`）：§3 的逐日 regime 解析（熔断 `frozen` 在 :234 算完后、开仓 `for s` :238 起之前）+ `eff*` 传入 computeAlloc/checkSkip。per-trade skip 排在现有 `if(frozen)`(:250) 之后做 `else if(regimeNoOpen)`，写 `fill.skipReason='regime_flat'`（与现有 skip 流 `fill.status='skipped';skipReason=...;continue` 同构）。**冻结优先于 regime**（frozen 日 skipReason 仍是 cooldown/drawdown_halt，不是 regime_flat）。
- **迷你回测**（signal-stats runner）：在组装单源 config 的 `buildSingleSourceConfig`（`signal-stats.runner.ts:369-392`）返回对象**账户级**补 `regimes: bc.regimes`（与 :390 `circuitBreaker` 同级，**不进 sources[0]**）；loader/engine 已惠及，无额外引擎改动。

## 7. 校验（DTO 层）

`regimes`（两处 config 各自校验，复用同一 validator）：

```text
每条 RegimeRule:
  conditions   非空数组;每项 field ∈ 5 个 0AMV 字段白名单(oamv_dif/dea/macd/close/ma240);
               operator ∈ {gt,lt,gte,lte,eq,neq}(禁 cross_above/cross_below);
               有 compareField → 它也在白名单;否则 value 为有限数(注:后端无 compareMode 字段,靠 compareField 存在性区分)
  maxPositions 正整数(有限,无「不限仓 null」档——与源静态 maxPositions 可为 null 不同,刻意收窄)
  positionRatio (0,1]
非法 → 中文 400。anchorMode=true 且配了 regimes:允许保存,运行时引擎静默旁路 regime(不 warn,与其它约束在 anchorMode 下旁路口径一致)。
```

落点：组合模拟 create dto 校验 + signal-stats `validateBacktestConfig`（复用同一 `validateRegimes`）。

## 8. 前端（两处，复用 ConditionRows）

新建 `apps/web/src/components/strategy/RegimeRulesEditor.vue`（共享，≤500 行）：regime 规则列表，每条 = `ConditionRows(targetType='a-share')`（用户只选 0AMV 字段）+ `maxPositions`(n-input-number 正整数) + `positionRatio`(n-input-number 0~1) + 增删；空列表 = 不启用。

```text
┌ RegimeRulesEditor ───────────────────────────────────┐
│ regime 调仓 (空=不启用,按顺序首个命中)        [+ 规则] │
│ ┌ 规则1 ─────────────────────────────────────[删]┐  │
│ │ 条件(0AMV): [ConditionRows]                     │  │
│ │ 最大持仓 [2]   单票仓位 [0.45]                   │  │
│ └─────────────────────────────────────────────────┘  │
│ ┌ 规则2 … ┐                                          │
│ ⚠ 提示:启用后未命中市场状态当天不开仓                 │
└───────────────────────────────────────────────────────┘
```

落点：
- 组合模拟 [PortfolioSimCreateModal.vue](../../../apps/web/src/components/portfolio-sim/PortfolioSimCreateModal.vue) 熔断 section（:104-115）之后；`onSubmit` 的 `dto.config` 组装（:322-334）加 `regimes`。熔断用 `reactive+DEFAULT` 模式（:185/:235），RegimeRulesEditor 仿此装配。
- 迷你回测 [SignalTestRiskSection.vue](../../../apps/web/src/components/strategy/form/SignalTestRiskSection.vue) 的 `enableBacktest` v-if 块内、熔断之后（实现前核该块真实结构）；经 `useSignalTestForm` 组装进 `backtestConfig.regimes`。
- 前端类型：`api/modules/strategy/portfolioSim.ts`（CreatePortfolioSimDto 等）、`composables/strategy/useSignalTestForm.ts` 各加 `regimes`。

## 9. 阶段与文件域

```text
M1 后端引擎核(依赖少,先行)
  types.ts(RegimeRule/OamvBar/扩展) + 新 portfolio-sim.regime.ts(resolveRegime纯函数)
  + sizing.ts(effectivePositionRatio) + engine.ts(逐日解析+eff*+regime_flat) + 单测
M2 后端 loader + 迷你回测接线 + DTO 校验(依赖 M1 types)
  loader.ts(fetchOamvSeries) + signal-stats runner(透传 regimes) + 两处 validateRegimes + 单测
M3 前端(依赖 M1/M2 契约)
  RegimeRulesEditor.vue + PortfolioSimCreateModal + SignalTestRiskSection + 前端类型 + vitest
M4 真机 e2e + 零漂移/对拍恒等门禁
```

M1/M2 后端串行（共享 engine/types），M3 前端在契约定后并行；e2e 收口。

## 10. 验证标准

- **单测**：`resolveRegime`（命中/首个优先/无命中/bar=null/字段 NULL→fail-closed/compareField 比较）；`evalOamvCondition` 各 operator（gt/lt/gte/lte/eq/neq）；`computeAlloc` 用 `effectivePositionRatio`；`checkSkip` 用 `effectiveMaxPositions`；DTO `validateRegimes`（非空条件/白名单字段/区间/正整数）。纯函数零 DB。
- **优先级不变量（单测）**：**frozen 优先于 regime**——熔断冻结日即使 regime 无命中，`skipReason` 必为 `cooldown`/`drawdown_halt`，**不得**是 `regime_flat`。
- **零漂移**：`regimes` 空/缺 → 引擎输出与改造前逐位一致（现有锚点 run 对拍）。
- **anchorMode 恒等**：带 regimes 但 anchorMode=true → regime 全旁路、`realizedRetNet ≡ ret`。
- **真机 e2e（路径有讲究）**：配 canonical 例子两 regime，跑一段 0AMV 数据齐全区间。
  - **逐笔 `regime_flat` 验证须走「组合模拟」run**（它落 `portfolio_sim_fill.skip_reason`）：查 fills——`oamv_macd>0&oamv_dif>0` 日 ≤2 仓每仓≈45%×NAV；`oamv_macd<0&oamv_dif>0` 日 ≤5 仓每仓≈20%；未配规则的日（如 `oamv_macd>0&oamv_dif<=0`）逐笔 `regime_flat`。
  - **迷你回测侧（signal-stats）不持久化 EngineFill**（只落 `signal_test_run` summary 11 列 + `signal_test_trade`），故 regime_flat 在迷你回测**只反映在 summary `nSkipped` 增量 + equity 空仓段**，查不到 per-fill skip_reason——迷你回测 e2e 改核 `nTaken/nSkipped` + 净值曲线在未配规则日横平（无新开仓）。

## 11. 硬约束

- 零漂移（§1.6）+ anchorMode 对拍恒等是合并门槛。
- 引擎/求值器纯函数，零 DB（regime 数据由 loader 装入 EngineInput）。
- 字段列名落源头：0AMV 柱=`amv_macd`、DIF=`amv_dif`、DEA=`amv_dea`、年线=`ma240`（`oamv_daily`），loader 的 `fetchOamvSeries` 直查这些**裸列**；求值器用 §5 的 `OAMV_FIELD_MAP`（前端字段 `oamv_macd`→`OamvBar.amvMacd`）。写 SQL/求值器前再核真实列名，禁二手转述。
- 单文件 ≤500 行；源文件 UTF-8；config jsonb 改动免 migration（仅扩接口可选字段）；后端改 `apps/server` 须重启进程再验证；改 `.vue` 合并前跑 `vite build`。
- 共用引擎双向影响：动 `engine/sizing/types/loader/regime` 会同时影响组合模拟与迷你回测，两边单测（portfolio-sim / signal-stats）须保持绿，对拍恒等不破。
