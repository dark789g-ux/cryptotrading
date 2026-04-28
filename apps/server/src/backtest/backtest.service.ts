import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { parseUTC } from './utils/backtest-ts.util';
import { BacktestRunEntity } from '../entities/backtest/backtest-run.entity';
import { BacktestTradeEntity } from '../entities/backtest/backtest-trade.entity';
import { BacktestCandleLogEntity } from '../entities/backtest/backtest-candle-log.entity';
import { StrategyEntity } from '../entities/strategy/strategy.entity';
import { BacktestDataService } from './engine/data.service';
import type {
  BacktestProgress,
  PositionQueryOptions,
  SymbolQueryOptions,
  RunSymbolMetricsQueryDto,
  RunSymbolMetricRow,
} from './backtest.types';
import { PROGRESS_RETENTION_MS } from './backtest.types';
import { filterSortPaginatePositions, filterSortPaginateSymbols } from './utils/backtest-report-rows.util';
import { resolveRunSymbolPool } from './utils/backtest-symbol-pool.util';
import {
  METRICS_SORT_COL_MAP,
  buildRunSymbolMetricsInnerSql,
  mapMetricRow,
} from './run-symbol-metrics.query';
import { executeBacktestPipeline } from './backtest-execution.pipeline';

export type { BacktestProgress, RunSymbolMetricsQueryDto, RunSymbolMetricRow } from './backtest.types';

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);
  private isRunning = false;
  private readonly progressMap = new Map<string, BacktestProgress>();

  constructor(
    @InjectRepository(BacktestRunEntity)
    private readonly runRepo: Repository<BacktestRunEntity>,
    @InjectRepository(BacktestTradeEntity)
    private readonly tradeRepo: Repository<BacktestTradeEntity>,
    @InjectRepository(StrategyEntity)
    private readonly strategyRepo: Repository<StrategyEntity>,
    @InjectRepository(BacktestCandleLogEntity)
    private readonly candleLogRepo: Repository<BacktestCandleLogEntity>,
    private readonly dataService: BacktestDataService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async listRuns(userId: string, strategyId: string) {
    return this.runRepo.find({
      where: { strategyId, userId } as any,
      order: { createdAt: 'DESC' },
    });
  }

  async getRun(userId: string, runId: string) {
    const run = await this.runRepo.findOneBy({ id: runId, userId } as any);
    if (!run) return null;
    const trades = await this.tradeRepo.find({ where: { runId } });
    return { ...run, trades };
  }

  async getRunPositions(userId: string, runId: string, opts: PositionQueryOptions) {
    const run = await this.runRepo.findOneBy({ id: runId, userId } as any);
    if (!run) return null;
    const reportData = (run.stats ?? {}) as Record<string, unknown>;
    return filterSortPaginatePositions(reportData, opts);
  }

  /**
   * 回测标的池在指定 open_time 上的指标快照（LEFT JOIN klines，缺行 dataStatus=missing）
   */
  async queryRunSymbolMetricsAtTs(
    userId: string,
    runId: string,
    dto: RunSymbolMetricsQueryDto,
  ): Promise<{ items: RunSymbolMetricRow[]; total: number; page: number; page_size: number } | null> {
    const run = await this.runRepo.findOneBy({ id: runId, userId } as any);
    if (!run) return null;

    const tsDate = parseUTC(dto.ts);
    if (!tsDate) {
      throw new BadRequestException('ts 无法解析为有效时间');
    }
    const interval = run.timeframe?.trim();
    if (!interval) {
      throw new BadRequestException('回测未记录 K 线周期，无法查询指标快照');
    }

    const pool = await resolveRunSymbolPool(run, this.strategyRepo);
    if (!pool.length) {
      throw new BadRequestException('无法解析标的池：回测记录与策略均未包含标的列表');
    }

    let sortField = dto.sort.field;
    if (!METRICS_SORT_COL_MAP[sortField]) {
      sortField = 'symbol';
    }
    const sortAsc = dto.sort.asc;
    const sortCol = METRICS_SORT_COL_MAP[sortField];

    const { inner, params, nextParamIndex: pi } = buildRunSymbolMetricsInnerSql({
      interval,
      tsDate,
      pool,
      runId,
      dto,
    });

    try {
      const countSql = `SELECT COUNT(*)::int AS c FROM (${inner}) sub`;
      const countRows = await this.dataSource.query(countSql, params);
      const total = Number(countRows[0]?.c ?? 0);

      const dir = sortAsc ? 'ASC' : 'DESC';
      const dataSql = `${inner} ORDER BY ${sortCol} ${dir} NULLS LAST, p.symbol ASC`;
      const offset = (dto.page - 1) * dto.page_size;
      const dataParams = [...params, dto.page_size, offset];
      const limitPi = pi;
      const offsetPi = pi + 1;
      const finalSql = `${dataSql} LIMIT $${limitPi} OFFSET $${offsetPi}`;

      const rawItems = await this.dataSource.query(finalSql, dataParams);
      const items = (rawItems as Record<string, unknown>[]).map(mapMetricRow);
      return { items, total, page: dto.page, page_size: dto.page_size };
    } catch (err) {
      const e = err as Error;
      this.logger.error(
        `symbol-metrics 查询失败 runId=${runId}: ${e.message}`,
        e.stack,
      );
      throw err;
    }
  }

  async getRunSymbols(userId: string, runId: string, opts: SymbolQueryOptions) {
    const run = await this.runRepo.findOneBy({ id: runId, userId } as any);
    if (!run) return null;
    const reportData = (run.stats ?? {}) as Record<string, unknown>;
    return filterSortPaginateSymbols(reportData, opts);
  }

  getProgress(userId: string, strategyId: string): BacktestProgress | null {
    const p = this.progressMap.get(this.progressKey(userId, strategyId));
    if (!p) return null;
    if (p.status !== 'running') return p;
    const elapsedMs = Date.now() - p.startedAt;
    const etaMs =
      p.percent > 0 && p.percent < 100
        ? Math.max(0, (elapsedMs * (100 - p.percent)) / p.percent)
        : null;
    return { ...p, elapsedMs, etaMs };
  }

  /** 启动回测，立即返回；通过 getProgress 轮询进度 */
  async startBacktest(userId: string, strategyId: string, symbols: string[]): Promise<{ ok: boolean; message?: string }> {
    if (this.isRunning) {
      return { ok: false, message: '回测任务已在运行中，请稍后再试' };
    }
    const strategy = await this.strategyRepo.findOneBy({ id: strategyId, userId } as any);
    if (!strategy) {
      throw new NotFoundException(`策略 ${strategyId} 不存在`);
    }

    this.isRunning = true;
    const key = this.progressKey(userId, strategyId);
    this.progressMap.set(key, {
      status: 'running',
      phase: '初始化',
      percent: 0,
      currentTs: null,
      startTs: null,
      endTs: null,
      startedAt: Date.now(),
      elapsedMs: 0,
      etaMs: null,
    });
    this.doBacktest(userId, strategyId, symbols, key).finally(() => {
      this.isRunning = false;
    });
    return { ok: true };
  }

  private updateProgress(key: string, patch: Partial<BacktestProgress>) {
    const cur = this.progressMap.get(key);
    if (!cur) return;
    const next: BacktestProgress = { ...cur, ...patch };
    next.elapsedMs = Date.now() - next.startedAt;
    if (next.status === 'running' && next.percent > 0 && next.percent < 100) {
      next.etaMs = Math.max(0, (next.elapsedMs * (100 - next.percent)) / next.percent);
    }
    this.progressMap.set(key, next);
  }

  private finalizeProgress(key: string, patch: Partial<BacktestProgress>) {
    this.updateProgress(key, patch);
    setTimeout(() => this.progressMap.delete(key), PROGRESS_RETENTION_MS);
  }

  private async doBacktest(userId: string, strategyId: string, symbols: string[], key: string) {
    await executeBacktestPipeline(
      {
        logger: this.logger,
        runRepo: this.runRepo,
        tradeRepo: this.tradeRepo,
        strategyRepo: this.strategyRepo,
        candleLogRepo: this.candleLogRepo,
        dataService: this.dataService,
        updateProgress: (id, patch) => this.updateProgress(id, patch),
        finalizeProgress: (id, patch) => this.finalizeProgress(id, patch),
      },
      userId,
      strategyId,
      symbols,
      key,
    );
  }

  private progressKey(userId: string, strategyId: string): string {
    return `${userId}:${strategyId}`;
  }
}
