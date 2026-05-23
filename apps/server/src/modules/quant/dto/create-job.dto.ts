import { BadRequestException } from '@nestjs/common';
import type { MlJobRunType } from '../../../entities/ml/ml-job.entity';

/**
 * `POST /quant/jobs` 请求体。
 *
 * 设计决策：项目目前未引入 class-validator（见 apps/server/package.json），沿用既有 DTO 约定：
 * - DTO 仅声明类型
 * - 校验放到独立 `validate*` 函数，由 controller 显式调用
 * 这样避免本 PR 新增一个全仓库都未用过的顶层依赖；规则严格度与 class-validator 等价。
 *
 * 校验规则：
 * - run_type 必须 ∈ ALLOWED_RUN_TYPES
 * - params 必须为对象（不能是数组 / null / 标量），不传则默认 `{}`
 *   内部字段不在 NestJS 侧校验，由 Python worker 按 §4.1 schema 校验（避免双重 schema 维护）
 * - priority / max_attempts 若传须为正整数（priority 范围 0..1000；max_attempts 至少 1）
 * - parent_job_id / created_by 透传（created_by 通常由 controller 覆盖为当前 user.id）
 */
export class CreateJobDto {
  run_type!: MlJobRunType;
  params?: Record<string, unknown>;
  priority?: number;
  max_attempts?: number;
  parent_job_id?: string;
  created_by?: string;
}

export const ALLOWED_RUN_TYPES: readonly MlJobRunType[] = [
  'noop',
  'sync',
  'quality',
  'factors',
  'labels',
  'features',
  'train',
  'infer',
  'optuna',
  'seed_avg',
  'train_e2e',
] as const;

export interface ValidatedCreateJob {
  runType: MlJobRunType;
  params: Record<string, unknown>;
  priority: number;
  maxAttempts: number;
  parentJobId?: string;
  /** controller 通常会用当前 user.id 覆盖；body 中显式传入仅供 cron / 内部脚本使用 */
  createdBy?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateCreateJob(input: unknown): ValidatedCreateJob {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('body 必须是对象');
  }
  const body = input as Record<string, unknown>;

  const runType = body.run_type;
  if (typeof runType !== 'string' || !ALLOWED_RUN_TYPES.includes(runType as MlJobRunType)) {
    throw new BadRequestException(
      `run_type 必须 ∈ {${ALLOWED_RUN_TYPES.join('|')}}，实际 ${JSON.stringify(runType)}`,
    );
  }

  let params: Record<string, unknown> = {};
  if (body.params !== undefined && body.params !== null) {
    if (typeof body.params !== 'object' || Array.isArray(body.params)) {
      throw new BadRequestException('params 必须为对象（非数组）');
    }
    params = body.params as Record<string, unknown>;
  }

  let priority = 100;
  if (body.priority !== undefined && body.priority !== null) {
    if (
      typeof body.priority !== 'number' ||
      !Number.isInteger(body.priority) ||
      body.priority < 0 ||
      body.priority > 1000
    ) {
      throw new BadRequestException('priority 必须为 0..1000 之间的整数');
    }
    priority = body.priority;
  }

  let maxAttempts = 1;
  if (body.max_attempts !== undefined && body.max_attempts !== null) {
    if (
      typeof body.max_attempts !== 'number' ||
      !Number.isInteger(body.max_attempts) ||
      body.max_attempts < 1 ||
      body.max_attempts > 32767
    ) {
      throw new BadRequestException('max_attempts 必须为 1..32767 之间的整数');
    }
    maxAttempts = body.max_attempts;
  }

  let parentJobId: string | undefined;
  if (body.parent_job_id !== undefined && body.parent_job_id !== null && body.parent_job_id !== '') {
    if (typeof body.parent_job_id !== 'string' || !UUID_RE.test(body.parent_job_id)) {
      throw new BadRequestException('parent_job_id 必须为 uuid');
    }
    parentJobId = body.parent_job_id;
  }

  let createdBy: string | undefined;
  if (body.created_by !== undefined && body.created_by !== null && body.created_by !== '') {
    if (typeof body.created_by !== 'string' || body.created_by.length > 64) {
      throw new BadRequestException('created_by 必须为 ≤64 字符的字符串');
    }
    createdBy = body.created_by;
  }

  return {
    runType: runType as MlJobRunType,
    params,
    priority,
    maxAttempts,
    parentJobId,
    createdBy,
  };
}
