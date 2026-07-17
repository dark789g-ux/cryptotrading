# 设计:Regime 引擎 Derived Field 注册表 + match OR 扩展

> 本文档记录为支撑 [3-regime-macd-kdj-strategy.md](./3-regime-macd-kdj-strategy.md) 所做的引擎扩展设计。读者:实现该扩展的 Agent + 未来维护者。

---

## 1. 背景与动机

### 1.1 问题

regime 引擎的 `entryConditions` / `exitConditions` 当前**只能引用预算好的 DB 列**:
- 个股指标走 `raw.daily_indicator`(MA5/30/60/120/240、KDJ 固定 9/3/3、MACD、OBV5/10/20d 等)
- 字段通过 `ASHARE_FIELD_COL_MAP`(field 名 → SQL 列引用)映射

但用户策略需要:
1. **MA20** —— 不在 `daily_indicator` 列里(只有 5/30/60/120/240)
2. **KDJ(3,2,2) / KDJ(6,2,2)** —— 库内只有固定 9/3/3,其它参数组合需现算
3. **match OR 语义** —— 震荡象限判定 `(HIST<0 ∧ DIF>0) ∨ (HIST>0 ∧ DIF<0)`,当前 match 数组仅支持 AND

### 1.2 已有先例(重要)

项目里**已有 KDJ 现算的完整实现**,但只服务实时扫描器,回测路径未集成:
- `apps/server/src/strategy-conditions/kdj-recompute.service.ts` —— 从 `raw.daily_quote` 读 qfq OHLC 前 250 根 → 内存算 KDJ
- `apps/server/src/strategy-conditions/kdj-condition-eval.ts` —— 内存条件求值(支持 value/field/cross)
- `apps/server/src/strategy-conditions/strategy-conditions.runner.ts:126-209` —— **两阶段重算模式**:Phase 1 SQL 筛候选集 + Phase 2 内存重算求交

本次扩展的核心工作 = **把 KDJ 这个特例泛化为通用 derived field 注册表,并接入回测路径的 SignalEnumerator**。

---

## 2. 架构:通用 Derived Field 注册表 + 两阶段重算

### 2.1 数据流图

```
                        entryConditions[](config)
                                │
                ┌───────────────┴───────────────┐
                ▼                               ▼
    sqlConds[]                          recompConds[]
    (字段在 COL_MAP,                   (字段在 derived field 注册表,
     走预算 DB 列)                       需现算)
                │                               │
                ▼                               │
    ┌──────────────────────┐                    │
    │ Phase 1: SQL 枚举     │                    │
    │ buildAShareQuery      │                    │
    │ buildEnumerateQuery   │                    │
    │ → 候选 ts_code 列表    │                    │
    └──────────┬───────────┘                    │
               │                                │
               ▼                                ▼
    ┌────────────────────────────────────────────────┐
    │ Phase 2: 内存重算(仅当 recompConds 非空)        │
    │ 1. DerivedFieldRecomputer.recomputeLatest(     │
    │      tsCodes, asOfDate, cond)                   │
    │    → Map<tsCode, {curr, prev}>                  │
    │ 2. 对候选集逐 ts_code 用 evaluate(cond, result) │
    │    过滤,保留全部 recompConds 满足者              │
    └──────────────────────┬─────────────────────────┘
                           │
                           ▼
                    交集后的候选集
                           │
                           ▼
                    rankField 排序
                (若 rankField 也是现算字段,
                 Phase 2 已补算,内存 assignRanks)
                           │
                           ▼
                    前 N 名 → 信号
```

### 2.2 关键约束

| 约束 | 原因 |
|---|---|
| 现算结果必须提供 `{curr, prev}` 两帧 | cross_above / cross_below 需要"前一日值"做穿越判断 |
| asOf 日期对齐:重算基于 `trade_date ≤ asOfDate` | 保证与回测当日一致,避免未来函数 |
| 参数分桶:不同 KDJ 参数集分别重算 | 例如 (3,2,2) 与 (9,3,3) 不能共用结果,按 `n-m1-m2` key 去重缓存 |
| Phase 2 仅在 recompConds 非空时触发 | 纯 SQL config 零额外开销,回溯兼容 |

---

## 3. 接口契约

### 3.1 DerivedFieldRecomputer 接口

