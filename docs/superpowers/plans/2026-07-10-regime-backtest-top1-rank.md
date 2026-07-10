# Regime 回测 Top1 排序选股 + 全量审计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同日命中多标的时按象限 `rankField`/`rankDir` 排序，仅 Top1 进开仓引擎；全量候选以 `not_top1` 审计行落库，详情按信号日分组可查。

**Architecture:** 纯函数排序（`rank-select`）→ 枚举 SQL 一次取出 `rankValue` → 仅 Top1 进 `WindowBuilder`/引擎 → runner 覆写 Top1 的 rank 三列并追加 `rank≥2` 的 `not_top1` 行；引擎不感知 rank。前端象限编辑排序控件 + 详情分组表。

**Tech Stack:** NestJS 10 + Jest + TypeORM；Vue 3 + Naive UI；PostgreSQL migration（sql+ps1）。

**Spec:** [docs/superpowers/specs/2026-07-10-regime-backtest-top1-rank-design.md](../specs/2026-07-10-regime-backtest-top1-rank-design.md)

---

## SubAgent 编排

```text
Wave 1（可并行，文件域不相交）
  ├─ Agent-A: Task 1–2   纯排序 + SkipReason + 校验
  └─ Agent-B: Task 3     迁移 + trade 实体列

Wave 2（依赖 Wave 1）
  └─ Agent-C: Task 4–5   枚举取数/Top1 截断 + runner merge 落库 + listTrades 排序

Wave 3（可与 Wave 2 尾部并行，若 C 已暴露类型）
  └─ Agent-D: Task 6–7   前端配置 UI + 详情分组表

Wave 4
  └─ Agent-Review: 对照 spec §7 验收做只读代码审查
```

**不相交依据：** A=`core/*`+`validation*`+`rank-select*`；B=`migration`+`entity`；C=`enumerator`+`data-loader`+`runner`+`service.listTrades`；D=`apps/web`。

**风险：** Wave 2 改 `RegimeBacktestDataLoader.load` 返回值时，runner 调用点必须同步；前端 D 依赖 API 类型字段名与后端一致（`rank`/`rankField`/`rankValue`）。

---

## 文件结构总览

```text
apps/server/src/
  migration/
    20260710_regime_backtest_trade_rank.sql          新建
    20260710_regime_backtest_trade_rank.ps1          新建
  entities/strategy/
    regime-strategy-config.entity.ts                修改：QuadrantEntry.rankField/rankDir
    regime-backtest-trade.entity.ts                 修改：rank 三列
  strategies/regime-engine/
    core/types.ts                                   修改：SkipReason += not_top1
    regime-engine.validation.ts                     修改：trade rank 校验
    regime-engine.validation.spec.ts                修改
    backtest/
      rank-select.ts                                新建：排序纯函数
      rank-select.spec.ts                           新建
      types/backtest-data.types.ts                  修改：RankedCandidate 等
      regime-backtest.types.ts                      修改：Trade + load 旁路审计
      loaders/signal-enumerator.ts                  修改：取 rankValue + 排序截断
      regime-backtest.data-loader.ts                修改：只建 Top1 窗口；返回 audit
      regime-backtest.runner.ts                     修改：merge + nSkipped
      regime-backtest.service.ts                    修改：listTrades ORDER BY
  strategy-conditions/
    strategy-conditions.enumerator.ts               修改：可选 rank 列 SELECT

apps/web/src/
  api/modules/strategy/regimeEngine.ts              修改：类型
  components/regime/
    regimeConfigEditor.helpers.ts                   修改：默认 rank
    RegimeConfigEditor.vue                          修改：排序控件
    rankFieldMeta.ts                                新建（短名单+标签+默认方向）
  components/strategy/regime-backtest/
    RegimeBacktestConfigSummary.vue                 修改：展示排序
    RegimeBacktestTradesTable.vue                   修改：分组+筛选+labels
```

---

## UI 变更（ASCII）

### 象限编辑（trade）

