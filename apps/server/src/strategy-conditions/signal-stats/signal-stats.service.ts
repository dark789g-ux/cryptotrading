/**
 * signal-stats.service.ts
 *
 * CRUD（signal_test） + 触发 run + 查询（进度/历史聚合/逐笔明细分页）。
 *
 * 校验规则（fail-fast, 400 BadRequestException）：
 *   - buyConditions 非空。
 *   - exitMode='fixed_n' → horizonN 必填且 ≥1。
 *   - exitMode='strategy' → exitConditions 非空 + maxHold ≥1。
 *   - universe.type='list' → tsCodes 非空。
 *   - dateStart ≤ dateEnd 且均在 raw.trade_cal（exchange='SSE'）覆盖范围内。
 *
 * 历史 run 不删除，保留可对比（与 strategy-conditions 的 delete-before-run 不同）。
 */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { SignalTestEntity } from '../../entities/strategy/signal-test.entity';
import { SignalTestRunEntity } from '../../entities/strategy/signal-test-run.entity';
import { SignalTestTradeEntity } from '../../entities/strategy/signal-test-trade.entity';
import { CreateSignalTestDto } from './dto/create-signal-test.dto';
import { UpdateSignalTestDto } from './dto/update-signal-test.dto';
import { SignalStatsRunner } from './signal-stats.runner';

@Injectable()
export class SignalStatsService {
  private readonly logger = new Logger(SignalStatsService.name);

