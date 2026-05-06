import { Injectable, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { StrategyConditionEntity, StrategyConditionItem } from '../entities/strategy-condition.entity';
import { StrategyConditionRunEntity } from '../entities/strategy-condition-run.entity';
import { StrategyConditionHitEntity } from '../entities/strategy-condition-hit.entity';
import { CreateStrategyConditionDto } from './dto/create-strategy-condition.dto';
import { UpdateStrategyConditionDto } from './dto/update-strategy-condition.dto';

const ASHARE_FIELD_COL_MAP: Record<string, string> = {
  macd_dif: 'i.dif',
  macd_dea: 'i.dea',
  macd_hist: 'i.macd',
  kdj_j: 'i.kdj_j',
  kdj_k: 'i.kdj_k',
  kdj_d: 'i.kdj_d',
  bbi: 'i.bbi',
  ma5: 'i.ma5',
  ma30: 'i.ma30',
  ma60: 'i.ma60',
  ma120: 'i.ma120',
  ma240: 'i.ma240',
  atr14: 'i.atr_14',
  profit_loss_ratio: 'i.risk_reward_ratio',
  brick: 'i.brick',
  brick_delta: 'i.brick_delta',
  brick_xg: 'i.brick_xg',
  close: 'q.close',
  open: 'q.open',
  high: 'q.high',
  low: 'q.low',
  volume: 'q.vol',
  amount: 'q.amount',
  pct_chg: 'q.pct_chg',
  turnover_rate: 'm.turnover_rate',
  volume_ratio: 'm.volume_ratio',
  pe: 'm.pe',
  pe_ttm: 'm.pe_ttm',
  pb: 'm.pb',
  total_mv: 'm.total_mv',
  circ_mv: 'm.circ_mv',
};

const CRYPTO_FIELD_COL_MAP: Record<string, string> = {
  macd_dif: 'k.dif',
  macd_dea: 'k.dea',
  macd_hist: 'k.macd',
  kdj_j: 'k.kdj_j',
  kdj_k: 'k.kdj_k',
  kdj_d: 'k.kdj_d',
  bbi: 'k.bbi',
  ma5: 'k.ma5',
  ma30: 'k.ma30',
  ma60: 'k.ma60',
  ma120: 'k.ma120',
  ma240: 'k.ma240',
  atr14: 'k.atr_14',
  profit_loss_ratio: 'k.risk_reward_ratio',
  close: 'k.close',
  open: 'k.open',
  high: 'k.high',
  low: 'k.low',
  volume: 'k.volume',
  amount: 'k.quote_volume',
};

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
        JOIN a_share_daily_indicators i
          ON i.ts_code = s.ts_code
         AND i.trade_date = (SELECT MAX(trade_date) FROM a_share_daily_indicators)
        LEFT JOIN a_share_daily_quotes q
          ON q.ts_code = s.ts_code AND q.trade_date = i.trade_date
        LEFT JOIN a_share_daily_metrics m
          ON m.ts_code = s.ts_code AND m.trade_date = i.trade_date
        WHERE s.list_status = 'L'
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
        whereClauses.push(`${col} ${this.getSqlOperator(operator)} ${value}`);
      }
    }

    return whereClauses.length > 0 ? whereClauses.join(' AND ') : 'TRUE';
  }

  private buildCryptoQuery(conditions: StrategyConditionItem[]): string {
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
