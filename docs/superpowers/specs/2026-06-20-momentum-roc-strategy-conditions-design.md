# 标的筛选 · 动量（ROC）指标 设计

- 日期：2026-06-20
- 范围：`strategy-conditions` 模块新增技术指标「动量（ROC，变化率百分比）」
- 状态：已 brainstorming、待实现
- 关联 spec：[`2026-06-17-kdj-custom-params-strategy-conditions-design.md`](./2026-06-17-kdj-custom-params-strategy-conditions-design.md)（KDJ 自定义参数，是本设计的直接对标范本）

## 1. 背景与目标

### 1.1 需求

在标的筛选模块（后端 `/api/strategy-conditions`、前端 `StrategyConditionsView.vue`）中新增技术指标**动量**，作为筛选条件。

### 1.2 动量定义（已确认）

采用 **ROC（Rate of Change，变化率百分比）**：

```
ROC(N) = (Close_今日 − Close_N个交易日前) / Close_N个交易日前 × 100
```

- 量纲：百分比，**无量纲、可跨标的比较**，适合设统一阈值筛选。
- 「N 日前」指 **N 个交易日**（非自然日），停牌日不计入。

### 1.3 为什么是 ROC 而非 Momentum(价差)

项目里「动量」一词散在三处，定义各异：

| 名称 | 位置 | 公式 | 落库 | 进筛选 |
|---|---|---|---|---|
| `momentum_20d/60d` | quant-pipeline（Python 因子） | 本质是 ROC（20/60 日收益率） | `factors.daily_factors` | ❌ spec 标 Tier-3 P2，不进 screener |
| `factor:'momentum'` | 回测引擎 | 用 MA 周期算的排序打分 | ❌ 不落库 | ❌ 回测内部排序 |
| ROC（本设计） | strategy-conditions | 见 1.2 | ❌ 不落库（SQL 现算） | ✅ |

Momentum(绝对价差 = 今收 − N日前收) 有量纲，10 元股票与 1000 元股票不可比，设统一阈值筛选无意义。ROC 无量纲，是筛选的首选。本设计与 quant-pipeline 的 `momentum_20d/60d` 语义一致（都是 ROC），但落点不同、互不冲突。

## 2. 关键决策（均已 brainstorming 确认）

| 决策点 | 选定 | 理由 |
|---|---|---|
| 动量定义 | ROC（变化率%） | 无量纲、可跨标的比、适合设阈值 |
| 周期 N | **用户可调**，默认 10，范围 [1,250] | 用户明确要求仿 KDJ 可调 + 记住选择 |
| 字段形态 | 单一 `roc` 字段 key，周期藏 `rocParams.n` | 与 KDJ（单一 `kdj_j` + `kdjParams`）对称 |
| 实现路径 | **方案 A：SQL OFFSET/LIMIT 现算** | 见 §3 |
| 取数方式 | OFFSET n LIMIT 1 子查询 | 走索引、零窗口扫描、比 LAG 更直白 |
| 落库 | **不落库**（不进 daily_indicator） | N 可变无法映射固定列；ROC 公式简单，SQL 现算即可 |
| 适用市场 | A 股 + 加密 | 两端都有映射需求 |
| A 股取数口径 | 前复权 `qfq_close` | 与指标预算口径一致；不复权价会因除权产生假动量 |
| cross 支持 | **首版不支持**上穿/下穿 | 降低复杂度；cross 0 轴留作后续迭代 |

## 3. 方案选型：为什么是 SQL 现算（方案 A）

三个候选方案：

```text
┌─────────────────────────────────────────────────────────┐
│  需求：用户可调周期 N                                    │
│    │                                                     │
│    ├─ 接受固定几档？ ─ 否 ──┐                            │
│    │     是                 │                            │
│    │     ↓                  ├─→ 方案 A（SQL OFFSET 现算）│
│    └─→ 方案 B（落库固定列） │    ✓ 选定                  │
│        ✗ 不满足"可调"       │                            │
│                             │                            │
│   ROC 公式复杂到要内存算？  │                            │
│   否 ───────────────────────┘                            │
│   是 → 方案 C（仿 KDJ 全套重算）过度工程 ✗               │
└─────────────────────────────────────────────────────────┘
```

