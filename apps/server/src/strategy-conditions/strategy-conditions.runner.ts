import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { StrategyConditionEntity } from '../entities/strategy/strategy-condition.entity';
import { StrategyConditionRunEntity } from '../entities/strategy/strategy-condition-run.entity';
import { StrategyConditionHitEntity } from '../entities/strategy/strategy-condition-hit.entity';
import { StrategyConditionsQueryBuilder } from './strategy-conditions.query-builder';

@Injectable()
export class StrategyConditionsRunner {
  private readonly logger = new Logger(StrategyConditionsRunner.name);

  constructor(
    @InjectRepository(StrategyConditionRunEntity)
    private readonly runRepo: Repository<StrategyConditionRunEntity>,
    @InjectRepository(StrategyConditionHitEntity)
    private readonly hitRepo: Repository<StrategyConditionHitEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly queryBuilder: StrategyConditionsQueryBuilder,
  ) {}

  async executeRun(condition: StrategyConditionEntity, runId: string): Promise<void> {
    try {
      const total = await this.countTotalSymbols(condition.targetType);
      await this.runRepo.update(runId, { progressTotal: total });

      const batchSize = 100;
      const allHits: Array<{ tsCode: string; name: string; matchedConditions: string[] }> = [];

      for (let offset = 0; offset < total; offset += batchSize) {
        const batch = await this.scanBatch(condition, offset, batchSize);
        allHits.push(...batch);
        await this.runRepo.update(runId, {
          progressScanned: Math.min(offset + batchSize, total),
        });
      }

      if (allHits.length > 0) {
        const hitEntities = allHits.map(hit =>
          this.hitRepo.create({
            runId,
            tsCode: hit.tsCode,
            name: hit.name,
            matchedConditions: hit.matchedConditions,
          }),
        );
        await this.hitRepo.save(hitEntities);
      }

      await this.runRepo.update(runId, {
        status: 'completed',
        totalHits: allHits.length,
        completedAt: new Date(),
      });
    } catch (error: unknown) {
      await this.runRepo.update(runId, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async countTotalSymbols(targetType: string): Promise<number> {
    if (targetType === 'a-share') {
      const rows = await this.dataSource.query<Array<{ count: string }>>(`
        SELECT COUNT(*) FROM a_share_symbols WHERE list_status = 'L'
      `);
      return parseInt(rows[0].count, 10);
    } else {
      const rows = await this.dataSource.query<Array<{ count: string }>>(`
        SELECT COUNT(DISTINCT symbol) FROM klines WHERE interval = '1d'
      `);
      return parseInt(rows[0].count, 10);
    }
  }

  private async scanBatch(
    condition: StrategyConditionEntity,
    offset: number,
    limit: number,
  ): Promise<Array<{ tsCode: string; name: string; matchedConditions: string[] }>> {
    const { conditions, targetType } = condition;
    if (conditions.length === 0) return [];

    const conditionDescriptions = conditions.map(c => {
      if (c.compareField) return `${c.field} ${c.operator} ${c.compareField}`;
      return `${c.field} ${c.operator} ${c.value}`;
    });

    let query: string;
    let params: unknown[];
    if (targetType === 'a-share') {
      const where = this.queryBuilder.buildAShareQuery(conditions);
      params = [...where.params];
      const limitPh = `$${params.length + 1}`;
      const offsetPh = `$${params.length + 2}`;
      params.push(limit, offset);
      query = `
        SELECT s.ts_code as "tsCode", s.name
        FROM a_share_symbols s
        JOIN raw.daily_indicator i
          ON i.ts_code = s.ts_code
         AND i.trade_date = (SELECT MAX(trade_date) FROM raw.daily_indicator)
        LEFT JOIN raw.daily_quote q
          ON q.ts_code = s.ts_code AND q.trade_date = i.trade_date
        LEFT JOIN raw.daily_basic m
          ON m.ts_code = s.ts_code AND m.trade_date = i.trade_date
        LEFT JOIN stock_amv_daily sa
          ON sa.ts_code = s.ts_code AND sa.trade_date = i.trade_date
        LEFT JOIN signal_rolling_indicator d
          ON d.ts_code = s.ts_code AND d.trade_date = i.trade_date
        WHERE s.list_status = 'L'
          AND ${where.sql}
        ORDER BY s.ts_code
        LIMIT ${limitPh} OFFSET ${offsetPh}
      `;
    } else {
      const where = this.queryBuilder.buildCryptoQuery(conditions);
      params = [...where.params];
      const limitPh = `$${params.length + 1}`;
      const offsetPh = `$${params.length + 2}`;
      params.push(limit, offset);
      query = `
        SELECT k.symbol as "tsCode", k.symbol as name
        FROM klines k
        WHERE k.interval = '1d'
          AND k.open_time = (
            SELECT MAX(open_time) FROM klines WHERE symbol = k.symbol AND interval = '1d'
          )
          AND ${where.sql}
        ORDER BY k.symbol
        LIMIT ${limitPh} OFFSET ${offsetPh}
      `;
    }

    const result = await this.dataSource.query(query, params);
    return (result as Array<Record<string, unknown>>).map(row => ({
      tsCode: row.tsCode as string,
      name: row.name as string,
      matchedConditions: conditionDescriptions,
    }));
  }
}
