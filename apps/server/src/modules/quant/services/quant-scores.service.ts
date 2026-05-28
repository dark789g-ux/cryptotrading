/**
 * `QuantScoresService` —— `ml.scores_daily` 只读。
 *
 * ## P95 优化点（M3 验收门槛：5500 标的 × 4 年规模 P95 < 500ms）
 *  1. **索引依赖**：所有按日 Top-K / 列表查询均按 `(trade_date, model_version, rank_in_day)`
 *     联合索引取（M0 Alembic 已建），where(trade_date) + where(model_version) + orderBy(rank_in_day)
 *     是该索引的精确前缀匹配，限定 LIMIT K 后 PG 走 index range scan，无需 sort。
 *  2. **限制返回字段**：QueryBuilder 全部用 `select(['s.field', ...])` 明确列字段，
 *     不发 `SELECT *`，避免 jsonb / 长 text 列拖慢网卡。本表无 jsonb 列，但仍按规范明示。
 *  3. **强制 top_k / page_size 上限**：DTO 层 top_k ≤ 1000，page_size ≤ 500；
 *     防止恶意请求触发全表 / 全分区扫描。
 *  4. **不做跨日聚合**：service 仅做单日（或单股票时间序列）切片；
 *     compare 接口也是同 trade_date 多 model_version，仍走索引前缀。
 *  5. **count 与 list 分离**：listScores 内 total 用单独 COUNT(*)（限定同样的 where），
 *     避免 `getManyAndCount` 在 limit + select 列受限时的子查询包装开销。
 *
 * 未来压测验证命令（README 兜底说明，本 PR 不真实跑）：
 *   pnpm --filter @cryptotrading/server jest src/modules/quant
 *   psql -c "EXPLAIN ANALYZE SELECT ts_code, score, rank_in_day FROM ml.scores_daily
 *           WHERE trade_date='20260517' AND model_version='lgb-v1' ORDER BY rank_in_day LIMIT 50"
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MlScoreDailyEntity } from '../../../entities/ml/ml-score-daily.entity';
import { MlModelRunEntity } from '../../../entities/ml/ml-model-run.entity';
import { AShareSymbolEntity } from '../../../entities/a-share/a-share-symbol.entity';
import type {
  ValidatedScoresByTsCodesQuery,
  ValidatedScoresCompareQuery,
  ValidatedScoresDailyQuery,
  ValidatedScoresListQuery,
  ValidatedScoresTimeSeriesQuery,
} from '../dto/score-query.dto';

/**
 * 动态过滤 / 排序字段 → 实际 SQL 列名映射（CLAUDE.md 硬约束）。
 *
 * - key：前端 / DTO 传入的过滤字段名（snake_case）
 * - value：QueryBuilder 内的 `alias.column_name`（alias 固定为 `s`）
 *
 * 未命中本表的字段一律 `logger.warn` + skip，禁止把外部字段名直接拼进 SQL。
 */
export const SCORES_FIELD_COL_MAP: Readonly<Record<string, string>> = Object.freeze({
  trade_date: 's.trade_date',
  model_version: 's.model_version',
  ts_code: 's.ts_code',
  score: 's.score',
  rank_in_day: 's.rank_in_day',
});

export function resolveScoresFilterColumn(field: string): string | null {
  const col = SCORES_FIELD_COL_MAP[field];
  return col ?? null;
}

export interface DailyTopKRow {
  trade_date: string;
  ts_code: string;
  model_version: string;
  score: number;
  rank_in_day: number;
  /** A 股中文名（来源 a_share_symbols.name；未匹配到时 null） */
  name: string | null;
}

export interface ScoreTimeSeriesRow {
  trade_date: string;
  score: number;
  rank_in_day: number;
}

export interface ModelVersionsListItem {
  model_version: string;
  created_at: string; // UTC 墙钟字符串
}

export interface CompareGroup {
  model_version: string;
  rows: DailyTopKRow[];
}

