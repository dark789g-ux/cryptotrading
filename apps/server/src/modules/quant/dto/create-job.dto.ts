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
 * - labelRef：任意 run_type 传了 label_ref 都会被解析并携带；训练类（TRAIN_RUN_TYPES）缺失时 400；
 *   labels run_type 还要求 params.scheme / label_ref / (params.strategy_id + params.strategy_version) 三者至少其一
 *   由 QuantJobsService.create() 调 LabelsService.expandForTraining() 展开写入 params
 */

/** 需要 labelRef 的训练类 run_type（spec 03-backend.md） */
export const TRAIN_RUN_TYPES: ReadonlySet<MlJobRunType> = new Set<MlJobRunType>([
  'train_e2e',
  'train',
  'optuna',
  'seed_avg',
]);

export class CreateJobDto {
  run_type!: MlJobRunType;
  params?: Record<string, unknown>;
  priority?: number;
  max_attempts?: number;
  parent_job_id?: string;
  created_by?: string;
  /** 训练类 run_type 必填；后端展开写入 params */
  label_ref?: { label_id: string; label_version: string };
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
  /** 任意 run_type 传了 label_ref 都会携带；训练类（TRAIN_RUN_TYPES）缺失则 400 */
  labelRef?: { labelId: string; labelVersion: string };
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

  // labelRef：任意 run_type 传了 label_ref 都接受解析；训练类（TRAIN_RUN_TYPES）缺失时 fail-fast 400
  let labelRef: { labelId: string; labelVersion: string } | undefined;
  const isTrainType = TRAIN_RUN_TYPES.has(runType as MlJobRunType);
  if (body.label_ref !== undefined && body.label_ref !== null) {
    if (typeof body.label_ref !== 'object' || Array.isArray(body.label_ref)) {
      throw new BadRequestException('label_ref 必须为对象 { label_id, label_version }');
    }
    const lr = body.label_ref as Record<string, unknown>;
    if (typeof lr.label_id !== 'string' || lr.label_id.length === 0 || lr.label_id.length > 64) {
      throw new BadRequestException('label_ref.label_id 必须为 1..64 字符的字符串');
    }
    if (
      typeof lr.label_version !== 'string' ||
      lr.label_version.length === 0 ||
      lr.label_version.length > 16
    ) {
      throw new BadRequestException('label_ref.label_version 必须为 1..16 字符的字符串');
    }
    labelRef = { labelId: lr.label_id, labelVersion: lr.label_version };
  } else if (isTrainType) {
    // 训练类 run_type 未传 labelRef → fail-fast
    throw new BadRequestException(
      `run_type=${runType as string} 为训练类任务，labelRef 必填。` +
        '请在请求体中提供 label_ref: { label_id, label_version }。',
    );
  }

  // labels 专属 fail-fast：scheme / label_ref / (strategy_id + strategy_version) 三者至少其一
  if (runType === 'labels') {
    const hasScheme =
      typeof params.scheme === 'string' && params.scheme.length > 0;
    const hasLabelRef = labelRef !== undefined;
    const hasStrategyRef =
      typeof params.strategy_id === 'string' &&
      params.strategy_id.length > 0 &&
      typeof params.strategy_version === 'string' &&
      params.strategy_version.length > 0;

    if (!hasScheme && !hasLabelRef && !hasStrategyRef) {
      throw new BadRequestException(
        'run_type=labels 任务必须提供以下三者之一：' +
          '(1) params.scheme（方案名字符串）；' +
          '(2) label_ref: { label_id, label_version }；' +
          '(3) params.strategy_id + params.strategy_version（两者均需非空）。',
      );
    }
  }

  return {
    runType: runType as MlJobRunType,
    params,
    priority,
    maxAttempts,
    parentJobId,
    createdBy,
    labelRef,
  };
}