- **方案 A（选定）**：ROC 不落库，query-builder 识别到 `roc` 字段时动态生成 OFFSET/LIMIT 子查询；`rocParams.n` 携带周期。零 DB 迁移、真可调、改动最小。
- **方案 B（否）**：预计算 `roc10/20/60` 落库做静态列映射。与「可调周期」直接冲突，只能给固定几档。
- **方案 C（否）**：仿 KDJ 的 `roc-params.ts` + `roc-recompute.service.ts` + `evalRocCondition` 全套内存重算。严重过度工程 —— KDJ 的复杂管线是为 RSV→K→D→J 递推 + 250 根 warmup 买单，ROC 只是两个 close 一减一除，SQL 直接能算。

## 4. 数据模型与条件契约

### 4.1 条件结构扩展

`StrategyConditionItem` 新增可选 `rocParams`，完全对称已有的 `kdjParams`：

```ts
// apps/server/src/entities/strategy/strategy-condition.entity.ts
export interface StrategyConditionItem {
  field: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'cross_above' | 'cross_below';
  value?: number;
  compareField?: string;
  compareMode?: 'field' | 'value';
  kdjParams?: { n: number; m1: number; m2: number };
  rocParams?: { n: number };          // ← 新增。仅 field='roc' 时有意义
}
```

`dto/create-strategy-condition.dto.ts` 镜像同步。

### 4.2 新字段 key：`roc`

前后端各加一个统一的 `roc`（不分 `roc10/roc20`，周期由 `rocParams.n` 决定）。

### 4.3 「记住用户选择 + 入库」

无需额外工作。条件集本身是 jsonb 存在 `StrategyConditionEntity.conditions`，`rocParams` 作为条件对象属性**自动随之序列化入库**，与 KDJ 完全一致。

```text
┌─────────────────────────────────────────────────────────────┐
│ 条件对象（存入 conditions jsonb）                            │
│  field: 'roc'                                               │
│  operator: 'gt'                                             │
│  value: 5                                                   │
│  rocParams: { n: 20 }   ← 用户选择，随 jsonb 入库即"记住"    │
│  语义：ROC(20) = (今收-20日前收)/20日前收×100 > 5%           │
└─────────────────────────────────────────────────────────────┘
```

## 5. 后端实现

### 5.1 文件改动清单

| 文件 | 改动 |
|---|---|
| `entities/strategy/strategy-condition.entity.ts` | `StrategyConditionItem` 加 `rocParams?: {n:number}` |
| `dto/create-strategy-condition.dto.ts` | 同步镜像 |
| `strategy-conditions.types.ts` | **不改**（ROC 不进静态列映射 ASHARE/CRYPTO_FIELD_COL_MAP） |
| `strategy-conditions.query-builder.ts` | ★核心：`build()` 签名新增 `rocCfg` 参数；加 ROC 早退分支 + `buildRocExpr()` + `resolveRocN()` |
| `strategy-conditions.service.ts` | `validateConditions` **不加新校验**（ROC 无 compareField 语义陷阱） |
| `strategy-conditions.runner.ts` | **零改动**（ROC 留 sqlConds，不进 KDJ 重算路径） |

> ⚠️ **取数表与现有 `crossCfg.tablePrev` 不同**：`crossCfg.tablePrev`（A 股 = `raw.daily_indicator`）是**指标表，无价格列**；ROC 要的是价格列（A 股 `qfq_close`、crypto `close`），必须单独指向价格表（A 股 `raw.daily_quote`）。故 `buildRocExpr` **不复用 `crossCfg`**，而是接收下文专门的 `rocCfg`。

### 5.2 query-builder ROC 分支（核心）