```text
前:
  仓位比例 [0.2]  最大持仓 [4]
  入场条件 …

后:
  仓位比例 [0.2]  最大持仓 [4]
  选股排序 [换手率 ▾]  方向 [降序 ▾]    ← none 时隐藏方向
  入场条件 …
```

### 详情交易明细

```text
前: 扁平 DataTable（按 buyDate）

后:
  筛选 [全部|仅入选|仅成交]  [信号日]
  ▼ 20260115  Q1  候选87  入选 000001.SZ (#1)
      #  代码  换手率  状态  原因
      1  …     12.35   taken —
      2  …     11.10   skipped 未入选
```

---

## Task 1: 排序纯函数 + SkipReason

**Files:**
- Create: `apps/server/src/strategies/regime-engine/backtest/rank-select.ts`
- Create: `apps/server/src/strategies/regime-engine/backtest/rank-select.spec.ts`
- Modify: `apps/server/src/strategies/regime-engine/core/types.ts`
- Modify: `apps/server/src/entities/strategy/regime-strategy-config.entity.ts`

- [ ] **Step 1: 扩展 SkipReason**

在 `core/types.ts` 的 `SkipReason` 增加：

```typescript
| 'not_top1' // 同日排序未入选（审计行；未进引擎）
```

- [ ] **Step 2: QuadrantEntry 类型**

在 `regime-strategy-config.entity.ts` 的 `QuadrantEntry` 增加：

```typescript
/** trade 必填；短名单见 RANK_FIELD_WHITELIST */
rankField?: string | null;
/** rankField≠none 时必填 */
rankDir?: 'asc' | 'desc' | null;
```

- [ ] **Step 3: 写失败单测（排序）**

创建 `rank-select.spec.ts`：

```typescript
import { assignRanks, RANK_FIELD_WHITELIST, defaultRankDir } from './rank-select';

describe('assignRanks', () => {
  it('desc: higher value rank=1', () => {
    const out = assignRanks(
      [
        { tsCode: '000002.SZ', rankValue: 10 },
        { tsCode: '000001.SZ', rankValue: 20 },
      ],
      'desc',
    );
    expect(out.map((x) => x.tsCode)).toEqual(['000001.SZ', '000002.SZ']);
    expect(out[0].rank).toBe(1);
  });

  it('tie → smaller ts_code first', () => {
    const out = assignRanks(
      [
        { tsCode: '000002.SZ', rankValue: 10 },
        { tsCode: '000001.SZ', rankValue: 10 },
      ],
      'desc',
    );
    expect(out[0].tsCode).toBe('000001.SZ');
  });

  it('nulls last for both dirs', () => {
    const desc = assignRanks(
      [
        { tsCode: '000002.SZ', rankValue: null },
        { tsCode: '000001.SZ', rankValue: 1 },
      ],
      'desc',
    );
    expect(desc[0].tsCode).toBe('000001.SZ');
    const asc = assignRanks(
      [
        { tsCode: '000002.SZ', rankValue: null },
        { tsCode: '000001.SZ', rankValue: 1 },
      ],
      'asc',
    );
    expect(asc[0].tsCode).toBe('000001.SZ');
  });

  it('none: sort by ts_code only', () => {
    const out = assignRanks(
      [
        { tsCode: '000002.SZ', rankValue: null },
        { tsCode: '000001.SZ', rankValue: null },
      ],
      'asc',
      { mode: 'none' },
    );
    expect(out[0].tsCode).toBe('000001.SZ');
  });
});

describe('defaultRankDir', () => {
  it('turnover_rate → desc', () => {
    expect(defaultRankDir('turnover_rate')).toBe('desc');
  });
  it('pos_120 → asc', () => {
    expect(defaultRankDir('pos_120')).toBe('asc');
  });
});

describe('RANK_FIELD_WHITELIST', () => {
  it('contains curated fields + none', () => {
    expect(RANK_FIELD_WHITELIST.has('turnover_rate')).toBe(true);
    expect(RANK_FIELD_WHITELIST.has('none')).toBe(true);
    expect(RANK_FIELD_WHITELIST.has('oamv_macd')).toBe(false);
  });
});
```