  constructor(
    @InjectRepository(SignalTestEntity)
    private readonly testRepo: Repository<SignalTestEntity>,
    @InjectRepository(SignalTestRunEntity)
    private readonly runRepo: Repository<SignalTestRunEntity>,
    @InjectRepository(SignalTestTradeEntity)
    private readonly tradeRepo: Repository<SignalTestTradeEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly runner: SignalStatsRunner,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  // CRUD
  // ──────────────────────────────────────────────────────────────────────────

  async create(dto: CreateSignalTestDto): Promise<SignalTestEntity> {
    await this.validateDto(dto);
    const entity = this.testRepo.create({
      name: dto.name,
      buyConditions: dto.buyConditions,
      exitMode: dto.exitMode,
      horizonN: dto.horizonN ?? null,
      exitConditions: dto.exitConditions ?? null,
      maxHold: dto.maxHold ?? null,
      universe: dto.universe,
      dateStart: dto.dateStart,
      dateEnd: dto.dateEnd,
    });
    return this.testRepo.save(entity);
  }

  async findAll(): Promise<SignalTestEntity[]> {
    return this.testRepo.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<SignalTestEntity> {
    const entity = await this.testRepo.findOne({ where: { id } });
    if (!entity) throw new NotFoundException(`SignalTest ${id} not found`);
    return entity;
  }

  async update(id: string, dto: UpdateSignalTestDto): Promise<SignalTestEntity> {
    const entity = await this.findOne(id);
    // 合并后整体再验证
    const merged: CreateSignalTestDto = {
      name: dto.name ?? entity.name,
      buyConditions: dto.buyConditions ?? entity.buyConditions,
      exitMode: dto.exitMode ?? entity.exitMode,
      horizonN: dto.horizonN ?? entity.horizonN ?? undefined,
      exitConditions: dto.exitConditions ?? entity.exitConditions ?? undefined,
      maxHold: dto.maxHold ?? entity.maxHold ?? undefined,
      universe: dto.universe ?? entity.universe,
      dateStart: dto.dateStart ?? entity.dateStart,
      dateEnd: dto.dateEnd ?? entity.dateEnd,
    };
    await this.validateDto(merged);
    Object.assign(entity, {
      name: merged.name,
      buyConditions: merged.buyConditions,
      exitMode: merged.exitMode,
      horizonN: merged.horizonN ?? null,
      exitConditions: merged.exitConditions ?? null,
      maxHold: merged.maxHold ?? null,
      universe: merged.universe,
      dateStart: merged.dateStart,
      dateEnd: merged.dateEnd,
    });
    return this.testRepo.save(entity);
  }

  async remove(id: string): Promise<void> {
    const entity = await this.findOne(id);
    await this.testRepo.remove(entity);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Run 触发
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * 触发异步 run：创建 run 记录 → 异步启动 runner → 立即返回 runId。
   * 同一 test 已有 running 状态的 run 时拒绝（ConflictException）。
   */
  async triggerRun(testId: string): Promise<{ runId: string }> {
    const test = await this.findOne(testId);

    const existing = await this.runRepo.findOne({
      where: { testId: test.id, status: 'running' },
    });
    if (existing) {
      throw new ConflictException('该方案已有运行中的任务，请等待完成后再触发');
    }

    const run = this.runRepo.create({
      testId: test.id,
      status: 'running',
      progressScanned: 0,
      progressTotal: 0,
      filteredCount: 0,
    });
    await this.runRepo.save(run);

    // 异步执行，不等待
    this.runner.executeRun(test, run.id).catch((err: unknown) => {
      this.logger.error(
        `SignalStatsRunner.executeRun failed for run=${run.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    });

    return { runId: run.id };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 查询
  // ──────────────────────────────────────────────────────────────────────────

  /** 当前/最近一次 run 的进度。 */
  async getRunProgress(testId: string): Promise<SignalTestRunEntity> {
    await this.findOne(testId);
    const run = await this.runRepo.findOne({
      where: { testId },
      order: { createdAt: 'DESC' },
    });
    if (!run) throw new NotFoundException(`No run found for test ${testId}`);
    return run;
  }

  /** 历史运行聚合列表（仅聚合字段，不含逐笔明细）。 */
  async listRuns(testId: string): Promise<SignalTestRunEntity[]> {
    await this.findOne(testId);
    return this.runRepo.find({
      where: { testId },
      order: { createdAt: 'DESC' },
    });
  }

  /** 逐笔明细分页。 */
  async listTrades(
    runId: string,
    page: number,
    pageSize: number,
  ): Promise<{ total: number; items: SignalTestTradeEntity[] }> {
    // 确认 run 存在
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Run ${runId} not found`);

    const safePage = Math.max(1, page);
    const safeSize = Math.min(Math.max(1, pageSize), 500);
    const skip = (safePage - 1) * safeSize;

    const [items, total] = await this.tradeRepo.findAndCount({
      where: { runId },
      order: { signalDate: 'ASC', tsCode: 'ASC' },
      skip,
      take: safeSize,
    });
    return { total, items };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 内部：校验
  // ──────────────────────────────────────────────────────────────────────────

  private async validateDto(dto: CreateSignalTestDto): Promise<void> {
    // 1. buyConditions 非空
    if (!dto.buyConditions || dto.buyConditions.length === 0) {
      throw new BadRequestException('buyConditions 不能为空');
    }

    // 2. exitMode 联动必填
    if (dto.exitMode === 'fixed_n') {
      if (dto.horizonN === undefined || dto.horizonN === null) {
        throw new BadRequestException('exitMode=fixed_n 时 horizonN 必填');
      }
      if (dto.horizonN < 1) {
        throw new BadRequestException('horizonN 必须 ≥ 1');
      }
    } else if (dto.exitMode === 'strategy') {
      if (!dto.exitConditions || dto.exitConditions.length === 0) {
        throw new BadRequestException('exitMode=strategy 时 exitConditions 不能为空');
      }
      if (dto.maxHold === undefined || dto.maxHold === null) {
        throw new BadRequestException('exitMode=strategy 时 maxHold 必填');
      }
      if (dto.maxHold < 1) {
        throw new BadRequestException('maxHold 必须 ≥ 1');
      }
    } else {
      throw new BadRequestException('exitMode 必须为 fixed_n 或 strategy');
    }

    // 3. universe.type='list' 时 tsCodes 非空
    if (dto.universe?.type === 'list') {
      if (!dto.universe.tsCodes || dto.universe.tsCodes.length === 0) {
        throw new BadRequestException('universe.type=list 时 tsCodes 不能为空');
      }
    }

    // 4. dateStart ≤ dateEnd
    if (!dto.dateStart || !dto.dateEnd) {
      throw new BadRequestException('dateStart 和 dateEnd 不能为空');
    }
    if (dto.dateStart > dto.dateEnd) {
      throw new BadRequestException('dateStart 必须 ≤ dateEnd');
    }

    // 5. 日期在 trade_cal 覆盖范围内
    await this.validateDatesInTradeCal(dto.dateStart, dto.dateEnd);
  }

  /** 校验 dateStart/dateEnd 在 raw.trade_cal(SSE) 覆盖范围内，超出则 400。 */
  private async validateDatesInTradeCal(dateStart: string, dateEnd: string): Promise<void> {
    const rows = await this.dataSource.query<Array<{ minDate: string; maxDate: string }>>(
      `SELECT MIN(cal_date) AS "minDate", MAX(cal_date) AS "maxDate"
         FROM raw.trade_cal
        WHERE exchange = 'SSE'`,
    );
    if (!rows.length || !rows[0].minDate) {
      throw new BadRequestException('trade_cal 数据为空，无法校验日期范围');
    }
    const { minDate, maxDate } = rows[0];
    if (dateStart < minDate || dateStart > maxDate) {
      throw new BadRequestException(
        `dateStart=${dateStart} 超出 trade_cal 覆盖范围 [${minDate}, ${maxDate}]`,
      );
    }
    if (dateEnd < minDate || dateEnd > maxDate) {
      throw new BadRequestException(
        `dateEnd=${dateEnd} 超出 trade_cal 覆盖范围 [${minDate}, ${maxDate}]`,
      );
    }
  }
}
