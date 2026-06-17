# 策略条件 KDJ 参数可配（A 股，实时重算）设计

- 日期：2026-06-17
- 范围：A 股策略条件构建器（`StrategyConditionsView` / `StrategyConditionBuilder`）
- 状态：设计已与用户确认，待 spec 自审 + 用户审阅

## 1. 目标与背景

让用户在 A 股策略条件的 **KDJ 条件行**里填自定义 `N/M1/M2`（如 `6,2,2`），用这组参数筛选标的。

**现状（决定方案的关键事实，均已落源头核对）：**

- 一条条件 = `{ field, operator, value?, compareField?, compareMode? }`，前端类型 `apps/web/src/api/modules/strategy/strategyConditions.ts:3-9`。
- KDJ 以三字段出现：`kdj_j / kdj_k / kdj_d`，A 股/加密均有，`supportsCross: true`（`apps/web/src/components/strategy-conditions/conditionFieldMeta.ts:33-35, 84-86`）。当前**界面无任何指标参数输入**。
- 扫描**不实时算指标**：`runner` 拼一条 SQL `WHERE i.kdj_j < $1` 过滤**预存列**（A 股 `raw.daily_indicator.kdj_j`，映射见 `apps/server/src/strategy-conditions/strategy-conditions.types.ts:8`）。
- 预存列由**写死的 9/3/3** 算出（`apps/server/src/indicators/indicators.ts:130-150`，`i-8` 窗口、`*(2/3)+/3` 平滑）。
- 已有可复用先例：回测引擎 `precomputeAllKdj(data, n, m1, m2)`（`apps/server/src/backtest/engine/bt-indicators.ts:80-105`），纯函数、支持任意参数、9/3/3 时与 `calcIndicators` **数学等价（已核对公式）**。

**核心权衡（已向用户讲清）：** 自定义参数后预存列无现成值可用，必须**实时重算**；界面加输入框是小事，工作量在后端重算。

## 2. 已确认的设计决策

| # | 决策 | 选择 |
|---|------|------|
| 1 | 后端方案 | **实时重算**（任意填）；默认 9/3/3 仍走 SQL 快路径 |
| 2 | 参数粒度 | **每行各自一份**（存进条件 jsonb，零 migration） |
| 3 | 跨线比较 | **整条用同一套参数**（作用于该条里所有 KDJ 字段）；不支持快慢线 |
| 4 | 覆盖范围 | **仅 A 股**；加密 KDJ 条件保持 9/3/3 SQL 路径 |
| 5 | 界面布局 | **行内三输入框**（仅当该行字段是 KDJ 时出现） |
| 6 | warmup | **as-of 前约 250 个交易日**截断（自定义参数无需对齐预存列，KDJ 已收敛、确定可复现） |
| 7 | v1 限制 | 自定义 KDJ 参数 + `compareMode='field'` 时，compareField **只允许 KDJ 字段** |

## 3. 判定路径

```text
┌─────────── 一条 KDJ 条件的判定路径 ───────────┐
│  field ∈ {kdj_j,kdj_k,kdj_d} 且 参数 ≠ 9/3/3 ? │
│        │是                          │否        │
│        ▼                            ▼          │
│   实时重算分支                  原 SQL 快路径    │
│  (raw.daily_quote qfq)         (预存列过滤)     │
└────────────────────────────────────────────────┘
```

`参数 == 9/3/3` 视为默认（含老条件无 `kdjParams`），永远走 SQL，**零额外成本**。

## 4. 数据模型（零 migration）

`StrategyConditionItem` 增可选字段；conditions 是 jsonb 且后端无 ValidationPipe（`strategy-condition.entity.ts:35-36`），新字段自动透传。

```text
{ field, operator, value?, compareField?, compareMode?,
  kdjParams?: { n: number; m1: number; m2: number } }   ← 新增
```

三处加类型注解（仅类型，无运行时改动）：

| 位置 | 文件 |
|------|------|
| 前端类型 | `apps/web/src/api/modules/strategy/strategyConditions.ts:3-9` |
| 后端 DTO | `apps/server/src/strategy-conditions/dto/create-strategy-condition.dto.ts:1-6` |
| 实体接口 | `apps/server/src/entities/strategy/strategy-condition.entity.ts:14-19` |

- **只在 ≠9/3/3 时落库**（与 `compareMode` 默认省略同理，payload 干净）。
- 老条件无字段 = 9/3/3，**向后兼容**。
- 仅当 field/compareField 是 KDJ 字段时有意义。
- ⚠️ 后端 DTO / 实体接口当前**无 `compareMode` 字段**（仅前端类型有；jsonb 运行时透传所以值在，但 TS 类型缺）。§8 保存校验要读 `compareMode==='field'`，故 T1 在加 `kdjParams?` 时**一并补 `compareMode?`** 到后端两处。

