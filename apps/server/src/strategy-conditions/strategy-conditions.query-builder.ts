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

const COMPARISON_OPERATORS: Record<string, string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '=',
  neq: '!=',
};

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
    );
  }

  buildCryptoQuery(conditions: StrategyConditionItem[]): BuiltWhere {
    return this.build(conditions, CRYPTO_FIELD_COL_MAP, 'k.', '加密', {
      tablePrev: 'klines',
      prevAlias: 'prev',
      prevJoinKey: 'symbol',
      prevDateKey: 'open_time',
      prevExtraJoin: "AND prev.interval = k.interval",
      prevExtraSubquery: "AND interval = k.interval",
    });
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
  ): BuiltWhere {
    const whereClauses: string[] = [];
    const params: unknown[] = [];
    const ph = (): string => `$${params.length}`;

    for (const cond of conditions) {
      const { field, operator, value, compareField } = cond;

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
}
