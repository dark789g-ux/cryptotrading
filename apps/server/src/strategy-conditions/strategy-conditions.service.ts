import { Injectable, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { StrategyConditionEntity } from '../entities/strategy/strategy-condition.entity';
import { StrategyConditionRunEntity } from '../entities/strategy/strategy-condition-run.entity';
import { StrategyConditionHitEntity } from '../entities/strategy/strategy-condition-hit.entity';
import { CreateStrategyConditionDto } from './dto/create-strategy-condition.dto';
import { UpdateStrategyConditionDto } from './dto/update-strategy-condition.dto';
import { StrategyConditionsRunner } from './strategy-conditions.runner';
import { RunProgress, LastRunStatus } from './strategy-conditions.types';

export { RunProgress, LastRunStatus };

@Injectable()
export class StrategyConditionsService {
  private readonly logger = new Logger(StrategyConditionsService.name);

  constructor(
    @InjectRepository(StrategyConditionEntity)
    private readonly repo: Repository<StrategyConditionEntity>,
    @InjectRepository(StrategyConditionRunEntity)
    private readonly runRepo: Repository<StrategyConditionRunEntity>,
    @InjectRepository(StrategyConditionHitEntity)
    private readonly hitRepo: Repository<StrategyConditionHitEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly runner: StrategyConditionsRunner,
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

    const existing = await this.runRepo.findOne({
      where: { conditionId: entity.id, status: 'running' },
    });
    if (existing) {
      throw new ConflictException('该策略条件已有运行中的任务');
    }

    await this.runRepo.delete({ conditionId: entity.id });

    const run = this.runRepo.create({
      conditionId: entity.id,
      userId,
      status: 'running',
      progressScanned: 0,
      progressTotal: 0,
    });
    await this.runRepo.save(run);
    await this.repo.update(entity.id, { lastRunId: run.id });

    this.runner.executeRun(entity, run.id).catch(err => {
      this.logger.error('Strategy run failed', err instanceof Error ? err.stack : String(err));
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

    const runIds = conditions
      .map(c => c.lastRunId)
      .filter((id): id is string => id != null);

    const runs = runIds.length > 0
      ? await this.runRepo.find({ where: { id: In(runIds) } })
      : [];

    const runMap = new Map(runs.map(r => [r.id, r]));

    const [cryptoMax] = await this.dataSource.query<Array<{ max: Date | null }>>(`
      SELECT MAX(open_time) as max FROM klines WHERE interval = '1d'
    `);
    const [aShareMax] = await this.dataSource.query<Array<{ max: string | null }>>(`
      SELECT MAX(trade_date) as max FROM raw.daily_indicator
    `);

    const parseTradeDate = (s: string): Date => {
      const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`;
      return new Date(iso);
    };

    return conditions.map(c => {
      const run = c.lastRunId ? runMap.get(c.lastRunId) : undefined;
      if (!run) return { conditionId: c.id, freshness: 'never' as const, lastRunAt: null, totalHits: 0 };
      if (run.status === 'running') return { conditionId: c.id, freshness: 'running' as const, lastRunAt: run.createdAt.toISOString(), totalHits: 0 };
      if (run.status === 'failed') return { conditionId: c.id, freshness: 'failed' as const, lastRunAt: run.createdAt.toISOString(), totalHits: 0 };

      const dataUpdateTime = c.targetType === 'crypto'
        ? (cryptoMax?.max ?? new Date(0))
        : (aShareMax?.max ? parseTradeDate(aShareMax.max) : new Date(0));

      return {
        conditionId: c.id,
        freshness: run.completedAt && run.completedAt >= dataUpdateTime ? 'fresh' as const : 'stale' as const,
        lastRunAt: run.completedAt?.toISOString() ?? run.createdAt.toISOString(),
        totalHits: run.totalHits,
      };
    });
  }
}
