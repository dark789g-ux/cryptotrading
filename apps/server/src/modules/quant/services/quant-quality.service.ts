/**
 * `QuantQualityService` —— `ml.quality_reports` 只读。
 *
 * ## P95 优化点
 *  1. **索引依赖**：`(trade_date, level)` 联合索引（M0 Alembic 已建）；
 *     `getByDate` 与 `getRecent` 均按 trade_date 范围过滤，命中索引前缀。
 *  2. **不暴露 jsonb 过滤 / 排序**：detail 是 jsonb，FIELD_COL_MAP 未含，
 *     防止前端构造形如 `?sort=detail.psi` 的查询拖慢 PG（要做 jsonb path index 才行）。
 *  3. **CASE 排序用字面量**：level 严重程度排序的 CASE 表达式不含 user input，
 *     PG planner 能在 LIMIT 较小时直接走索引扫描后内存排序。
 *  4. **按 trade_date 字符串字典序比较**：YYYYMMDD 字符串字典序与日期序一致，
 *     无需 CAST 为 date，避免索引失效。
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  MlQualityReportEntity,
  type MlQualityLevel,
} from '../../../entities/ml/ml-quality-report.entity';
import type { ValidatedQualityRecentQuery } from '../dto/quality-query.dto';

/**
 * 动态过滤 / 排序字段 → 实际 SQL 列名映射（CLAUDE.md 硬约束）。
 *
 * - key：前端 / DTO 字段名
 * - value：QueryBuilder alias `q` 下的列名
 */
export const QUALITY_FIELD_COL_MAP: Readonly<Record<string, string>> = Object.freeze({
  trade_date: 'q.trade_date',
  level: 'q.level',
  rule: 'q.rule',
  created_at: 'q.created_at',
});

export function resolveQualityFilterColumn(field: string): string | null {
  const col = QUALITY_FIELD_COL_MAP[field];
  return col ?? null;
}

export interface QualityReportRow {
  id: string;
  trade_date: string;
  level: MlQualityLevel;
  rule: string;
  detail: Record<string, unknown>;
  created_at: string;
}

@Injectable()
export class QuantQualityService {
  private readonly logger = new Logger(QuantQualityService.name);

  constructor(
    @InjectRepository(MlQualityReportEntity)
    private readonly qualityRepo: Repository<MlQualityReportEntity>,
  ) {}

  /**
   * 当日质量事件（按 level 严重程度 + created_at DESC 排序）。
   *
   * - `levels` 可选：传入则只返回这些 level 的事件（spec M3 §5 `?level=warn,critical`）
   * - levels 走 PG `= ANY(:levels::text[])`（CLAUDE.md NOT DO 第 1 条）
   */
  async getByDate(
    tradeDate: string,
    levels?: MlQualityLevel[],
  ): Promise<QualityReportRow[]> {
    const tradeDateCol = resolveQualityFilterColumn('trade_date');
    const levelCol = resolveQualityFilterColumn('level');
    if (!tradeDateCol || !levelCol) {
      // 防御不可达：FIELD_COL_MAP 写死 trade_date / level
      this.logger.warn('getByDate: FIELD_COL_MAP 缺失核心字段（不应发生）');
      return [];
    }
    const qb = this.qualityRepo
      .createQueryBuilder('q')
      .where(`${tradeDateCol} = :tradeDate`, { tradeDate });

    if (levels && levels.length > 0) {
      qb.andWhere(`${levelCol} = ANY(:levels::text[])`, { levels });
    }

    qb.orderBy(
      // CASE 表达式手写，避免暴露 user input；level 值由 DB 枚举保证
      `CASE q.level WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 WHEN 'info' THEN 2 ELSE 3 END`,
      'ASC',
    ).addOrderBy('q.created_at', 'DESC');

    const rows = await qb.getMany();
    return rows.map((r) => this.toRow(r));
  }

  /**
   * 最近 N 日 warn/critical 事件流。
   *
   * 实现：
   *  - days 控制日期下界（按 trade_date 字符串比较，仅取 today - days 至 today 的区间）
   *    —— UI 通常配合"最近 7 天"按钮使用；trade_date 是 YYYYMMDD 字符串，按字典序与日期序一致
   *  - levels（可选）走 `::text[]` 参数（CLAUDE.md NOT DO 第 1 条：数组参数类型必须匹配列类型）
   */
  async getRecent(dto: ValidatedQualityRecentQuery): Promise<QualityReportRow[]> {
    const tradeDateCol = resolveQualityFilterColumn('trade_date');
    const levelCol = resolveQualityFilterColumn('level');
    if (!tradeDateCol || !levelCol) {
      this.logger.warn('getRecent: FIELD_COL_MAP 缺失核心字段（不应发生）');
      return [];
    }

    const lowerBound = computeLowerTradeDate(dto.days);
    const qb = this.qualityRepo
      .createQueryBuilder('q')
      .where(`${tradeDateCol} >= :lowerBound`, { lowerBound });

    if (dto.levels && dto.levels.length > 0) {
      qb.andWhere(`${levelCol} = ANY(:levels::text[])`, { levels: dto.levels });
    }

    qb.orderBy('q.created_at', 'DESC').addOrderBy(tradeDateCol, 'DESC');

    const rows = await qb.getMany();
    return rows.map((r) => this.toRow(r));
  }

  private toRow(r: MlQualityReportEntity): QualityReportRow {
    return {
      id: String(r.id),
      trade_date: r.tradeDate,
      level: r.level,
      rule: r.rule,
      detail: r.detail ?? {},
      created_at: formatUtcWallClock(r.createdAt),
    };
  }
}

/**
 * 计算 "今天 - days 天" 对应的 YYYYMMDD 下界。
 *
 * 用 UTC 计算（DB 入库 timestamptz 是 UTC；trade_date 字符串约定也是 UTC 日历日）。
 */
export function computeLowerTradeDate(days: number, now: Date = new Date()): string {
  const t = new Date(now.getTime());
  t.setUTCDate(t.getUTCDate() - days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}`;
}

function formatUtcWallClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}
