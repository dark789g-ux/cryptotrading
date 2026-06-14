/**
 * portfolio-sim.loader-sql.ts
 *
 * 装载层「多因子 SQL 构建 + factorValues 组装」纯逻辑（不依赖 DB / NestJS），抽出以便单测。
 *
 * 设计动机（database-sql.md 教训）：
 *   - 「动态 SQL 构建禁止直接拼接前端字段名」——前端只送因子 KEY，本模块用 RANK_FACTOR_REGISTRY
 *     里写死的常量（表 / schema / 列）翻译成 SQL，绝不把前端字符串拼进 SQL。
 *   - mock QueryBuilder 单测验不出水合是否正确；本模块把「能纯逻辑断言」的部分（表去重、列别名、
 *     ml_score DISTINCT ON 子查询、momentum compute、null 置位）抽成无副作用函数，单测可真断言；
 *     真实 JOIN 水合 / 行数翻倍只能靠真机集成验证（见 spec 09）。
 *
 * 口径基准：spec 06-loader-multifactor.md（注册表驱动多因子装载）。
 */

import {
  RANK_FACTOR_REGISTRY,
  RankFactorRegistryEntry,
} from './portfolio-sim.factor-registry';
import { parseNumericString } from './portfolio-sim.loader-helpers';
import { RankFactorKey } from './portfolio-sim.types';

/**
 * 解析后的「一列因子来源」：注册表常量翻译出的 schema/表/列 + SELECT 别名。
 * alias 同时用作 JS 侧读取该列值的 key（与 SQL `AS "alias"` 一致）。
 */
export interface ResolvedFactorColumn {
  /** schema（缺省 'public'）。 */
  schema: string;
  /** 表名（注册表常量）。 */
  table: string;
  /** 列名（注册表常量）。 */
  column: string;
  /** SELECT 列别名（同 JS 侧读值 key）。 */
  alias: string;
}

/** 单张需 JOIN 的表 + 它要 SELECT 的列集合。 */
export interface FactorJoinTable {
  schema: string;
  table: string;
  /** SQL 内该表的 JOIN 别名（如 j0/j1）。 */
  joinAlias: string;
  /** 该表要 SELECT 的列（按出现顺序，已去重）。 */
  columns: ResolvedFactorColumn[];
}

/** ml.scores_daily 的 schema/table 常量（DISTINCT ON 去重 JOIN 专用判定）。 */
const ML_SCORES_SCHEMA = 'ml';
const ML_SCORES_TABLE = 'scores_daily';

/**
 * 为 column-kind 因子生成稳定 SELECT 别名。
 * 用因子 KEY 前缀 `f_`，每 KEY 唯一、不含外部输入；与 computed 的 needs.alias（mom_*）天然不冲突。
 */
export function columnAliasFor(key: RankFactorKey): string {
  return `f_${key}`;
}

/**
 * 把一组因子 KEY 翻译成「需 SELECT 的列」（全来自注册表常量）。
 *
 * - column 因子：取 entry.source（schema 缺省 public），别名 = columnAliasFor(key)。
 * - computed 因子（momentum_60）：展开 entry.needs，别名用 needs 自带 alias。
 * - 未命中注册表的 KEY：onUnknown 回调（loader 侧 warn）+ 跳过。
 *
 * 返回列已去重：同 (schema, table, column) 只保留首个别名（同表多因子共用同列时不重复 SELECT）。
 */