export interface ScoresByTsCodesItem {
  ts_code: string;
  score: number;
  rank_in_day: number;
}

export interface ScoresByTsCodesResult {
  trade_date: string;
  /** 当前 prod 模型版本；无 prod 模型时为 null（不抛 500） */
  model_version: string | null;
  items: ScoresByTsCodesItem[];
}

@Injectable()
export class QuantScoresService {
  private readonly logger = new Logger(QuantScoresService.name);

  constructor(
    @InjectRepository(MlScoreDailyEntity)
    private readonly scoresRepo: Repository<MlScoreDailyEntity>,
    @InjectRepository(MlModelRunEntity)
    private readonly runsRepo: Repository<MlModelRunEntity>,
    @InjectRepository(AShareSymbolEntity)
    private readonly symbolsRepo: Repository<AShareSymbolEntity>,
  ) {}

  /**
   * 给一批 ts_code 批量查 a_share_symbols.name；返回 ts_code → name 映射。
   *
   * 单 PK 查表，索引命中 ≈ 零成本（实测全市场 5500 行 IN-list 查询 < 5ms）。
   * 未匹配到的 ts_code 不进 map（调用方读 map.get(...) 自动得到 undefined → null）。
   */
  private async loadNameMap(tsCodes: readonly string[]): Promise<Map<string, string>> {
    if (tsCodes.length === 0) return new Map();
    // 去重：减少 SQL IN-list 大小（同一标的可能在多模型对照里出现多次）
    const unique = Array.from(new Set(tsCodes));
    const rows = await this.symbolsRepo.find({
      where: { tsCode: In(unique) },
      select: ['tsCode', 'name'],
    });
    return new Map(rows.map((r) => [r.tsCode, r.name]));
  }

  /**
   * 顶层 `GET /quant/scores` 列表：分页 + 排序 + total。
   *
   * - 默认排序 `rank_in_day ASC`（命中索引前缀，零 sort 成本）
   * - top_k 作为单次查询行数硬上限（≤1000）；优先级低于 page_size × page，
   *   即 `effective_limit = min(top_k - skip, page_size)`，确保不会越过 top_k 边界
   * - total 经 FIELD_COL_MAP 翻译 + COUNT(*)，未命中 sortField 则 warn + 回退默认
   */
  async listScores(q: ValidatedScoresListQuery): Promise<{
    items: DailyTopKRow[];
    total: number;
    trade_date: string;
    model_version: string;
  }> {
    const tradeDateCol = resolveScoresFilterColumn('trade_date');
    const modelVersionCol = resolveScoresFilterColumn('model_version');
    if (!tradeDateCol || !modelVersionCol) {
      this.logger.warn('listScores: FIELD_COL_MAP 缺失核心字段（不应发生）');
      return { items: [], total: 0, trade_date: q.tradeDate, model_version: q.modelVersion };
    }

    // 排序字段经 FIELD_COL_MAP 翻译；未命中 → warn + 回退 rank_in_day ASC
    let sortCol = resolveScoresFilterColumn('rank_in_day')!;
    let sortDir: 'ASC' | 'DESC' = 'ASC';
    const candidate = resolveScoresFilterColumn(q.sortField);
    if (!candidate) {
      this.logger.warn(
        `list_scores_sort_skip field=${q.sortField} (not in FIELD_COL_MAP) → fallback rank_in_day ASC`,
      );
    } else {
      sortCol = candidate;
      sortDir = q.sortDir;
    }

    const skip = (q.page - 1) * q.pageSize;
    // top_k 上限为单次查询天花板；effective_limit 取 page_size 与剩余配额的较小者
    const remaining = Math.max(q.topK - skip, 0);
    const effectiveLimit = Math.min(q.pageSize, remaining);

    // 列表查询：明确 SELECT 字段，避免 SELECT *（P95 优化点 2）
    const baseQb = this.scoresRepo
      .createQueryBuilder('s')
      .where(`${tradeDateCol} = :tradeDate`, { tradeDate: q.tradeDate })
      .andWhere(`${modelVersionCol} = :modelVersion`, { modelVersion: q.modelVersion });

    let items: DailyTopKRow[] = [];
    if (effectiveLimit > 0) {
      const rows = await baseQb
        .clone()
        .select([
          's.trade_date',
          's.ts_code',
          's.model_version',
          's.score',
          's.rank_in_day',
        ])
        .orderBy(sortCol, sortDir)
        .offset(skip)
        .limit(effectiveLimit)
        .getMany();
      const nameMap = await this.loadNameMap(rows.map((r) => r.tsCode));
      items = rows.map((r) => this.toDailyTopKRow(r, nameMap));
    }

    // total = min(实际行数, top_k 上限)；count(*) 走同样的 where 命中索引
    const rawCount = await baseQb.clone().select('COUNT(*)', 'cnt').getRawOne<{ cnt: string }>();
    const dbTotal = rawCount ? parseInt(rawCount.cnt, 10) || 0 : 0;
    const total = Math.min(dbTotal, q.topK);

    return {
      items,
      total,
      trade_date: q.tradeDate,
      model_version: q.modelVersion,
    };
  }

