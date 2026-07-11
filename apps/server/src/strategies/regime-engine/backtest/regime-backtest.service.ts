import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, FindOptionsWhere } from 'typeorm';
import { RegimeBacktestRunEntity, RegimeBacktestRunStatus } from '../../../entities/strategy/regime-backtest-run.entity';
import { RegimeBacktestDailyEntity } from '../../../entities/strategy/regime-backtest-daily.entity';
import { RegimeBacktestDailyLogEntity } from '../../../entities/strategy/regime-backtest-daily-log.entity';
import { RegimeBacktestTradeEntity } from '../../../entities/strategy/regime-backtest-trade.entity';
import { RegimeStrategyConfigEntity } from '../../../entities/strategy/regime-strategy-config.entity';
import { ASharesService } from '../../../market-data/a-shares/a-shares.service';
import { CreateRegimeBacktestDto } from './dto/create-regime-backtest.dto';
import { RegimeBacktestRunner } from './regime-backtest.runner';
import { validateRegimeConfig } from '../regime-engine.validation';
import {
  aggregateSymbolStats,
  mapDailyLogEntity,
  overlayTradesOnBars,
  paginatePositions,
  paginateSymbolStats,
  shiftTradeDate,
  normalizeTradeDateLabel,
  tradeEntityToPosition,
  type RegimeBacktestDailyLogDto,
  type RegimeBacktestPositionRow,
  type RegimeBacktestSymbolStatRow,
  type RegimeRowsPage,
  type RegimeTradeOnBar,
} from './regime-backtest-audit.helpers';
import type { AShareKlineRow } from '../../../market-data/a-shares/a-shares.types';

const DATE_RE = /^\d{8}$/;

export interface RegimeBacktestProgress {
  status: string;
  phase: string | null;
  progressDone: number;
  progressTotal: number;
  errorMessage: string | null;
}

export type RegimeBacktestKlineBar = AShareKlineRow & { trades?: RegimeTradeOnBar[] };

export type {
  RegimeBacktestDailyLogDto,
  RegimeBacktestPositionRow,
  RegimeBacktestSymbolStatRow,
  RegimeRowsPage,
};

@Injectable()
export class RegimeBacktestService {
  private readonly logger = new Logger(RegimeBacktestService.name);
  private readonly running = new Set<string>();

  constructor(
    @InjectRepository(RegimeBacktestRunEntity)
    private readonly runRepo: Repository<RegimeBacktestRunEntity>,
    @InjectRepository(RegimeBacktestDailyEntity)
    private readonly dailyRepo: Repository<RegimeBacktestDailyEntity>,
    @InjectRepository(RegimeBacktestDailyLogEntity)
    private readonly dailyLogRepo: Repository<RegimeBacktestDailyLogEntity>,
    @InjectRepository(RegimeBacktestTradeEntity)
    private readonly tradeRepo: Repository<RegimeBacktestTradeEntity>,
    @InjectRepository(RegimeStrategyConfigEntity)
    private readonly configRepo: Repository<RegimeStrategyConfigEntity>,
    private readonly runner: RegimeBacktestRunner,
    private readonly aSharesService: ASharesService,
  ) {}

  async create(dto: CreateRegimeBacktestDto): Promise<RegimeBacktestRunEntity> {
    this.validateDto(dto);
    validateRegimeConfig(dto.config);

    let regimeConfigId: string | null = dto.regimeConfigId ?? null;
    let regimeConfigVersion: number | null = null;
    if (regimeConfigId) {
      const ent = await this.configRepo.findOne({ where: { id: regimeConfigId } });
      if (!ent) {
        throw new BadRequestException(`regime config ${regimeConfigId} not found`);
      }
      regimeConfigVersion = ent.version;
    }

    const capital = { ...dto.capital };
    if (capital.positionRatio !== undefined || capital.maxPositions !== undefined) {
      this.logger.warn('ignoring capital.positionRatio/maxPositions (deprecated)');
      delete capital.positionRatio;
      delete capital.maxPositions;
    }

    const entity = this.runRepo.create({
      regimeConfigId,
      regimeConfigVersion,
      name: dto.name.trim(),
      note: dto.note ?? null,
      config: {
        config: dto.config,
        capital,
      },
      dateStart: dto.dateStart,
      dateEnd: dto.dateEnd,
      status: 'pending',
      progressDone: 0,
      progressTotal: 0,
    });
    return this.runRepo.save(entity);
  }

