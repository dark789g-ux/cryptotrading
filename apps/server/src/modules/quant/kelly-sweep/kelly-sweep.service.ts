import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KellySweepResult } from '../../../entities/ml/kelly-sweep-result.entity';
import { MlJobEntity } from '../../../entities/ml/ml-job.entity';

/**
 * `GET /api/quant/kelly-sweep` 查询服务（只读）。
 *
 * 结果表：`research.kelly_sweep_results`。
 * 全部接口均依 job_id + window_group 取数，window_group 必须是 'with_rs'|'no_rs' 之一，
 * 口径不可跨组比（spec 04 强制）。
 */

/** scatter 点的精简结构 */
export interface ScatterPoint {
  id: string;
  n_valid: number;
  kelly_valid: number | null;
  is_frontier: boolean;
  below_floor: boolean;
  variant_id: string;
  exit_id: string;
}

/** 分页通用出参 */
export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** top-K 行出参（含 CI） */
export interface TopkRow {
  id: string;
  variant_id: string;
  exit_id: string;
  n_valid: number;
  kelly_valid: number | null;
  kelly_ci_low: number | null;
  kelly_ci_high: number | null;
  win_rate_valid: number | null;
  payoff_b_valid: number | null;
  profit_factor_valid: number | null;
  below_floor: boolean;
  is_frontier: boolean;
  same_day_rule: string;
}

/**
 * sort 列白名单（防 SQL 注入）。
 * key = 前端传入字符串，value = 实体属性名（TypeORM 用属性名，不用 DB 列名）。
 * 只允许数值/文本类可排序列。
 */
export const KELLY_SORT_FIELD_MAP: Readonly<Record<string, string>> = Object.freeze({
  kelly_valid: 'kellyValid',
  kelly_train: 'kellyTrain',
  kelly_ci_low: 'kellyCiLow',
  kelly_ci_high: 'kellyCiHigh',
  n_valid: 'nValid',
  n_train: 'nTrain',
  win_rate_valid: 'winRateValid',
  win_rate_train: 'winRateTrain',
  payoff_b_valid: 'payoffBValid',
  payoff_b_train: 'payoffBTrain',
  profit_factor_valid: 'profitFactorValid',
  profit_factor_train: 'profitFactorTrain',
  variant_id: 'variantId',
  exit_id: 'exitId',
  same_day_rule: 'sameDayRule',
  created_at: 'createdAt',
});

const VALID_GROUPS = new Set(['with_rs', 'no_rs']);
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** meta 接口返回的常量（不变，避免前端硬编码漂移） */
export const KELLY_META = Object.freeze({
  /**
   * base_trigger.field 白名单。
   * 唯一真相源：apps/quant-pipeline/src/quant_pipeline/research/kelly_sweep/enumerate.py:57
   * 改 Python _ALLOWED_INDICATOR_FIELDS 时须同步此处。
   */
  base_fields: [
    'kdj_k',
    'kdj_d',
    'kdj_j',
    'macd',
    'macd_dif',
    'macd_dea',
    'rsi_6',
    'rsi_12',
    'rsi_24',
    'cci',
    'dmi_pdi',
    'dmi_mdi',
    'dmi_adx',
    'dmi_adxr',
    'boll_upper',
    'boll_mid',
    'boll_lower',
    'ma5',
    'ma10',
    'ma20',
    'ma30',
    'ma60',
    'atr_14',
    'obv',
    'wr',
    'bias',
    'ema5',
    'ema10',
    'ema20',
  ] as const,
  exit_families: ['fixed_n', 'tp_sl', 'trailing', 'atr_stop'] as const,
  /** industry 暂未接通（Python NotImplementedError），禁止前端展示 */
  rs_benchmarks: ['hs300', 'zz500'] as const,
});

function validateGroup(group: unknown): string {
  if (typeof group !== 'string' || !VALID_GROUPS.has(group)) {
    throw new BadRequestException(
      `group 必须是 'with_rs' 或 'no_rs'，实际 ${JSON.stringify(group)}`,
    );
  }
  return group;
}

