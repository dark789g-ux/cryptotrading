import { Injectable, Logger } from '@nestjs/common';
import { StrategyConditionItem } from '../entities/strategy/strategy-condition.entity';
import {
  ASHARE_BOOLEAN_COLS,
  ASHARE_FIELD_COL_MAP,
  ASHARE_INDUSTRY_AMV_COL_MAP,
  ASHARE_MARKET_AMV_COL_MAP,
  CRYPTO_FIELD_COL_MAP,
} from './strategy-conditions.types';

export interface BuiltWhere {
  sql: string;
  params: unknown[];
}

/**
 * ROC 取数配置：不复用 crossCfg（crossCfg.tablePrev 是指标表，无价格列）。
 * ROC 要的是价格列（A 股 qfq_close 在 raw.daily_quote、crypto close 在 klines），
 * 故单独定义。buildAShareQuery / buildCryptoQuery 各自构造后传给 build()。
 */
interface RocCfg {
  priceTable: string; // a-share: 'raw.daily_quote'；crypto: 'klines'
  closeCol: string; // a-share: 'qfq_close'；crypto: 'close'
  joinKey: string; // a-share: 'ts_code'；crypto: 'symbol'
  dateKey: string; // a-share: 'trade_date'；crypto: 'open_time'
  extraFilter?: string; // crypto: "AND interval = '1d'"；a-share: 无
  refAlias: string; // 主查询里行的别名：a-share 'i'；crypto 'k'
}

const COMPARISON_OPERATORS: Record<string, string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '=',
  neq: '!=',
};

const DEFAULT_ROC_N = 10;

/**
 * 解析 ROC 周期 N；非法或缺省回退默认 10（后端不信前端，仿 KDJ isValidKdjParams 模式）。
 * 前端 n-input-number 已 min1/max250/precision0 约束，这是给 API 直连调用方的兜底。
 */
function resolveRocN(p: { n: number } | undefined): number {
  if (!p || typeof p.n !== 'number' || !Number.isInteger(p.n) || p.n < 1 || p.n > 250) {
    return DEFAULT_ROC_N;
  }
  return p.n;
}

@Injectable()
export class StrategyConditionsQueryBuilder {
  private readonly logger = new Logger(StrategyConditionsQueryBuilder.name);

  buildAShareQuery(conditions: StrategyConditionItem[]): BuiltWhere {
    return this.build(
      conditions,
      ASHARE_FIELD_COL_MAP,
      'i.',
      'A股',
      {
        tablePrev: 'raw.daily_indicator',
        prevAlias: 'prev',
        prevJoinKey: 'ts_code',
        prevDateKey: 'trade_date',
        booleanCols: ASHARE_BOOLEAN_COLS,
      },
      // 行业 AMV 走 EXISTS。这里只 JOIN industry_amv_daily（恒为同花顺 type='I' 行业指数），
      // 概念指数（type='N'）在 concept_amv_daily、JOIN 不上自然排除——"仅算行业、不算概念"
      // 这一语义依赖 industry_amv_daily 只存 type='I' 这一数据事实。若该表将来也存概念，
      // 需在此 EXISTS 显式 JOIN ths_index_catalog 过滤 c.type='I'。
      {
        fieldMap: ASHARE_INDUSTRY_AMV_COL_MAP,
        memberTable: 'ths_member_stocks',
        memberAlias: 'mem',
        memberConKey: 'con_code',
        memberIndexKey: 'ts_code',
        amvTable: 'industry_amv_daily',
        amvAlias: 'ia',
        amvIndexKey: 'ts_code',
        amvDateKey: 'trade_date',
        outerCodeRef: 'i.ts_code',
        outerDateRef: 'i.trade_date',
      },
      // 大盘 0AMV 走 EXISTS（oamv_daily 每交易日一行，按日期对齐即可，无成分股 join）。
      // 该日 oamv_daily 无行或 MACD 列为 NULL → EXISTS 不成立 → 当日所有信号被排除（fail-closed，
      // 择时闸门宁缺勿滥）；因此回测/扫描窗口内 oamv_daily 覆盖必须先行核齐。
      {
        fieldMap: ASHARE_MARKET_AMV_COL_MAP,
        amvTable: 'oamv_daily',
        amvAlias: 'oa',
        amvDateKey: 'trade_date',
        outerDateRef: 'i.trade_date',
      },
      // ROC 取数：A 股价格列在 raw.daily_quote（qfq_close 前复权），主查询行别名为 i。
      {
        priceTable: 'raw.daily_quote',
        closeCol: 'qfq_close',
        joinKey: 'ts_code',
        dateKey: 'trade_date',
        refAlias: 'i',
      },
    );
  }