```typescript
/** 单个现算字段的重算器接口(泛化自 KdjRecomputeService) */
export interface DerivedFieldRecomputer<TResult = unknown> {
  /** 该重算器的人类可读名(日志/调试用) */
  readonly name: string;

  /** 判断条件是否需要本重算器处理(例如 field 是 'ma20' 或带特定 kdjParams) */
  needsRecompute(cond: StrategyConditionItem): boolean;

  /** 批量重算,返回每个 ts_code 的 curr + prev 两帧 */
  recomputeLatest(
    tsCodes: string[],
    asOfDate: string,
    cond: StrategyConditionItem,
  ): Promise<Map<string, DerivedFieldSnapshot<TResult>>>;

  /** 内存求值单条件(支持 value/field/cross_above/cross_below) */
  evaluate(
    cond: StrategyConditionItem,
    result: DerivedFieldSnapshot<TResult>,
    siblingResults?: Map<string, DerivedFieldSnapshot<TResult>>,
  ): boolean;
}
```

### 3.2 注册表

```typescript
@Injectable()
export class DerivedFieldRegistry {
  private recomputers: DerivedFieldRecomputer[] = [];

  register(recomputer: DerivedFieldRecomputer): void {
    this.recomputers.push(recomputer);
  }

  /** 找到能处理该条件的重算器;无则返回 null(走纯 SQL) */
  resolve(cond: StrategyConditionItem): DerivedFieldRecomputer | null {
    return this.recomputers.find(r => r.needsRecompute(cond)) ?? null;
  }

  /** 拆分条件数组为 sqlConds + recompConds */
  split(conditions: StrategyConditionItem[]): {
    sqlConds: StrategyConditionItem[];
    recompConds: StrategyConditionItem[];
  } {
    const sqlConds: StrategyConditionItem[] = [];
    const recompConds: StrategyConditionItem[] = [];
    for (const c of conditions) {
      if (this.resolve(c)) recompConds.push(c);
      else sqlConds.push(c);
    }
    return { sqlConds, recompConds };
  }
}
```

### 3.3 已注册字段(本次扩展)

| 字段模式 | 重算器 | 数据源 | 计算函数 |
|---|---|---|---|
| `ma{N}`(如 ma20) | MaFieldRecomputer | `raw.daily_quote.qfq_close` | `calcStrictSma(closes, N)`(indicators 库导出) |
| `kdj_j` / `kdj_k` / `kdj_d`(带 `kdjParams`) | KdjFieldRecomputer(复用已有 KdjRecomputeService) | `raw.daily_quote.qfq_high/low/close` | `calcKdjSeries(bars, n, m1, m2)`(已有) |

**注册时机**:Module 初始化时(`onModuleInit`)注册默认字段;后续扩展只需 `registry.register(new XxxRecomputer())`。

---

## 4. match OR 设计

### 4.1 单层 matchLogic 字段扩展

`QuadrantEntry` 加可选字段:

```typescript
export interface QuadrantEntry {
  // ...既有字段
  /** match 数组的逻辑连接,默认 'and'。'or' = 任一条件满足即命中本象限 */
  matchLogic?: 'and' | 'or';
}
```

### 4.2 MatchGroup 嵌套条件

#### 背景

单层 `matchLogic` 只能表达「所有条件 AND」或「所有条件 OR」。但震荡象限判定需要 `(HIST<0 ∧ DIF>0) ∨ (HIST>0 ∧ DIF<0)`,即嵌套 AND/OR 组合。单层无法表达。

#### 设计

引入 `MatchGroup` 递归结构:

```typescript
export type MatchNode = RegimeBucketCondition | MatchGroup;

export interface MatchGroup {
  logic: 'and' | 'or';
  items: MatchNode[];
}
```

`match` 数组类型从 `RegimeBucketCondition[]` 升级为 `MatchNode[]`。求值器递归遍历:
- 叶子节点(`RegimeBucketCondition`)调用 `evaluateSingleCondition`
- 分组节点(`MatchGroup`)按 `logic` 对 `items` 递归求值,支持短路(AND 首假即返,OR 首真即返)

类型判别用 `isMatchGroup(node)` type guard:有 `logic` + `items` 且无 `type` 字段 → MatchGroup。

#### 关键改动点

| 模块 | 改动 |
|---|---|
| **entity** | `regime-strategy-config.entity.ts`:新增 `MatchGroup`/`MatchNode` 类型 + `isMatchGroup` type guard + `collectMatchTargets` 递归收集函数 |
| **validation** | `regime-engine.validation.ts`:新增 `validateMatchGroup` 递归校验(检查 `logic` 值 + `items` 非空 + 嵌套深度 ≤ 5) |
| **evaluator** | `market-condition-evaluator.ts`:新增 `evaluateMatchNode`/`evaluateMatchGroup`(递归 + 短路);`evaluateMarketConditions` 内遍历 match 数组时用 `evaluateMatchNode` 代替 `evaluateSingleCondition` |
| **snapshot loader** | `market-snapshot.loader.ts`:`extractTargets` 改用 `collectMatchTargets` **递归收集** match 树内所有叶子条件的 target,确保每个 target 的快照数据都被加载(不递归会导致 MatchGroup 内 target 不被加载,snapshot 缺数据,求值 fail-closed 误判) |