function resolvePagination(
  pageRaw: unknown,
  pageSizeRaw: unknown,
): { skip: number; take: number; page: number; pageSize: number } {
  const page = Number.isInteger(Number(pageRaw)) && Number(pageRaw) >= 1 ? Number(pageRaw) : 1;
  const rawSize = Number(pageSizeRaw);
  const pageSize = Number.isInteger(rawSize) && rawSize >= 1
    ? Math.min(rawSize, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  return { skip: (page - 1) * pageSize, take: pageSize, page, pageSize };
}

function resolveSort(
  sortRaw: unknown,
  defaultField = 'kellyValid',
  defaultOrder: 'ASC' | 'DESC' = 'DESC',
): { field: string; order: 'ASC' | 'DESC' } {
  if (typeof sortRaw !== 'string' || !sortRaw) {
    return { field: defaultField, order: defaultOrder };
  }
  // 支持 "field:asc" 或 "field:desc" 或纯 "field"
  const [rawField, rawOrder] = sortRaw.split(':');
  const mappedField = KELLY_SORT_FIELD_MAP[rawField];
  if (!mappedField) {
    // 未命中白名单 → 回退默认排序（防注入，不报错）
    return { field: defaultField, order: defaultOrder };
  }
  const order: 'ASC' | 'DESC' =
    rawOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  return { field: mappedField, order };
}

@Injectable()
export class KellySweepService {
  private readonly logger = new Logger(KellySweepService.name);

  constructor(
    @InjectRepository(KellySweepResult)
    private readonly resultRepo: Repository<KellySweepResult>,
    @InjectRepository(MlJobEntity)
    private readonly jobRepo: Repository<MlJobEntity>,
  ) {}

  /** GET /meta — 前端无需硬编码白名单 */
  getMeta() {
    return KELLY_META;
  }

  /**
   * GET /runs/:jobId/summary
   * 返回 job 元信息 + result_payload 摘要（轻量，不查 results 表）。
   */
  async getSummary(jobId: string) {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) {
      throw new NotFoundException(`job ${jobId} 不存在`);
    }
    if (job.runType !== 'kelly_sweep') {
      throw new BadRequestException(`job ${jobId} 的 run_type=${job.runType}，不是 kelly_sweep`);
    }
    return {
      id: job.id,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      run_type: job.runType,
      params: job.params,
      result_payload: job.resultPayload,
      created_at: job.createdAt,
      started_at: job.startedAt,
      finished_at: job.finishedAt,
    };
  }

  /**
   * GET /runs/:jobId/scatter?group=with_rs|no_rs
   * 精简点集供前端渲染帕累托散点图，取该组全部行。
   */
  async getScatter(jobId: string, groupRaw: unknown): Promise<ScatterPoint[]> {
    const group = validateGroup(groupRaw);
    const rows = await this.resultRepo.find({
      where: { jobId, windowGroup: group },
      select: ['id', 'nValid', 'kellyValid', 'isFrontier', 'belowFloor', 'variantId', 'exitId'],
    });
    return rows.map((r) => ({
      id: r.id,
      n_valid: r.nValid,
      kelly_valid: r.kellyValid,
      is_frontier: r.isFrontier,
      below_floor: r.belowFloor,
      variant_id: r.variantId,
      exit_id: r.exitId,
    }));
  }

  /**
   * GET /runs/:jobId/topk?group=&page=&pageSize=&sort=
   * is_topk 行分页，默认 kelly_valid DESC，含 CI 列。
   */
  async getTopk(
    jobId: string,
    groupRaw: unknown,
    pageRaw: unknown,
    pageSizeRaw: unknown,
    sortRaw: unknown,
  ): Promise<PagedResult<TopkRow>> {
    const group = validateGroup(groupRaw);
    const { skip, take, page, pageSize } = resolvePagination(pageRaw, pageSizeRaw);
    const { field, order } = resolveSort(sortRaw, 'kellyValid', 'DESC');

    const qb = this.resultRepo
      .createQueryBuilder('r')
      .where('r.job_id = :jobId', { jobId })
      .andWhere('r.window_group = :group', { group })
      .andWhere('r.is_topk = true')
      .orderBy(`r.${field}`, order, 'NULLS LAST')
      .skip(skip)
      .take(take);

    const [rows, total] = await qb.getManyAndCount();

    return {
      items: rows.map((r) => ({
        id: r.id,
        variant_id: r.variantId,
        exit_id: r.exitId,
        n_valid: r.nValid,
        kelly_valid: r.kellyValid,
        kelly_ci_low: r.kellyCiLow,
        kelly_ci_high: r.kellyCiHigh,
        win_rate_valid: r.winRateValid,
        payoff_b_valid: r.payoffBValid,
        profit_factor_valid: r.profitFactorValid,
        below_floor: r.belowFloor,
        is_frontier: r.isFrontier,
        same_day_rule: r.sameDayRule,
      })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * GET /runs/:jobId/rows?group=&page=&pageSize=&sort=
   * 全量行分页 + 任意列排序。
   */
  async getRows(
    jobId: string,
    groupRaw: unknown,
    pageRaw: unknown,
    pageSizeRaw: unknown,
    sortRaw: unknown,
  ): Promise<PagedResult<KellySweepResult>> {
    const group = validateGroup(groupRaw);
    const { skip, take, page, pageSize } = resolvePagination(pageRaw, pageSizeRaw);
    const { field, order } = resolveSort(sortRaw, 'kellyValid', 'DESC');

    const [rows, total] = await this.resultRepo
      .createQueryBuilder('r')
      .where('r.job_id = :jobId', { jobId })
      .andWhere('r.window_group = :group', { group })
      .orderBy(`r.${field}`, order, 'NULLS LAST')
      .skip(skip)
      .take(take)
      .getManyAndCount();

    return { items: rows, total, page, pageSize };
  }

  /**
   * GET /runs/:jobId/rows/:rowId
   * 单行完整字段（详情弹窗）。
   */
  async getRow(jobId: string, rowId: string): Promise<KellySweepResult> {
    const row = await this.resultRepo.findOne({ where: { id: rowId, jobId } });
    if (!row) {
      throw new NotFoundException(`结果行 id=${rowId}（job_id=${jobId}）不存在`);
    }
    return row;
  }

  /**
   * GET /history?status=&page=
   * ml.jobs WHERE run_type='kelly_sweep' 列表（历史下拉）。
   */
  async getHistory(
    statusRaw: unknown,
    pageRaw: unknown,
    pageSizeRaw: unknown,
  ): Promise<PagedResult<Partial<MlJobEntity>>> {
    const { skip, take, page, pageSize } = resolvePagination(pageRaw, pageSizeRaw);

    const qb = this.jobRepo
      .createQueryBuilder('j')
      .where("j.run_type = 'kelly_sweep'")
      .orderBy('j.created_at', 'DESC')
      .skip(skip)
      .take(take);

    if (typeof statusRaw === 'string' && statusRaw) {
      qb.andWhere('j.status = :status', { status: statusRaw });
    }

    const [rows, total] = await qb.getManyAndCount();
    return { items: rows, total, page, pageSize };
  }
}