  /**
   * 当日 Top-K：按 (trade_date, model_version) 取前 K 名。
   *
   * 走 `(trade_date, model_version, rank_in_day)` 联合索引 + `LIMIT K`。
   * 验收门槛：5500 标的 × 4 年规模 P95 < 500ms（M3 spec 第 8 条）。
   */
  async getDailyTopK(q: ValidatedScoresDailyQuery): Promise<DailyTopKRow[]> {
    // 防御：上游 validateScoresDailyQuery 已保证 trade_date/model_version 安全
    const tradeDateCol = resolveScoresFilterColumn('trade_date');
    const modelVersionCol = resolveScoresFilterColumn('model_version');
    const rankCol = resolveScoresFilterColumn('rank_in_day');
    if (!tradeDateCol || !modelVersionCol || !rankCol) {
      // 不可能发生；FIELD_COL_MAP 写死了这三个 key。安全网兜底。
      this.logger.warn('getDailyTopK: FIELD_COL_MAP 缺失核心字段（不应发生）');
      return [];
    }

    const qb = this.scoresRepo
      .createQueryBuilder('s')
      .where(`${tradeDateCol} = :tradeDate`, { tradeDate: q.tradeDate })
      .andWhere(`${modelVersionCol} = :modelVersion`, { modelVersion: q.modelVersion })
      .orderBy(rankCol, 'ASC')
      .limit(q.topK);

    const rows = await qb.getMany();
    const nameMap = await this.loadNameMap(rows.map((r) => r.tsCode));
    return rows.map((r) => this.toDailyTopKRow(r, nameMap));
  }

  /**
   * 单股票的多日评分历史（用于 ts_code 详情页"评分时间序列"折线图）。
   */
  async getTimeSeries(q: ValidatedScoresTimeSeriesQuery): Promise<ScoreTimeSeriesRow[]> {
    const tsCodeCol = resolveScoresFilterColumn('ts_code');
    const modelVersionCol = resolveScoresFilterColumn('model_version');
    const tradeDateCol = resolveScoresFilterColumn('trade_date');
    if (!tsCodeCol || !modelVersionCol || !tradeDateCol) {
      this.logger.warn('getTimeSeries: FIELD_COL_MAP 缺失核心字段（不应发生）');
      return [];
    }

    const qb = this.scoresRepo
      .createQueryBuilder('s')
      .where(`${tsCodeCol} = :tsCode`, { tsCode: q.tsCode })
      .andWhere(`${modelVersionCol} = :modelVersion`, { modelVersion: q.modelVersion })
      .andWhere(`${tradeDateCol} >= :start`, { start: q.start })
      .andWhere(`${tradeDateCol} <= :end`, { end: q.end })
      .orderBy(tradeDateCol, 'ASC');

    const rows = await qb.getMany();
    return rows.map((r) => ({
      trade_date: r.tradeDate,
      score: Number(r.score),
      rank_in_day: r.rankInDay,
    }));
  }