  buildCryptoQuery(conditions: StrategyConditionItem[]): BuiltWhere {
    return this.build(
      conditions,
      CRYPTO_FIELD_COL_MAP,
      'k.',
      '加密',
      {
        tablePrev: 'klines',
        prevAlias: 'prev',
        prevJoinKey: 'symbol',
        prevDateKey: 'open_time',
        prevExtraJoin: 'AND prev.interval = k.interval',
        prevExtraSubquery: "AND interval = k.interval",
      },
      // crypto 无行业/大盘 AMV，industryCfg/marketCfg 留空占位
      undefined,
      undefined,
      // ROC 取数：crypto 价格列即 klines.close，主查询行别名为 k；需 interval='1d' 过滤。
      {
        priceTable: 'klines',
        closeCol: 'close',
        joinKey: 'symbol',
        dateKey: 'open_time',
        extraFilter: "AND interval = '1d'",
        refAlias: 'k',
      },
    );
  }

  private build(
    conditions: StrategyConditionItem[],
    fieldMap: Record<string, string>,
    indicatorPrefix: string,
    label: string,
    crossCfg: {
      tablePrev: string;
      prevAlias: string;
      prevJoinKey: string;
      prevDateKey: string;
      prevExtraJoin?: string;
      prevExtraSubquery?: string;
      booleanCols?: Set<string>;
    },
    industryCfg?: {
      fieldMap: Record<string, string>;
      memberTable: string;
      memberAlias: string;
      memberConKey: string;
      memberIndexKey: string;
      amvTable: string;
      amvAlias: string;
      amvIndexKey: string;
      amvDateKey: string;
      outerCodeRef: string;
      outerDateRef: string;
    },
    marketCfg?: {
      fieldMap: Record<string, string>;
      amvTable: string;
      amvAlias: string;
      amvDateKey: string;
      outerDateRef: string;
    },
    // 可选：仅 buildAShareQuery/buildCryptoQuery 传入（两者均传）。声明可选以避开
    // "必选参数不能跟在可选参数后" 的 TS 限制（industryCfg?/marketCfg? 均可选）。
    rocCfg?: RocCfg,
  ): BuiltWhere {
    const whereClauses: string[] = [];
    const params: unknown[] = [];
    const ph = (): string => `$${params.length}`;

    for (const cond of conditions) {
      const { field, operator, value, compareField } = cond;

      // ROC 早退分支：field='roc' 走专用 OFFSET/LIMIT 子查询现算，不进静态列映射
      // （价格列不在 daily_indicator 指标表，需按 RocCfg 指向 raw.daily_quote / klines）。
      if (field === 'roc' && rocCfg) {
        const n = resolveRocN(cond.rocParams);
        if (operator === 'cross_above' || operator === 'cross_below') {
          this.logger.warn(`[${label}] ROC 首版不支持上穿/下穿，已跳过`);
          continue;
        }
        const sqlOp = COMPARISON_OPERATORS[operator];
        if (!sqlOp) {
          this.logger.warn(`[${label}] ROC 未知操作符 "${operator}"，已跳过`);
          continue;
        }

        const rocExpr = this.buildRocExpr(rocCfg, n);
        if (compareField) {
          const compareCol = fieldMap[compareField];
          if (!compareCol) {
            this.logger.warn(`[${label}] ROC 比较字段 "${compareField}" 未知，已跳过`);
            continue;
          }
          whereClauses.push(`${rocExpr} ${sqlOp} ${compareCol}`);
        } else {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            this.logger.warn(`[${label}] ROC 比较值非法（${String(value)}），已跳过`);
            continue;
          }
          params.push(value);
          whereClauses.push(`${rocExpr} ${sqlOp} ${ph()}`);
        }
        continue;
      }

      const marketCol = marketCfg?.fieldMap[field];
      if (marketCfg && marketCol) {
        if (operator === 'cross_above' || operator === 'cross_below') {
          this.logger.warn(`[${label}] 大盘字段 "${field}" 不支持上穿/下穿，已跳过`);
          continue;
        }
        const sqlOp = COMPARISON_OPERATORS[operator];
        if (!sqlOp) {
          this.logger.warn(`[${label}] 未知操作符 "${operator}"，已跳过`);
          continue;
        }

        let predicate: string;
        if (compareField) {
          const compareMarketCol = marketCfg.fieldMap[compareField];
          if (!compareMarketCol) {
            this.logger.warn(
              `[${label}] 大盘字段 "${field}" 只能与大盘 0AMV 字段或常量比较，比较字段 "${compareField}" 非法，已跳过`,
            );
            continue;
          }
          predicate = `${marketCol} ${sqlOp} ${compareMarketCol}`;
        } else {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            this.logger.warn(`[${label}] 字段 "${field}" 比较值非法（${String(value)}），已跳过`);
            continue;
          }
          params.push(value);
          predicate = `${marketCol} ${sqlOp} ${ph()}`;
        }

        whereClauses.push(`
          EXISTS (
            SELECT 1
            FROM ${marketCfg.amvTable} ${marketCfg.amvAlias}
            WHERE ${marketCfg.amvAlias}.${marketCfg.amvDateKey} = ${marketCfg.outerDateRef}
              AND ${predicate}
          )
        `);
        continue;
      }