**先说明取数表的难点**：现有 `crossCfg.tablePrev`（A 股 = `raw.daily_indicator`）是**指标表，无价格列**（`qfq_close` 只在 `raw.daily_quote`，见 `daily-quote.entity.ts:53`）。ROC 需要价格列，不能复用 `crossCfg`。故 `build()` 签名新增一个专门的 `rocCfg` 参数，在 `buildAShareQuery`/`buildCryptoQuery` 各自构造：

```ts
// 新增的 ROC 取数配置（不复用 crossCfg）
interface RocCfg {
  priceTable: string;       // a-share: 'raw.daily_quote'；crypto: 'klines'
  closeCol: string;         // a-share: 'qfq_close'；crypto: 'close'
  joinKey: string;          // a-share: 'ts_code'；crypto: 'symbol'
  dateKey: string;          // a-share: 'trade_date'；crypto: 'open_time'
  extraFilter?: string;     // crypto: 'AND interval = ''1d'''；a-share: 无
  refAlias: string;         // 主查询里价格/指标行的别名：a-share 'i'；crypto 'k'
}
```

`buildAShareQuery` 构造 `{ priceTable:'raw.daily_quote', closeCol:'qfq_close', joinKey:'ts_code', dateKey:'trade_date', refAlias:'i' }`；`buildCryptoQuery` 构造 `{ priceTable:'klines', closeCol:'close', joinKey:'symbol', dateKey:'open_time', extraFilter:"AND interval = '1d'", refAlias:'k' }`。

在 `build()` 的 for 循环**最前面**（market/industry/普通字段查找之前）插入 ROC 早退分支：

```ts
if (field === 'roc') {
  const n = resolveRocN(cond.rocParams);
  if (operator === 'cross_above' || operator === 'cross_below') {
    this.logger.warn(`[${label}] ROC 首版不支持上穿/下穿，已跳过`);
    continue;
  }
  const sqlOp = COMPARISON_OPERATORS[operator];
  if (!sqlOp) { this.logger.warn(`[${label}] ROC 未知操作符 "${operator}"，已跳过`); continue; }

  const rocExpr = this.buildRocExpr(rocCfg, n);
  if (compareField) {
    const compareCol = fieldMap[compareField];
    if (!compareCol) { this.logger.warn(`[${label}] ROC 比较字段 "${compareField}" 未知，已跳过`); continue; }
    whereClauses.push(`${rocExpr} ${sqlOp} ${compareCol}`);
  } else {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.logger.warn(`[${label}] ROC 比较值非法（${String(value)}），已跳过`); continue;
    }
    params.push(value);
    whereClauses.push(`${rocExpr} ${sqlOp} ${ph()}`);
  }
  continue;
}
```

`buildRocExpr` 生成标量子查询。**`cur`（当日收盘）与 `prev`（N 日前收盘）均从价格表取，两侧都带 `extraFilter`**（crypto 的 `interval='1d'` 必须同时在两处，否则多 interval 下行集不一致、算错）：

```ts
private buildRocExpr(rocCfg: RocCfg, n: number): string {
  const { priceTable, closeCol, joinKey, dateKey, extraFilter, refAlias } = rocCfg;
  const ef = extraFilter ?? '';  // crypto: "AND interval = '1d'"；a-share: ''
  return `(
    SELECT CASE
      WHEN prev.${closeCol} IS NULL OR prev.${closeCol} = 0 THEN NULL
      ELSE (cur.${closeCol} - prev.${closeCol}) / prev.${closeCol} * 100
    END
    FROM ${priceTable} cur
    LEFT JOIN LATERAL (
      SELECT ${closeCol} FROM ${priceTable}
      WHERE ${joinKey} = cur.${joinKey}${ef}
        AND ${dateKey} <= cur.${dateKey}
      ORDER BY ${dateKey} DESC
      OFFSET ${n} LIMIT 1
    ) prev ON true
    WHERE cur.${joinKey} = ${refAlias}.${joinKey}
      AND cur.${dateKey} = ${refAlias}.${dateKey}${ef}
  )`;
}
```

### 5.3 取数与边界处理