- [ ] **Step 4: Run test — expect FAIL**

```powershell
pnpm --filter @cryptotrading/server exec jest rank-select.spec -v
```

Expected: FAIL（module not found / assignRanks undefined）

- [ ] **Step 5: 实现 `rank-select.ts`**

```typescript
import { ASHARE_FIELD_COL_MAP } from '../../../strategy-conditions/strategy-conditions.types';

export const RANK_FIELDS = [
  'turnover_rate',
  'pct_chg',
  'amount',
  'pos_120',
  'circ_mv',
  'amv_macd',
  'none',
] as const;

export type RankField = (typeof RANK_FIELDS)[number];
export type RankDir = 'asc' | 'desc';

export const RANK_FIELD_WHITELIST = new Set<string>(RANK_FIELDS);

const DEFAULT_DIR: Record<Exclude<RankField, 'none'>, RankDir> = {
  turnover_rate: 'desc',
  pct_chg: 'desc',
  amount: 'desc',
  pos_120: 'asc',
  circ_mv: 'asc',
  amv_macd: 'desc',
};

export function defaultRankDir(field: string): RankDir | null {
  if (field === 'none') return null;
  return DEFAULT_DIR[field as Exclude<RankField, 'none'>] ?? null;
}

/** SQL 表达式；none → null（不 SELECT） */
export function rankValueSqlExpr(rankField: string): string | null {
  if (rankField === 'none') return null;
  const col = ASHARE_FIELD_COL_MAP[rankField];
  if (!col) throw new Error(`rankField not in ASHARE_FIELD_COL_MAP: ${rankField}`);
  return col;
}

export interface RankCandidateIn {
  tsCode: string;
  rankValue: number | null;
}

export interface RankCandidateOut extends RankCandidateIn {
  rank: number;
}

export function assignRanks(
  items: RankCandidateIn[],
  dir: RankDir,
  opts?: { mode?: 'none' | 'value' },
): RankCandidateOut[] {
  const mode = opts?.mode ?? 'value';
  const sorted = [...items].sort((a, b) => {
    if (mode === 'none') return a.tsCode.localeCompare(b.tsCode);
    const aMiss = a.rankValue == null || Number.isNaN(a.rankValue);
    const bMiss = b.rankValue == null || Number.isNaN(b.rankValue);
    if (aMiss && bMiss) return a.tsCode.localeCompare(b.tsCode);
    if (aMiss) return 1;
    if (bMiss) return -1;
    const cmp = a.rankValue! - b.rankValue!;
    if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
    return a.tsCode.localeCompare(b.tsCode);
  });
  return sorted.map((x, i) => ({ ...x, rank: i + 1 }));
}
```

- [ ] **Step 6: Run test — expect PASS**

```powershell
pnpm --filter @cryptotrading/server exec jest rank-select.spec -v
```

- [ ] **Step 7: Commit**（仅当用户要求提交时执行；否则跳过）

```powershell
git add apps/server/src/strategies/regime-engine/backtest/rank-select.ts apps/server/src/strategies/regime-engine/backtest/rank-select.spec.ts apps/server/src/strategies/regime-engine/core/types.ts apps/server/src/entities/strategy/regime-strategy-config.entity.ts
git commit -m "feat(regime-backtest): add rank-select helper and not_top1 skip reason"
```

---

## Task 2: 配置校验

**Files:**
- Modify: `apps/server/src/strategies/regime-engine/regime-engine.validation.ts`
- Modify: `apps/server/src/strategies/regime-engine/regime-engine.validation.spec.ts`

- [ ] **Step 1: 写失败单测**

在 `regime-engine.validation.spec.ts` 增加（沿用现有 `cfg` / `expectFail` helper）：