      const industryCol = industryCfg?.fieldMap[field];
      if (industryCfg && industryCol) {
        if (operator === 'cross_above' || operator === 'cross_below') {
          this.logger.warn(`[${label}] 行业字段 "${field}" 不支持上穿/下穿，已跳过`);
          continue;
        }
        const sqlOp = COMPARISON_OPERATORS[operator];
        if (!sqlOp) {
          this.logger.warn(`[${label}] 未知操作符 "${operator}"，已跳过`);
          continue;
        }

        let predicate: string;
        if (compareField) {
          const compareIndustryCol = industryCfg.fieldMap[compareField];
          if (!compareIndustryCol) {
            this.logger.warn(
              `[${label}] 行业字段 "${field}" 只能与行业 AMV 字段或常量比较，比较字段 "${compareField}" 非法，已跳过`,
            );
            continue;
          }
          predicate = `${industryCol} ${sqlOp} ${compareIndustryCol}`;
        } else {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            this.logger.warn(`[${label}] 字段 "${field}" 比较值非法（${String(value)}），已跳过`);
            continue;
          }
          params.push(value);
          predicate = `${industryCol} ${sqlOp} ${ph()}`;
        }

        whereClauses.push(`
          EXISTS (
            SELECT 1
            FROM ${industryCfg.memberTable} ${industryCfg.memberAlias}
            JOIN ${industryCfg.amvTable} ${industryCfg.amvAlias}
              ON ${industryCfg.amvAlias}.${industryCfg.amvIndexKey} = ${industryCfg.memberAlias}.${industryCfg.memberIndexKey}
             AND ${industryCfg.amvAlias}.${industryCfg.amvDateKey} = ${industryCfg.outerDateRef}
            WHERE ${industryCfg.memberAlias}.${industryCfg.memberConKey} = ${industryCfg.outerCodeRef}
              AND ${predicate}
          )
        `);
        continue;
      }

      const col = fieldMap[field];
      if (!col) {
        this.logger.warn(`[${label}] 未知字段 "${field}"，已跳过`);
        continue;
      }

      if (operator === 'cross_above' || operator === 'cross_below') {
        if (!col.startsWith(indicatorPrefix)) {
          this.logger.warn(
            `[${label}] 字段 "${field}"（${col}）不在 ${crossCfg.tablePrev} 表，不支持上穿/下穿，已跳过`,
          );
          continue;
        }
        const compareCol = compareField ? fieldMap[compareField] : null;
        if (!compareCol) {
          this.logger.warn(`[${label}] cross 比较字段 "${compareField}" 未知，已跳过`);
          continue;
        }
        if (!compareCol.startsWith(indicatorPrefix)) {
          this.logger.warn(
            `[${label}] 比较字段 "${compareField}"（${compareCol}）不在 ${crossCfg.tablePrev} 表，不支持上穿/下穿，已跳过`,
          );
          continue;
        }
        const prevDirection = operator === 'cross_above' ? '<' : '>';
        const curDirection = operator === 'cross_above' ? '>' : '<';
        const prevExtraJoin = crossCfg.prevExtraJoin ? `\n              ${crossCfg.prevExtraJoin}` : '';
        const prevExtraSubquery = crossCfg.prevExtraSubquery ? ` ${crossCfg.prevExtraSubquery}` : '';
        const refAlias = indicatorPrefix.replace(/\.$/, '');
        whereClauses.push(`
          EXISTS (
            SELECT 1 FROM ${crossCfg.tablePrev} ${crossCfg.prevAlias}
            WHERE ${crossCfg.prevAlias}.${crossCfg.prevJoinKey} = ${refAlias}.${crossCfg.prevJoinKey}${prevExtraJoin}
              AND ${crossCfg.prevAlias}.${crossCfg.prevDateKey} = (
                SELECT MAX(${crossCfg.prevDateKey}) FROM ${crossCfg.tablePrev}
                WHERE ${crossCfg.prevDateKey} < ${refAlias}.${crossCfg.prevDateKey}
                  AND ${crossCfg.prevJoinKey} = ${refAlias}.${crossCfg.prevJoinKey}${prevExtraSubquery}
              )
              AND ${col.replace(indicatorPrefix, `${crossCfg.prevAlias}.`)} ${prevDirection} ${compareCol.replace(indicatorPrefix, `${crossCfg.prevAlias}.`)}
          )
          AND ${col} ${curDirection} ${compareCol}
        `);
      } else if (compareField) {
        const compareCol = fieldMap[compareField];
        if (!compareCol) {
          this.logger.warn(`[${label}] 未知比较字段 "${compareField}"，已跳过`);
          continue;
        }
        const sqlOp = COMPARISON_OPERATORS[operator];
        if (!sqlOp) {
          this.logger.warn(`[${label}] 未知操作符 "${operator}"，已跳过`);
          continue;
        }
        whereClauses.push(`${col} ${sqlOp} ${compareCol}`);
      } else {
        const sqlOp = COMPARISON_OPERATORS[operator];
        if (!sqlOp) {
          this.logger.warn(`[${label}] 未知操作符 "${operator}"，已跳过`);
          continue;
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          this.logger.warn(`[${label}] 字段 "${field}" 比较值非法（${String(value)}），已跳过`);
          continue;
        }
        const colExpr = crossCfg.booleanCols?.has(col) ? `(${col})::int` : col;
        params.push(value);
        whereClauses.push(`${colExpr} ${sqlOp} ${ph()}`);
      }
    }

    if (whereClauses.length > 0) {
      return { sql: whereClauses.join(' AND '), params };
    }

    // 配了条件但全部被跳过（未知字段/操作符/非法比较等）：fail-closed 返回 FALSE，
    // 不退化成匹配全部 list_status='L' 的"伪装成功"。
    if (conditions.length > 0) {
      this.logger.warn(
        `[${label}] 全部 ${conditions.length} 条条件均无法翻译为 SQL，本次查询不匹配任何标的（sql=FALSE）`,
      );
      return { sql: 'FALSE', params };
    }

    // 真正无条件（runner 已在更上层短路 return []，此处保留以防被直接调用）。
    return { sql: 'TRUE', params };
  }

  /**
   * 生成 ROC 标量子查询：取「当日收盘」与「N 个交易日前收盘」算变化率百分比。
   *
   * - cur 固定到主查询行 (refAlias.joinKey, refAlias.dateKey)；
   * - prev 用 LATERAL + OFFSET n LIMIT 1 取 N 个交易日前收盘（ORDER BY date DESC 下
   *   OFFSET n 跳过最近 n 行、取 row n = N 日前）；
   * - prev 为 NULL（数据不足/新股上市<N天）或为 0（除零防御）→ CASE 返回 NULL →
   *   外层 `NULL $op $value` 求值为 NULL（非 true）→ fail-closed 不命中。
   *
   * extraFilter（crypto 的 interval='1d'）必须同时出现在 prev 内层与 cur 外层两处，
   * 否则多 interval 表（klines）行集不一致会算错。
   */
  private buildRocExpr(rocCfg: RocCfg, n: number): string {
    const { priceTable, closeCol, joinKey, dateKey, extraFilter, refAlias } = rocCfg;
    const ef = extraFilter ?? '';
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
}
