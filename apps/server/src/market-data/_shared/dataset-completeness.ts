import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';

const logger = new Logger('DatasetCompleteness');

/**
 * 数据集完整性对账配置（通用版）。
 *
 * baseline：
 *   - 'self'：仅自身行数 > 0（PRE 门控；POST 告警对 self 无意义，直接返回 []）。
 *   - { table, dateColumn?, filter? }：按基准表行数对账。
 *     - dateColumn 给出时按 trade_date 对齐（target vs baseline 当日行数）。
 *     - dateColumn 缺省时 baseline 为全表标量 COUNT（如 etf_symbol.tracked，不按日期）。
 *     - filter 是静态配置字符串（如 'tracked = true'），原样拼进 baseline WHERE。
 *       **filter 必须是代码内配置常量，禁止接受任何用户输入**（SQL 注入防线；
 *       trade_date 走 $1 参数化，filter 为字面值由调用方保证可控）。
 *
 * strictNonNullColumns：行级硬约束，仅 PRE isDatasetComplete 检查；
 *   POST collectCompletenessErrors 只看行数对账，不看列 NULL（粗粒度）。
 */
export type DatasetCompletenessConfig = {
  tableName: string;
  dateColumn: string;
  strictNonNullColumns?: string[];
  baseline: 'self' | { table: string; dateColumn?: string; filter?: string };
  toleranceRatio?: number;
};

type BaselineObject = { table: string; dateColumn?: string; filter?: string };

function isBaselineObject(b: DatasetCompletenessConfig['baseline']): b is BaselineObject {
  return typeof b === 'object' && b !== null;
}

function buildBaselineFilterFragment(b: BaselineObject): string {
  return b.filter ? ` AND ${b.filter}` : '';
}

/**
 * 构造 baseline 标量子查询（PRE isDatasetComplete 内联用）。
 *
 * - baseline 有 dateColumn：按日对齐，`WHERE dateColumn = $1 AND filter?`
 * - baseline 无 dateColumn：全表标量（不 WHERE 日期），如 etf_symbol.tracked
 *   全表；用 `WHERE TRUE AND filter?` 保持 SQL 形状一致
 */
function buildBaselineScalarSql(b: BaselineObject): string {
  const filterFrag = buildBaselineFilterFragment(b);
  if (b.dateColumn) {
    return `SELECT COUNT(*) FROM ${b.table} WHERE ${b.dateColumn} = $1${filterFrag}`;
  }
  return `SELECT COUNT(*) FROM ${b.table} WHERE TRUE${filterFrag}`;
}

/**
 * PRE-sync 门控：判断数据集当日是否完整。
 *
 * 判定不完整（返回 false，触发同步补齐）：
 *   - 查询无返回行
 *   - 自身总数 <= 0
 *   - 任一 strictNonNullColumns 在当日存在 NULL（行级硬约束）
 *   - baseline 对象时：
 *       * 基准当日 = 0（基准尚未落库，等本轮上游同步后再判）
 *       * total < baseline（行数对齐失败）
 *
 * SQL 形状（与 a-shares-sync-completeness 原实现保持一致）：
 *   SELECT
 *     COUNT(*) AS "__total",
 *     COUNT(*) FILTER (WHERE col IS NULL) AS "col__nulls", ...,
 *     (SELECT COUNT(*) FROM ${baseline.table} WHERE ...) AS "__baseline"
 *   FROM ${tableName} WHERE ${dateColumn} = $1
 *
 * baseline='self' 时不内联 baseline 子查询。
 */
export async function isDatasetComplete(
  repo: Repository<unknown>,
  config: DatasetCompletenessConfig,
  tradeDate: string,
): Promise<boolean> {
  const nullChecks = (config.strictNonNullColumns ?? [])
    .map((col) => `COUNT(*) FILTER (WHERE ${col} IS NULL) AS "${col}__nulls"`)
    .join(', ');

  const baselineSub = isBaselineObject(config.baseline)
    ? `, (${buildBaselineScalarSql(config.baseline)}) AS "__baseline"`
    : '';

  const sql = `
    SELECT
      COUNT(*) AS "__total"
      ${nullChecks ? `, ${nullChecks}` : ''}
      ${baselineSub}
    FROM ${config.tableName}
    WHERE ${config.dateColumn} = $1
  `;
  const rows = await repo.query<Array<Record<string, string | null>>>(sql, [tradeDate]);
  const row = rows[0];
  if (!row) return false;

  const total = Number(row.__total ?? 0);
  if (total <= 0) return false;

  for (const col of config.strictNonNullColumns ?? []) {
    const nulls = Number(row[`${col}__nulls`] ?? 0);
    if (nulls > 0) {
      logger.warn(
        `${config.tableName} ${tradeDate} 列 ${col} 存在 ${nulls} 行 NULL（共 ${total} 行），判定不完整以触发补齐`,
      );
      return false;
    }
  }

  if (isBaselineObject(config.baseline)) {
    const baseline = Number(row.__baseline ?? 0);
    if (baseline <= 0) {
      // 基准当日尚未落库，子数据集无从对齐——视为不完整，等本轮上游同步后再判
      return false;
    }
    const tolerance = config.toleranceRatio ?? 0;
    const threshold = baseline * (1 - tolerance);
    if (total < threshold) {
      logger.warn(
        `${config.tableName} ${tradeDate} 行数 ${total} < 基准 ${config.baseline.table} 行数 ${baseline}（容差 ${tolerance}，判定线 ${threshold}），判定不完整以触发补齐`,
      );
      return false;
    }
  }

  return true;
}

