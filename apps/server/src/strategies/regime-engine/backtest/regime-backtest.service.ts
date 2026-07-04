import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RegimeBacktestRunEntity } from '../../../entities/strategy/regime-backtest-run.entity';
import { RegimeBacktestDailyEntity } from '../../../entities/strategy/regime-backtest-daily.entity';
import { RegimeBacktestTradeEntity } from '../../../entities/strategy/regime-backtest-trade.entity';
import { RegimeStrategyConfigEntity } from '../../../entities/strategy/regime-strategy-config.entity';
import { CreateRegimeBacktestDto } from './dto/create-regime-backtest.dto';
import { RegimeBacktestRunner } from './regime-backtest.runner';

const DATE_RE = /^\d{8}$/;

export interface RegimeBacktestProgress {
  status: string;
  phase: string | null;
  progressDone: number;
  progressTotal: number;
  errorMessage: string | null;
}

@Injectable()
export class RegimeBacktestService {
  private readonly logger = new Logger(RegimeBacktestService.name);
  private readonly running = new Set<string>();

  constructor(
    @InjectRepository(RegimeBacktestRunEntity)
    private readonly runRepo: Repository<RegimeBacktestRunEntity>,
    @InjectRepository(RegimeBacktestDailyEntity)
    private readonly dailyRepo: Repository<RegimeBacktestDailyEntity>,
    @InjectRepository(RegimeBacktestTradeEntity)
    private readonly tradeRepo: Repository<RegimeBacktestTradeEntity>,
    @InjectRepository(RegimeStrategyConfigEntity)
    private readonly configRepo: Repository<RegimeStrategyConfigEntity>,
    private readonly runner: RegimeBacktestRunner,
  ) {}

  async create(dto: CreateRegimeBacktestDto): Promise<RegimeBacktestRunEntity> {
    this.validateDto(dto);
    const configEntity = await this.configRepo.findOne({ where: { id: dto.regimeConfigId } });
    if (!configEntity) {
      throw new BadRequestException(`regime config ${dto.regimeConfigId} not found`);
    }
    const entity = this.runRepo.create({
      regimeConfigId: dto.regimeConfigId,
      regimeConfigVersion: configEntity.version,
      name: dto.name.trim(),
      note: dto.note ?? null,
      config: {
        config: configEntity.config,
        capital: dto.capital,
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
  ): Promise<{ total: number; items: RegimeBacktestRunEntity[] }> {
    const safePage = Math.max(1, page);
    const safeSize = Math.min(Math.max(1, pageSize), 200);
    const [items, total] = await this.runRepo.findAndCount({
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
    return this.tradeRepo.find({
      where: { runId: id },
      order: { buyDate: 'ASC', id: 'ASC' },
    });
  }

  private validateDto(dto: CreateRegimeBacktestDto): void {
    if (!dto.regimeConfigId || typeof dto.regimeConfigId !== 'string') {
      throw new BadRequestException('regimeConfigId required');
    }
    if (!dto.name || dto.name.trim() === '') {
      throw new BadRequestException('name required');
    }
    if (dto.name.trim().length > 200) {
      throw new BadRequestException('name too long (max 200)');
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
    if (typeof cap.positionRatio !== 'number' || !(cap.positionRatio > 0) || cap.positionRatio > 1) {
      throw new BadRequestException('capital.positionRatio must be in (0, 1]');
    }
    if (
      cap.maxPositions !== null &&
      (!Number.isInteger(cap.maxPositions) || cap.maxPositions < 1)
    ) {
      throw new BadRequestException('capital.maxPositions must be >=1 int or null');
    }
    if (!cap.cost || typeof cap.cost !== 'object') {
      throw new BadRequestException('capital.cost required');
    }
  }
}