## 5. 界面（前端 · 行内三输入框）

`ConditionRows.vue` 当 `condition.field` 是 KDJ 字段时，在字段选择器后渲染三个 `n-input-number`（N/M1/M2）：

```text
  字段         参数               操作符    目标
 [KDJ_J ▾]  N[6] M1[2] M2[2]  [小于▾]  (数值)[0]

非 KDJ 字段 → 不显示参数:
 [MA60比 ▾]                   [大于▾]  (数值)[1.05]

J 上穿 D(跨线,右侧共用左侧参数):
 [KDJ_J ▾]  N[6] M1[2] M2[2]  [上穿▾]  (指标)[KDJ_D ▾·同参数]
```

- 默认 9/3/3，`min:1 max:99 precision:0`（沿用回测 `apps/web/src/components/backtest/strategy/sections/EntrySignalSection.vue:22-58` 的口径）。
- 跨线比较（compareField 也是 KDJ）：右侧**不再出参数**，显示「同参数」提示。
- **v1 限制**：KDJ 参数非默认 + `compareMode='field'` 时，`getCompareFieldOptions()`（`ConditionRows.vue:119-158`）只返回 KDJ 字段。
- KDJ 字段判定：给 `conditionFieldMeta.ts` 的 `FieldOption`（:17-26）加 `isKdj?: boolean`，三个 KDJ 字段标 `true`（避免 key 前缀魔法字符串）。
- 切换字段离开 KDJ 时清空 `kdjParams`（参照 compareMode 切换的清理逻辑 `ConditionRows.vue:222-231`）。

## 6. 后端扫描（两阶段，AND 语义，复用现有分页）

**先核实的现状**（`runner.ts` 亲读）：`executeRun`（:23-62）按 `countTotalSymbols`（A 股 = `COUNT(*) FROM a_share_symbols WHERE list_status='L'`，全标的集）步进 `offset += 100`；`scanBatch`（:78-143）的 `LIMIT/OFFSET` 套在**已 AND 上 WHERE 过滤的查询尾部**（:113-116 `WHERE s.list_status='L' AND ${where.sql} ... LIMIT $n OFFSET $m`）。即**分页是对「命中集」翻页、循环上界用全标的数做安全上估**（命中 ≤ 标的数，故翻得遍全部命中，后续页为空）。query-builder 用 `whereClauses.join(' AND ')` 拼接（`query-builder.ts:283`），**确认 AND**。

改造**不动这套分页机制**，只在 `scanBatch` 内拆条件 + 加一步重算二次过滤：

```text
scanBatch(condition, offset, 100):
 1) 拆条件:
      sqlConds    = 非自定义-KDJ 条件(含默认 9/3/3 的 KDJ)
      recompConds = field/compareField 是 KDJ 且参数 ≠ 9/3/3 的条件
 2) Phase 1 = buildAShareQuery(sqlConds) + 现有 LIMIT/OFFSET 原样跑
      · sqlConds 为空(纯自定义 KDJ 组) → where.sql 取 'TRUE',枚举全标的(分页)
      · 返回该页 ≤100 行(已满足 sqlConds、已在 as-of 日)
 3) recompConds 为空 → 直接返回 Phase 1 行(等价现状,零重算)
 4) Phase 2(仅当 recompConds 非空,对该页 ≤100 行):
      ├ 批量读 qfq OHLC: raw.daily_quote, qfq_*,
      │   WHERE ts_code = ANY($1) AND qfq_* IS NOT NULL
      │   AND trade_date <= asOf, ORDER BY ts_code, trade_date
      ├ 按 ts_code 分组 → 每个 distinct 参数组跑一次 precomputeAllKdj
      ├ 取 as-of 根 K/D/J(上穿/下穿再取前一根)
      └ 行须满足全部 recompConds 才保留(与 Phase 1 求交 = AND)
```

**为什么正确（AND 语义，已辨析审阅疑虑）：** 满足「全部条件」的标的必满足 sqlConds 子集 → 必出现在 Phase 1 某一页 → Phase 2 再按 recompConds 过滤后保留。循环上界（全标的数）≥ sqlConds 命中数，故**不漏页、不重复**。`total`/进度沿用现状（安全上估）。**不采用**「scanBatch 改成不带 WHERE 先取 100 标的再过滤」的方案——那会丧失 SQL 预缩集、迫使全市场都重算，更差。

