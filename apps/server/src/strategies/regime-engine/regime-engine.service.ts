/**
 * regime-engine.service.ts
 *
 * 每日指数分桶象限识别 + 按 active 配置生成选股清单。
 *
 * 设计基准：docs/superpowers/specs/2026-06-10-0amv-regime-strategy-design/03-automation-design.md
 *
 * 要点：
 *   - 象限口径走 classifyRegime 纯函数（与研究侧离线 SQL 一致）。
 *   - 仅支持 type='index' 分桶条件；含 type='stock' 或数据缺行 → fail-closed。
 *   - 扫描复用 strategy-conditions 查询构建器 + signal-stats 单日枚举 SQL，
 *     不复制查询构建逻辑。
 *   - 幂等：同 trade_date 重跑按日全删重建（含 NULL 版本行），删插同一事务。
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import {
  RegimeConfigEntry,
  RegimeConfigMap,
  RegimeStrategyConfigEntity,
} from '../../entities/strategy/regime-strategy-config.entity';
import { RegimeDailyPickEntity } from '../../entities/strategy/regime-daily-pick.entity';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity';
import { IndexDailyIndicatorEntity } from '../../entities/index-daily/index-daily-indicator.entity';
import { StrategyConditionItem } from '../../entities/strategy/strategy-condition.entity';
import { StrategyConditionsQueryBuilder } from '../../strategy-conditions/strategy-conditions.query-builder';
import { buildEnumerateQuery } from '../../strategy-conditions/strategy-conditions.enumerator';
import { classifyRegime, isSingleWildcardQuadrant, RegimeResult } from './regime.classifier';
import { validateRegimeConfig } from './regime-engine.validation';
import {
  CreateRegimeConfigDto,
  RegimeTodaySummary,
  RunDailyResult,
  UpdateRegimeConfigDto,
} from './regime-engine.types';
import {
  MarketSnapshot,
  TargetSnapshot,
} from './market-condition-evaluator';

const TRADE_DATE_RE = /^\d{8}$/;

@Injectable()
export class RegimeEngineService {
  private readonly logger = new Logger(RegimeEngineService.name);

  constructor(
    @InjectRepository(RegimeStrategyConfigEntity)
    private readonly configRepo: Repository<RegimeStrategyConfigEntity>,
    @InjectRepository(RegimeDailyPickEntity)
    private readonly pickRepo: Repository<RegimeDailyPickEntity>,
    @InjectRepository(AShareSymbolEntity)
    private readonly symbolRepo: Repository<AShareSymbolEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly queryBuilder: StrategyConditionsQueryBuilder,
  ) {}

  // ── 每日流水线 ────────────────────────────────────────────────────────────

  /**
   * 跑指定交易日（缺省=最新指数交易日）的象限识别 + 选股，结果按日全删重建落
   * regime_daily_pick。
   */
  async runDaily(tradeDateInput?: string): Promise<RunDailyResult> {
    const tradeDate = await this.resolveTradeDate(tradeDateInput);

    const active = await this.findActiveConfig();
    if (!active) {
      throw new ConflictException('无生效配置，请先激活');
    }

    const snapshot = await this.buildMarketSnapshot(tradeDate, active.config);
    const regime: RegimeResult = snapshot
      ? classifyRegime(snapshot, active.config.quadrants)
      : 'unknown';

    // fail-closed：snapshot 不完整 → unknown，不扫描，落一条 unknown 记录
    if (regime === 'unknown') {
      this.logger.warn(
        `[regime-engine] tradeDate=${tradeDate} 大盘 snapshot 不完整或分桶条件不满足，regime=unknown，fail-closed 不扫描`,
      );
      await this.replaceDayPicks(tradeDate, [
        this.buildMarkerRecord(tradeDate, 'unknown', 'unknown', active.version, null),
      ]);
      return {
        tradeDate,
        regime,
        action: 'unknown',
        configVersion: active.version,
        pickCount: 0,
      };
    }

    const entry = active.config.quadrants.find((q) => q.key === regime);
    if (!entry || (entry.action !== 'trade' && entry.action !== 'flat')) {
      // createConfig 已做 fail-fast 校验，此处兜底拦截绕过校验落库的脏数据
      throw new ConflictException(`配置 v${active.version} 缺少象限 ${regime} 的合法条目`);
    }

    if (entry.action === 'flat') {
      await this.replaceDayPicks(tradeDate, [
        this.buildMarkerRecord(tradeDate, regime, 'flat', active.version, entryLabel(entry)),
      ]);
      return {
        tradeDate,
        regime,
        action: 'flat',
        configVersion: active.version,
        pickCount: 0,
      };
    }

    // trade：当日条件扫描（读在事务外，删插在事务内）
    const conditions = entry.entryConditions;
    if (!Array.isArray(conditions) || conditions.length === 0) {
      // 防御：空条件经 buildAShareQuery 会退化为 TRUE 全市场扫描，宁断不滥
      throw new ConflictException(
        `配置 v${active.version} 象限 ${regime} 的 entryConditions 为空，拒绝全市场扫描`,
      );
    }

    const hits = await this.scanEntryConditions(tradeDate, conditions);
    const nameMap = await this.loadNames(hits.map((h) => h.tsCode));
    const records: Array<Partial<RegimeDailyPickEntity>> = hits.map((h) => ({
      tradeDate,
      regime,
      action: 'trade' as const,
      configVersion: active.version,
      tsCode: h.tsCode,
      name: nameMap.get(h.tsCode) ?? null,
      snapshot: { close: h.close },
    }));
    await this.replaceDayPicks(tradeDate, records);

    return {
      tradeDate,
      regime,
      action: 'trade',
      configVersion: active.version,
      pickCount: records.length,
    };
  }

  // ── 查询 ──────────────────────────────────────────────────────────────────

  /** 最新指数交易日的象限 + active 配置摘要 + 该日清单（只读视图，无 active 不抛 409）。 */
  async getToday(): Promise<RegimeTodaySummary> {
    let tradeDate: string | null = null;
    try {
      tradeDate = await this.resolveTradeDate();
    } catch {
      return { tradeDate: null, regime: 'unknown', activeConfig: null, picks: [] };
    }

    const active = await this.findActiveConfig();
    const snapshot = active
      ? await this.buildMarketSnapshot(tradeDate, active.config)
      : null;
    const regime: RegimeResult =
      snapshot && active ? classifyRegime(snapshot, active.config.quadrants) : 'unknown';
    const entryIndex =
      active && regime !== 'unknown'
        ? active.config.quadrants.findIndex((q) => q.key === regime)
        : null;
    const entry: RegimeConfigEntry | null =
      active && regime !== 'unknown'
        ? active.config.quadrants.find((q) => q.key === regime) ?? null
        : null;
    const picks = await this.pickRepo.find({
      where: { tradeDate },
      order: { tsCode: 'ASC' },
    });

    return {
      tradeDate,
      regime,
      activeConfig: active
        ? { id: active.id, version: active.version, note: active.note, entryIndex, entry }
        : null,
      picks,
    };
  }

  /** 指定日全部记录（含 flat/unknown 行）。 */
  async getPicks(tradeDate: string): Promise<RegimeDailyPickEntity[]> {
    if (!TRADE_DATE_RE.test(tradeDate ?? '')) {
      throw new BadRequestException('tradeDate 必填且须为 YYYYMMDD 格式');
    }
    return this.pickRepo.find({
      where: { tradeDate },
      order: { tsCode: 'ASC' },
    });
  }

  // ── 配置管理 ──────────────────────────────────────────────────────────────

  async listConfigs(): Promise<RegimeStrategyConfigEntity[]> {
    return this.configRepo.find({ order: { version: 'DESC' } });
  }

  /** 新建 draft 配置（fail-fast 校验；version 缺省自动 max+1）。 */
  async createConfig(dto: CreateRegimeConfigDto): Promise<RegimeStrategyConfigEntity> {
    validateRegimeConfig(dto?.config);

    let version = dto.version;
    if (version !== undefined && version !== null) {
      if (!Number.isInteger(version) || version <= 0) {
        throw new BadRequestException('version 须为正整数');
      }
      const dup = await this.configRepo.findOne({ where: { version } });
      if (dup) {
        throw new ConflictException(`版本 ${version} 已存在`);
      }
    } else {
      const [latest] = await this.configRepo.find({
        order: { version: 'DESC' },
        take: 1,
      });
      version = (latest?.version ?? 0) + 1;
    }

    const entity = this.configRepo.create({
      version,
      status: 'draft',
      note: dto.note ?? null,
      config: dto.config,
    });
    return this.configRepo.save(entity);
  }

  /** 激活配置：事务内原 active → archived、目标 → active（目标已 active 则幂等返回）。 */
  async activateConfig(id: string): Promise<RegimeStrategyConfigEntity> {
    return this.dataSource.transaction(async (manager) => {
      const target = await manager.findOne(RegimeStrategyConfigEntity, {
        where: { id },
      });
      if (!target) {
        throw new NotFoundException(`配置 ${id} 不存在`);
      }
      if (target.status === 'active') {
        return target;
      }
      await manager.update(
        RegimeStrategyConfigEntity,
        { status: 'active' },
        { status: 'archived' },
      );
      await manager.update(RegimeStrategyConfigEntity, { id }, { status: 'active' });
      target.status = 'active';
      return target;
    });
  }

  /** 更新 draft 配置（仅 draft 状态可更新；config 传入时做 fail-fast 校验）。 */
  async updateConfig(id: string, dto: UpdateRegimeConfigDto): Promise<RegimeStrategyConfigEntity> {
    const entity = await this.configRepo.findOne({ where: { id } });
    if (!entity) {
      throw new NotFoundException(`配置 ${id} 不存在`);
    }
    if (entity.status !== 'draft') {
      throw new ConflictException(`仅 draft 状态可编辑，当前状态为 ${entity.status}`);
    }

    if (dto.config !== undefined) {
      validateRegimeConfig(dto.config);
      entity.config = dto.config as RegimeConfigMap;
    }
    if (dto.version !== undefined && dto.version !== null) {
      if (!Number.isInteger(dto.version) || dto.version <= 0) {
        throw new BadRequestException('version 须为正整数');
      }
      if (dto.version !== entity.version) {
        const dup = await this.configRepo.findOne({ where: { version: dto.version } });
        if (dup) {
          throw new ConflictException(`版本 ${dto.version} 已存在`);
        }
        entity.version = dto.version;
      }
    }
    if (dto.note !== undefined) {
      entity.note = dto.note ?? null;
    }

    return this.configRepo.save(entity);
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private async resolveTradeDate(input?: string): Promise<string> {
    if (input !== undefined && input !== null && input !== '') {
      if (!TRADE_DATE_RE.test(input)) {
        throw new BadRequestException(`tradeDate 须为 YYYYMMDD 格式（收到 "${input}"）`);
      }
      return input;
    }
    const row = await this.dataSource
      .createQueryBuilder()
      .select('MAX(q.trade_date)', 'latestDate')
      .from(IndexDailyQuoteEntity, 'q')
      .getRawOne<{ latestDate: string | null }>();
    if (!row?.latestDate) {
      throw new ConflictException('index_daily_quotes 无数据，无法确定最新交易日，请先同步指数日线');
    }
    return row.latestDate;
  }

  private async findActiveConfig(): Promise<RegimeStrategyConfigEntity | null> {
    return this.configRepo.findOne({ where: { status: 'active' } });
  }

  /**
   * 构造每日大盘 snapshot：按配置 quadrants[].match 动态加载目标指数。
   * - 仅支持 type='index' 分桶条件；含 type='stock' 直接返回 null。
   * - 缺目标 / 缺行 → 仍返回 snapshot，由 evaluator fail-closed。
   */
  private async buildMarketSnapshot(
    tradeDate: string,
    config: RegimeConfigMap,
  ): Promise<MarketSnapshot | null> {
    // 单象限空 match（通配）：无需加载任何大盘数据，返回最小 snapshot，由 classifyRegime 通配命中。
    if (isSingleWildcardQuadrant(config.quadrants)) {
      return { date: tradeDate, targets: new Map() };
    }

    const indexTargets = new Set<string>();
    let hasStockBucket = false;
    for (const q of config.quadrants ?? []) {
      for (const cond of q.match ?? []) {
        if (cond.type === 'stock') {
          hasStockBucket = true;
        } else if (cond.type === 'index' && cond.target) {
          indexTargets.add(cond.target);
        }
      }
    }

    if (hasStockBucket) {
      this.logger.warn(
        `[regime-engine] tradeDate=${tradeDate} 配置含 type='stock' 分桶条件，当前每日流水线仅支持指数分桶，fail-closed`,
      );
      return null;
    }

    const targets = [...indexTargets];
    if (targets.length === 0) {
      this.logger.warn(
        `[regime-engine] tradeDate=${tradeDate} 未配置 type='index' 分桶目标，无法构造 snapshot`,
      );
      return null;
    }

    const indexQuoteRepo = this.dataSource.getRepository(IndexDailyQuoteEntity);
    const indexIndicatorRepo = this.dataSource.getRepository(IndexDailyIndicatorEntity);

    const [quoteRows, indicatorRows, prevDateRow] = await Promise.all([
      indexQuoteRepo
        .createQueryBuilder('q')
        .where('q.tradeDate = :tradeDate AND q.tsCode IN (:...targets)', { tradeDate, targets })
        .getMany(),
      indexIndicatorRepo
        .createQueryBuilder('i')
        .where('i.tradeDate = :tradeDate AND i.tsCode IN (:...targets)', { tradeDate, targets })
        .getMany(),
      this.dataSource
        .createQueryBuilder()
        .select('MAX(q.trade_date)', 'prevDate')
        .from(IndexDailyQuoteEntity, 'q')
        .where('q.trade_date < :tradeDate', { tradeDate })
        .getRawOne<{ prevDate: string | null }>(),
    ]);

    const quoteMap = new Map(quoteRows.map((r) => [r.tsCode, r]));
    const indicatorMap = new Map(indicatorRows.map((r) => [r.tsCode, r]));
    const targetSnapshots = new Map<string, TargetSnapshot>();
    for (const tsCode of targets) {
      targetSnapshots.set(tsCode, this.buildTargetSnapshot(quoteMap.get(tsCode), indicatorMap.get(tsCode)));
    }

    const prevDate = prevDateRow?.prevDate ?? undefined;
    let prevTargets: Map<string, TargetSnapshot> | undefined;
    if (prevDate) {
      const [prevQuoteRows, prevIndicatorRows] = await Promise.all([
        indexQuoteRepo
          .createQueryBuilder('q')
          .where('q.tradeDate = :prevDate AND q.tsCode IN (:...targets)', { prevDate, targets })
          .getMany(),
        indexIndicatorRepo
          .createQueryBuilder('i')
          .where('i.tradeDate = :prevDate AND i.tsCode IN (:...targets)', { prevDate, targets })
          .getMany(),
      ]);
      const prevQuoteMap = new Map(prevQuoteRows.map((r) => [r.tsCode, r]));
      const prevIndicatorMap = new Map(prevIndicatorRows.map((r) => [r.tsCode, r]));
      prevTargets = new Map<string, TargetSnapshot>();
      for (const tsCode of targets) {
        prevTargets.set(tsCode, this.buildTargetSnapshot(prevQuoteMap.get(tsCode), prevIndicatorMap.get(tsCode)));
      }
    }

    return { date: tradeDate, targets: targetSnapshots, prevDate, prevTargets };
  }

  private buildTargetSnapshot(
    q: IndexDailyQuoteEntity | undefined,
    i: IndexDailyIndicatorEntity | undefined,
  ): TargetSnapshot {
    return {
      quote: {
        open: q?.open ?? null,
        high: q?.high ?? null,
        low: q?.low ?? null,
        close: q?.close ?? null,
        pre_close: q?.preClose ?? null,
        change: q?.change ?? null,
        pct_change: q?.pctChange ?? null,
        vol_hand: q?.volHand ?? null,
        amount: q?.amount ?? null,
      },
      indicator: {
        ma5: i?.ma5 ?? null,
        ma30: i?.ma30 ?? null,
        ma60: i?.ma60 ?? null,
        ma120: i?.ma120 ?? null,
        ma240: i?.ma240 ?? null,
        dif: i?.dif ?? null,
        dea: i?.dea ?? null,
        macd: i?.macd ?? null,
        kdj_k: i?.kdjK ?? null,
        kdj_d: i?.kdjD ?? null,
        kdj_j: i?.kdjJ ?? null,
        bbi: i?.bbi ?? null,
        brick: i?.brick ?? null,
        brick_delta: i?.brickDelta ?? null,
        brick_xg: i?.brickXg ?? null,
      },
    };
  }

  /**
   * 单日条件扫描：复用 buildAShareQuery（WHERE 翻译）+ buildEnumerateQuery
   * （signal-stats 单日枚举 SQL：主锚 raw.daily_indicator i + LEFT JOIN
   * daily_quote/daily_basic/stock_amv_daily/signal_rolling_indicator，
   * 锚定 i.trade_date=$N），再批量补当日收盘价做 snapshot。
   */
  private async scanEntryConditions(
    tradeDate: string,
    conditions: StrategyConditionItem[],
  ): Promise<Array<{ tsCode: string; close: number | null }>> {
    const where = this.queryBuilder.buildAShareQuery(conditions);
    const { sql, params } = buildEnumerateQuery(where, tradeDate, { type: 'all' });
    const rows = await this.dataSource.query<Array<{ tsCode: string }>>(sql, params);
    const codes = rows.map((r) => r.tsCode);
    if (codes.length === 0) return [];

    const closeRows = await this.dataSource.query<
      Array<{ tsCode: string; close: string | null }>
    >(
      `SELECT ts_code AS "tsCode", close
         FROM raw.daily_quote
        WHERE trade_date = $1 AND ts_code = ANY($2::text[])`,
      [tradeDate, codes],
    );
    const closeMap = new Map(
      closeRows.map((r) => [r.tsCode, r.close === null ? null : Number(r.close)]),
    );
    return codes.map((tsCode) => ({ tsCode, close: closeMap.get(tsCode) ?? null }));
  }

  /** 名称注入：同批标的去重后批量查 a_share_symbols（沿用 signal-stats 明细表做法）。 */
  private async loadNames(codes: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(codes)];
    if (unique.length === 0) return new Map();
    const rows = await this.symbolRepo.find({
      where: { tsCode: In(unique) },
      select: { tsCode: true, name: true },
    });
    return new Map(rows.map((r) => [r.tsCode, r.name]));
  }

  /** flat/unknown 单行标记记录（ts_code null；防重完全由按日删插语义保证）。 */
  private buildMarkerRecord(
    tradeDate: string,
    regime: RegimeResult,
    action: 'flat' | 'unknown',
    configVersion: number | null,
    label: string | null,
  ): Partial<RegimeDailyPickEntity> {
    return {
      tradeDate,
      regime,
      action,
      configVersion,
      tsCode: null,
      name: null,
      snapshot: label ? { label } : null,
    };
  }

  /** 幂等落库：按日全删重建（含 NULL 版本行），删插同一事务。 */
  private async replaceDayPicks(
    tradeDate: string,
    records: Array<Partial<RegimeDailyPickEntity>>,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(RegimeDailyPickEntity, { tradeDate });
      if (records.length > 0) {
        await manager.insert(RegimeDailyPickEntity, records);
      }
    });
  }
}

function entryLabel(entry: RegimeConfigEntry): string | null {
  return typeof entry.label === 'string' && entry.label !== '' ? entry.label : null;
}
