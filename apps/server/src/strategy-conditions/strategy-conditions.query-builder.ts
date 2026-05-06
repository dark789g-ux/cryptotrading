import { Injectable, Logger } from '@nestjs/common';
import { StrategyConditionItem } from '../entities/strategy-condition.entity';
import {
  ASHARE_BOOLEAN_COLS,
  ASHARE_FIELD_COL_MAP,
  CRYPTO_FIELD_COL_MAP,
} from './strategy-conditions.types';

@Injectable()
export class StrategyConditionsQueryBuilder {
  private readonly logger = new Logger(StrategyConditionsQueryBuilder.name);

  buildAShareQuery(conditions: StrategyConditionItem[]): string {
    const whereClauses: string[] = [];

    for (const cond of conditions) {
      const { field, operator, value, compareField } = cond;
      const col = ASHARE_FIELD_COL_MAP[field];
      if (!col) {
        this.logger.warn(`[A股] 未知字段 "${field}"，已跳过`);
        continue;
      }

      if (operator === 'cross_above' || operator === 'cross_below') {
        if (!col.startsWith('i.')) {
          this.logger.warn(
            `[A股] 字段 "${field}"（${col}）不在 indicators 表，不支持上穿/下穿，已跳过`,
          );
          continue;
        }
        const compareCol = compareField ? ASHARE_FIELD_COL_MAP[compareField] : null;
        if (!compareCol) {
          this.logger.warn(`[A股] cross 比较字段 "${compareField}" 未知，已跳过`);
          continue;
        }
        if (!compareCol.startsWith('i.')) {
          this.logger.warn(
            `[A股] 比较字段 "${compareField}"（${compareCol}）不在 indicators 表，不支持上穿/下穿，已跳过`,
          );
          continue;
        }
        const prevDirection = operator === 'cross_above' ? '<' : '>';
        const curDirection = operator === 'cross_above' ? '>' : '<';
        whereClauses.push(`
          EXISTS (
            SELECT 1 FROM a_share_daily_indicators prev
            WHERE prev.ts_code = i.ts_code
              AND prev.trade_date = (
                SELECT MAX(trade_date) FROM a_share_daily_indicators
                WHERE trade_date < i.trade_date AND ts_code = i.ts_code
              )
              AND ${col.replace(/^i\./, 'prev.')} ${prevDirection} ${compareCol.replace(/^i\./, 'prev.')}
          )
          AND ${col} ${curDirection} ${compareCol}
        `);
      } else if (compareField) {
        const compareCol = ASHARE_FIELD_COL_MAP[compareField];
        if (!compareCol) {
          this.logger.warn(`[A股] 未知比较字段 "${compareField}"，已跳过`);
          continue;
        }
        whereClauses.push(`${col} ${this.getSqlOperator(operator)} ${compareCol}`);
      } else {
        const colExpr = ASHARE_BOOLEAN_COLS.has(col) ? `(${col})::int` : col;
        whereClauses.push(`${colExpr} ${this.getSqlOperator(operator)} ${value}`);
      }
    }

    return whereClauses.length > 0 ? whereClauses.join(' AND ') : 'TRUE';
  }

  buildCryptoQuery(conditions: StrategyConditionItem[]): string {
    const whereClauses: string[] = [];

    for (const cond of conditions) {
      const { field, operator, value, compareField } = cond;
      const col = CRYPTO_FIELD_COL_MAP[field];
      if (!col) {
        this.logger.warn(`[加密] 未知字段 "${field}"，已跳过`);
        continue;
      }

      if (operator === 'cross_above' || operator === 'cross_below') {
        if (!col.startsWith('k.')) {
          this.logger.warn(
            `[加密] 字段 "${field}"（${col}）不在 klines 表，不支持上穿/下穿，已跳过`,
          );
          continue;
        }
        const compareCol = compareField ? CRYPTO_FIELD_COL_MAP[compareField] : null;
        if (!compareCol) {
          this.logger.warn(`[加密] cross 比较字段 "${compareField}" 未知，已跳过`);
          continue;
        }
        if (!compareCol.startsWith('k.')) {
          this.logger.warn(
            `[加密] 比较字段 "${compareField}"（${compareCol}）不在 klines 表，不支持上穿/下穿，已跳过`,
          );
          continue;
        }
        const prevDirection = operator === 'cross_above' ? '<' : '>';
        const curDirection = operator === 'cross_above' ? '>' : '<';
        whereClauses.push(`
          EXISTS (
            SELECT 1 FROM klines prev
            WHERE prev.symbol = k.symbol
              AND prev.interval = k.interval
              AND prev.open_time = (
                SELECT MAX(open_time) FROM klines
                WHERE open_time < k.open_time AND symbol = k.symbol AND interval = k.interval
              )
              AND ${col.replace(/^k\./, 'prev.')} ${prevDirection} ${compareCol.replace(/^k\./, 'prev.')}
          )
          AND ${col} ${curDirection} ${compareCol}
        `);
      } else if (compareField) {
        const compareCol = CRYPTO_FIELD_COL_MAP[compareField];
        if (!compareCol) {
          this.logger.warn(`[加密] 未知比较字段 "${compareField}"，已跳过`);
          continue;
        }
        whereClauses.push(`${col} ${this.getSqlOperator(operator)} ${compareCol}`);
      } else {
        whereClauses.push(`${col} ${this.getSqlOperator(operator)} ${value}`);
      }
    }

    return whereClauses.length > 0 ? whereClauses.join(' AND ') : 'TRUE';
  }

  getSqlOperator(operator: string): string {
    const operatorMap: Record<string, string> = {
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<=',
      eq: '=',
      neq: '!=',
    };
    return operatorMap[operator] || '=';
  }
}
