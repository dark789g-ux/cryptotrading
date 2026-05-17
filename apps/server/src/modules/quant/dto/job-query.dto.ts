import { BadRequestException } from '@nestjs/common';
import type { MlJobRunType, MlJobStatus } from '../../../entities/ml/ml-job.entity';
import { ALLOWED_RUN_TYPES } from './create-job.dto';

/**
 * `GET /quant/jobs` 查询参数（已经过 controller 显式校验）。
 *
 * 注意：动态过滤字段必须经过 service 内的 FIELD_COL_MAP 翻译为实际列名，
 * 未命中字段一律 `logger.warn` + skip（CLAUDE.md 硬约束）。
 */
export class JobQueryDto {
  status?: MlJobStatus;
  run_type?: MlJobRunType;
  page?: number;
  page_size?: number;
}

const ALLOWED_STATUSES: readonly MlJobStatus[] = [
  'pending',
  'running',
  'success',
  'failed',
  'blocked',
  'cancelled',
] as const;

export interface ValidatedJobQuery {
  status?: MlJobStatus;
  runType?: MlJobRunType;
  page: number;
  pageSize: number;
}

export function validateJobQuery(query: Record<string, unknown>): ValidatedJobQuery {
  const out: ValidatedJobQuery = { page: 1, pageSize: 20 };

  if (query.status !== undefined && query.status !== '' && query.status !== null) {
    const s = String(query.status);
    if (!ALLOWED_STATUSES.includes(s as MlJobStatus)) {
      throw new BadRequestException(`status 必须 ∈ {${ALLOWED_STATUSES.join('|')}}`);
    }
    out.status = s as MlJobStatus;
  }

  if (query.run_type !== undefined && query.run_type !== '' && query.run_type !== null) {
    const r = String(query.run_type);
    if (!ALLOWED_RUN_TYPES.includes(r as MlJobRunType)) {
      throw new BadRequestException(`run_type 必须 ∈ {${ALLOWED_RUN_TYPES.join('|')}}`);
    }
    out.runType = r as MlJobRunType;
  }

  if (query.page !== undefined && query.page !== '' && query.page !== null) {
    const p = parseInt(String(query.page), 10);
    if (!Number.isFinite(p) || p < 1) {
      throw new BadRequestException('page 必须为 >=1 的整数');
    }
    out.page = p;
  }

  if (query.page_size !== undefined && query.page_size !== '' && query.page_size !== null) {
    const ps = parseInt(String(query.page_size), 10);
    if (!Number.isFinite(ps) || ps < 1 || ps > 200) {
      throw new BadRequestException('page_size 必须为 1..200 之间的整数');
    }
    out.pageSize = ps;
  }

  return out;
}

// 兼容旧引用别名（M2 spec 既写过 ListJobsDto 也写过 JobQueryDto，统一以 JobQuery 为主）
export const validateListJobs = validateJobQuery;
export type ValidatedListJobs = ValidatedJobQuery;
export type ListJobsDto = JobQueryDto;
