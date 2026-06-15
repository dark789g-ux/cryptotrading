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
import { SignalTestBacktestConfig } from '../../entities/strategy/signal-test.entity';
import {
  RANK_FACTOR_REGISTRY,
  VALID_RANK_FACTOR_KEYS,
} from '../portfolio-sim/portfolio-sim.factor-registry';
import { validateRegimes } from '../portfolio-sim/portfolio-sim.regime-validator';

/** 方案列表条目：附带该方案最新一次 run 的完整实体（无 run 时为 null）。 */
export type SignalTestWithLatestRun = SignalTestEntity & {
  latestRun: SignalTestRunEntity | null;
};

/** listTrades 响应条目：在实体字段基础上注入 name（标的中文名，查不到为 null）。 */
export type SignalTestTradeWithName = SignalTestTradeEntity & { name: string | null };

// ── band_lock 参数：量化 + 默认 + 组装 ───────────────────────────────────────

/** band_lock 4 参数默认值（与核 decideBandLock 的 `?? 默认` 逐字一致）。 */
const BAND_LOCK_DEFAULTS = {
  stopRatio: 0.999,
  floorRatio: 0.999,
  floorEnabled: true,
  ma5RequireDown: true,
} as const;

/**
 * ratio 量化：round-half-up 到 0.001（NNNN = floor(r*1000+0.5)）。
 * 与核 band_lock_exit `floor(r*1000+0.5)` 对齐，避免 JS Math.round 的 banker's 分叉。
 * 返回量化后的 ratio（NNNN/1000）。
 */
export function quantizeRatio(r: number): number {
  return Math.floor(r * 1000 + 0.5) / 1000;
}

/**
 * 把 DTO 的 band_lock 4 参数组装成落库的 bandLockParams jsonb。
 * - 非 trailing_lock 模式 → null。
 * - trailing_lock 且量化后 4 参数全为默认 → null（存量行零漂移）。
 * - 否则 → 量化后的完整 4 字段对象（runner 直接透传，核不再量化）。
 * 调用前提：已过 validateDto（ratio 量化后在合法范围、布尔合法）。
 */
export function buildBandLockParams(
  dto: CreateSignalTestDto,
): SignalTestEntity['bandLockParams'] {
  if (dto.exitMode !== 'trailing_lock') return null;
  const stopRatio =
    dto.stopRatio !== undefined ? quantizeRatio(dto.stopRatio) : BAND_LOCK_DEFAULTS.stopRatio;
  const floorRatio =
    dto.floorRatio !== undefined ? quantizeRatio(dto.floorRatio) : BAND_LOCK_DEFAULTS.floorRatio;
  const floorEnabled = dto.floorEnabled ?? BAND_LOCK_DEFAULTS.floorEnabled;
  const ma5RequireDown = dto.ma5RequireDown ?? BAND_LOCK_DEFAULTS.ma5RequireDown;
  // 全默认 → null（零漂移）。
  if (
    stopRatio === BAND_LOCK_DEFAULTS.stopRatio &&
    floorRatio === BAND_LOCK_DEFAULTS.floorRatio &&
    floorEnabled === BAND_LOCK_DEFAULTS.floorEnabled &&
    ma5RequireDown === BAND_LOCK_DEFAULTS.ma5RequireDown
  ) {
    return null;
  }
  return { stopRatio, floorRatio, floorEnabled, ma5RequireDown };
}

// ── phase_lock 参数：量化 + 默认 + 组装 ──────────────────────────────────────

/** phase_lock 3 参数默认值（与共享核 phase_lock_exit.py 默认逐字一致）。 */
const PHASE_LOCK_DEFAULTS = {
  initFactor: 0.999,
  lockFactor: 0.999,
  lookback: 10,
} as const;

/**
 * 把 DTO 的 phase_lock 3 参数组装成落库的 phaseLockParams jsonb。
 * - 非 phase_lock 模式 → null。
 * - phase_lock 且量化后 3 参数全为默认 → null（存量行零漂移）。
 * - 否则 → 量化后的完整 3 字段对象（runner 直接透传，核不再量化）。
 * 调用前提：已过 validateDto（factor 量化后在合法范围、lookback 正整数）。
 */
