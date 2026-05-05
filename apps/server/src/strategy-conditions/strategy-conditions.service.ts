import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { StrategyConditionEntity, StrategyConditionItem } from '../entities/strategy-condition.entity';
import { StrategyConditionRunEntity } from '../entities/strategy-condition-run.entity';
import { StrategyConditionHitEntity } from '../entities/strategy-condition-hit.entity';
import { CreateStrategyConditionDto } from './dto/create-strategy-condition.dto';
import { UpdateStrategyConditionDto } from './dto/update-strategy-condition.dto';

export interface RunResult {
  hits: Array<{
    tsCode: string;
    name: string;
    matchedConditions: string[];
  }>;
  totalHits: number;
  totalScanned: number;
}

export interface RunProgress {
  runId: string;
  status: string;
  progressScanned: number;
  progressTotal: number;
  totalHits: number;
  errorMessage: string | null;
}

export interface LastRunStatus {
  conditionId: string;
  freshness: 'fresh' | 'stale' | 'never' | 'running' | 'failed';
  lastRunAt: string | null;
  totalHits: number;
}

@Injectable()
export class StrategyConditionsService {
  constructor(
    @InjectRepository(StrategyConditionEntity)
    private readonly repo: Repository<StrategyConditionEntity>,
    @InjectRepository(StrategyConditionRunEntity)
    private readonly runRepo: Repository<StrategyConditionRunEntity>,
    @InjectRepository(StrategyConditionHitEntity)
    private readonly hitRepo: Repository<StrategyConditionHitEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async create(userId: string, dto: CreateStrategyConditionDto): Promise<StrategyConditionEntity> {
    const entity = this.repo.create({
      name: dto.name,
      targetType: dto.targetType as any,
      conditions: dto.conditions as any,
      userId,
    });
    return this.repo.save(entity);
  }

  async findAll(userId: string, targetType?: string): Promise<StrategyConditionEntity[]> {
    const where: any = { userId };
    if (targetType) {
      where.targetType = targetType;
    }
    return this.repo.find({ where, order: { createdAt: 'DESC' } });
  }

  async findOne(id: string, userId: string): Promise<StrategyConditionEntity> {
    const entity = await this.repo.findOne({ where: { id, userId } });
    if (!entity) {
      throw new NotFoundException('Strategy condition not found');
    }
    return entity;
  }

  async update(id: string, userId: string, dto: UpdateStrategyConditionDto): Promise<StrategyConditionEntity> {
    const entity = await this.findOne(id, userId);
    Object.assign(entity, dto);
    return this.repo.save(entity);
  }

  async remove(id: string, userId: string): Promise<void> {
    const entity = await this.findOne(id, userId);
    await this.repo.remove(entity);
  }

  async run(id: string, userId: string): Promise<{ runId: string }> {
    const entity = await this.findOne(id, userId);

    // 检查是否有正在运行的任务
    const existing = await this.runRepo.findOne({
      where: { conditionId: entity.id, status: 'running' },
    });
    if (existing) {
      throw new ConflictException('该策略条件已有运行中的任务');
    }

    // 删除该条件之前的运行记录（级联删除 hits）
    await this.runRepo.delete({ conditionId: entity.id });

    // 创建新的运行记录
    const run = this.runRepo.create({
      conditionId: entity.id,
      userId,
      status: 'running',
      progressScanned: 0,
      progressTotal: 0,
    });
    await this.runRepo.save(run);

    // 更新条件的 last_run_id
    await this.repo.update(entity.id, { lastRunId: run.id });

    // 异步执行扫描
    this.executeRun(entity, run.id).catch(err => {
      console.error('Strategy run failed:', err);
    });

    return { runId: run.id };
  }

  async getRunProgress(conditionId: string, userId: string): Promise<RunProgress> {
    await this.findOne(conditionId, userId);
    const run = await this.runRepo.findOne({
      where: { conditionId, userId },
      order: { createdAt: 'DESC' },
    });
    if (!run) {
      throw new NotFoundException('No run record found');
    }
    return {
      runId: run.id,
      status: run.status,
      progressScanned: run.progressScanned,
      progressTotal: run.progressTotal,
      totalHits: run.totalHits,
      errorMessage: run.errorMessage,
    };
  }

  async getRunResult(conditionId: string, userId: string): Promise<{
    hits: Array<{ tsCode: string; name: string; matchedConditions: string[] }>;
    totalHits: number;
  }> {
    await this.findOne(conditionId, userId);
    const run = await this.runRepo.findOne({
      where: { conditionId, userId, status: 'completed' },
      order: { createdAt: 'DESC' },
    });
    if (!run) {
      return { hits: [], totalHits: 0 };
    }
    const hits = await this.hitRepo.find({ where: { runId: run.id } });
    return {
      hits: hits.map(h => ({
        tsCode: h.tsCode,
        name: h.name ?? '',
        matchedConditions: h.matchedConditions,
      })),
      totalHits: run.totalHits,
    };
  }

  async getLastRunStatus(userId: string): Promise<LastRunStatus[]> {
    const conditions = await this.repo.find({ where: { userId } });
    if (conditions.length === 0) return [];

    // 批量获取运行记录
    const runIds = conditions
      .map(c => c.lastRunId)
      .filter((id): id is string => id != null);

    const runs = runIds.length > 0
      ? await this.runRepo.find({ where: { id: In(runIds) } })
      : [];

    const runMap = new Map(runs.map(r => [r.id, r]));

    // 获取数据最新更新时间
    const [cryptoMax] = await this.dataSource.query<Array<{ max: Date | null }>>(`
      SELECT MAX(open_time) as max FROM klines WHERE interval = '1d'
    `);
    const [aShareMax] = await this.dataSource.query<Array<{ max: string | null }>>(`
      SELECT MAX(trade_date) as max FROM a_share_daily_indicators
    `);

    return conditions.map(c => {
      const run = c.lastRunId ? runMap.get(c.lastRunId) : undefined;
      if (!run) return { conditionId: c.id, freshness: 'never' as const, lastRunAt: null, totalHits: 0 };
      if (run.status === 'running') return { conditionId: c.id, freshness: 'running' as const, lastRunAt: run.createdAt.toISOString(), totalHits: 0 };
      if (run.status === 'failed') return { conditionId: c.id, freshness: 'failed' as const, lastRunAt: run.createdAt.toISOString(), totalHits: 0 };

      const dataUpdateTime = c.targetType === 'crypto'
        ? (cryptoMax?.max ?? new Date(0))
        : (aShareMax?.max ? new Date(aShareMax.max) : new Date(0));

      return {
        conditionId: c.id,
        freshness: run.completedAt && run.completedAt >= dataUpdateTime ? 'fresh' as const : 'stale' as const,
        lastRunAt: run.completedAt?.toISOString() ?? run.createdAt.toISOString(),
        totalHits: run.totalHits,
      };
    });
  }

  private async executeRun(condition: StrategyConditionEntity, runId: string): Promise<void> {
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

      // 批量保存命中结果
      if (allHits.length > 0) {
        const hitEntities = allHits.map(hit => this.hitRepo.create({
          runId,
          tsCode: hit.tsCode,
          name: hit.name,
          matchedConditions: hit.matchedConditions,
        }));
        await this.hitRepo.save(hitEntities);
      }

      // 标记完成
      await this.runRepo.update(runId, {
        status: 'completed',
        totalHits: allHits.length,
        completedAt: new Date(),
      });
    } catch (error: any) {
      await this.runRepo.update(runId, {
        status: 'failed',
        errorMessage: error?.message ?? String(error),
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
    if (targetType === 'a-share') {
      const whereClause = this.buildAShareQuery(conditions);
      query = `
        SELECT s.ts_code as "tsCode", s.name
        FROM a_share_symbols s
        JOIN a_share_daily_indicators i ON s.ts_code = i.ts_code
        WHERE i.trade_date = (SELECT MAX(trade_date) FROM a_share_daily_indicators)
          AND s.list_status = 'L'
          AND ${whereClause}
        ORDER BY s.ts_code
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      const whereClause = this.buildCryptoQuery(conditions);
      query = `
        SELECT k.symbol as "tsCode", k.symbol as name
        FROM klines k
        WHERE k.interval = '1d'
          AND k.open_time = (
            SELECT MAX(open_time) FROM klines WHERE symbol = k.symbol AND interval = '1d'
          )
          AND ${whereClause}
        ORDER BY k.symbol
        LIMIT ${limit} OFFSET ${offset}
      `;
    }

    const result = await this.dataSource.query(query);
    return result.map((row: any) => ({
      tsCode: row.tsCode,
      name: row.name,
      matchedConditions: conditionDescriptions,
    }));
  }

  private buildAShareQuery(conditions: StrategyConditionItem[]): string {
    const whereClauses: string[] = [];

    for (const cond of conditions) {
      const { field, operator, value, compareField } = cond;

      if (operator === 'cross_above' || operator === 'cross_below') {
        const direction = operator === 'cross_above' ? '<' : '>';
        whereClauses.push(`
          EXISTS (
            SELECT 1 FROM a_share_daily_indicators prev
            WHERE prev.ts_code = i.ts_code
              AND prev.trade_date = (
                SELECT MAX(trade_date) FROM a_share_daily_indicators
                WHERE trade_date < i.trade_date AND ts_code = i.ts_code
              )
              AND prev.${field} ${direction} prev.${compareField}
          )
          AND i.${field} ${operator === 'cross_above' ? '>' : '<'} i.${compareField}
        `);
      } else if (compareField) {
        whereClauses.push(`i.${field} ${this.getSqlOperator(operator)} i.${compareField}`);
      } else {
        whereClauses.push(`i.${field} ${this.getSqlOperator(operator)} ${value}`);
      }
    }

    return whereClauses.join(' AND ');
  }

  private buildCryptoQuery(conditions: StrategyConditionItem[]): string {
    const whereClauses: string[] = [];

    for (const cond of conditions) {
      const { field, operator, value, compareField } = cond;

      if (operator === 'cross_above' || operator === 'cross_below') {
        const direction = operator === 'cross_above' ? '<' : '>';
        whereClauses.push(`
          EXISTS (
            SELECT 1 FROM klines prev
            WHERE prev.symbol = k.symbol
              AND prev.interval = k.interval
              AND prev.open_time = (
                SELECT MAX(open_time) FROM klines
                WHERE open_time < k.open_time AND symbol = k.symbol AND interval = k.interval
              )
              AND prev.${field} ${direction} prev.${compareField}
          )
          AND k.${field} ${operator === 'cross_above' ? '>' : '<'} k.${compareField}
        `);
      } else if (compareField) {
        whereClauses.push(`k.${field} ${this.getSqlOperator(operator)} k.${compareField}`);
      } else {
        whereClauses.push(`k.${field} ${this.getSqlOperator(operator)} ${value}`);
      }
    }

    return whereClauses.join(' AND ');
  }

  private getSqlOperator(operator: string): string {
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
