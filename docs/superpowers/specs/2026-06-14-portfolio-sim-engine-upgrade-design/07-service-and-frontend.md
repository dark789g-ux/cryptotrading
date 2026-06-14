# 07 · service 校验 + 后端读路径 + 前端

## service 校验(`portfolio-sim.service.ts`)

`validateCreateDto`(现 `:211-304`,rankField 白名单在 `:42`、校验 `:266-268`)扩展:

```text
# 1) 排序:rankSpec(若提供)优先,否则 legacy rankField
if src.rankSpec:
  for f in src.rankSpec.factors:
    f.factor ∈ VALID_RANK_FACTOR_KEYS            # 注册表 keys 派生(02),否则 400
    f.weight > 0                                 # 否则 400
    f.dir ∈ {'asc','desc'}                       # 否则 400
    if !REGISTRY[f.factor].histAvailable: logger.warn(`${tag}.factor=${f.factor} 历史不足,仅前向`)  # ml_score
  # factors 允许为 []（= none）
else:
  src.rankField ∈ (VALID_RANK_FACTOR_KEYS ∪ {'none'})   # legacy 兼容;rankDir ∈ {asc,desc}

# 2) 仓位 sizing(若提供):
src.sizing.mode ∈ {'fixed','signal_weighted','source_kelly'}
if mode==='signal_weighted': floorMult>0, capMult≥floorMult
if mode==='source_kelly':    kellyFraction∈(0,1], kellyMaxMult>0

# 3) 熔断 circuitBreaker(若提供,config 级):
if enableCooldown: consecutiveLossesThreshold≥1(整数), 0≤base≤max, extendOnLoss≥0, reduceOnProfit≥0
if enableDrawdownHalt: 0<drawdownHaltPct<1, 0≤drawdownResumePct≤drawdownHaltPct
```

- 非法一律 `BadRequestException`(400),消息含字段 tag(沿用现风格)。
- `VALID_RANK_FACTOR_KEYS = new Set(Object.keys(RANK_FACTOR_REGISTRY))`(02),`'none'` 仅 legacy 路径放行。

## 后端 fills 读路径白名单(易漏!`portfolio-sim.list-fills-options.ts`)

`buildFillListOptions`(`:52-57 VALID_SKIP_REASONS`,门控在 `:106`)按 skipReason 过滤 fills。该 Set 现只有
4 值,**必须加 3 个新原因**,否则用户按新原因筛选时后端**静默丢弃过滤条件**(返回全部、无 warn):

```text
VALID_SKIP_REASONS += 'cooldown', 'drawdown_halt', 'sized_out'
```

- 该函数已有 `list-fills-options.spec.ts` 覆盖 → 加按新原因筛选命中的断言(任务 T6)。

## dto(`dto/create-portfolio-sim.dto.ts`)

镜像 types 的新字段:`rankSpec?`、`sizing?`(per source)、`circuitBreaker?`(config 级)。
沿用现有风格(宽松 dto + service 手校)。

## 前端

### 类型镜像(`apps/web/src/api/modules/strategy/portfolioSim.ts`)

- `PortfolioRankField`(现 `:14`)→ 增 `PortfolioRankFactorKey`(9 值)、`RankSpec`/`RankFactor`/
  `SizingConfig`/`CircuitBreaker` 接口,与后端 types **逐字段镜像**。
- **`PortfolioSkipReason`(现 `:125-129`,4 值闭合联合)→ 加 `'cooldown' | 'drawdown_halt' | 'sized_out'`**;
  否则 `ListFillsParams.skipReason` 传新值 type 报错。
- fill 详情类型增 `rankScore`/`factorValues`。

### 选项 / 标签常量(`portfolioSimPresets.ts`)

- `RANK_FIELD_OPTIONS`(现 `:118-122`)→ 扩为 `RANK_FACTOR_OPTIONS`(9 因子,带 label + histAvailable 标记)、
  `SIZING_MODE_OPTIONS`、熔断默认值常量。ml_score 选项 label 标「⚠️历史仅2天·前向专用」。
- **`SKIP_REASON_LABELS`(现 `:124-129`,4 键)→ 加** `cooldown:'连亏熔断'`、`drawdown_halt:'回撤熔断'`、
  `sized_out:'凯利归零'`。`FillsTable` 的筛选下拉(`:118-120` 由 `Object.keys(SKIP_REASON_LABELS)` 派生)
  与原因列渲染(`:202`)随之自动带上新值。

### 组件拆分(≤500 行硬约束)

`PortfolioSimSourceRow.vue` 现 312 行,加多因子编辑器 + sizing 会顶破 500 → **抽子组件**:

```text
PortfolioSimSourceRow.vue (瘦身)
  ├─ RankSpecEditor.vue   (新)  多因子行:[因子下拉][权重][方向] ×N + 增删
  └─ SizingFields.vue     (新)  mode 下拉 + 条件字段(floor/cap 或 kellyFraction/max)
PortfolioSimCreateModal.vue (现 391 行)
  └─ CircuitBreakerPanel.vue (新) 账户级:连亏组 + 回撤组开关与阈值
PortfolioSimFillsTable.vue  (现 284 行)
  └─ 加 rank_score 列 + 逐因子展开(读 factor_values);rank值列按 rank_field 分支渲染
```

- **lint:quant-lines 覆盖修复**:已核 `scripts/check-quant-vue-line-count.mjs` 的 ROOTS 仅
  `views/quant`+`components/quant`,**不含** `components/portfolio-sim`/`views/strategy`。任务 T8 须把这两个
  目录**加进 ROOTS**,让本期新组件 ≤500 行受 CI 强制(否则 09 门禁对它们是虚假保证)。
- ASCII 线框(实现参考,不入代码):

```text
信号源 #1
  runId[__] label[__] posRatio[0.03] maxPos[30] expCap[0.9]
  排序 rankSpec:
    [risk_reward ▼] w[1.0] [desc ▼]  (−)
    [momentum_60 ▼] w[0.5] [desc ▼]  (−)   [+ 加因子]
  仓位 sizing: [signal_weighted ▼]  floor[0.5] cap[1.5]
熔断 circuitBreaker(账户级)
  [x]连亏熔断  连亏[3]笔 base[3]d max[10]d 延[2] 缩[1]
  [x]回撤熔断  停于[15]% 复于[10]%
```

### fill 详情逐因子透明(展示链路,勿落库无入口)

- `PortfolioSimFillsTable.vue` **新增 `rank_score` 列**;`rank值`列(现 `:164-169` 固定 `num(rankValue,2)`)
  按 `rank_field` 分支:composite 显综合分并标注、单因子显原值(量纲不同,避免同列混显)。
- 逐因子展开:点击行展开读 `factor_values`,渲染每因子原始值(贡献可由 run.config 的 weights 重算)。
  ml_score 列若全 null 标「无历史」。
- 控制行数 ≤500;若展开交互使 FillsTable 超限,把展开块抽 `FillFactorDetail.vue`(列入 T8 文件域)。
- **本期落库即展示**(用户定:一步到位逐因子透明),不留「落库无 UI 入口」缺口。

## 单测要点(前端)

- `portfolioSim.ts` 类型 build 通过(`pnpm --filter @cryptotrading/web type-check`)。
- RankSpecEditor:增删因子、切 none/单/composite、emit 的 rankSpec 结构正确(vitest)。
- 新 skipReason:`SKIP_REASON_LABELS` 含 3 新键 → FillsTable 筛选下拉与原因列显示中文。
- 选 ml_score 显示历史不足警示。
