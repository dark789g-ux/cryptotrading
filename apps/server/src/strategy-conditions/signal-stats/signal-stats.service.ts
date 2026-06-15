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
import { Repository, DataSource, In } from 'typeorm';
import { SignalTestEntity } from '../../entities/strategy/signal-test.entity';
import { SignalTestRunEntity } from '../../entities/strategy/signal-test-run.entity';
import { SignalTestTradeEntity } from '../../entities/strategy/signal-test-trade.entity';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { CreateSignalTestDto } from './dto/create-signal-test.dto';
import { UpdateSignalTestDto } from './dto/update-signal-test.dto';
import { SignalStatsRunner } from './signal-stats.runner';
import { buildRetHistogram, RetHistogramResult } from './signal-stats.histogram';
import {
  buildTradeListOptions,
  ListTradesOptions,
} from './signal-stats.list-trades-options';
import { SignalTestEquityEntity } from '../../entities/strategy/signal-test-equity.entity';
import {
  buildBandLockParams,
  buildPhaseLockParams,
  validateBandLockParams,
  validatePhaseLockParams,
} from './signal-stats.exit-params';
import { validateBacktestConfig } from './signal-stats.backtest-validators';

/** 方案列表条目：附带该方案最新一次 run 的完整实体（无 run 时为 null）。 */
export type SignalTestWithLatestRun = SignalTestEntity & {
  latestRun: SignalTestRunEntity | null;
};

