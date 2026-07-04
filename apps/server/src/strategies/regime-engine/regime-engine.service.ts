/**
 * regime-engine.service.ts
 *
 * 每日 0AMV 象限识别 + 按 active 配置生成选股清单。
 *
 * 设计基准：docs/superpowers/specs/2026-06-10-0amv-regime-strategy-design/03-automation-design.md
 *
 * 要点：
 *   - 象限口径走 classifyRegime 纯函数（与研究侧离线 SQL 一致）。
 *   - oamv 缺行 / 指标列 NULL → fail-closed：落 unknown 记录、不扫描（黄牌）。
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
import { OamvDailyEntity } from '../../entities/oamv/oamv-daily.entity';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { StrategyConditionItem } from '../../entities/strategy/strategy-condition.entity';
import { StrategyConditionsQueryBuilder } from '../../strategy-conditions/strategy-conditions.query-builder';
import { buildEnumerateQuery } from '../../strategy-conditions/strategy-conditions.enumerator';
import { classifyRegime, RegimeResult } from './regime.classifier';
import { validateRegimeConfig } from './regime-engine.validation';
import {
  CreateRegimeConfigDto,
  RegimeTodaySummary,
  RunDailyResult,
  UpdateRegimeConfigDto,
} from './regime-engine.types';

const TRADE_DATE_RE = /^\d{8}$/;

@Injectable()
export class RegimeEngineService {
  private readonly logger = new Logger(RegimeEngineService.name);

  constructor(
    @InjectRepository(RegimeStrategyConfigEntity)
    private readonly configRepo: Repository<RegimeStrategyConfigEntity>,
    @InjectRepository(RegimeDailyPickEntity)
    private readonly pickRepo: Repository<RegimeDailyPickEntity>,
    @InjectRepository(OamvDailyEntity)
    private readonly oamvRepo: Repository<OamvDailyEntity>,
    @InjectRepository(AShareSymbolEntity)
    private readonly symbolRepo: Repository<AShareSymbolEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly queryBuilder: StrategyConditionsQueryBuilder,
  ) {}

  // ── 每日流水线 ────────────────────────────────────────────────────────────

  /**
   * 跑指定交易日（缺省=最新 oamv 日）的象限识别 + 选股，结果按日全删重建落
   * regime_daily_pick。
   */
  async runDaily(tradeDateInput?: string): Promise<RunDailyResult> {
    const tradeDate = await this.resolveTradeDate(tradeDateInput);

    const oamvRow = await this.oamvRepo.findOne({ where: { tradeDate } });
    const regime: RegimeResult = oamvRow
      ? classifyRegime(oamvRow.amvDif, oamvRow.amvMacd)
      : 'unknown';
    const active = await this.findActiveConfig();

    // fail-closed：缺行或指标列 NULL → unknown，不扫描，落一条 unknown 记录
    if (regime === 'unknown') {
      this.logger.warn(
        `[regime-engine] tradeDate=${tradeDate} oamv_daily ${
          oamvRow ? 'MACD 指标列为 NULL' : '缺行'
        }，regime=unknown，fail-closed 不扫描`,
      );
      const configVersion = active ? active.version : null;
      await this.replaceDayPicks(tradeDate, [
        this.buildMarkerRecord(tradeDate, 'unknown', 'unknown', configVersion, null),
      ]);
      return { tradeDate, regime, action: 'unknown', configVersion, pickCount: 0 };
    }

    if (!active) {
      throw new ConflictException('无生效配置，请先激活');
    }

    const entry = active.config ? active.config[regime] : undefined;
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

  /** 最新 oamv 日的象限 + active 配置摘要 + 该日清单（只读视图，无 active 不抛 409）。 */
  async getToday(): Promise<RegimeTodaySummary> {
    const [latest] = await this.oamvRepo.find({
      order: { tradeDate: 'DESC' },
      take: 1,
    });
    if (!latest) {
      return { tradeDate: null, regime: 'unknown', oamv: null, activeConfig: null, picks: [] };
    }

    const regime = classifyRegime(latest.amvDif, latest.amvMacd);
    const active = await this.findActiveConfig();
    const entry: RegimeConfigEntry | null =
      active && regime !== 'unknown' ? active.config?.[regime] ?? null : null;
    const picks = await this.pickRepo.find({
      where: { tradeDate: latest.tradeDate },
      order: { tsCode: 'ASC' },
    });

    return {
      tradeDate: latest.tradeDate,
      regime,
      oamv: {
        close: Number(latest.close),
        amvDif: latest.amvDif,
        amvDea: latest.amvDea,
        amvMacd: latest.amvMacd,
      },
      activeConfig: active
        ? { id: active.id, version: active.version, note: active.note, entry }
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
    const [latest] = await this.oamvRepo.find({
      order: { tradeDate: 'DESC' },
      take: 1,
    });
    if (!latest) {
      throw new ConflictException('oamv_daily 无数据，无法确定最新交易日，请先同步 0AMV');
    }
    return latest.tradeDate;
  }

  private async findActiveConfig(): Promise<RegimeStrategyConfigEntity | null> {
    return this.configRepo.findOne({ where: { status: 'active' } });
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