/**
 * POST-sync 告警：批量检查多日 actual vs baseline 行数对账。
 *
 * - tradeDates 空 → 返回 []（不查 DB）。
 * - baseline='self' → 返回 []（POST 告警对 self 无意义，调用方不应传，但 helper 容错）。
 * - 单日判定：
 *   * 基准当日未落库（map 缺键，如 baseline 表该日无行）→ 跳过不告警。
 *   * 基准当日 = 0（仅 baseline 不按日期且全表为空时可能出现）→ 跳过不告警。
 *   * actual < baseline → push `[${apiName}_incomplete] ${date} 入库 ${actual} < ${baseline}，疑似部分缺失`。
 *
 * 单次 GROUP BY 查询（target + baseline 各一次），避免 N 日 N 次往返。
 * 告警文案携带 apiName + 完整参数（遵 data-integrity.md「告警文案带 apiName」）。
 */
export async function collectCompletenessErrors(
  repo: Repository<unknown>,
  config: DatasetCompletenessConfig,
  tradeDates: string[],
  apiName: string,
): Promise<string[]> {
  if (tradeDates.length === 0) return [];
  if (!isBaselineObject(config.baseline)) return [];

  const errors: string[] = [];
  const baseline = config.baseline;

  // target：当日入库行数（按 trade_date GROUP BY）
  const targetSql = `
    SELECT ${config.dateColumn} AS trade_date, COUNT(*) AS total
    FROM ${config.tableName}
    WHERE ${config.dateColumn} = ANY($1::text[])
    GROUP BY ${config.dateColumn}
  `;
  const targetRows = await repo.query<Array<{ trade_date: string; total: string }>>(targetSql, [tradeDates]);
  const targetMap = new Map<string, number>();
  for (const r of targetRows) {
    targetMap.set(r.trade_date, Number(r.total));
  }

  // baseline：按日（map）或全表标量（均匀映射到每个 trade_date）
  const baselineByDate = await fetchBaselineByDate(repo, baseline, tradeDates);

  for (const date of tradeDates) {
    const actual = targetMap.get(date) ?? 0;
    const base = baselineByDate.get(date);
    if (base === undefined) continue; // 基准当日未落库，跳过不告警
    if (base <= 0) continue; // 基准当日为 0，跳过不告警
    if (actual < base) {
      errors.push(`[${apiName}_incomplete] ${date} 入库 ${actual} < ${base}，疑似部分缺失`);
    }
  }

  return errors;
}

/**
 * 取 baseline 行数映射。
 *
 * - baseline 有 dateColumn：`SELECT dateColumn, COUNT(*) WHERE dateColumn = ANY($1) GROUP BY` → Map<tradeDate, count>。
 *   基准表该日无行 → map 缺键（POST 调用方据此跳过不告警）。
 * - baseline 无 dateColumn：`SELECT COUNT(*) WHERE TRUE AND filter?` 全表标量。
 *   全表 COUNT > 0 → 对每个 tradeDate 复用同一值；= 0 → 返回空 Map（全部跳过，避免误报）。
 */
async function fetchBaselineByDate(
  repo: Repository<unknown>,
  baseline: BaselineObject,
  tradeDates: string[],
): Promise<Map<string, number>> {
  const filterFrag = buildBaselineFilterFragment(baseline);
  if (baseline.dateColumn) {
    const sql = `
      SELECT ${baseline.dateColumn} AS trade_date, COUNT(*) AS total
      FROM ${baseline.table}
      WHERE ${baseline.dateColumn} = ANY($1::text[])${filterFrag}
      GROUP BY ${baseline.dateColumn}
    `;
    const rows = await repo.query<Array<{ trade_date: string; total: string }>>(sql, [tradeDates]);
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.trade_date, Number(r.total));
    return m;
  }

  // baseline 不按日期：全表 COUNT 标量
  const sql = `SELECT COUNT(*) AS total FROM ${baseline.table} WHERE TRUE${filterFrag}`;
  const rows = await repo.query<Array<{ total: string }>>(sql);
  const total = Number(rows[0]?.total ?? 0);
  const m = new Map<string, number>();
  if (total > 0) {
    for (const date of tradeDates) m.set(date, total);
  }
  return m;
}