/** listTrades 响应条目：在实体字段基础上注入 name（标的中文名，查不到为 null）。 */
export type SignalTestTradeWithName = SignalTestTradeEntity & { name: string | null };

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
    @InjectRepository(SignalTestEquityEntity)
    private readonly equityRepo: Repository<SignalTestEquityEntity>,
    @InjectRepository(AShareSymbolEntity)
    private readonly symbolRepo: Repository<AShareSymbolEntity>,
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
      bandLockParams: buildBandLockParams(dto),
      phaseLockParams: buildPhaseLockParams(dto),
      backtestConfig: dto.backtestConfig ?? null,
      universe: dto.universe,
      dateStart: dto.dateStart,
      dateEnd: dto.dateEnd,
    });
    return this.testRepo.save(entity);
  }

  async findAll(): Promise<SignalTestWithLatestRun[]> {
    const tests = await this.testRepo.find({ order: { createdAt: 'DESC' } });

    // 两步查询 + JS 拼接，避开 TypeORM 同表 leftJoin+orderBy 已知坑。
    // DISTINCT ON (test_id) ORDER BY test_id, created_at DESC → 每个 test 最新 run。
    const latestRuns = await this.runRepo
      .createQueryBuilder('r')
      .distinctOn(['r.testId'])
      .orderBy('r.testId', 'ASC')
      .addOrderBy('r.createdAt', 'DESC')
      .getMany();

    const runByTestId = new Map<string, SignalTestRunEntity>();
    for (const run of latestRuns) {
      runByTestId.set(run.testId, run);
    }

    return tests.map((test) => ({
      ...test,
      latestRun: runByTestId.get(test.id) ?? null,
    }));
  }

  async findOne(id: string): Promise<SignalTestEntity> {
    const entity = await this.testRepo.findOne({ where: { id } });
    if (!entity) throw new NotFoundException(`SignalTest ${id} not found`);
    return entity;
  }

  async update(id: string, dto: UpdateSignalTestDto): Promise<SignalTestEntity> {
    const entity = await this.findOne(id);
    // 先确定合并后的目标 exitMode（dto 显式带 → 用 dto；否则沿用存量）。
    const targetExitMode = dto.exitMode ?? entity.exitMode;
    // band_lock 4 参数合并：仅当目标模式仍是 trailing_lock 才回填存量值（dto 显式带优先）；
    //   切到 fixed_n/strategy 时丢弃存量 band_lock 残留（置 undefined），避免被 stray 校验误判 400。
    // 注意 floorEnabled/ma5RequireDown 用 ?? 防显式/存量 false 被吞。
    const prev = targetExitMode === 'trailing_lock' ? entity.bandLockParams : null;
    const keepBandLock = targetExitMode === 'trailing_lock';
    // phase_lock 3 参数合并：仅当目标模式仍是 phase_lock 才回填存量值（dto 显式带优先）；
    //   切到其它模式时丢弃存量 phase_lock 残留（置 undefined），避免被 stray 校验误判 400。
    const prevPL = targetExitMode === 'phase_lock' ? entity.phaseLockParams : null;
    const keepPhaseLock = targetExitMode === 'phase_lock';
    const merged: CreateSignalTestDto = {
      name: dto.name ?? entity.name,
      buyConditions: dto.buyConditions ?? entity.buyConditions,
      exitMode: targetExitMode,
      horizonN: dto.horizonN ?? entity.horizonN ?? undefined,
      exitConditions: dto.exitConditions ?? entity.exitConditions ?? undefined,
      maxHold: dto.maxHold ?? entity.maxHold ?? undefined,
      stopRatio: keepBandLock ? (dto.stopRatio ?? prev?.stopRatio ?? undefined) : undefined,
      floorRatio: keepBandLock ? (dto.floorRatio ?? prev?.floorRatio ?? undefined) : undefined,
      floorEnabled: keepBandLock ? (dto.floorEnabled ?? prev?.floorEnabled ?? undefined) : undefined,
      ma5RequireDown: keepBandLock
        ? (dto.ma5RequireDown ?? prev?.ma5RequireDown ?? undefined)
        : undefined,
      initFactor: keepPhaseLock ? (dto.initFactor ?? prevPL?.initFactor ?? undefined) : undefined,
      lockFactor: keepPhaseLock ? (dto.lockFactor ?? prevPL?.lockFactor ?? undefined) : undefined,
      lookback: keepPhaseLock ? (dto.lookback ?? prevPL?.lookback ?? undefined) : undefined,
      universe: dto.universe ?? entity.universe,
      dateStart: dto.dateStart ?? entity.dateStart,
      dateEnd: dto.dateEnd ?? entity.dateEnd,
      // backtestConfig 整对象替换：dto 显式带（含 null=关闭）优先；未带则沿用存量。
      backtestConfig:
        'backtestConfig' in dto ? dto.backtestConfig : entity.backtestConfig,
    };
    await this.validateDto(merged);
    Object.assign(entity, {
      name: merged.name,
      buyConditions: merged.buyConditions,
      exitMode: merged.exitMode,
      horizonN: merged.horizonN ?? null,
      exitConditions: merged.exitConditions ?? null,
      maxHold: merged.maxHold ?? null,
      bandLockParams: buildBandLockParams(merged),
      phaseLockParams: buildPhaseLockParams(merged),
      backtestConfig: merged.backtestConfig ?? null,
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

  /** 逐笔明细分页（支持服务端排序/筛选，响应注入标的名称）。 */
  async listTrades(
    runId: string,
    page: number,
    pageSize: number,
    opts: ListTradesOptions = {},
  ): Promise<{ total: number; items: SignalTestTradeWithName[] }> {
    // 确认 run 存在
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Run ${runId} not found`);

    const safePage = Math.max(1, page);
    const safeSize = Math.min(Math.max(1, pageSize), 500);
    const skip = (safePage - 1) * safeSize;

    const { where, order } = buildTradeListOptions(runId, opts);

    const [items, total] = await this.tradeRepo.findAndCount({
      where,
      order,
      skip,
      take: safeSize,
    });

    // 名称注入（响应期，非 join）：同页内标的去重后批量查 a_share_symbols
    const codes = [...new Set(items.map((t) => t.tsCode))];
    const symbolRows = codes.length
      ? await this.symbolRepo.find({
          where: { tsCode: In(codes) },
          select: { tsCode: true, name: true },
        })
      : [];
    const nameMap = new Map(symbolRows.map((r) => [r.tsCode, r.name]));

    const enriched: SignalTestTradeWithName[] = items.map((t) => ({
      ...t,
      name: nameMap.get(t.tsCode) ?? null,
    }));

    return { total, items: enriched };
  }

  /** 收益率分布直方图。 */
  async getRetHistogram(runId: string, bins: number): Promise<RetHistogramResult> {
    // 确认 run 存在
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Run ${runId} not found`);

    // 单列查询 ret，numeric 以 string 返回，转为 number
    const rows = await this.tradeRepo
      .createQueryBuilder('t')
      .select('t.ret', 'ret')
      .where('t.runId = :runId', { runId })
      .getRawMany<{ ret: string }>();

    const rets = rows.map((r) => Number(r.ret));
    return buildRetHistogram(runId, rets, bins);
  }

  /**
   * 迷你回测逐日净值曲线（signal_test_equity），按 trade_date 升序。
   * 只读；run 不存在 → 404。run 未跑回测层 → 返回空数组（前端据此渲染"无回测视图"）。
   */
  async listEquity(runId: string): Promise<SignalTestEquityEntity[]> {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Run ${runId} not found`);
    return this.equityRepo.find({
      where: { runId },
      order: { tradeDate: 'ASC' },
    });
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
    } else if (dto.exitMode === 'trailing_lock') {
      // trailing_lock：maxHold 可选（留空=无硬上限）；若填须为整数且 ≥1。
      // 无 horizonN / exitConditions 必填项。
      if (dto.maxHold !== undefined && dto.maxHold !== null) {
        if (!Number.isInteger(dto.maxHold) || dto.maxHold < 1) {
          throw new BadRequestException('exitMode=trailing_lock 时 maxHold 须为整数且 ≥ 1');
        }
      }
      validateBandLockParams(dto);
    } else if (dto.exitMode === 'phase_lock') {
      // phase_lock：无 horizonN / exitConditions / maxHold 必填项（max_hold 不提供）。
      validatePhaseLockParams(dto);
    } else {
      throw new BadRequestException('exitMode 必须为 fixed_n、strategy、trailing_lock 或 phase_lock');
    }

    // 2b. band_lock 4 参数仅 trailing_lock 可送；其它模式误送 → 400（保持模式纯净）。
    if (dto.exitMode !== 'trailing_lock') {
      const stray: string[] = [];
      if (dto.stopRatio !== undefined) stray.push('stopRatio');
      if (dto.floorRatio !== undefined) stray.push('floorRatio');
      if (dto.floorEnabled !== undefined) stray.push('floorEnabled');
      if (dto.ma5RequireDown !== undefined) stray.push('ma5RequireDown');
      if (stray.length > 0) {
        throw new BadRequestException(
          `exitMode=${dto.exitMode} 不支持 band_lock 参数：${stray.join(', ')}`,
        );
      }
    }

    // 2c. phase_lock 3 参数仅 phase_lock 可送；其它模式误送 → 400（保持模式纯净）。
    if (dto.exitMode !== 'phase_lock') {
      const stray: string[] = [];
      if (dto.initFactor !== undefined) stray.push('initFactor');
      if (dto.lockFactor !== undefined) stray.push('lockFactor');
      if (dto.lookback !== undefined) stray.push('lookback');
      if (stray.length > 0) {
        throw new BadRequestException(
          `exitMode=${dto.exitMode} 不支持 phase_lock 参数：${stray.join(', ')}`,
        );
      }
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

    // 6. 迷你回测配置（可选）；提供时按 portfolio-sim 语义 fail-fast（spec 04 §4.6）
    validateBacktestConfig(dto.backtestConfig, (m) => this.logger.warn(m));
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