```typescript
it('trade 象限 rankField 必填', () => {
  // 构造 action=trade、有 positionRatio/maxPositions、无 rankField
  expectFail(cfg, 'rankField');
});

it('trade rankField 非法 → fail', () => {
  // rankField: 'oamv_macd'
  expectFail(cfg, 'rankField');
});

it('trade rankField≠none 缺 rankDir → fail', () => {
  expectFail(cfg, 'rankDir');
});

it('trade rankField=none 可不要求 rankDir', () => {
  // rankField: 'none', rankDir: null → pass
  expectPass(cfg);
});

it('flat 带非法 rankField 不校验（原样保留）', () => {
  // action=flat, rankField: 'garbage' → pass
  expectPass(cfg);
});
```

- [ ] **Step 2: Run — expect FAIL**

```powershell
pnpm --filter @cryptotrading/server exec jest regime-engine.validation.spec -v
```

- [ ] **Step 3: 实现校验**

在校验 `action=trade` 分支（已有 `positionRatio`/`maxPositions` 处）追加：

```typescript
import { RANK_FIELD_WHITELIST } from './backtest/rank-select';

// trade:
const rf = entry.rankField;
if (typeof rf !== 'string' || !RANK_FIELD_WHITELIST.has(rf)) {
  fail(`${path}.rankField 必填且须为短名单字段（含 none）`);
}
if (rf !== 'none') {
  if (entry.rankDir !== 'asc' && entry.rankDir !== 'desc') {
    fail(`${path}.rankDir 在 rankField≠none 时必须为 asc|desc`);
  }
}
// flat: 不校验 rankField/rankDir
```

- [ ] **Step 4: Run — expect PASS**

```powershell
pnpm --filter @cryptotrading/server exec jest regime-engine.validation.spec -v
```

- [ ] **Step 5: Commit**（用户要求时）

---

## Task 3: DB 迁移 + 实体

**Files:**
- Create: `apps/server/src/migration/20260710_regime_backtest_trade_rank.sql`
- Create: `apps/server/src/migration/20260710_regime_backtest_trade_rank.ps1`
- Modify: `apps/server/src/entities/strategy/regime-backtest-trade.entity.ts`
- Modify: `apps/server/src/strategies/regime-engine/backtest/regime-backtest.types.ts`

- [ ] **Step 1: SQL**

```sql
ALTER TABLE regime_backtest_trade
  ADD COLUMN IF NOT EXISTS rank integer NULL,
  ADD COLUMN IF NOT EXISTS rank_field varchar(32) NULL,
  ADD COLUMN IF NOT EXISTS rank_value numeric NULL;

CREATE INDEX IF NOT EXISTS idx_regime_backtest_trade_run_signal_rank
  ON regime_backtest_trade (run_id, signal_date, rank);
```

- [ ] **Step 2: PS1**

照抄 `20260710_regime_backtest_version_nullable.ps1` 模板：`$PSScriptRoot` 引同名 SQL，`docker exec -i crypto-postgres psql ...`，再 `information_schema` 验证三列存在。

- [ ] **Step 3: 实体列**

```typescript
@Column({ type: 'int', nullable: true })
rank: number | null;

@Column({ type: 'varchar', length: 32, nullable: true, name: 'rank_field' })
rankField: string | null;

@Column({ type: 'numeric', nullable: true, name: 'rank_value' })
rankValue: string | null;
```

- [ ] **Step 4: `RegimeBacktestTrade` 类型**

```typescript
rank?: number;
rankField?: string;
rankValue?: number | null;
```

- [ ] **Step 5: 跑迁移（本地 DB 可用时）**

```powershell
powershell apps/server/src/migration/20260710_regime_backtest_trade_rank.ps1
```

Expected: `Migration complete`

- [ ] **Step 6: Commit**（用户要求时）

---

## Task 4: 枚举取数 + Top1 截断 + audit 产出