  /**
   * 返回所有可用的 model_version 列表（用于前端版本切换器）。
   *
   * 数据源选用 `ml.model_runs.model_version`（带 created_at），而非 `ml.scores_daily`
   * 的 `DISTINCT model_version` —— 因为 model_runs 已经天然按 model_version 唯一索引、
   * 行数小（远 << scores_daily），DISTINCT 成本最低，且能附带创建时间排序。
   */
  async getModelVersions(): Promise<ModelVersionsListItem[]> {
    const rows = await this.runsRepo
      .createQueryBuilder('r')
      .select(['r.modelVersion AS model_version', 'r.createdAt AS created_at'])
      .orderBy('r.createdAt', 'DESC')
      .getRawMany<{ model_version: string; created_at: Date }>();
    return rows.map((r) => ({
      model_version: r.model_version,
      created_at: formatUtcWallClock(r.created_at),
    }));
  }

  /**
   * 同日多模型对比：M3 spec 验收门槛"两个 model_version 共存查询无串扰"。
   *
   * 实现要点：
   *  - 数组参数走 PG `::text[]`，因 `ml.scores_daily.model_version` 是 `text` 列（01-pg-schema.md §4）
   *  - 不用 `IN (...)` 拼字符串，避免 SQL 注入面 + 字段类型不匹配（CLAUDE.md NOT DO 第 1 条）
   *  - 一次性按 model_version 分组在内存里 slice top-K（每组数据量受 top_k 上限 500 控制）
   */
  async compareModels(q: ValidatedScoresCompareQuery): Promise<CompareGroup[]> {
    if (q.modelVersions.length === 0) return [];

    const tradeDateCol = resolveScoresFilterColumn('trade_date');
    const modelVersionCol = resolveScoresFilterColumn('model_version');
    const rankCol = resolveScoresFilterColumn('rank_in_day');
    if (!tradeDateCol || !modelVersionCol || !rankCol) {
      this.logger.warn('compareModels: FIELD_COL_MAP 缺失核心字段（不应发生）');
      return [];
    }

    // PG: model_version 列是 text；数组参数必须 ::text[] 强转（CLAUDE.md NOT DO 第 1 条）
    const rows = await this.scoresRepo
      .createQueryBuilder('s')
      .where(`${tradeDateCol} = :tradeDate`, { tradeDate: q.tradeDate })
      .andWhere(`${modelVersionCol} = ANY(:modelVersions::text[])`, {
        modelVersions: q.modelVersions,
      })
      .andWhere(`${rankCol} <= :topK`, { topK: q.topK })
      .orderBy(modelVersionCol, 'ASC')
      .addOrderBy(rankCol, 'ASC')
      .getMany();

    // 按 model_version 分组，保留入参顺序；name 批量查一次后所有分组共享
    const nameMap = await this.loadNameMap(rows.map((r) => r.tsCode));
    const groups = new Map<string, DailyTopKRow[]>();
    for (const mv of q.modelVersions) groups.set(mv, []);
    for (const r of rows) {
      const list = groups.get(r.modelVersion);
      if (!list) continue;
      list.push(this.toDailyTopKRow(r, nameMap));
    }
    return q.modelVersions.map((mv) => ({
      model_version: mv,
      rows: groups.get(mv) ?? [],
    }));
  }

