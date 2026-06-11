/**
 * portfolio-sim.service.ts
 *
 * CRUD（portfolio_sim_run） + 触发 run（per-id 互斥 + 源 run fail-fast 校验） + 查询
 * （进度 / 每日 / fills 分页）。
 *
 * 校验（fail-fast, 400 BadRequestException）：仓内无全局 ValidationPipe，校验集中在 service。
 *   - name 非空 ≤100。
 *   - config.sources 数组 1~5；每源 runId 为 uuid、positionRatio∈(0,1]、maxPositions≥1 或 null、
 *     exposureCap∈(0,1] 或 null、rankField∈{pos_120,circ_mv,none}、rankDir∈{asc,desc}。
 *   - config.initialCapital>0；cost 各费率≥0。
 *   - anchorMode=true 时 sources.length 必须为 1。
 *
 * 触发互斥（per-id）：该 run 自身 status='running' 时再触发 → 409（防重复跑同一方案）。
 * 触发前 fail-fast：各 source.runId 在 signal_test_run 存在、status='completed'、trades>0。
 *   （signal_test_run 的成功态是 'completed'，已落真 DB 核实——非 portfolio 的 'success'。）
 */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { PortfolioSimRunEntity } from '../../entities/strategy/portfolio-sim-run.entity';
import { PortfolioSimDailyEntity } from '../../entities/strategy/portfolio-sim-daily.entity';
import { PortfolioSimFillEntity } from '../../entities/strategy/portfolio-sim-fill.entity';
import { CreatePortfolioSimDto } from './dto/create-portfolio-sim.dto';
import { PortfolioSimRunner } from './portfolio-sim.runner';
import { PortfolioSimConfig } from './portfolio-sim.types';
import {
  ListFillsOptions,
  buildFillListOptions,
  isValidFillSortField,
} from './portfolio-sim.list-fills-options';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_RANK_FIELDS = new Set(['pos_120', 'circ_mv', 'none']);
const VALID_RANK_DIRS = new Set(['asc', 'desc']);

/** 进度查询响应。 */
export interface PortfolioSimProgress {
  status: string;
  phase: string | null;
  progressDone: number;
  progressTotal: number;
  errorMessage: string | null;
}

@Injectable()
export class PortfolioSimService {
  private readonly logger = new Logger(PortfolioSimService.name);