  async findAll(
    page: number,
    pageSize: number,
    filter?: { status?: string; keyword?: string },
  ): Promise<{ total: number; items: RegimeBacktestRunEntity[] }> {
    const safePage = Math.max(1, page);
    const safeSize = Math.min(Math.max(1, pageSize), 200);
    const where: FindOptionsWhere<RegimeBacktestRunEntity> = {};
    if (filter?.status) {
      where.status = filter.status as RegimeBacktestRunStatus;
    }
    const trimmedKeyword = filter?.keyword?.trim();
    if (trimmedKeyword) {
      // 转义 LIKE 通配符，避免关键字中的 % _ \ 影响匹配
      const escaped = trimmedKeyword.replace(/[%_\\]/g, '\\$&');
      where.name = Like(`%${escaped}%`);
    }
    const [items, total] = await this.runRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (safePage - 1) * safeSize,
      take: safeSize,
    });
    return { total, items };
  }

  async findOne(id: string): Promise<RegimeBacktestRunEntity> {
    const entity = await this.runRepo.findOne({ where: { id } });
    if (!entity) throw new NotFoundException(`regime backtest ${id} not found`);
    return entity;
  }

  async remove(id: string): Promise<void> {
    const entity = await this.findOne(id);
    if (entity.status === 'running') {
      throw new ConflictException('run is running, cannot delete');
    }
    await this.runRepo.remove(entity);
  }

  async triggerRun(id: string): Promise<{ runId: string }> {
    const run = await this.findOne(id);
    if (this.running.has(id)) {
      throw new ConflictException('run is already running');
    }
    if (run.status === 'running') {
      throw new ConflictException('run is already running');
    }

    await this.runRepo.update(id, {
      status: 'running',
      phase: null,
      progressDone: 0,
      progressTotal: 0,
      errorMessage: null,
      completedAt: null,
    });

    this.running.add(id);

    this.runner.executeRun(id).catch((err: unknown) => {
      this.logger.error(
        `RegimeBacktestRunner.executeRun failed run=${id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }).finally(() => {
      this.running.delete(id);
    });

    return { runId: id };
  }

  async getProgress(id: string): Promise<RegimeBacktestProgress> {
    const run = await this.findOne(id);
    return {
      status: run.status,
      phase: run.phase,
      progressDone: run.progressDone,
      progressTotal: run.progressTotal,
      errorMessage: run.errorMessage,
    };
  }

  async listDaily(id: string): Promise<RegimeBacktestDailyEntity[]> {
    await this.findOne(id);
    return this.dailyRepo.find({
      where: { runId: id },
      order: { tradeDate: 'ASC', id: 'ASC' },
    });
  }

  async listTrades(id: string): Promise<RegimeBacktestTradeEntity[]> {
    await this.findOne(id);
    return this.tradeRepo
      .createQueryBuilder('t')
      .where('t.run_id = :id', { id })
      .orderBy('t.signal_date', 'ASC')
      .addOrderBy('t.rank', 'ASC', 'NULLS LAST')
      .addOrderBy('t.id', 'ASC')
      .getMany();
  }

  async listDailyLog(id: string): Promise<RegimeBacktestDailyLogDto[]> {
    await this.findOne(id);
    const rows = await this.dailyLogRepo.find({
      where: { runId: id },
      order: { tradeDate: 'ASC', id: 'ASC' },
    });
    return rows.map(mapDailyLogEntity);
  }

  async listPositions(
    id: string,
    opts: {
      page?: number;
      pageSize?: number;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      tsCode?: string;
    } = {},
  ): Promise<RegimeRowsPage<RegimeBacktestPositionRow>> {
    await this.findOne(id);
    const trades = await this.tradeRepo.find({
      where: { runId: id, status: 'taken' },
      order: { signalDate: 'ASC', id: 'ASC' },
    });
    const rows = trades.map(tradeEntityToPosition);
    return paginatePositions(rows, {
      page: opts.page ?? 1,
      pageSize: opts.pageSize ?? 50,
      sortBy: opts.sortBy,
      sortOrder: opts.sortOrder,
      tsCode: opts.tsCode,
    });
  }

  async listSymbolStats(
    id: string,
    opts: {
      page?: number;
      pageSize?: number;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      tsCode?: string;
    } = {},
  ): Promise<RegimeRowsPage<RegimeBacktestSymbolStatRow>> {
    await this.findOne(id);
    const trades = await this.tradeRepo.find({
      where: { runId: id, status: 'taken' },
    });
    const rows = aggregateSymbolStats(trades);
    return paginateSymbolStats(rows, {
      page: opts.page ?? 1,
      pageSize: opts.pageSize ?? 50,
      sortBy: opts.sortBy,
      sortOrder: opts.sortOrder,
      tsCode: opts.tsCode,
    });
  }

  async getKlineChart(
    id: string,
    tsCode: string,
    signalDate: string,
    before = 100,
    after = 30,
  ): Promise<RegimeBacktestKlineBar[]> {
    await this.findOne(id);
    if (!tsCode?.trim()) {
      throw new BadRequestException('tsCode required');
    }
    if (!/^\d{8}$/.test(signalDate ?? '')) {
      throw new BadRequestException('signalDate must be YYYYMMDD');
    }

    const safeBefore = Math.min(500, Math.max(1, before));
    const safeAfter = Math.min(200, Math.max(0, after));
    const startDate = shiftTradeDate(signalDate, -safeBefore * 2);
    const endDate = shiftTradeDate(signalDate, safeAfter * 2);
    const sym = tsCode.trim();

    const [bars, trades] = await Promise.all([
      this.aSharesService.getKlines(sym, safeBefore + safeAfter + 5, 'qfq', {
        startDate,
        endDate,
      }),
      this.tradeRepo.find({ where: { runId: id, tsCode: sym } }),
    ]);

    const anchorKey = normalizeTradeDateLabel(signalDate);
    const anchorIdx = bars.findIndex((b) => b.open_time >= anchorKey);
    const center = anchorIdx >= 0 ? anchorIdx : bars.length - 1;
    const sliceStart = Math.max(0, center - safeBefore);
    const sliceEnd = Math.min(bars.length, center + safeAfter + 1);
    const window = bars.slice(sliceStart, sliceEnd);

    overlayTradesOnBars(window, trades, sym);
    return window as RegimeBacktestKlineBar[];
  }

  private validateDto(dto: CreateRegimeBacktestDto): void {
    if (!dto.name || dto.name.trim() === '') {
      throw new BadRequestException('name required');
    }
    if (dto.name.trim().length > 200) {
      throw new BadRequestException('name too long (max 200)');
    }
    if (dto.config === undefined || dto.config === null) {
      throw new BadRequestException('config required');
    }
    if (!dto.dateStart || !DATE_RE.test(dto.dateStart)) {
      throw new BadRequestException('dateStart must be YYYYMMDD');
    }
    if (!dto.dateEnd || !DATE_RE.test(dto.dateEnd)) {
      throw new BadRequestException('dateEnd must be YYYYMMDD');
    }
    if (dto.dateStart >= dto.dateEnd) {
      throw new BadRequestException('dateStart must be < dateEnd');
    }
    const cap = dto.capital;
    if (!cap || typeof cap !== 'object') {
      throw new BadRequestException('capital required');
    }
    if (typeof cap.initialCapital !== 'number' || !(cap.initialCapital > 0)) {
      throw new BadRequestException('capital.initialCapital must be > 0');
    }
    if (!cap.cost || typeof cap.cost !== 'object') {
      throw new BadRequestException('capital.cost required');
    }
    this.validateCapitalSizingAndKelly(cap);
  }

  private validateCapitalSizingAndKelly(cap: CreateRegimeBacktestDto['capital']): void {
    const sizing = cap.sizing as Record<string, unknown> | undefined;
    const kelly = cap.kelly as Record<string, unknown> | undefined;
    const circuitBreaker = cap.circuitBreaker as Record<string, unknown> | undefined;

    if (sizing !== undefined && sizing !== null) {
      const mode = sizing.mode;
      if (mode !== undefined && mode !== 'fixed' && mode !== 'signal_weighted' && mode !== 'source_kelly') {
        throw new BadRequestException('capital.sizing.mode must be fixed | signal_weighted | source_kelly');
      }
    }

    if (kelly !== undefined && kelly !== null) {
      if (typeof kelly.enabled !== 'boolean') {
        throw new BadRequestException('capital.kelly.enabled must be boolean');
      }
      if (!kelly.enabled) return;

      if (sizing?.mode !== 'source_kelly') {
        throw new BadRequestException('capital.kelly requires sizing.mode = source_kelly');
      }

      const intInRange = (v: unknown, name: string, min: number, max: number): void => {
        if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) {
          throw new BadRequestException(`${name} must be integer ${min}~${max}`);
        }
      };
      intInRange(kelly.simTrades, 'capital.kelly.simTrades', 0, 500);
      intInRange(kelly.windowTrades, 'capital.kelly.windowTrades', 1, 500);
      intInRange(kelly.stepTrades, 'capital.kelly.stepTrades', 1, 500);

      if (!(typeof kelly.kellyFraction === 'number' && kelly.kellyFraction > 0 && kelly.kellyFraction <= 1)) {
        throw new BadRequestException('capital.kelly.kellyFraction must be in (0, 1]');
      }
      if (!(typeof kelly.kellyMaxMult === 'number' && kelly.kellyMaxMult > 0)) {
        throw new BadRequestException('capital.kelly.kellyMaxMult must be > 0');
      }
      if (typeof kelly.enableProbe !== 'boolean') {
        throw new BadRequestException('capital.kelly.enableProbe must be boolean');
      }
    }

    if (circuitBreaker !== undefined && circuitBreaker !== null) {
      const boolKeys = ['enableCooldown', 'enableDrawdownHalt'] as const;
      for (const key of boolKeys) {
        if (circuitBreaker[key] !== undefined && typeof circuitBreaker[key] !== 'boolean') {
          throw new BadRequestException(`capital.circuitBreaker.${key} must be boolean`);
        }
      }
    }
  }
}