**Files:**
- Modify: `apps/server/src/strategy-conditions/strategy-conditions.enumerator.ts`
- Modify: `apps/server/src/strategies/regime-engine/backtest/loaders/signal-enumerator.ts`
- Modify: `apps/server/src/strategies/regime-engine/backtest/types/backtest-data.types.ts`
- Modify: `apps/server/src/strategies/regime-engine/backtest/regime-backtest.data-loader.ts`
- Modify: `apps/server/src/strategies/regime-engine/backtest/regime-backtest.types.ts`
- Create: `apps/server/src/strategies/regime-engine/backtest/loaders/signal-enumerator.spec.ts`（若现有无测，可测纯逻辑抽出部分；否则在 data-loader 旁测 `buildNotTop1Trades`）

- [ ] **Step 1: 扩展 `buildEnumerateQuery`**

增加可选参数 `rankValueExpr?: string | null`：

```typescript
export function buildEnumerateQuery(
  where: { sql: string; params: unknown[] },
  tradeDate: string,
  universe: SignalTestUniverse,
  opts?: { rankValueExpr?: string | null },
): { sql: string; params: unknown[] } {
  // ...
  const rankSelect =
    opts?.rankValueExpr != null && opts.rankValueExpr !== ''
      ? `, ${opts.rankValueExpr} AS "rankValue"`
      : '';
  const sql = `
    SELECT i.ts_code AS "tsCode"${rankSelect}
      FROM raw.daily_indicator i
      ...
     ORDER BY i.ts_code
  `;
  return { sql, params };
}
```

现有调用方不传 `opts` → 行为不变。

- [ ] **Step 2: 定义 `RankedCandidate`**

在 `backtest-data.types.ts`：

```typescript
export interface RankedCandidate {
  signalDate: string;
  buyDate: string;
  tsCode: string;
  regime: string;
  exitMode: string;
  rank: number;
  rankField: string;
  rankValue: number | null;
}
```

- [ ] **Step 3: 改 `SignalEnumerator.enumerate` 返回值**

```typescript
async enumerate(...): Promise<{
  top1Signals: RawSignal[];
  rankedAll: RankedCandidate[];
}>
```

逻辑（每日）：

1. `rankField = entry.rankField`（trade 已校验必有）  
2. `rankValueSqlExpr(rankField)` → `buildEnumerateQuery(..., { rankValueExpr })`  
3. rows → `assignRanks(..., rankDir, { mode: rankField==='none' ? 'none' : 'value' })`  
4. 无 `buyDate`（无 T+1）→ **整日 skip**（不进 top1、不进 rankedAll）  
5. 有 buyDate：全部写入 `rankedAll`；仅 `rank===1` push 到 `top1Signals`

解析 `rankValue`：`row.rankValue == null ? null : Number(row.rankValue)`（NaN→null）。

`exitMode: entry.exitMode ?? ''`。

- [ ] **Step 4: 改 `RegimeBacktestDataLoader.load`**

```typescript
async load(...): Promise<{
  input: RegimeBacktestInput;
  rankedAll: RankedCandidate[];
}> {
  const { top1Signals, rankedAll } = await this.signalEnumerator.enumerate(...);
  const signalsByDate = await this.windowBuilder.build(top1Signals, globalCalendar, dateEnd);
  return {
    input: { regimeConfig, capital, calendar, marketSnapshots, signalsByDate },
    rankedAll,
  };
}
```

- [ ] **Step 5: 单测排序截断（可对 enumerator 抽纯函数测，或 mock query）**

至少覆盖：3 候选 desc → top1 1 条、rankedAll 3 条且 rank 1..3。

- [ ] **Step 6: 更新 runner 调用点编译通过（Task 5 完成 merge；本步可先临时 `const { input } = await load`）**

- [ ] **Step 7: Commit**（用户要求时）

---

## Task 5: Runner merge 落库 + listTrades 排序 + nSkipped