#### 向后兼容

- 扁平条件数组 + `matchLogic` 行为完全不变(顶层仍按 `matchLogic` 连接)
- `isMatchGroup` 对带 `type` 字段的对象返回 false,旧 `RegimeBucketCondition` 自动判定为叶子

### 4.3 求值器分支

`evaluateMarketConditions` 加第三参数:

```typescript
export function evaluateMarketConditions(
  snapshot: MarketSnapshot,
  conditions: MatchNode[],       // ← 升级为 MatchNode[](支持 MatchGroup)
  logic: 'and' | 'or' = 'and',
): boolean {
  if (!Array.isArray(conditions) || conditions.length === 0) return false;
  if (logic === 'or') {
    for (const c of conditions) {
      if (evaluateMatchNode(snapshot, c)) return true;  // 任一满足即命中(含 MatchGroup 递归)
    }
    return false;
  }
  // AND(既有逻辑)
  for (const c of conditions) {
    if (!evaluateMatchNode(snapshot, c)) return false;
  }
  return true;
}
```

`classifyRegime` 调用处传 `q.matchLogic ?? 'and'`。`evaluateMatchNode` 内部判断 `isMatchGroup(node)` 决定走 `evaluateSingleCondition` 还是递归 `evaluateMatchGroup`。

### 4.4 边界与互斥检查

- 互斥性 warning(`quadrantsMayOverlap`)当前仅 warn 不阻断,加 OR 后语义更复杂,本次**不动重叠检查**(保持 warn 行为),文档注明"OR 象限的重叠检查可能产生误报,以实际回测为准"。

---

## 5. 改动清单(逐文件)

### 5.1 数据层(改动 1)

| 文件 | 改动 |
|---|---|
| `apps/server/src/migration/20260717120000-add-csi-all-index.sql` | 新建:INSERT `('000985.CSI','中证全指','M','SH')` 到 `ths_index_catalog`(注意:中证全指由中证指数公司发布,ts_code 后缀用 `.CSI` 非 `.SH`) |
| `apps/server/src/migration/20260717120000-add-csi-all-index.ps1` | 新建:配套 docker exec 脚本 |
| 触发同步 | `GET /api/ths-index-daily/sync/market?start_date=20210101&end_date=20260716`(MarketIndexSyncService 尾部自动算指标) |

### 5.2 OBV 白名单(改动 2)

| 文件 | 改动 |
|---|---|
| `apps/server/src/strategy-conditions/strategy-conditions.types.ts` | `ASHARE_FIELD_COL_MAP` 加 `obv10d: 'i.obv_10d'`(DB 列名 Agent 实测确认) |
| `apps/server/src/strategies/regime-engine/backtest/rank-select.ts` | `RANK_FIELDS` 加 `'obv10d'`,`DEFAULT_DIR` 加 `obv10d: 'desc'` |

### 5.3 match OR(改动 3,4 文件 ~15 行)

| 文件 | 行号 | 改动 |
|---|---|---|
| `entities/strategy/regime-strategy-config.entity.ts` | :29 | QuadrantEntry 加 `matchLogic?: 'and' \| 'or'` |
| `strategies/regime-engine/regime-engine.validation.ts` | :387 后 | validateQuadrant 加 matchLogic 值校验 |
| `strategies/regime-engine/market-condition-evaluator.ts` | :266 | evaluateMarketConditions 加 logic 参数 + OR 分支 |
| `strategies/regime-engine/regime.classifier.ts` | :51 | 调用传 `q.matchLogic ?? 'and'` |
| `market-condition-evaluator.spec.ts` | — | 加 OR 用例 |

### 5.4 Derived Field 注册表(改动 4,核心)

**新建**:
| 文件 | 内容 | 预估行数 |
|---|---|---|
| `strategy-conditions/derived-field-registry.ts` | 注册表 + DerivedFieldRecomputer 接口 + split helper | ~100 |
| `strategy-conditions/derived-field-recompute.service.ts` | 通用取数(qfq close/high/low 序列) | ~150 |
| `strategy-conditions/derived-field-ma.recomputer.ts` | MaFieldRecomputer(ma20 等) | ~80 |
| `strategy-conditions/derived-field-eval.ts` | 通用内存条件求值(从 kdj-condition-eval.ts 泛化) | ~120 |

