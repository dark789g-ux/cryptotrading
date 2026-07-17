/**
 * signal-enumerator-phase2.ts
 *
 * Phase 2 内存重算 helpers，供 SignalEnumerator 使用。
 *
 * 拆出是因为 signal-enumerator.ts 不能膨胀到 500+ 行。
 * 包含：
 *   - phase2Recompute: 对 Phase 1 候选集按 recompConds 做内存过滤
 *   - phase2RankValue: 当 rankField 为现算字段时补算 rankValue
 *   - fetchSqlFieldValues: 批量查预算字段当日值（供 siblingResults 注入）
 */

import { DataSource } from 'typeorm';
import { StrategyConditionItem } from '../../../../entities/strategy/strategy-condition.entity';
import {
  DerivedFieldRegistry,
  DerivedFieldSnapshot,
} from '../../../../strategy-conditions/derived-field-registry';
import { ASHARE_FIELD_COL_MAP } from '../../../../strategy-conditions/strategy-conditions.types';

const MA_FIELD_RE = /^ma\d+$/;

// ── 公共类型 ────────────────────────────────────────────────────────────────

/** Phase 1 查询返回的行（可能缺 rankValue） */
export interface Phase1Row {
  tsCode: string;
  rankValue?: unknown;
}

// ── Phase 2 内存重算过滤 ────────────────────────────────────────────────────

/**
 * 对 Phase 1 候选集按 recompConds 做内存 AND 过滤。
 *
 * 每个 recompCond 单独用 registry.resolve 拿 recomputer 调 recomputeLatest，
 * 再用 evaluate 求值；全部通过才保留该 tsCode。
 *
 * siblingResults 注入策略：
 *   - compareField 是现算字段 → 从 snapshotsByCond 找
 *   - compareField 是预算字段 → 从 sqlFieldValues Map 查（需提前调 fetchSqlFieldValues）
 */
export async function phase2Recompute(
  rows: Phase1Row[],
  recompConds: StrategyConditionItem[],
  asOfDate: string,
  registry: DerivedFieldRegistry,
  dataSource: DataSource,
  sqlFieldValues?: Map<string, Record<string, number>>,
): Promise<Phase1Row[]> {
  if (rows.length === 0 || recompConds.length === 0) return rows;
  const tsCodes = rows.map((r) => r.tsCode);

  // 预加载每个 recompCond 的 snapshots
  const snapshotsByCond = new Map<number, Map<string, DerivedFieldSnapshot<unknown>>>();
  for (let i = 0; i < recompConds.length; i++) {
    const cond = recompConds[i];
    const recomputer = registry.resolve(cond)!;
    const snapshots = await recomputer.recomputeLatest(tsCodes, asOfDate, cond);
    snapshotsByCond.set(i, snapshots);
  }

  // 逐行 AND 求值
  const keep = new Set<string>();
  for (const row of rows) {
    let allPass = true;
    for (let i = 0; i < recompConds.length; i++) {
      const cond = recompConds[i];
      const recomputer = registry.resolve(cond)!;
      const snap = snapshotsByCond.get(i)!.get(row.tsCode);
      if (!snap) {
        allPass = false;
        break;
      }

      // 构造 siblingResults
      const siblingResults = buildSiblingResults(
        cond,
        row.tsCode,
        snapshotsByCond,
        recompConds,
        registry,
        sqlFieldValues,
      );

      if (!recomputer.evaluate(cond, snap, siblingResults)) {
        allPass = false;
        break;
      }
    }
    if (allPass) keep.add(row.tsCode);
  }

  return rows.filter((r) => keep.has(r.tsCode));
}

// ── Phase 2 rankValue 补算 ────────────────────────────────────────────────

/**
 * 当 rankField 是现算字段时，Phase 1 SQL 不会 SELECT rankValue。
 * 本函数为每个候选补算 rankField 的 curr 值。
 *
 * 返回值语义与 MaFieldRecomputer 的 MaSnapshot.curr.ma 一致：
 *   - 如果 recomputer 是 MaFieldRecomputer，取 curr.ma
 *   - 如果是 KdjFieldRecomputer，取 curr 中对应线的值（按 field 名称推断）
 *   - 通用兜底：如果 curr 是数字直接取，是对象尝试取 .ma / 按 kdj 取
 *
 * 简化实现：直接用 recomputeLatest 拿 snapshot，再从 curr 中提取数字。
 */
export async function phase2RankValue(
  rows: Phase1Row[],
  rankField: string,
  asOfDate: string,
  registry: DerivedFieldRegistry,
): Promise<Phase1Row[]> {
  if (rows.length === 0) return rows;

  // 构造一个"假"条件（只有 field）来让 registry 解析
  const probeCond = { field: rankField } as StrategyConditionItem;
  const recomputer = registry.resolve(probeCond);
  if (!recomputer) return rows; // rankField 不是现算字段，不处理

  const tsCodes = rows.map((r) => r.tsCode);
  const snapshots = await recomputer.recomputeLatest(tsCodes, asOfDate, probeCond);

  return rows.map((row) => {
    const snap = snapshots.get(row.tsCode);
    if (!snap || snap.curr === null) return row;

    const num = extractNumericValue(snap.curr, rankField);
    if (num === null) return row;

    return { ...row, rankValue: num };
  });
}