export function collectFactorColumns(
  keys: RankFactorKey[],
  onUnknown?: (key: string) => void,
): ResolvedFactorColumn[] {
  const out: ResolvedFactorColumn[] = [];
  const seen = new Set<string>(); // schema.table.column 去重

  const push = (col: ResolvedFactorColumn): void => {
    const dedupKey = `${col.schema}.${col.table}.${col.column}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push(col);
  };

  for (const key of keys) {
    const entry: RankFactorRegistryEntry | undefined = RANK_FACTOR_REGISTRY[key];
    if (!entry) {
      onUnknown?.(key);
      continue;
    }
    if (entry.kind === 'column' && entry.source) {
      push({
        schema: entry.source.schema ?? 'public',
        table: entry.source.table,
        column: entry.source.column,
        alias: columnAliasFor(key),
      });
    } else if (entry.kind === 'computed' && entry.needs) {
      for (const n of entry.needs) {
        push({
          schema: n.schema ?? 'public',
          table: n.table,
          column: n.column,
          alias: n.alias,
        });
      }
    }
  }
  return out;
}

/**
 * 把列集合按 (schema, table) 归并成 JOIN 计划：同一张表只 JOIN 一次，SELECT 该表全部用到的列。
 *
 * @returns FactorJoinTable[]，joinAlias 按出现顺序 j0/j1/...（确定性，便于单测）。
 */
export function buildJoinTables(
  cols: ResolvedFactorColumn[],
): FactorJoinTable[] {
  const byTable = new Map<string, FactorJoinTable>();
  for (const col of cols) {
    const tableKey = `${col.schema}.${col.table}`;
    let entry = byTable.get(tableKey);
    if (!entry) {
      entry = {
        schema: col.schema,
        table: col.table,
        joinAlias: `j${byTable.size}`,
        columns: [],
      };
      byTable.set(tableKey, entry);
    }
    entry.columns.push(col);
  }
  return Array.from(byTable.values());
}

/** 判定某张表是否为需 DISTINCT ON 去重的 ml.scores_daily。 */
function isMlScoresTable(t: FactorJoinTable): boolean {
  return t.schema === ML_SCORES_SCHEMA && t.table === ML_SCORES_TABLE;
}

/**
 * 为单张 JOIN 表生成 LEFT JOIN 子句。
 *
 * - 普通表：LEFT JOIN <schema>.<table> jX ON jX.ts_code=t.ts_code AND jX.trade_date=t.signal_date
 * - ml.scores_daily：必须先 pin 单模型再去重，否则跨 model_version 重复键致 trade 翻倍。
 *     LEFT JOIN ( SELECT DISTINCT ON (trade_date, ts_code) trade_date, ts_code, score
 *                   FROM ml.scores_daily
 *                  ORDER BY trade_date, ts_code, model_version DESC, rank_in_day ASC ) jX
 *       ON jX.ts_code=t.ts_code AND jX.trade_date=t.signal_date
 *   （model_version DESC → 每键取最新模型；单模型内 (date,ts_code) 唯一故确定。）
 *
 * 表名 / schema 全来自注册表常量，无外部输入。
 */
function joinClauseFor(t: FactorJoinTable): string {
  const on = `${t.joinAlias}.ts_code = t.ts_code AND ${t.joinAlias}.trade_date = t.signal_date`;
  if (isMlScoresTable(t)) {
    return (
      `LEFT JOIN (\n` +
      `  SELECT DISTINCT ON (trade_date, ts_code) trade_date, ts_code, score\n` +
      `    FROM ${ML_SCORES_SCHEMA}.${ML_SCORES_TABLE}\n` +
      `   ORDER BY trade_date, ts_code, model_version DESC, rank_in_day ASC\n` +
      `) ${t.joinAlias} ON ${on}`
    );
  }
  return `LEFT JOIN ${t.schema}.${t.table} ${t.joinAlias} ON ${on}`;
}

/** 单条 SELECT 因子列：jX.<column> AS "alias"。 */
function selectColumnExpr(t: FactorJoinTable, col: ResolvedFactorColumn): string {
  return `${t.joinAlias}.${col.column} AS "${col.alias}"`;
}

/**
 * 装载某源 trades 的参数化 SQL（注册表驱动多因子 JOIN）。
 *
 * 固定 SELECT trade 基础列（ts_code/signal_date/buy_date/exit_date/ret/hold_days），
 * 追加各因子列（jX.col AS "alias"），FROM signal_test_trade t，每因子表 LEFT JOIN 一次，
 * WHERE t.run_id = $1。
 *
 * keys 为空（rankSpec=[] / none）→ 不 JOIN 任何因子表，只取基础列。
 *
 * @returns { sql, columns } columns 供 buildFactorValues 知道每因子读哪个别名。
 */
export function buildSourceTradesSql(
  keys: RankFactorKey[],
  onUnknown?: (key: string) => void,
): { sql: string; columns: ResolvedFactorColumn[] } {
  const cols = collectFactorColumns(keys, onUnknown);
  const joinTables = buildJoinTables(cols);

  const selectFactorCols = joinTables
    .flatMap((t) => t.columns.map((c) => selectColumnExpr(t, c)))
    .map((s) => `,\n         ${s}`)
    .join('');

  const joins = joinTables.map((t) => joinClauseFor(t)).join('\n  ');

  const sql =
    `SELECT t.ts_code AS "tsCode",\n` +
    `         t.signal_date AS "signalDate",\n` +
    `         t.buy_date AS "buyDate",\n` +
    `         t.exit_date AS "exitDate",\n` +
    `         t.ret AS "ret",\n` +
    `         t.hold_days AS "holdDays"` +
    selectFactorCols +
    `\n    FROM signal_test_trade t` +
    (joins ? `\n  ${joins}` : '') +
    `\n   WHERE t.run_id = $1`;

  return { sql, columns: cols };
}

/**
 * 从一行查询结果组装 factorValues：column 直取过 parseNumericString，computed 调注册表 compute。
 *
 * - column 因子：取 row[columnAliasFor(key)]，过 parseNumericString（pg numeric=string / double=number 都吃）；
 *   null / 未命中 → null。
 * - computed 因子：先 parseNumericString 每个 needs.alias，再调 entry.compute；任一输入 null / 分母 0 → null。
 * - 未命中注册表的 KEY：跳过（不进 out；与 collectFactorColumns 的 onUnknown 双保险）。
 *
 * keys 为空 → 返回 undefined（无因子，引擎走 ts_code 升序）。
 */
export function buildFactorValues(
  keys: RankFactorKey[],
  row: Record<string, unknown>,
): Record<RankFactorKey, number | null> | undefined {
  if (keys.length === 0) return undefined;
  const out = {} as Record<RankFactorKey, number | null>;
  for (const key of keys) {
    const entry = RANK_FACTOR_REGISTRY[key];
    if (!entry) continue; // 防御跳过（warn 已在 collectFactorColumns）
    if (entry.kind === 'column' && entry.source) {
      out[key] = toNum(row[columnAliasFor(key)]);
    } else if (entry.kind === 'computed' && entry.needs && entry.compute) {
      const vals: Record<string, number | null> = {};
      for (const n of entry.needs) vals[n.alias] = toNum(row[n.alias]);
      out[key] = entry.compute(vals);
    } else {
      out[key] = null;
    }
  }
  return out;
}

/** pg 原始值（string numeric / number double / null）→ number|null，统一过 parseNumericString。 */
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return parseNumericString(String(v));
}
