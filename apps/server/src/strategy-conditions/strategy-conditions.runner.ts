import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { StrategyConditionEntity, StrategyConditionItem } from '../entities/strategy/strategy-condition.entity';
import { StrategyConditionRunEntity } from '../entities/strategy/strategy-condition-run.entity';
import { StrategyConditionHitEntity } from '../entities/strategy/strategy-condition-hit.entity';
import { StrategyConditionsQueryBuilder } from './strategy-conditions.query-builder';
import { DerivedFieldRegistry, DerivedFieldSnapshot } from './derived-field-registry';
import { ASHARE_FIELD_COL_MAP } from './strategy-conditions.types';

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
    private readonly registry: DerivedFieldRegistry,
  ) {}

  async executeRun(
    condition: StrategyConditionEntity,
    runId: string,
    userId: string,
    onDone: (finalStatus: 'completed' | 'failed') => Promise<void>,
  ): Promise<void> {
    try {
      await this.runRepo.update(runId, { status: 'running' });
      const total = await this.countTotalSymbols(condition.targetType);
      await this.runRepo.update(runId, { progressTotal: total });

      // A 股自定义参数重算的 as-of 日：与 scanBatch Phase 1 SQL 的对齐日同源
      // （raw.daily_indicator 最新交易日），保证命中集与重算口径严格一致。crypto 不需要。
      // 'YYYYMMDD' 字符串，禁止 new Date()。
      let asOf: string | undefined;
      if (condition.targetType === 'a-share') {
        const rows = await this.dataSource.query<Array<{ max: string | null }>>(
          `SELECT MAX(trade_date) AS max FROM raw.daily_indicator`,
        );
        asOf = rows[0]?.max ?? undefined;
      }

      const batchSize = 100;
      const allHits: Array<{ tsCode: string; name: string; matchedConditions: string[] }> = [];

      for (let offset = 0; offset < total; offset += batchSize) {
        const batch = await this.scanBatch(condition, offset, batchSize, asOf);
        allHits.push(...batch);
        await this.runRepo.update(runId, {
          progressScanned: Math.min(offset + batchSize, total),
          totalHits: allHits.length, // 问题 6：实时命中数，每批累加后写入
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
      await onDone('completed');
    } catch (error: unknown) {
      await this.runRepo.update(runId, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      await onDone('failed');
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
    asOf?: string,
  ): Promise<Array<{ tsCode: string; name: string; matchedConditions: string[] }>> {
    const { conditions, targetType } = condition;
    if (conditions.length === 0) return [];

    const conditionDescriptions = conditions.map(c => {
      if (c.compareField) return `${c.field} ${c.operator} ${c.compareField}`;
      return `${c.field} ${c.operator} ${c.value}`;
    });

    // A 股两阶段：registry.split 把现算字段条件从 SQL 路径剔除（Phase 1 仅按 sqlConds
    // 枚举/分页），再在内存里用重算结果按 recompConds 求交。crypto 完全不变。
    if (targetType === 'a-share') {
      const { sqlConds, recompConds } = this.registry.split(conditions);

      const where = this.queryBuilder.buildAShareQuery(sqlConds);
      const params: unknown[] = [...where.params];
      const limitPh = `$${params.length + 1}`;
      const offsetPh = `$${params.length + 2}`;
      params.push(limit, offset);
      const query = `
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

      const phase1 = await this.dataSource.query(query, params);
      const rows = (phase1 as Array<Record<string, unknown>>).map(row => ({
        tsCode: row.tsCode as string,
        name: row.name as string,
      }));

      if (recompConds.length === 0) {
        return rows.map(r => ({ ...r, matchedConditions: conditionDescriptions }));
      }

      // Phase 2：对 Phase 1 命中集，按 recompConds 逐条用 registry.resolve 拿 recomputer
      // 做重算+求值，AND 求交。
      const tsCodes = rows.map(r => r.tsCode);
      const snapshotsByCond = new Map<number, Map<string, DerivedFieldSnapshot<unknown>>>();
      for (let i = 0; i < recompConds.length; i++) {
        const cond = recompConds[i];
        const recomputer = this.registry.resolve(cond)!;
        const snapshots = await recomputer.recomputeLatest(tsCodes, asOf ?? '', cond);
        snapshotsByCond.set(i, snapshots);
      }

      const kept = rows.filter(r => {
        for (let i = 0; i < recompConds.length; i++) {
          const cond = recompConds[i];
          const recomputer = this.registry.resolve(cond)!;
          const snap = snapshotsByCond.get(i)!.get(r.tsCode);
          if (!snap || !recomputer.evaluate(cond, snap)) return false;
        }
        return true;
      });

      return kept.map(r => ({ ...r, matchedConditions: conditionDescriptions }));
    }

    // crypto 分支不变：走纯 SQL，不做实时重算。
    const where = this.queryBuilder.buildCryptoQuery(conditions);
    const params: unknown[] = [...where.params];
    const limitPh = `$${params.length + 1}`;
    const offsetPh = `$${params.length + 2}`;
    params.push(limit, offset);
    const query = `
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

    const result = await this.dataSource.query(query, params);
    return (result as Array<Record<string, unknown>>).map(row => ({
      tsCode: row.tsCode as string,
      name: row.name as string,
      matchedConditions: conditionDescriptions,
    }));
  }
}