**修改**:
| 文件 | 改动 |
|---|---|
| `indicators/indicators.ts` 或新建 `indicators/sma.ts` | 导出 `calcStrictSma`(当前模块私有) |
| `strategy-conditions/strategy-conditions.runner.ts:126-209` | 把硬编码 KDJ 两阶段重算改为注册表驱动(向后兼容) |
| `strategies/regime-engine/backtest/loaders/signal-enumerator.ts:23` | enumerate() 内部加 Phase 2:拆 sqlConds/recompConds,SQL 后内存重算过滤 |
| `strategies/regime-engine/backtest/loaders/exit-signal.loader.ts` | 同样接入(exitMode='strategy' 的 exitConditions) |
| `strategies/regime-engine/regime-engine.validation.ts` | ASHARE_CONDITION_FIELD_WHITELIST 加现算字段(ma20 等) |
| `strategies/regime-engine/regime-engine.module.ts` | providers 注册 DerivedFieldRegistry + 各 Recomputer |

### 5.5 MatchGroup 嵌套条件(改动 6)

| 文件 | 改动 |
|---|---|
| `entities/strategy/regime-strategy-config.entity.ts` | 新增 `MatchGroup`/`MatchNode` 类型 + `isMatchGroup` type guard + `collectMatchTargets` 递归收集 |
| `strategies/regime-engine/regime-engine.validation.ts` | 新增 `validateMatchGroup` 递归校验(深度 ≤ 5) |
| `strategies/regime-engine/market-condition-evaluator.ts` | 新增 `evaluateMatchNode`/`evaluateMatchGroup`(递归 + 短路),`evaluateMarketConditions` 参数类型升级为 `MatchNode[]` |
| `strategies/regime-engine/backtest/loaders/market-snapshot.loader.ts` | `extractTargets` 改用 `collectMatchTargets` 递归收集 match 树内所有 target |
| `strategies/regime-engine/market-condition-evaluator.spec.ts` | 嵌套 MatchGroup 单元测试(含深度、短路、混合、empty 等用例) |

### 5.6 文档同步(改动 5)

| 文件 | 改动 |
|---|---|
| `docs/design_rules/regime-backtest-agent-workflow.md` | §5 加现算字段说明 + §6 加 derived field 段落 + §5.4 加 matchLogic |
| `docs/design_rules/regime-backtest-field-whitelist.md` | 加 OBV + 现算字段章节 |

---

## 6. 回溯兼容(红线)

| 场景 | 旧行为 | 新行为 |
|---|---|---|
| config 无 `matchLogic` | AND 求值 | **不变**(默认 'and') |
| entryConditions 无现算字段 | 纯 SQL 一次查出 | **不变**(recompConds 为空,Phase 2 跳过) |
| entryConditions 用旧 KDJ(无 kdjParams) | 走 `i.kdj_j` SQL 列 | **不变**(KdjFieldRecomputer.needsRecompute 仅在带 kdjParams 时返回 true) |
| rankField 用旧字段(turnover_rate 等) | SQL SELECT rankValue | **不变**(仅现算字段走内存) |
| match 含 MatchGroup | 不支持(旧版只有扁平数组) | **不变**(扁平数组仍合法,`isMatchGroup` 自动判定为叶子) |

---

## 7. 性能权衡

| 场景 | 开销 |
|---|---|
| 纯 SQL config(无现算字段) | **零额外开销**(Phase 2 跳过) |
| 含现算字段的回测 | Phase 1 SQL 候选集 + Phase 2 每候选读 N 根 OHLC 现算。全市场单日候选典型 ~数百只,每只读 250 根 warmup,内存算 SMA/KDJ 微秒级,可接受 |
| KDJ 多参数集 | 按 `n-m1-m2` key 缓存重算结果,同参数不重复算 |

**实测风险**:全市场(~5000 只)全周期(~1340 个交易日)回测时,若每个 trade_date 的每个现算字段都触发 Phase 2 DB 查询,累计 DB 读取量巨大。实测 8+ 分钟仍在 loading 阶段。

**缓解措施**(建议未来迭代):
1. **LRU 缓存**:`loadQfqBars` 按 `(tsCode, asOfDate, bars)` 缓存 warmup 序列,相邻交易日的 OHLC 序列大量重叠可复用
2. **Phase 1 粗筛收缩**:建议 config 中至少配置一个 SQL 预算字段条件做粗筛,缩小 Phase 2 候选集范围
3. **批量查询优化**:同一天多只股票的 qfq 数据合并为单次 DB 查询

**风险**:全市场全周期回测时,若每个 trade_date 都触发 Phase 2,累计 DB 读取量可能较大。缓解:derived-field-recompute.service 内部按 (tsCode, asOfDate) 做 LRU 缓存,相邻交易日的 warmup 序列大量重叠可复用。

---

## 8. 不做(边界)

- 不改主回测引擎 `/api/backtest/start`(加密币)
- 不引入 `technicalindicators` npm 包(死依赖,会破坏与 DB 预存数据一致性)
- 不做分钟级/周线级回测
- 不修复 `GET /:id/trades` 500 缺陷(另开任务)