**Files:**
- Modify: `apps/server/src/strategies/regime-engine/backtest/regime-backtest.runner.ts`
- Modify: `apps/server/src/strategies/regime-engine/backtest/regime-backtest.service.ts`
- Create: `apps/server/src/strategies/regime-engine/backtest/rank-audit-merge.ts`
- Create: `apps/server/src/strategies/regime-engine/backtest/rank-audit-merge.spec.ts`

- [ ] **Step 1: 写 `mergeRankAudit` 失败单测**

```typescript
import { mergeRankAudit } from './rank-audit-merge';

it('enriches top1 engine trade with rank=1', () => {
  const engine = [{
    signalDate: '20260101', buyDate: '20260102', exitDate: null,
    tsCode: '000001.SZ', regime: 'Q1', exitMode: 'fixed_n',
    status: 'taken' as const, alloc: 100,
  }];
  const ranked = [{
    signalDate: '20260101', buyDate: '20260102', tsCode: '000001.SZ',
    regime: 'Q1', exitMode: 'fixed_n', rank: 1,
    rankField: 'turnover_rate', rankValue: 12.3,
  }, {
    signalDate: '20260101', buyDate: '20260102', tsCode: '000002.SZ',
    regime: 'Q1', exitMode: 'fixed_n', rank: 2,
    rankField: 'turnover_rate', rankValue: 11,
  }];
  const { trades, extraSkipped } = mergeRankAudit(engine, ranked);
  expect(trades.filter((t) => t.rank === 1)).toHaveLength(1);
  expect(trades.find((t) => t.tsCode === '000001.SZ')?.rankValue).toBe(12.3);
  expect(trades.filter((t) => t.skipReason === 'not_top1')).toHaveLength(1);
  expect(extraSkipped).toBe(1);
});

it('does not duplicate rank=1 as not_top1', () => {
  const { trades } = mergeRankAudit([], [/* only rank 2,3 */]);
  expect(trades.every((t) => t.rank !== 1 || t.skipReason !== 'not_top1')).toBe(true);
});

it('top1 already_held still rank=1 skipped, no promote rank2', () => {
  const engine = [{
    signalDate: '20260101', buyDate: '20260102', exitDate: null,
    tsCode: '000001.SZ', regime: 'Q1', exitMode: 'fixed_n',
    status: 'skipped' as const, skipReason: 'already_held' as const,
  }];
  const ranked = [/* rank1 000001, rank2 000002 */];
  const { trades } = mergeRankAudit(engine, ranked);
  expect(trades.find((t) => t.rank === 1)?.skipReason).toBe('already_held');
  expect(trades.find((t) => t.rank === 2)?.skipReason).toBe('not_top1');
  expect(trades.filter((t) => t.status === 'taken')).toHaveLength(0);
});
```

- [ ] **Step 2: 实现 `rank-audit-merge.ts`**

```typescript
export function mergeRankAudit(
  engineTrades: RegimeBacktestTrade[],
  rankedAll: RankedCandidate[],
): { trades: RegimeBacktestTrade[]; extraSkipped: number } {
  const byKey = new Map(
    rankedAll.map((c) => [`${c.signalDate}|${c.tsCode}`, c]),
  );
  const enriched = engineTrades.map((t) => {
    const c = byKey.get(`${t.signalDate}|${t.tsCode}`);
    if (!c) return t;
    return {
      ...t,
      rank: c.rank,
      rankField: c.rankField,
      rankValue: c.rankValue,
    };
  });
  const notTop1 = rankedAll
    .filter((c) => c.rank >= 2)
    .map((c) => ({
      signalDate: c.signalDate,
      buyDate: c.buyDate,
      exitDate: null as string | null,
      tsCode: c.tsCode,
      regime: c.regime,
      exitMode: c.exitMode,
      status: 'skipped' as const,
      skipReason: 'not_top1' as const,
      rank: c.rank,
      rankField: c.rankField,
      rankValue: c.rankValue,
    }));
  return {
    trades: [...enriched, ...notTop1],
    extraSkipped: notTop1.length,
  };
}
```

- [ ] **Step 3: Runner 接线**