  constructor(
    @InjectRepository(PortfolioSimRunEntity)
    private readonly runRepo: Repository<PortfolioSimRunEntity>,
    @InjectRepository(PortfolioSimDailyEntity)
    private readonly dailyRepo: Repository<PortfolioSimDailyEntity>,
    @InjectRepository(PortfolioSimFillEntity)
    private readonly fillRepo: Repository<PortfolioSimFillEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly runner: PortfolioSimRunner,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  // CRUD
  // ──────────────────────────────────────────────────────────────────────────

  async create(dto: CreatePortfolioSimDto): Promise<PortfolioSimRunEntity> {
    this.validateCreateDto(dto);
    const entity = this.runRepo.create({
      name: dto.name.trim(),
      note: dto.note ?? null,
      config: dto.config as unknown as PortfolioSimRunEntity['config'],
      status: 'pending',
      progressDone: 0,
      progressTotal: 0,
    });
    return this.runRepo.save(entity);
  }

  /** 分页列表（created_at 倒序）。 */
  async findAll(
    page: number,
    pageSize: number,
  ): Promise<{ total: number; items: PortfolioSimRunEntity[] }> {
    const safePage = Math.max(1, page);
    const safeSize = Math.min(Math.max(1, pageSize), 200);
    const [items, total] = await this.runRepo.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (safePage - 1) * safeSize,
      take: safeSize,
    });
    return { total, items };
  }

  async findOne(id: string): Promise<PortfolioSimRunEntity> {
    const entity = await this.runRepo.findOne({ where: { id } });
    if (!entity) throw new NotFoundException(`组合模拟 ${id} 不存在`);
    return entity;
  }

  /** 删除：running 中拒绝（409）；否则删（级联清 daily/fills）。 */
  async remove(id: string): Promise<void> {
    const entity = await this.findOne(id);
    if (entity.status === 'running') {
      throw new ConflictException('该组合模拟正在运行，无法删除，请等待完成或失败后再删');
    }
    await this.runRepo.remove(entity);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 触发 run
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * 触发异步 run：per-id 互斥 + 源 run fail-fast → 置 running → 异步启动 runner → 立即返回。
   */
  async triggerRun(id: string): Promise<{ runId: string }> {
    const run = await this.findOne(id);

    // per-id 互斥：自身已 running → 409。
    if (run.status === 'running') {
      throw new ConflictException('该组合模拟已有运行中的任务，请等待完成后再触发');
    }

    const config = run.config as unknown as PortfolioSimConfig;
    await this.validateSourceRuns(config);

    // 置 running + 清旧终态字段（重跑覆盖语义）。
    await this.runRepo.update(id, {
      status: 'running',
      phase: null,
      progressDone: 0,
      progressTotal: 0,
      errorMessage: null,
      completedAt: null,
    });

    // 异步执行，不等待。
    this.runner.executeRun(id).catch((err: unknown) => {
      this.logger.error(
        `PortfolioSimRunner.executeRun 失败 run=${id}`,
        err instanceof Error ? err.stack : String(err),
      );
    });

    return { runId: id };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 查询
  // ──────────────────────────────────────────────────────────────────────────

  async getProgress(id: string): Promise<PortfolioSimProgress> {
    const run = await this.findOne(id);
    return {
      status: run.status,
      phase: run.phase,
      progressDone: run.progressDone,
      progressTotal: run.progressTotal,
      errorMessage: run.errorMessage,
    };
  }

  /** 全量每日行（trade_date 升序）。 */
  async listDaily(id: string): Promise<PortfolioSimDailyEntity[]> {
    await this.findOne(id);
    return this.dailyRepo.find({
      where: { runId: id },
      order: { tradeDate: 'ASC', id: 'ASC' },
    });
  }

  /** fills 服务端分页 + 筛选 + 排序白名单。 */
  async listFills(
    id: string,
    page: number,
    pageSize: number,
    opts: ListFillsOptions = {},
  ): Promise<{ total: number; items: PortfolioSimFillEntity[] }> {
    await this.findOne(id);

    // 排序白名单拒绝未知列（spec 要求显式拒绝，而非静默回落）。
    if (!isValidFillSortField(opts.sortField)) {
      throw new BadRequestException(`非法排序字段：${opts.sortField}`);
    }

    const safePage = Math.max(1, page);
    const safeSize = Math.min(Math.max(1, pageSize), 500);
    const { where, order } = buildFillListOptions(id, opts);

    const [items, total] = await this.fillRepo.findAndCount({
      where,
      order,
      skip: (safePage - 1) * safeSize,
      take: safeSize,
    });
    return { total, items };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 校验
  // ──────────────────────────────────────────────────────────────────────────

  private validateCreateDto(dto: CreatePortfolioSimDto): void {
    if (!dto.name || dto.name.trim() === '') {
      throw new BadRequestException('name 不能为空');
    }
    if (dto.name.trim().length > 100) {
      throw new BadRequestException('name 不能超过 100 字符');
    }

    const config = dto.config;
    if (!config || typeof config !== 'object') {
      throw new BadRequestException('config 不能为空');
    }

    // sources 1~5
    const sources = config.sources;
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > 5) {
      throw new BadRequestException('config.sources 数组长度须为 1~5');
    }

    const labels = new Set<string>();
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      const tag = `config.sources[${i}]`;
      if (!src || typeof src !== 'object') {
        throw new BadRequestException(`${tag} 非法`);
      }
      if (!src.runId || !UUID_RE.test(src.runId)) {
        throw new BadRequestException(`${tag}.runId 须为合法 uuid`);
      }
      if (!src.label || String(src.label).trim() === '') {
        throw new BadRequestException(`${tag}.label 不能为空`);
      }
      if (labels.has(src.label)) {
        throw new BadRequestException(`${tag}.label 重复：${src.label}（须组内唯一）`);
      }
      labels.add(src.label);
      if (
        typeof src.positionRatio !== 'number' ||
        !(src.positionRatio > 0) ||
        src.positionRatio > 1
      ) {
        throw new BadRequestException(`${tag}.positionRatio 须在 (0, 1] 区间`);
      }
      if (
        src.maxPositions !== null &&
        (!Number.isInteger(src.maxPositions) || src.maxPositions < 1)
      ) {
        throw new BadRequestException(`${tag}.maxPositions 须为 ≥1 的整数或 null`);
      }
      if (
        src.exposureCap !== null &&
        (typeof src.exposureCap !== 'number' || !(src.exposureCap > 0) || src.exposureCap > 1)
      ) {
        throw new BadRequestException(`${tag}.exposureCap 须在 (0, 1] 区间或 null`);
      }
      if (!VALID_RANK_FIELDS.has(src.rankField)) {
        throw new BadRequestException(`${tag}.rankField 须为 pos_120 / circ_mv / none`);
      }
      if (!VALID_RANK_DIRS.has(src.rankDir)) {
        throw new BadRequestException(`${tag}.rankDir 须为 asc / desc`);
      }
    }

    // initialCapital > 0
    if (typeof config.initialCapital !== 'number' || !(config.initialCapital > 0)) {
      throw new BadRequestException('config.initialCapital 须 > 0');
    }

    // cost 各费率 ≥ 0
    const cost = config.cost;
    if (!cost || typeof cost !== 'object') {
      throw new BadRequestException('config.cost 不能为空');
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
        throw new BadRequestException(`config.cost.${String(k)} 须为 ≥0 的有限数`);
      }
    }

    // anchorMode
    if (typeof config.anchorMode !== 'boolean') {
      throw new BadRequestException('config.anchorMode 须为布尔值');
    }
    if (config.anchorMode && sources.length !== 1) {
      throw new BadRequestException('anchorMode=true 时 config.sources 必须恰为 1 个源');
    }
  }

  /**
   * 触发前校验各源 run：存在 + status='completed' + trades>0。
   * 任一不满足 → 400（中文，标明 runId）。
   */
  private async validateSourceRuns(config: PortfolioSimConfig): Promise<void> {
    for (let i = 0; i < config.sources.length; i++) {
      const { runId, label } = config.sources[i];
      const tag = `信号源 #${i}（label=${label}, runId=${runId}）`;

      const runRows = await this.dataSource.query<Array<{ status: string }>>(
        `SELECT status FROM signal_test_run WHERE id = $1`,
        [runId],
      );
      if (runRows.length === 0) {
        throw new BadRequestException(`${tag}：signal_test_run 不存在`);
      }
      if (runRows[0].status !== 'completed') {
        throw new BadRequestException(
          `${tag}：run 状态为 ${runRows[0].status}，须为 completed 才能纳入组合`,
        );
      }

      const cntRows = await this.dataSource.query<Array<{ cnt: string }>>(
        `SELECT count(*) AS cnt FROM signal_test_trade WHERE run_id = $1`,
        [runId],
      );
      const cnt = parseInt(cntRows[0]?.cnt ?? '0', 10);
      if (cnt <= 0) {
        throw new BadRequestException(`${tag}：该 run 无逐笔交易（trades=0），无法纳入组合`);
      }
    }
  }
}