export function buildPhaseLockParams(
  dto: CreateSignalTestDto,
): SignalTestEntity['phaseLockParams'] {
  if (dto.exitMode !== 'phase_lock') return null;
  const initFactor =
    dto.initFactor !== undefined ? quantizeRatio(dto.initFactor) : PHASE_LOCK_DEFAULTS.initFactor;
  const lockFactor =
    dto.lockFactor !== undefined ? quantizeRatio(dto.lockFactor) : PHASE_LOCK_DEFAULTS.lockFactor;
  const lookback = dto.lookback ?? PHASE_LOCK_DEFAULTS.lookback;
  // 全默认 → null（零漂移）。
  if (
    initFactor === PHASE_LOCK_DEFAULTS.initFactor &&
    lockFactor === PHASE_LOCK_DEFAULTS.lockFactor &&
    lookback === PHASE_LOCK_DEFAULTS.lookback
  ) {
    return null;
  }
  return { initFactor, lockFactor, lookback };
}

// ── 迷你回测 config 校验白名单（复用 portfolio-sim 语义，spec 04 §4.6）─────────
const VALID_RANK_DIRS = new Set(['asc', 'desc']);
const VALID_SIZING_MODES = new Set(['fixed', 'signal_weighted', 'source_kelly']);

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
      this.validateBandLockParams(dto);
    } else if (dto.exitMode === 'phase_lock') {
      // phase_lock：无 horizonN / exitConditions / maxHold 必填项（max_hold 不提供）。
      this.validatePhaseLockParams(dto);
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
    this.validateBacktestConfig(dto.backtestConfig);
  }

  /**
   * 校验扁平单源迷你回测配置（spec 04 §4.6）。null/undefined = 不跑回测，直接放行。
   * 校验语义复用 portfolio-sim.service.validateCreateDto（区间/枚举/anchorMode），
   * 但落到扁平形（不嵌 sources:[...]，runId 由 runner 在触发时注入本 run.id）。
   */
  private validateBacktestConfig(
    bc: SignalTestBacktestConfig | null | undefined,
  ): void {
    if (bc === undefined || bc === null) return;
    if (typeof bc !== 'object') {
      throw new BadRequestException('backtestConfig 非法');
    }

    // initialCapital > 0
    if (typeof bc.initialCapital !== 'number' || !(bc.initialCapital > 0)) {
      throw new BadRequestException('backtestConfig.initialCapital 须 > 0');
    }

    // positionRatio ∈ (0, 1]
    if (
      typeof bc.positionRatio !== 'number' ||
      !(bc.positionRatio > 0) ||
      bc.positionRatio > 1
    ) {
      throw new BadRequestException('backtestConfig.positionRatio 须在 (0, 1] 区间');
    }

    // maxPositions: null 或 ≥1 整数
    if (
      bc.maxPositions !== null &&
      (!Number.isInteger(bc.maxPositions) || (bc.maxPositions as number) < 1)
    ) {
      throw new BadRequestException(
        'backtestConfig.maxPositions 须为 ≥1 的整数或 null',
      );
    }

    // exposureCap: null 或 (0,1]
    if (
      bc.exposureCap !== null &&
      (typeof bc.exposureCap !== 'number' ||
        !(bc.exposureCap > 0) ||
        bc.exposureCap > 1)
    ) {
      throw new BadRequestException(
        'backtestConfig.exposureCap 须在 (0, 1] 区间或 null',
      );
    }

    // cost 各费率 ≥ 0
    const cost = bc.cost;
    if (!cost || typeof cost !== 'object') {
      throw new BadRequestException('backtestConfig.cost 不能为空');
    }
    const feeKeys: Array<keyof typeof cost> = [
      'commissionPerSide',
      'transferPerSide',
      'stampSellBefore20230828',
      'stampSellFrom20230828',
      'slippagePerSide',
    ];
    for (const k of feeKeys) {
      const v = cost[k];
      if (typeof v !== 'number' || !(v >= 0) || !Number.isFinite(v)) {
        throw new BadRequestException(
          `backtestConfig.cost.${String(k)} 须为 ≥0 的有限数`,
        );
      }
    }

    // anchorMode 须布尔
    if (typeof bc.anchorMode !== 'boolean') {
      throw new BadRequestException('backtestConfig.anchorMode 须为布尔值');
    }

    // rankSpec.factors：每项 factor∈9 白名单、weight>0、dir∈{asc,desc}；允许 []
    this.validateBacktestRankSpec(bc.rankSpec);

    // sizing：mode∈白名单；signal_weighted/source_kelly 子约束
    this.validateBacktestSizing(bc.sizing);

    // circuitBreaker：null 或双触发字段齐全（与 portfolio-sim 同语义）
    this.validateBacktestCircuitBreaker(bc.circuitBreaker);

    // regimes：账户级 regime 调仓（与 portfolio-sim 复用同一 validateRegimes）
    validateRegimes(bc.regimes, 'backtestConfig.regimes');
  }

  private validateBacktestRankSpec(spec: SignalTestBacktestConfig['rankSpec']): void {
    if (!spec || typeof spec !== 'object' || !Array.isArray(spec.factors)) {
      throw new BadRequestException('backtestConfig.rankSpec.factors 须为数组');
    }
    for (let j = 0; j < spec.factors.length; j++) {
      const f = spec.factors[j];
      const ftag = `backtestConfig.rankSpec.factors[${j}]`;
      if (!f || typeof f !== 'object') {
        throw new BadRequestException(`${ftag} 非法`);
      }
      if (!VALID_RANK_FACTOR_KEYS.has(f.factor)) {
        throw new BadRequestException(
          `${ftag}.factor 非法：${String(f.factor)}（须为注册表内因子 KEY）`,
        );
      }
      if (typeof f.weight !== 'number' || !(f.weight > 0) || !Number.isFinite(f.weight)) {
        throw new BadRequestException(`${ftag}.weight 须为 > 0 的有限数`);
      }
      if (!VALID_RANK_DIRS.has(f.dir)) {
        throw new BadRequestException(`${ftag}.dir 须为 asc / desc`);
      }
      if (!RANK_FACTOR_REGISTRY[f.factor].histAvailable) {
        this.logger.warn(`${ftag}.factor=${f.factor} 历史不足，仅前向`);
      }
    }
  }

  private validateBacktestSizing(sizing: SignalTestBacktestConfig['sizing']): void {
    if (!sizing || typeof sizing !== 'object') {
      throw new BadRequestException('backtestConfig.sizing 不能为空');
    }
    const stag = 'backtestConfig.sizing';
    if (!VALID_SIZING_MODES.has(sizing.mode)) {
      throw new BadRequestException(
        `${stag}.mode 须为 fixed / signal_weighted / source_kelly`,
      );
    }
    if (sizing.mode === 'signal_weighted') {
      if (
        typeof sizing.floorMult !== 'number' ||
        !(sizing.floorMult > 0) ||
        !Number.isFinite(sizing.floorMult)
      ) {
        throw new BadRequestException(`${stag}.floorMult 须为 > 0 的有限数`);
      }
      if (
        typeof sizing.capMult !== 'number' ||
        !Number.isFinite(sizing.capMult) ||
        sizing.capMult < sizing.floorMult
      ) {
        throw new BadRequestException(`${stag}.capMult 须为 ≥ floorMult 的有限数`);
      }
    }
    if (sizing.mode === 'source_kelly') {
      if (
        typeof sizing.kellyFraction !== 'number' ||
        !(sizing.kellyFraction > 0) ||
        sizing.kellyFraction > 1
      ) {
        throw new BadRequestException(`${stag}.kellyFraction 须在 (0, 1] 区间`);
      }
      if (
        typeof sizing.kellyMaxMult !== 'number' ||
        !(sizing.kellyMaxMult > 0) ||
        !Number.isFinite(sizing.kellyMaxMult)
      ) {
        throw new BadRequestException(`${stag}.kellyMaxMult 须为 > 0 的有限数`);
      }
    }
  }

  private validateBacktestCircuitBreaker(
    cb: SignalTestBacktestConfig['circuitBreaker'],
  ): void {
    if (cb === undefined || cb === null) return;
    const tag = 'backtestConfig.circuitBreaker';
    if (typeof cb !== 'object') {
      throw new BadRequestException(`${tag} 非法`);
    }

    if (cb.enableCooldown) {
      if (
        !Number.isInteger(cb.consecutiveLossesThreshold) ||
        cb.consecutiveLossesThreshold < 1
      ) {
        throw new BadRequestException(
          `${tag}.consecutiveLossesThreshold 须为 ≥1 的整数`,
        );
      }
      if (
        typeof cb.baseCooldownDays !== 'number' ||
        !Number.isFinite(cb.baseCooldownDays) ||
        cb.baseCooldownDays < 0
      ) {
        throw new BadRequestException(`${tag}.baseCooldownDays 须为 ≥0 的有限数`);
      }
      if (
        typeof cb.maxCooldownDays !== 'number' ||
        !Number.isFinite(cb.maxCooldownDays) ||
        cb.maxCooldownDays < cb.baseCooldownDays
      ) {
        throw new BadRequestException(
          `${tag}.maxCooldownDays 须为 ≥ baseCooldownDays 的有限数`,
        );
      }
      if (
        typeof cb.extendOnLoss !== 'number' ||
        !Number.isFinite(cb.extendOnLoss) ||
        cb.extendOnLoss < 0
      ) {
        throw new BadRequestException(`${tag}.extendOnLoss 须为 ≥0 的有限数`);
      }
      if (
        typeof cb.reduceOnProfit !== 'number' ||
        !Number.isFinite(cb.reduceOnProfit) ||
        cb.reduceOnProfit < 0
      ) {
        throw new BadRequestException(`${tag}.reduceOnProfit 须为 ≥0 的有限数`);
      }
    }

    if (cb.enableDrawdownHalt) {
      if (
        typeof cb.drawdownHaltPct !== 'number' ||
        !Number.isFinite(cb.drawdownHaltPct) ||
        !(cb.drawdownHaltPct > 0) ||
        !(cb.drawdownHaltPct < 1)
      ) {
        throw new BadRequestException(`${tag}.drawdownHaltPct 须在 (0, 1) 开区间`);
      }
      if (
        typeof cb.drawdownResumePct !== 'number' ||
        !Number.isFinite(cb.drawdownResumePct) ||
        cb.drawdownResumePct < 0 ||
        cb.drawdownResumePct > cb.drawdownHaltPct
      ) {
        throw new BadRequestException(
          `${tag}.drawdownResumePct 须在 [0, drawdownHaltPct] 区间`,
        );
      }
    }
  }

  /**
   * 校验 trailing_lock 的 band_lock 4 参数（仅在 exitMode='trailing_lock' 分支调用）。
   *   stopRatio:      提供 → 量化后 NNNN∈[1,1000]（ratio∈[0.001,1.0]），否则 400
   *   floorRatio:     提供 → 量化后 NNNN∈[1,9999]（ratio∈[0.001,9.999]，允许锁盈 >1），否则 400
   *   floorEnabled:   提供 → 必须 boolean
   *   ma5RequireDown: 提供 → 必须 boolean
   */
  private validateBandLockParams(dto: CreateSignalTestDto): void {
    const checkRatio = (name: string, v: number | undefined, maxNNNN: number): void => {
      if (v === undefined) return;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new BadRequestException(`${name} 必须为有限数值`);
      }
      const nnnn = Math.floor(v * 1000 + 0.5); // 与核量化对齐（round-half-up）
      if (nnnn < 1 || nnnn > maxNNNN) {
        throw new BadRequestException(
          `${name} 量化后须在 [${(1 / 1000).toFixed(3)}, ${(maxNNNN / 1000).toFixed(3)}] 范围内`,
        );
      }
    };
    checkRatio('stopRatio', dto.stopRatio, 1000);
    checkRatio('floorRatio', dto.floorRatio, 9999);
    if (dto.floorEnabled !== undefined && typeof dto.floorEnabled !== 'boolean') {
      throw new BadRequestException('floorEnabled 必须为布尔值');
    }
    if (dto.ma5RequireDown !== undefined && typeof dto.ma5RequireDown !== 'boolean') {
      throw new BadRequestException('ma5RequireDown 必须为布尔值');
    }
  }

  /**
   * 校验 phase_lock 的 3 参数（仅在 exitMode='phase_lock' 分支调用）。
   *   initFactor: 提供 → 量化后 NNNN∈[1,2000]（ratio∈[0.001,2.0]，允许 >1），否则 400
   *   lockFactor: 提供 → 量化后 NNNN∈[1,2000]（同上），否则 400
   *   lookback:   提供 → 整数且 ∈[1,250]，否则 400
   * 范围依据 spec 02 §参数范围（量化校验）。
   */
  private validatePhaseLockParams(dto: CreateSignalTestDto): void {
    const checkRatio = (name: string, v: number | undefined, maxNNNN: number): void => {
      if (v === undefined) return;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new BadRequestException(`${name} 必须为有限数值`);
      }
      const nnnn = Math.floor(v * 1000 + 0.5); // 与核量化对齐（round-half-up）
      if (nnnn < 1 || nnnn > maxNNNN) {
        throw new BadRequestException(
          `${name} 量化后须在 [${(1 / 1000).toFixed(3)}, ${(maxNNNN / 1000).toFixed(3)}] 范围内`,
        );
      }
    };
    checkRatio('initFactor', dto.initFactor, 2000);
    checkRatio('lockFactor', dto.lockFactor, 2000);
    if (dto.lookback !== undefined) {
      if (typeof dto.lookback !== 'number' || !Number.isInteger(dto.lookback)) {
        throw new BadRequestException('lookback 必须为整数');
      }
      if (dto.lookback < 1 || dto.lookback > 250) {
        throw new BadRequestException('lookback 须在 [1, 250] 范围内');
      }
    }
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
