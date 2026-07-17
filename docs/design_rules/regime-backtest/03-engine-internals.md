📍 [手册首页](./README.md) | [第 1 章 接口与工作流](./01-workflow.md) | [第 2 章 字段白名单](./02-field-whitelist.md) | 第 3 章 引擎内部机制

# 第 3 章 引擎内部机制

> Regime 回测手册 · 引擎层

本章说明 Regime 引擎的两个核心内部机制——Derived Field（现算字段）两阶段求值、match 条件的 OR 语义与 MatchGroup 嵌套。这些机制在 [第 1 章](./01-workflow.md) §5.4/§6.1 已从接口视角提及，本章给出引擎内部视角的实现契约与性能权衡。

---

## 1. Derived Field 注册表与两阶段重算

### 1.1 数据流图

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

### 1.2 关键约束

| 约束 | 原因 |
|---|---|
| 现算结果必须提供 `{curr, prev}` 两帧 | cross_above / cross_below 需要"前一日值"做穿越判断 |
| asOf 日期对齐：重算基于 `trade_date ≤ asOfDate` | 保证与回测当日一致,避免未来函数 |
| 参数分桶：不同 KDJ 参数集分别重算 | 例如 (3,2,2) 与 (9,3,3) 不能共用结果,按 `n-m1-m2` key 去重缓存 |
| Phase 2 仅在 recompConds 非空时触发 | 纯 SQL config 零额外开销,回溯兼容 |

### 1.3 已注册的现算字段

| 字段模式 | 重算器 | 数据源 | 计算函数 |
|---|---|---|---|
| `ma{N}`（如 ma20） | MaFieldRecomputer | `raw.daily_quote.qfq_close` | `calcStrictSma(closes, N)`（indicators 库导出） |
| `kdj_j` / `kdj_k` / `kdj_d`（带 `kdjParams`） | KdjFieldRecomputer（复用已有 KdjRecomputeService） | `raw.daily_quote.qfq_high/low/close` | `calcKdjSeries(bars, n, m1, m2)`（已有） |

**实现要点**：

| 组件 | 文件 | 职责 |
|---|---|---|
| 注册表 + 接口 | `strategy-conditions/derived-field-registry.ts` | DerivedFieldRecomputer 接口定义、DerivedFieldRegistry 注册表、`split()` 条件拆分 |
| 通用取数 | `strategy-conditions/derived-field-recompute.service.ts` | 按 (tsCode, asOfDate) 读取 qfq close/high/low 序列 |
| MA 重算器 | `strategy-conditions/derived-field-ma.recomputer.ts` | MaFieldRecomputer,支持任意 N 值的 SMA |
| 通用内存求值 | `strategy-conditions/derived-field-eval.ts` | 从 KDJ 专用求值器泛化而来,支持 value/field/cross_above/cross_below |
| SMA 工具函数 | `indicators/indicators.ts`（或 `indicators/sma.ts`） | 导出 `calcStrictSma`（原为模块私有） |
| 信号枚举器 | `backtest/loaders/signal-enumerator.ts` | `enumerate()` 内部实现 Phase 2：拆分 sqlConds/recompConds,SQL 后内存重算过滤 |
| 退出信号 | `backtest/loaders/exit-signal.loader.ts` | exitMode='strategy' 的 exitConditions 同样接入两阶段重算 |
| 条件运行器 | `strategy-conditions/strategy-conditions.runner.ts` | 原硬编码 KDJ 两阶段重算改为注册表驱动 |
| 模块注册 | `regime-engine.module.ts` | providers 注册 DerivedFieldRegistry + 各 Recomputer |

**注册时机**：Module 初始化时（`onModuleInit`）注册默认字段；后续扩展只需 `registry.register(new XxxRecomputer())`。

---

## 2. 接口契约

### 2.1 DerivedFieldRecomputer 接口

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

### 2.2 注册表

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

---

## 3. match 条件的 OR 语义与 MatchGroup 嵌套

### 3.1 单层 matchLogic

`QuadrantEntry` 支持可选字段 `matchLogic`：

```typescript
export interface QuadrantEntry {
  // ...既有字段
  /** match 数组的逻辑连接,默认 'and'。'or' = 任一条件满足即命中本象限 */
  matchLogic?: 'and' | 'or';
}
```

### 3.2 MatchGroup 嵌套条件

单层 `matchLogic` 只能表达「所有条件 AND」或「所有条件 OR」。部分策略需要嵌套 AND/OR 组合（如 `(HIST<0 ∧ DIF>0) ∨ (HIST>0 ∧ DIF<0)`），因此引入 `MatchGroup` 递归结构：

```typescript
export type MatchNode = RegimeBucketCondition | MatchGroup;

export interface MatchGroup {
  logic: 'and' | 'or';
  items: MatchNode[];
}
```