- **OFFSET n LIMIT 1**：`ORDER BY dateKey DESC` 下，今日=row 0、上交易日=row 1、…、N 个交易日前=row N；`OFFSET n` 跳过 row 0..n-1 共 n 行、取 row n，**严格等价于取 Close_{N 个交易日前}**。走 `(joinKey, dateKey)` 索引，每标的常数级开销。
- **停牌缺口**：OFFSET 按「行」计数，停牌日无行 → 不计入 → 正好是「N 个交易日」。这是正确行为，无需处理。
- **除零**：`prev.close = 0 → CASE 返回 NULL`。
- **数据不足**（新股上市 < N 天 / 停牌太久）：`prev` 子查询返回 NULL → CASE 返回 NULL → `NULL $op $value` 求值为 NULL（非 true）→ **fail-closed 不命中**，与 KDJ 重算缺失数据口径一致。
- **复权口径**：A 股强制 `qfq_close`（取自 `raw.daily_quote`），避免除权假动量。crypto 用 `close`。

### 5.4 默认值与兜底校验（仿 KDJ isValidKdjParams）

```ts
const DEFAULT_ROC_N = 10;
function resolveRocN(p: { n: number } | undefined): number {
  if (!p || typeof p.n !== 'number' || !Number.isInteger(p.n) || p.n < 1 || p.n > 250) {
    return DEFAULT_ROC_N;  // 非法回退默认，warn 在调用处
  }
  return p.n;
}
```

- 前端 input-number 约束 `min=1 / max=250 / precision=0 / default=10`。
- 后端不信前端，`resolveRocN` 兜底；非法参数回退默认而非报错（API 直连调用方可用）。
- service 层不加新校验：KDJ 需要 service 校验是因为「自定义参数 + compareField 非同源字段」会引发**语义错误**（混算）；ROC 无此陷阱，参数范围校验放 query-builder 足够。

### 5.5 runner 归类

ROC 条件**留在 sqlConds**，不进 KDJ 的内存重算路径。原因：ROC 纯 SQL 可解，无需拉数据到内存。`needsRecompute` 判定只针对 KDJ，保持不变。

数据流：`ROC 条件 → sqlConds（runner.ts:136-137）→ buildAShareQuery/buildCryptoQuery → build() 循环首个 ROC 早退分支 → whereClauses`。

## 6. 前端实现

### 6.1 文件改动清单

| 文件 | 改动 |
|---|---|
| `conditionFieldMeta.ts` | A_SHARE_FIELDS + CRYPTO_FIELDS 各加 `roc`；+`isRoc`/`DEFAULT_ROC_N`/`isRocField` |
| `ConditionRows.vue` | +ROC 周期 N 输入框（对称 KDJ 参数框）+ 切字段清理 |
| `api/modules/strategy/strategyConditions.ts` | `StrategyConditionItem` 加 `rocParams?` |

### 6.2 conditionFieldMeta.ts

两端字段列表在 ATR14 之后插入：

```ts
{ label: '动量(ROC)', value: 'roc', supportsCross: false, valueUnit: '%', isRoc: true },
```

新增（对称 KDJ 那套）：

```ts
export type FieldOption = Omit<SelectOption, 'label'|'value'> & {
  // ... 现有字段
  isRoc?: boolean;  // ← 新增
};

export const ROC_FIELD_VALUES = new Set(['roc']);
export const DEFAULT_ROC_N = 10;
export function isRocField(field: string): boolean {
  return ROC_FIELD_VALUES.has(field);
}
```

- `supportsCross: false` → 操作符下拉 cross 置灰（现有 `getOperatorOptions` 自动处理）。
- `valueUnit: '%'` → label 显示「动量(ROC)（%）」。
- 无 `valueToStorageFactor` → ROC value 透传（如 5 即 5%）。

### 6.3 ConditionRows.vue

ROC 周期 N 输入框，对称 KDJ 参数 template，但**两端都显示**（不像 KDJ crypto 隐藏）：

```text
┌──────────────────────────────────────────────────────────────┐
│  条件行（选了 roc 后）                                         │
│  [动量(ROC)▾] [?] 周期 [10] [大于▾] ○指标 ●数值 [5]  🗑️      │
└──────────────────────────────────────────────────────────────┘
```