```typescript
const { input, rankedAll } = await this.dataLoader.load(...);
const result = runRegimeBacktest(input);
const { trades, extraSkipped } = mergeRankAudit(result.trades, rankedAll);
result.trades = trades;
result.summary.nSkipped += extraSkipped;
await this.writeResults(runId, result);
// writeResults create 时写入 rank/rankField/rankValue（numStr）
```

- [ ] **Step 4: `listTrades` 排序**

```typescript
order: { signalDate: 'ASC', rank: 'ASC', id: 'ASC' },
```

（TypeORM；若 `rank` null 旧数据排后，可接受。若需 `NULLS LAST`，改 query builder raw `ORDER BY signal_date ASC, rank ASC NULLS LAST`。）

- [ ] **Step 5: Run tests**

```powershell
pnpm --filter @cryptotrading/server exec jest rank-audit-merge.spec rank-select.spec -v
```

- [ ] **Step 6: Commit**（用户要求时）

---

## Task 6: 前端配置 UI

**Files:**
- Create: `apps/web/src/components/regime/rankFieldMeta.ts`
- Modify: `apps/web/src/api/modules/strategy/regimeEngine.ts`
- Modify: `apps/web/src/components/regime/regimeConfigEditor.helpers.ts`
- Modify: `apps/web/src/components/regime/RegimeConfigEditor.vue`
- Modify: `apps/web/src/components/strategy/regime-backtest/RegimeBacktestConfigSummary.vue`

- [ ] **Step 1: `rankFieldMeta.ts`**

```typescript
export const RANK_FIELD_OPTIONS = [
  { value: 'turnover_rate', label: '换手率', defaultDir: 'desc' as const },
  { value: 'pct_chg', label: '涨跌幅', defaultDir: 'desc' as const },
  { value: 'amount', label: '成交额', defaultDir: 'desc' as const },
  { value: 'pos_120', label: '120日位置', defaultDir: 'asc' as const },
  { value: 'circ_mv', label: '流通市值', defaultDir: 'asc' as const },
  { value: 'amv_macd', label: '个股AMV-MACD', defaultDir: 'desc' as const },
  { value: 'none', label: '不排序(代码升序)', defaultDir: null },
]

export const RANK_DIR_OPTIONS = [
  { value: 'asc', label: '升序' },
  { value: 'desc', label: '降序' },
]

export function labelForRankField(field: string | null | undefined): string {
  return RANK_FIELD_OPTIONS.find((o) => o.value === field)?.label ?? field ?? '—'
}
```

- [ ] **Step 2: 前端类型**

`QuadrantEntry` 增加 `rankField?` / `rankDir?`。  
`RegimeBacktestTrade` 增加 `rank` / `rankField` / `rankValue`。

- [ ] **Step 3: helpers 默认值**

`makeDefaultQuadrant` / `cloneQuadrant`：

```typescript
rankField: 'turnover_rate',
rankDir: 'desc',
```

`validateAndGetConfig` 路径：trade 缺 `rankField` → `message.warning` 并 return null（与仓位校验同级）。

- [ ] **Step 4: Editor UI**

在仓位 `n-form-item` 下方（仅 `q.action==='trade'`）：

```vue
<n-form-item label="选股排序">
  <n-space>
    <n-select
      :value="q.rankField ?? 'turnover_rate'"
      :options="RANK_FIELD_OPTIONS.map(o => ({ label: o.label, value: o.value }))"
      style="width: 180px"
      @update:value="(v) => onRankFieldChange(q, v)"
    />
    <n-select
      v-if="q.rankField !== 'none'"
      :value="q.rankDir ?? 'desc'"
      :options="RANK_DIR_OPTIONS"
      style="width: 100px"
      @update:value="(v) => (q.rankDir = v)"
    />
  </n-space>
</n-form-item>
```

`onRankFieldChange`：设 `rankField`；若 ≠ none，设对应 `defaultDir`；若 none，`rankDir = null`。

- [ ] **Step 5: ConfigSummary**

