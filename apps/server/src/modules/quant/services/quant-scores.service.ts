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
import { Repository } from 'typeorm';
import { MlScoreDailyEntity } from '../../../entities/ml/ml-score-daily.entity';
import { MlModelRunEntity } from '../../../entities/ml/ml-model-run.entity';
import type {
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

@Injectable()
export class QuantScoresService {
  private readonly logger = new Logger(QuantScoresService.name);

  constructor(
    @InjectRepository(MlScoreDailyEntity)
    private readonly scoresRepo: Repository<MlScoreDailyEntity>,
    @InjectRepository(MlModelRunEntity)
    private readonly runsRepo: Repository<MlModelRunEntity>,
  ) {}

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
      items = rows.map(this.toDailyTopKRow);
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
    return rows.map(this.toDailyTopKRow);
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

    // 按 model_version 分组，保留入参顺序
    const groups = new Map<string, DailyTopKRow[]>();
    for (const mv of q.modelVersions) groups.set(mv, []);
    for (const r of rows) {
      const list = groups.get(r.modelVersion);
      if (!list) continue;
      list.push(this.toDailyTopKRow(r));
    }
    return q.modelVersions.map((mv) => ({
      model_version: mv,
      rows: groups.get(mv) ?? [],
    }));
  }

  private toDailyTopKRow = (r: MlScoreDailyEntity): DailyTopKRow => ({
    trade_date: r.tradeDate,
    ts_code: r.tsCode,
    model_version: r.modelVersion,
    score: Number(r.score),
    rank_in_day: r.rankInDay,
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
