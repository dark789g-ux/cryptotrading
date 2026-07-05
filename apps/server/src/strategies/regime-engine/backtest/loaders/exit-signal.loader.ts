import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StrategyConditionItem } from '../../../../entities/strategy/strategy-condition.entity';
import { StrategyConditionsQueryBuilder } from '../../../../strategy-conditions/strategy-conditions.query-builder';

@Injectable()
export class ExitSignalLoader {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly queryBuilder: StrategyConditionsQueryBuilder,
  ) {}

  async fetchExitSignalHits(
    tsCode: string,
    dates: string[],
    exitConditions: unknown[],
  ): Promise<Set<string>> {
    if (dates.length === 0 || !exitConditions || exitConditions.length === 0) {
      return new Set();
    }
    const conditions = exitConditions as StrategyConditionItem[];
    const where = this.queryBuilder.buildAShareQuery(conditions);
    const params: unknown[] = [...where.params];
    const tsPh = `$${params.length + 1}`;
    const datesPh = `$${params.length + 2}`;
    params.push(tsCode, dates);
    const sql = `
      SELECT i.trade_date AS "tradeDate"
        FROM raw.daily_indicator i
        LEFT JOIN raw.daily_quote q ON q.ts_code = i.ts_code AND q.trade_date = i.trade_date
        LEFT JOIN raw.daily_basic m ON m.ts_code = i.ts_code AND m.trade_date = i.trade_date
        LEFT JOIN stock_amv_daily sa ON sa.ts_code = i.ts_code AND sa.trade_date = i.trade_date
       WHERE i.ts_code = ${tsPh} AND i.trade_date = ANY(${datesPh}::text[]) AND ${where.sql}
    `;
    const rows = await this.dataSource.query<Array<{ tradeDate: string }>>(sql, params);
    return new Set(rows.map((r) => r.tradeDate));
  }
}