trade 行增加：`sort={{ labelForRankField(q.rankField) }}{{ q.rankField==='none' ? '' : (q.rankDir==='asc'?'↑':'↓') }}`

- [ ] **Step 6: type-check**

```powershell
pnpm --filter @cryptotrading/web type-check
```

- [ ] **Step 7: Commit**（用户要求时）

---

## Task 7: 详情交易表分组 + 筛选

**Files:**
- Modify: `apps/web/src/components/strategy/regime-backtest/RegimeBacktestTradesTable.vue`
- 若行数将超 500：拆 `RegimeBacktestTradeDayGroup.vue`

- [ ] **Step 1: labels**

```typescript
const SKIP_REASON_LABELS: Record<string, string> = {
  // ...existing
  budget_full: '开仓预算已满',
  regime_flat: '象限空仓',
  not_top1: '未入选',
}
```

- [ ] **Step 2: 筛选 + 分组**

Props 仍为 `trades: RegimeBacktestTrade[]`。内部：

```typescript
type FilterMode = 'all' | 'selected' | 'taken'
// all: 不过滤
// selected: rank === 1
// taken: status === 'taken'
```

按 `signalDate` group；组头：`候选数`、`入选 tsCode`（`rank===1`）、`regime`。  
默认折叠（`n-collapse`）；组内小表列：`#`(rank)、代码、排序值（原始 `rankValue`）、状态、原因。  
列标题：用组内首条 `rankField` 的中文名（`labelForRankField`）。

顶部：

```vue
<n-radio-group v-model:value="filterMode">
  <n-radio-button value="all">全部</n-radio-button>
  <n-radio-button value="selected">仅入选</n-radio-button>
  <n-radio-button value="taken">仅成交</n-radio-button>
</n-radio-group>
```

- [ ] **Step 3: 行数检查**

```powershell
pnpm --filter @cryptotrading/web lint:quant-lines
```

超限则拆子组件。

- [ ] **Step 4: type-check**

```powershell
pnpm --filter @cryptotrading/web type-check
```

- [ ] **Step 5: Commit**（用户要求时）

---

## Task 8: 对照验收 + 代码审查（SubAgent）

- [ ] **Step 1: 主 Agent 跑后端相关单测**

```powershell
pnpm --filter @cryptotrading/server exec jest rank-select.spec rank-audit-merge.spec regime-engine.validation.spec -v
```

- [ ] **Step 2: 派发只读 Review SubAgent**

对照 spec §7 清单逐条核对 diff；检查：

- 同日仅一条 `rank=1`  
- 引擎不感知 rank  
- `not_top1` 行模板非空列齐全  
- 无 T+1 整日不产出  
- 不递补  
- Live `runDaily` 未改  

- [ ] **Step 3: 按审查意见修阻塞项**

---

## Spec 覆盖自检

| Spec 要求 | Task |
|-----------|------|
| 短名单 + 默认方向 + 空值殿后 + 平局 | Task 1 |
| trade 校验 / flat 忽略 / 缺字段 400 | Task 2 |
| trade 表 rank 三列 + 迁移 | Task 3 |
| SQL 取 rankValue + Top1 截断 + rankedAll | Task 4 |
| merge 不双写 + nSkipped + listTrades 序 | Task 5 |
| 编辑器排序 UI + 默认 + summary | Task 6 |
| 详情分组 / 仅入选 / 仅成交 / 未入选文案 | Task 7 |
| 验收 + 审查 | Task 8 |
| Live 不改 | 全任务禁止改 `runDaily` |
| 不递补 | Task 5 单测 |

---

## 执行方式

Plan 已保存到 `docs/superpowers/plans/2026-07-10-regime-backtest-top1-rank.md`。

两种执行选项：

1. **SubAgent-Driven（推荐）** — 按上方 Wave 每个 Task 派新鲜 SubAgent，Task 间主 Agent 审查  
2. **Inline Execution** — 本会话按 Task 顺序直接改代码

选哪一种？