- **as-of 日** = `SELECT MAX(trade_date) FROM raw.daily_indicator`（与现有 A 股扫描同源，`runner.ts:104`）。
- **内存有界**：每页只 ≤100 标的的 qfq 序列；SQL 子集已先行缩集，重算量通常远小于全市场。
- 新增**纯重算 helper**（独立可测）：入参 `tsCodes[] + asOfDate + {n,m1,m2}`，出参每标的 as-of（及前一根）K/D/J；**v1 直接从 `apps/server/src/backtest/engine/bt-indicators.ts` import `precomputeAllKdj`（纯函数），不抽共享**。

## 7. 一致性（重算口径必须与系统其它处一致）

A 股预存 KDJ 来源（`a-shares-indicator.service.ts:173-194` 的 `loadQuoteRows`）：`raw.daily_quote` 单表、`qfq_open/high/low/close`、`WHERE qfq_* IS NOT NULL`、`ORDER BY trade_date`。重算**必须**：

1. 用 `qfq_*` 列（前复权），**不得**用原始价。
2. 同样过滤停牌行（`qfq_* IS NOT NULL`），否则 RSV 窗口错位。
3. 走全量 `precomputeAllKdj`，**不得**走流式增量（`indicators-stream.ts` 窗口写死 8，改不了 N）。
4. `WHERE trade_date <= asOf` 截断，确保取的是与 SQL 路径同一根 bar。

> warmup 截断说明：自定义参数没有「必须逐 bit 对齐预存 9/3/3 列」的约束（预存只有 9/3/3 一份），且 KDJ 在 ~百根后种子（50）影响可忽略，故取 as-of 前约 250 交易日即可，结果确定、可复现。新股（上市不足约百根交易日）KDJ 收敛不足属**已知口径**，与预存列同源（预存也从上市首日起算、同样种子 50），可接受。

## 8. 校验与防御（后端不信前端）

- 前端 `n-input-number`：`min:1 max:99 precision:0`。
- 后端重算前防御性 `parseInt`，非法值回退 9/3/3 + `logger.warn`（遵循 data-integrity 的 skip/warn 精神）。
- **保存时**校验（service 层）：自定义 KDJ 字段 + `compareMode='field'` + compareField 非 KDJ → 拒绝并给明确报错（UI 已拦，后端兜底，防静默误判）。
- `kdjParams == {9,3,3}` → 视为默认，走 SQL，不重算。

## 9. 测试

| 层 | 用例 |
|----|------|
| query-builder 单测 | 带自定义参数的 KDJ 条件**被排除出** SQL WHERE；默认 9/3/3 仍进 WHERE |
| 重算 helper 单测 | ① 固定 qfq 序列 + 9/3/3 重算值 **== `calcIndicators` 对拍**（锁口径一致）；② `6/2/2` 锁一个已知值 |
| runner 集成 | SQL 缩集 ∩ 重算 的 AND 语义；停牌过滤一致；as-of 截断；cross 取前一根 |
| 保存校验单测 | 自定义 KDJ + field 比较非 KDJ → 拒绝 |
| 前端单测 | 选 KDJ 字段才出参数框；离开 KDJ 清空 kdjParams；非默认 + field 比较时 compareField 选项仅 KDJ |

## 10. v1 明确不做（YAGNI）

加密（保持 9/3/3 SQL）、跨线左右不同参数（快慢线）、自定义 KDJ vs 非 KDJ 字段比较、流式增量重算。

## 11. 任务拆分（供 subagent-driven-development，按独立文件域切分）

- **T1 契约**：三处加 `kdjParams?`（前端 type / 后端 DTO / 实体接口）；同时给后端 DTO + 实体接口补 `compareMode?`（前端已有、后端缺；§8 校验依赖）。文件域：上述三文件。
- **T2 前端**：`ConditionRows.vue` 行内参数框 + compareField 限制 + 清理；`conditionFieldMeta.ts` 加 `isKdj`。文件域：strategy-conditions 前端组件。
- **T3 重算 helper + 单测**：新建纯重算函数（`tsCodes+asOf+params → K/D/J`），复用 `precomputeAllKdj`。文件域：strategy-conditions 后端新文件 + spec。
- **T4 runner 两阶段接线**：按 §6 在 `scanBatch` 内拆 sqlConds/recompConds、Phase 1 复用现有 `buildAShareQuery`+LIMIT/OFFSET（空子集取 `'TRUE'`）、对该页 ≤100 行调 T3 重算二次过滤求交。**不改分页机制**。文件域：`strategy-conditions.runner.ts` + query-builder 子集排除逻辑。
- **T5 保存校验**：service 层 field-比较非 KDJ 拒绝 + 单测。文件域：`strategy-conditions.service.ts`。
- **T6 验收**：`pnpm --filter @cryptotrading/web type-check` + `build`、后端 jest、真机 e2e（建一条 `kdj_j(6,2,2) < 0` 运行命中）。

> 验收提醒：后端 `dev` 无 watch，改后端代码后**必须重启后端进程**再 e2e。