`match` 数组类型从 `RegimeBucketCondition[]` 升级为 `MatchNode[]`。求值器递归遍历：

- 叶子节点（`RegimeBucketCondition`）调用 `evaluateSingleCondition`
- 分组节点（`MatchGroup`）按 `logic` 对 `items` 递归求值，支持短路（AND 首假即返，OR 首真即返）

类型判别用 `isMatchGroup(node)` type guard：有 `logic` + `items` 且无 `type` 字段 → MatchGroup。

**涉及的模块**：

| 模块 | 职责 |
|---|---|
| **entity** | `regime-strategy-config.entity.ts`：`MatchGroup`/`MatchNode` 类型 + `isMatchGroup` type guard + `collectMatchTargets` 递归收集函数 |
| **validation** | `regime-engine.validation.ts`：`validateMatchGroup` 递归校验（检查 `logic` 值 + `items` 非空 + 嵌套深度 ≤ 5） |
| **evaluator** | `market-condition-evaluator.ts`：`evaluateMatchNode`/`evaluateMatchGroup`（递归 + 短路）；`evaluateMarketConditions` 内遍历 match 数组时用 `evaluateMatchNode` 代替 `evaluateSingleCondition` |
| **snapshot loader** | `market-snapshot.loader.ts`：`extractTargets` 改用 `collectMatchTargets` **递归收集** match 树内所有叶子条件的 target，确保每个 target 的快照数据都被加载（不递归会导致 MatchGroup 内 target 不被加载，snapshot 缺数据，求值 fail-closed 误判） |

**向后兼容**：

- 扁平条件数组 + `matchLogic` 行为完全不变（顶层仍按 `matchLogic` 连接）
- `isMatchGroup` 对带 `type` 字段的对象返回 false，旧 `RegimeBucketCondition` 自动判定为叶子

### 3.3 求值器分支

`evaluateMarketConditions` 签名：

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

### 3.4 边界与互斥检查

互斥性 warning（`quadrantsMayOverlap`）当前仅 warn 不阻断。加 OR 后语义更复杂，**不动重叠检查**（保持 warn 行为）。注意：OR 象限的重叠检查可能产生误报，以实际回测为准。

---

## 4. 不变性保证

以下不变性确保现有 config 在扩展实施后行为完全不变：

| 不变性 | 说明 |
|---|---|
| config 无 `matchLogic` | 默认 `'and'` 求值，旧行为保持 |
| entryConditions 无现算字段 | 纯 SQL 一次查出，`recompConds` 为空，Phase 2 跳过，零额外开销 |
| entryConditions 用旧 KDJ（无 kdjParams） | 走 `i.kdj_j` SQL 列；KdjFieldRecomputer.needsRecompute 仅在带 kdjParams 时返回 true |
| rankField 用旧字段（turnover_rate 等） | SQL SELECT rankValue，仅现算字段走内存 |
| match 含扁平数组（无 MatchGroup） | 扁平数组仍合法，`isMatchGroup` 自动判定为叶子，走既有求值路径 |

---

## 5. 性能权衡

| 场景 | 开销 |
|---|---|
| 纯 SQL config（无现算字段） | **零额外开销**（Phase 2 跳过） |
| 含现算字段的回测 | Phase 1 SQL 候选集 + Phase 2 每候选读 N 根 OHLC 现算。全市场单日候选典型 ~数百只，每只读 250 根 warmup，内存算 SMA/KDJ 微秒级，可接受 |
| KDJ 多参数集 | 按 `n-m1-m2` key 缓存重算结果，同参数不重复算 |

**实测风险**：全市场（~5000 只）全周期（~1340 个交易日）回测时，若每个 trade_date 的每个现算字段都触发 Phase 2 DB 查询，累计 DB 读取量巨大。实测 8+ 分钟仍在 loading 阶段。

**缓解措施**（建议未来迭代）：

1. **LRU 缓存**：`loadQfqBars` 按 `(tsCode, asOfDate, bars)` 缓存 warmup 序列，相邻交易日的 OHLC 序列大量重叠可复用
2. **Phase 1 粗筛收缩**：建议 config 中至少配置一个 SQL 预算字段条件做粗筛，缩小 Phase 2 候选集范围
3. **批量查询优化**：同一天多只股票的 qfq 数据合并为单次 DB 查询

**风险**：全市场全周期回测时，若每个 trade_date 都触发 Phase 2，累计 DB 读取量可能较大。缓解：`derived-field-recompute.service` 内部按 (tsCode, asOfDate) 做 LRU 缓存，相邻交易日的 warmup 序列大量重叠可复用。

---

## 6. 不做（边界）

- 不改主回测引擎 `/api/backtest/start`（加密币）
- 不引入 `technicalindicators` npm 包（死依赖，会破坏与 DB 预存数据一致性）
- 不做分钟级/周线级回测
- 不修复 `GET /:id/trades` 500 缺陷（另开任务）
