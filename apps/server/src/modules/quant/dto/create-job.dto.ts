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
 * 校验规则（spec 03-backend-decoupling.md run_type 参数契约）：
 * - run_type 必须 ∈ ALLOWED_RUN_TYPES
 * - params 必须为对象（不能是数组 / null / 标量），不传则默认 `{}`
 *   内部字段不在 NestJS 侧校验，由 Python worker 按 §4.1 schema 校验（避免双重 schema 维护）
 * - priority / max_attempts 若传须为正整数（priority 范围 0..1000；max_attempts 至少 1）
 * - parent_job_id / created_by 透传（created_by 通常由 controller 覆盖为当前 user.id）
 *
 * labelRef 与 feature_set_id 的契约分组：
 *   - LABEL_REF_RUN_TYPES  {labels, features, prepare}：需 labelRef（后端展开 scheme）
 *   - FEATURE_SET_RUN_TYPES {train, optuna, seed_avg}：需 feature_set_id + date_range（不要 labelRef）
 *     由 QuantJobsService.create() 进一步校验 date_range ⊆ R_F 且无空洞
 */

/** 需要 labelRef 展开的 run_type（spec 03-backend-decoupling.md §run_type 参数契约） */
export const LABEL_REF_RUN_TYPES: ReadonlySet<MlJobRunType> = new Set<MlJobRunType>([
  'labels',
  'features',
  'prepare',
]);

/** 需要 feature_set_id + date_range 的训练类 run_type（spec 03-backend-decoupling.md §run_type 参数契约） */
export const FEATURE_SET_RUN_TYPES: ReadonlySet<MlJobRunType> = new Set<MlJobRunType>([
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
  /** labels/features/prepare run_type 必填；后端展开写入 params */
  label_ref?: { label_id: string; label_version: string };
}

/**
 * 外部 `POST /quant/jobs` 允许创建的 run_type 白名单（spec 03-backend-decoupling 外部 API 契约）。
 *
 * 刻意排除、勿"补全"（`create-job.dto.spec.ts` 已锁定拒绝）：
 * - `monitor`：在 dispatcher `_ROUTES` 里（worker 能跑），但只走内部创建，不开放外部 POST。
 * - `train_e2e`：已废弃（spec 2026-06-06，dispatcher 路由已删），不能再新建；历史 job 仍存于
 *   DB，靠前端 `JobRunType` 类型 + 作业列表筛选下拉展示/筛选，但不在此白名单。
 */
export const ALLOWED_RUN_TYPES: readonly MlJobRunType[] = [
  'noop',
  'sync',
  'quality',
  'factors',
  'labels',
  'features',
  'prepare',
  'train',
  'infer',
  'optuna',
  'seed_avg',
] as const;

export interface ValidatedCreateJob {
  runType: MlJobRunType;
  params: Record<string, unknown>;
  priority: number;
  maxAttempts: number;
  parentJobId?: string;
  /** controller 通常会用当前 user.id 覆盖；body 中显式传入仅供 cron / 内部脚本使用 */
  createdBy?: string;
  /** labels/features/prepare run_type 携带；训练类（FEATURE_SET_RUN_TYPES）不携带 */
  labelRef?: { labelId: string; labelVersion: string };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** YYYYMMDD:YYYYMMDD 格式校验 */
const DATE_RANGE_RE = /^\d{8}:\d{8}$/;

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

  const rt = runType as MlJobRunType;
  const isLabelRefType = LABEL_REF_RUN_TYPES.has(rt);
  const isFeatureSetType = FEATURE_SET_RUN_TYPES.has(rt);

  // ---- labelRef 校验（labels/features/prepare）----
  let labelRef: { labelId: string; labelVersion: string } | undefined;
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
  } else if (isLabelRefType) {
    // labels/features/prepare 缺 labelRef → fail-fast 400
    throw new BadRequestException(
      `run_type=${rt} 需要 labelRef，请在请求体中提供 label_ref: { label_id, label_version }。`,
    );
  }

  // ---- feature_set_id + date_range 校验（train/optuna/seed_avg，浅层，service 层做 ⊆R_F 深度校验）----
  if (isFeatureSetType) {
    const fsId = params.feature_set_id;
    if (typeof fsId !== 'string' || fsId.length === 0) {
      throw new BadRequestException(
        `run_type=${rt} 需要 params.feature_set_id（非空字符串）。`,
      );
    }
    const dateRange = params.date_range;
    if (typeof dateRange !== 'string' || !DATE_RANGE_RE.test(dateRange)) {
      throw new BadRequestException(
        `run_type=${rt} 需要 params.date_range，格式 YYYYMMDD:YYYYMMDD（实际 ${JSON.stringify(dateRange)}）。`,
      );
    }
    // 确保 start <= end
    const [start, end] = dateRange.split(':');
    if (start > end) {
      throw new BadRequestException(
        `params.date_range 起始日期 ${start} 不得晚于结束日期 ${end}。`,
      );
    }
  }

  // ---- labels 专属 fail-fast：scheme / label_ref / (strategy_id + strategy_version) 三者至少其一 ----
  if (rt === 'labels') {
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
    runType: rt,
    params,
    priority,
    maxAttempts,
    parentJobId,
    createdBy,
    labelRef,
  };
}