// ── 批量查预算字段当日值（供 siblingResults） ──────────────────────────────

/**
 * 批量从 daily_indicator 查 recompConds 用到的预算字段当日值。
 *
 * 返回 Map<tsCode, Record<fieldName, number>>，缺失的 tsCode 不在 Map 中。
 */
export async function fetchSqlFieldValues(
  tsCodes: string[],
  asOfDate: string,
  fieldNames: string[],
  dataSource: DataSource,
): Promise<Map<string, Record<string, number>>> {
  const result = new Map<string, Record<string, number>>();
  if (tsCodes.length === 0 || fieldNames.length === 0) return result;

  // 构造 SELECT 子句：每个 field → ASHARE_FIELD_COL_MAP 的 SQL 表达式
  const selects = fieldNames.map(
    (f) => `${ASHARE_FIELD_COL_MAP[f]} AS "${f}"`,
  );
  const sql = `
    SELECT ts_code, ${selects.join(', ')}
    FROM raw.daily_indicator i
    WHERE ts_code = ANY($1::text[]) AND trade_date = $2
  `;
  const rows = await dataSource.query(sql, [tsCodes, asOfDate]);

  for (const row of rows) {
    const tsCode = row.ts_code;
    const values: Record<string, number> = {};
    for (const f of fieldNames) {
      const v = Number(row[f]);
      values[f] = Number.isNaN(v) ? null! : v;
    }
    result.set(tsCode, values);
  }

  return result;
}

// ── 内部 helpers ─────────────────────────────────────────────────────────────

/**
 * 找出 recompConds 里所有 compareField 且属于预算字段的字段名。
 */
export function findNeededSqlFields(
  recompConds: StrategyConditionItem[],
): Set<string> {
  const needed = new Set<string>();
  for (const cond of recompConds) {
    if (cond.compareField && ASHARE_FIELD_COL_MAP[cond.compareField]) {
      needed.add(cond.compareField);
    }
  }
  return needed;
}

/**
 * 构造 siblingResults Map，供 evaluate 使用。
 *
 * key = compareField 名(如 'ma10' / 'kdj_k')
 * value = DerivedFieldSnapshot（如果 compareField 是现算字段）
 *          或从 sqlFieldValues 构造的简单 snapshot（如果是预算字段）
 */
function buildSiblingResults(
  cond: StrategyConditionItem,
  tsCode: string,
  snapshotsByCond: Map<number, Map<string, DerivedFieldSnapshot<unknown>>>,
  recompConds: StrategyConditionItem[],
  registry: DerivedFieldRegistry,
  sqlFieldValues?: Map<string, Record<string, number>>,
): Map<string, DerivedFieldSnapshot<unknown>> | undefined {
  if (!cond.compareField) return undefined;

  const sibling = new Map<string, DerivedFieldSnapshot<unknown>>();

  const compareField = cond.compareField;

  // 情况 1: compareField 是现算字段 → 从 snapshotsByCond 找
  const probeCond = { field: compareField } as StrategyConditionItem;
  if (registry.resolve(probeCond)) {
    for (let i = 0; i < recompConds.length; i++) {
      if (recompConds[i].field === compareField) {
        const snap = snapshotsByCond.get(i)?.get(tsCode);
        if (snap) {
          sibling.set(compareField, snap);
        }
        break;
      }
    }
    return sibling.size > 0 ? sibling : undefined;
  }

  // 情况 2: compareField 是预算字段 → 从 sqlFieldValues 构造
  if (sqlFieldValues) {
    const vals = sqlFieldValues.get(tsCode);
    if (vals && vals[compareField] !== undefined && vals[compareField] !== null) {
      const rawValue = vals[compareField];
      // MA 字段包装成 {ma: number} 与 MaSnapshot 形状一致
      const curr = MA_FIELD_RE.test(compareField) ? { ma: rawValue } : rawValue;
      sibling.set(compareField, {
        curr,
        prev: null,
      });
      return sibling;
    }
  }

  return undefined;
}

/**
 * 从 snapshot curr 中提取数字值。
 *
 * - 如果 curr 是 number → 直接取
 * - 如果 curr 是 { ma: number } → 取 .ma
 * - 如果 curr 是 { k, d, j } → 根据 rankField 推断取哪根线
 */
function extractNumericValue(
  curr: unknown,
  rankField: string,
): number | null {
  if (typeof curr === 'number') return curr;

  if (typeof curr === 'object' && curr !== null) {
    const obj = curr as Record<string, unknown>;
    // MA pattern
    if ('ma' in obj && typeof obj.ma === 'number') return obj.ma;
    // KDJ pattern
    if ('j' in obj && rankField === 'kdj_j' && typeof obj.j === 'number')
      return obj.j;
    if ('k' in obj && rankField === 'kdj_k' && typeof obj.k === 'number')
      return obj.k;
    if ('d' in obj && rankField === 'kdj_d' && typeof obj.d === 'number')
      return obj.d;
    // 兜底：如果只有一个数字属性就取它
    const numProps = Object.values(obj).filter(
      (v) => typeof v === 'number' && Number.isFinite(v),
    );
    if (numProps.length === 1) return numProps[0] as number;
  }

  return null;
}