```vue
<template v-if="showRocParams(condition.field)">
  <span class="kdj-params-label">周期</span>
  <n-input-number
    :value="rocNView(condition)"
    placeholder="N" :min="1" :max="250" :precision="0"
    class="kdj-param-input"
    @update:value="handleRocNChange(index, $event)"
  />
</template>
```

配套函数对称 KDJ：
- `showRocParams(field)` — 不限制 targetType（两端都支持）。
- `rocNView(condition)` — 缺省回落 `DEFAULT_ROC_N=10`。
- `handleRocNChange(index, raw)` — 等于默认 10 → 删除 `rocParams`（不残留默认值）；否则写入。

切字段清理（防脏字段残留，对称现有 KDJ 清理逻辑 ConditionRows.vue:276-278）：

```ts
if (!showRocParams(newField)) {
  delete cond.rocParams;
}
```

### 6.4 不需改动

- `formatConditionItem`：条件展示文案自动用 field label，无需特判 ROC。
- API 客户端：`rocParams` 是可选字段，老数据自动兼容。

## 7. 测试与验收

### 7.1 后端单测（新文件 `strategy-conditions.query-builder.roc.spec.ts`）

- `resolveRocN` 边界：缺省/undefined → 10；n=0 → 10；n=251 → 10；n=10 → 10；n=20 → 20。
- A 股 ROC SQL：`cur`/`prev` 均从 `raw.daily_quote` 取 `qfq_close`，表达式含 `(cur.qfq_close - prev.qfq_close)/prev.qfq_close*100`，params=[5]，OFFSET 正确。
- crypto ROC SQL：`cur`/`prev` 均从 `klines` 取 `close`；**两处**都带 `interval = '1d'`（cur 外层 WHERE + prev LATERAL 内层 WHERE），不能只有一处。
- 非法 `rocParams` → OFFSET 回退 10。
- cross 操作符 → 该条跳过（warn 不报错），不影响其它条件。
- 多条件 AND：`roc gt 5` + `kdj_j gt 20` → 两子句 AND。
- compareField 模式：`roc gt ma5` → 右侧 `i.ma5`。

### 7.2 端到端验证

- 前端选「动量(ROC)」→ 出现周期 N 输入框（默认 10）。
- 改 N=20 → 入库 `rocParams:{n:20}`；改回 10 → `rocParams` 被删除。
- A 股：建 `roc gt 3 (n=20)` 条件集 → run → 命中标的 20 日 ROC 手工核算一致。
- crypto：同样验证。
- 新股（上市 < N 天）不命中（fail-closed）。
- 现有 KDJ/MACD 等条件功能不回归。
- 字段切换回归：ROC（无 valueToStorageFactor）切到 total_mv（factor=10000）→ value 被现有 `handleFieldChange` 逻辑清空，不残留。

## 8. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 除零（N日前收盘=0） | 低 | CASE `prev.close=0 → NULL`；fail-closed |
| 数据不足（新股<N天） | 低 | 子查询 NULL → fail-closed（不命中，符合预期） |
| 复权口径 | 中 | 强制 `qfq_close` |
| 性能（OFFSET n 扫 n 行） | 低 | N≤250、走索引、量级同 cross_above 子查询 |
| 停牌缺口 | 低（正确行为） | OFFSET 按行计数，停牌日不计入 = N 个交易日 |
| 老数据兼容 | 无 | 可选字段，缺省→resolveRocN 回退 10 |
| cross 缺失 | 低（已知取舍） | supportsCross:false 置灰；后续迭代补 |

## 9. 改动规模

| 文件 | 新增行 | 性质 |
|---|---|---|
| query-builder.ts | ~40 | 核心逻辑 |
| query-builder.roc.spec.ts | ~80 | 新单测 |
| entity.ts + dto.ts | ~2 | interface 加可选字段 |
| conditionFieldMeta.ts | ~15 | 字段定义 + helper |
| ConditionRows.vue | ~40 | template + handler |
| **合计** | **~180 行** | **零 DB 迁移** |