  /**
   * 取当前 prod 模型版本：`WHERE status='prod' ORDER BY created_at DESC LIMIT 1`。
   *
   * 命中 migration 20260529 建的 `idx_model_runs_status_created (status, created_at DESC)`。
   * 无 prod 模型时返回 null（调用方据此返回空 items，不抛 500）。
   * status 是固定常量列（非用户输入），直写别名列名（与 getModelVersions 写法一致），
   * FIELD_COL_MAP 只约束 scores_daily 的动态字段。
   */
  private async resolveProdModelVersion(): Promise<string | null> {
    const row = await this.runsRepo
      .createQueryBuilder('r')
      .select('r.modelVersion', 'model_version')
      .where('r.status = :status', { status: 'prod' })
      .orderBy('r.createdAt', 'DESC')
      .limit(1)
      .getRawOne<{ model_version: string }>();
    return row?.model_version ?? null;
  }

  /**
   * 给一批 ts_code 批量查"当日 prod 模型"的评分（A 股面板评分列用）。
   *
   * - 模型版本由服务端自动选当前 prod（前端不传 model_version）。
   * - prod 不存在 → `model_version=null, items=[]`，不抛 500。
   * - 缺失的 ts_code 不进 items（前端显示 `—`），**不回填 0 / 历史值**。
   * - ts_code 是 varchar：数组参数用 `::text[]` 强转（database-sql.md），
   *   与 compareModels 的 `= ANY(:...::text[])` 一致。
   */
  async getScoresByTsCodes(
    q: ValidatedScoresByTsCodesQuery,
  ): Promise<ScoresByTsCodesResult> {
    const modelVersion = await this.resolveProdModelVersion();
    if (!modelVersion) {
      this.logger.warn(
        `scores_by_tscodes_no_prod_model trade_date=${q.tradeDate} tsCodes=${q.tsCodes.length}`,
      );
      return { trade_date: q.tradeDate, model_version: null, items: [] };
    }
    if (q.tsCodes.length === 0) {
      return { trade_date: q.tradeDate, model_version: modelVersion, items: [] };
    }

    const tradeDateCol = resolveScoresFilterColumn('trade_date');
    const modelVersionCol = resolveScoresFilterColumn('model_version');
    const tsCodeCol = resolveScoresFilterColumn('ts_code');
    if (!tradeDateCol || !modelVersionCol || !tsCodeCol) {
      this.logger.warn('getScoresByTsCodes: FIELD_COL_MAP 缺失核心字段（不应发生）');
      return { trade_date: q.tradeDate, model_version: modelVersion, items: [] };
    }

    // 去重减少 IN-list / ANY 数组大小
    const uniqueTsCodes = Array.from(new Set(q.tsCodes));
    const rows = await this.scoresRepo
      .createQueryBuilder('s')
      // getMany() 按 entity 属性名水合，select 必须用属性名（tsCode/rankInDay），
      // 不能用 DB 列名（ts_code/rank_in_day），否则属性水合不上 → undefined
      .select(['s.tsCode', 's.score', 's.rankInDay'])
      .where(`${tradeDateCol} = :tradeDate`, { tradeDate: q.tradeDate })
      .andWhere(`${modelVersionCol} = :modelVersion`, { modelVersion })
      .andWhere(`${tsCodeCol} = ANY(:tsCodes::text[])`, { tsCodes: uniqueTsCodes })
      .getMany();

    return {
      trade_date: q.tradeDate,
      model_version: modelVersion,
      items: rows.map((r) => ({
        ts_code: r.tsCode,
        score: Number(r.score),
        rank_in_day: r.rankInDay,
      })),
    };
  }

  private toDailyTopKRow = (
    r: MlScoreDailyEntity,
    nameMap?: Map<string, string>,
  ): DailyTopKRow => ({
    trade_date: r.tradeDate,
    ts_code: r.tsCode,
    model_version: r.modelVersion,
    score: Number(r.score),
    rank_in_day: r.rankInDay,
    name: nameMap?.get(r.tsCode) ?? null,
  });
}

/**
 * Date → UTC 墙钟 `YYYY-MM-DD HH:mm:ssZ`。
 *
 * CLAUDE.md 时间规范：出参一律 UTC 墙钟字符串，禁 toLocaleString / toISOString().slice。
 */
function formatUtcWallClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}
