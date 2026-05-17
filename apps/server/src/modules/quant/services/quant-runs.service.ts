/**
 * `QuantRunsService` —— `ml.model_runs` 只读。
 *
 * ## P95 优化点
 *  1. **索引依赖**：`(model_version)` 已有 unique 索引（M0 Alembic 已建）；
 *     按 model_version 过滤 + 按 created_at 排序均无全表扫描风险。
 *  2. **列表不返回 jsonb 大字段**：`list()` 内的 `toListItem` 只暴露 oos_metrics 的核心字段
 *     （ndcg@5/ndcg@10/ic/rank_ic/portfolio_annual_after_cost），不发整个 oosMetrics jsonb；
 *     完整 jsonb 仅在 `findOne` 返回。
 *  3. **不做跨表 join**：model_runs 总行数小（一次成功训练 = 一行；预计 < 1k 行/年），
 *     即使 SELECT * 性能也足；本 service 仅在 list 路径做字段裁剪。
 *  4. **分页硬上限**：page_size ≤ 200（DTO 层校验），防止误用拉满。
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MlModelRunEntity } from '../../../entities/ml/ml-model-run.entity';
import type { ValidatedRunQuery } from '../dto/run-query.dto';

/**
 * 动态过滤 / 排序字段 → 实际 SQL 列名映射（CLAUDE.md 硬约束）。
 *
 * - key：前端 / DTO 字段名（snake_case）
 * - value：QueryBuilder alias `r` 下的列名
 *
 * 未命中本表的字段一律 `logger.warn` + skip。
 *
 * 注意：`oos_metrics` 是 jsonb；本任务只在响应里"提炼"核心字段，不暴露 jsonb 排序 / 过滤路径。
 */
export const RUNS_FIELD_COL_MAP: Readonly<Record<string, string>> = Object.freeze({
  model_version: 'r.model_version',
  created_at: 'r.created_at',
  feature_set_id: 'r.feature_set_id',
  artifact_uri: 'r.artifact_uri',
});

export function resolveRunsFilterColumn(field: string): string | null {
  const col = RUNS_FIELD_COL_MAP[field];
  return col ?? null;
}

/** OOS metrics 的核心字段（M3 前端要快速渲染的"NDCG@10 / IC / 扣成本年化"三个数字） */
export interface OosMetricsCore {
  ndcg_at_5: number | null;
  ndcg_at_10: number | null;
  ic: number | null;
  rank_ic: number | null;
  portfolio_annual_after_cost: number | null;
}

export interface RunListItem {
  id: string;
  model_version: string;
  feature_set_id: string;
  artifact_uri: string;
  report_uri: string | null;
  created_at: string;
  oos_metrics_core: OosMetricsCore;
}

export interface RunDetail extends RunListItem {
  job_id: string | null;
  hyperparams: Record<string, unknown>;
  oos_metrics: Record<string, unknown>;
  shap_uri: string | null;
}

@Injectable()
export class QuantRunsService {
  private readonly logger = new Logger(QuantRunsService.name);

  constructor(
    @InjectRepository(MlModelRunEntity)
    private readonly runsRepo: Repository<MlModelRunEntity>,
  ) {}

  /**
   * 分页列出 model_runs。
   *
   * - filter：仅支持 model_version 精确匹配（其它字段未命中则 warn+skip）
   * - sort：sortField 经 FIELD_COL_MAP 翻译；未命中则 warn 并回退默认 `created_at DESC`
   */
  async list(dto: ValidatedRunQuery): Promise<{
    items: RunListItem[];
    total: number;
    page: number;
    page_size: number;
  }> {
    const qb = this.runsRepo.createQueryBuilder('r');

    // 动态过滤：经 FIELD_COL_MAP；未命中 warn+skip
    const candidateFilters: Array<{ field: string; value: unknown }> = [
      { field: 'model_version', value: dto.modelVersion },
    ];
    for (const f of candidateFilters) {
      if (f.value === undefined || f.value === null || f.value === '') continue;
      const col = resolveRunsFilterColumn(f.field);
      if (!col) {
        this.logger.warn(`list_runs_filter_skip field=${f.field} (not in FIELD_COL_MAP)`);
        continue;
      }
      qb.andWhere(`${col} = :${f.field}`, { [f.field]: f.value });
    }

    // 动态排序：sortField 经 FIELD_COL_MAP；未命中 warn 并回退默认
    let sortCol = 'r.created_at';
    let sortDir: 'ASC' | 'DESC' = 'DESC';
    if (dto.sortField) {
      const col = resolveRunsFilterColumn(dto.sortField);
      if (!col) {
        this.logger.warn(
          `list_runs_sort_skip field=${dto.sortField} (not in FIELD_COL_MAP) → fallback created_at DESC`,
        );
      } else {
        sortCol = col;
        sortDir = dto.sortDir ?? 'DESC';
      }
    }
    qb.orderBy(sortCol, sortDir)
      .skip((dto.page - 1) * dto.pageSize)
      .take(dto.pageSize);

    const [rows, total] = await qb.getManyAndCount();
    return {
      items: rows.map((r) => this.toListItem(r)),
      total,
      page: dto.page,
      page_size: dto.pageSize,
    };
  }

  async findOne(id: string): Promise<RunDetail> {
    const row = await this.runsRepo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException(`model_run ${id} 不存在`);
    }
    const base = this.toListItem(row);
    return {
      ...base,
      job_id: row.jobId,
      hyperparams: row.hyperparams ?? {},
      oos_metrics: row.oosMetrics ?? {},
      shap_uri: row.shapUri,
    };
  }

  private toListItem(r: MlModelRunEntity): RunListItem {
    return {
      id: r.id,
      model_version: r.modelVersion,
      feature_set_id: r.featureSetId,
      artifact_uri: r.artifactUri,
      report_uri: r.reportUri,
      created_at: formatUtcWallClock(r.createdAt),
      oos_metrics_core: extractOosMetricsCore(r.oosMetrics ?? {}),
    };
  }
}

/**
 * 从 jsonb `oos_metrics` 抽取前端核心字段。
 *
 * Python 写入 schema（见 01-pg-schema.md §4）：
 *   {ndcg@5, ndcg@10, ic, rank_ic, portfolio_annual_after_cost, fold_metrics[]}
 *
 * 注意：`ndcg@5`/`ndcg@10` 用 `@` 符号是非标 JS 标识符，但作为 jsonb key 完全合法；
 * 这里同时容忍 `ndcg_at_5` 这种 snake_case 变体，给 Python 侧留一点演化空间。
 */
export function extractOosMetricsCore(m: Record<string, unknown>): OosMetricsCore {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    ndcg_at_5: num(m['ndcg@5']) ?? num(m['ndcg_at_5']),
    ndcg_at_10: num(m['ndcg@10']) ?? num(m['ndcg_at_10']),
    ic: num(m['ic']),
    rank_ic: num(m['rank_ic']),
    portfolio_annual_after_cost: num(m['portfolio_annual_after_cost']),
  };
}

function formatUtcWallClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}
