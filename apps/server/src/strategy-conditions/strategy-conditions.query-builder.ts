import { Injectable, Logger } from '@nestjs/common';
import { StrategyConditionItem } from '../entities/strategy/strategy-condition.entity';
import {
  ASHARE_BOOLEAN_COLS,
  ASHARE_FIELD_COL_MAP,
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
    return this.build(conditions, ASHARE_FIELD_COL_MAP, 'i.', 'A股', {
      tablePrev: 'raw.daily_indicator',
      prevAlias: 'prev',
      prevJoinKey: 'ts_code',
      prevDateKey: 'trade_date',
      booleanCols: ASHARE_BOOLEAN_COLS,
    });
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
  ): BuiltWhere {
    const whereClauses: string[] = [];
    const params: unknown[] = [];
    const ph = (): string => `$${params.length}`;

    for (const cond of conditions) {
      const { field, operator, value, compareField } = cond;
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

    return {
      sql: whereClauses.length > 0 ? whereClauses.join(' AND ') : 'TRUE',
      params,
    };
  }
}
