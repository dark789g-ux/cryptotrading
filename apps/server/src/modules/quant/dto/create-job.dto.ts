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
  /** true 时建为草稿（status=draft，worker 不捞）；默认 false 仍落 pending（M2 草稿态，spec 06 §6.3.2） */
  as_draft?: boolean;
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
  'kelly_sweep',
  // 美股 AkShare 同步（spec 2026-06-16-us-stocks-tab-design 05）。
  // 不属 LABEL_REF / FEATURE_SET run_type，create() 直接落 pending，无 labelRef / feature_set 校验。
  'us_sync',
  // 美股指数 AkShare 同步（spec 2026-06-16-us-index-subtab-design 02）。同上不属 LABEL_REF / FEATURE_SET。
  'us_index_sync',
  // 美股指数活跃市值（AMV）同步（spec 2026-06-16-us-index-amv-design 02）。同上不属 LABEL_REF / FEATURE_SET。
  'us_index_amv_sync',
  // 美股一键同步（spec 2026-06-17-us-sync-tab-design 02）。同上不属 LABEL_REF / FEATURE_SET。
  'us_one_click_sync',
  // custom_index_compute：历史 run_type；新代码由 NestJS Runner 计算，不再 INSERT ml.jobs（spec 2026-06-28）
] as const;

/**
 * `kelly_sweep` base_trigger.field 白名单。
 *
 * 唯一真相源：apps/quant-pipeline/src/quant_pipeline/research/kelly_sweep/enumerate.py:57
 * （_ALLOWED_INDICATOR_FIELDS frozenset，2026-06-09 核实全部成员）。
 * 改 Python 白名单时须同步此处。
 */
export const KELLY_SWEEP_ALLOWED_BASE_FIELDS: ReadonlySet<string> = new Set([
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
]);

/** kelly_sweep exit_families 合法成员 */
const KELLY_SWEEP_EXIT_FAMILIES: ReadonlySet<string> = new Set([
  'fixed_n',
  'tp_sl',
  'trailing',
  'atr_stop',
]);

/** YYYYMMDD 格式校验 */
const YYYYMMDD_RE = /^\d{8}$/;

/**
 * 校验 kelly_sweep 的 params 字段（12 个 SweepConfig 字段 + exit_families）。
 * 深度校验由 Python pydantic SweepConfig 兜底；NestJS 做基础边界与格式校验。
 *
 * 口径：apps/quant-pipeline/src/quant_pipeline/research/kelly_sweep/config.py:23-110
 */
export function validateKellySweepParams(params: Record<string, unknown>): void {
  // base_trigger
  const bt = params.base_trigger;
  if (!bt || typeof bt !== 'object' || Array.isArray(bt)) {
    throw new BadRequestException('kelly_sweep params.base_trigger 必须是对象 {field, op, value}');
  }
  const trigger = bt as Record<string, unknown>;
  if (typeof trigger.field !== 'string' || !KELLY_SWEEP_ALLOWED_BASE_FIELDS.has(trigger.field)) {
    throw new BadRequestException(
      `kelly_sweep params.base_trigger.field 必须 ∈ 白名单，实际 ${JSON.stringify(trigger.field)}。` +
        `允许值：${[...KELLY_SWEEP_ALLOWED_BASE_FIELDS].join(',')}`,
    );
  }
  const validOps = ['lt', 'lte', 'gt', 'gte', 'eq', 'neq'];
  if (typeof trigger.op !== 'string' || !validOps.includes(trigger.op)) {
    throw new BadRequestException(
      `kelly_sweep params.base_trigger.op 必须 ∈ {${validOps.join('|')}}，实际 ${JSON.stringify(trigger.op)}`,
    );
  }
  if (typeof trigger.value !== 'number') {
    throw new BadRequestException('kelly_sweep params.base_trigger.value 必须是数字');
  }

  // universe
  const universe = params.universe;
  if (universe !== 'all') {
    if (!Array.isArray(universe) || universe.some((v) => typeof v !== 'string')) {
      throw new BadRequestException(
        "kelly_sweep params.universe 必须是 'all' 或 string[] (ts_code 列表)",
      );
    }
  }

  // train_range / valid_range
  for (const rangeKey of ['train_range', 'valid_range'] as const) {
    const range = params[rangeKey];
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !YYYYMMDD_RE.test(range[0] as string) ||
      !YYYYMMDD_RE.test(range[1] as string)
    ) {
      throw new BadRequestException(
        `kelly_sweep params.${rangeKey} 必须是 [YYYYMMDD, YYYYMMDD] 二元组`,
      );
    }
    if ((range[0] as string) > (range[1] as string)) {
      throw new BadRequestException(
        `kelly_sweep params.${rangeKey}[0] (${range[0]}) 不得晚于 ${rangeKey}[1] (${range[1]})`,
      );
    }
  }
  // train_start <= valid_start
  const trainRange = params.train_range as [string, string];
  const validRange = params.valid_range as [string, string];
  if (trainRange[0] > validRange[0]) {
    throw new BadRequestException(
      `kelly_sweep params.train_range[0] (${trainRange[0]}) 不得晚于 valid_range[0] (${validRange[0]})`,
    );
  }

  // 数值下界
  const numChecks: [string, number][] = [
    ['max_window', 1],
    ['min_samples', 1],
    ['bootstrap_iters', 1],
    ['rs_lookback', 1],
    ['top_k', 1],
  ];
  for (const [field, minVal] of numChecks) {
    const v = params[field];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < minVal) {
      throw new BadRequestException(
        `kelly_sweep params.${field} 必须是整数且 >= ${minVal}，实际 ${JSON.stringify(v)}`,
      );
    }
  }
  // max_entry_filters >= 0
  const mef = params.max_entry_filters;
  if (typeof mef !== 'number' || !Number.isInteger(mef) || mef < 0) {
    throw new BadRequestException(
      `kelly_sweep params.max_entry_filters 必须是整数且 >= 0，实际 ${JSON.stringify(mef)}`,
    );
  }

  // same_day_rule
  if (params.same_day_rule !== 'sl_first' && params.same_day_rule !== 'tp_first') {
    throw new BadRequestException(
      `kelly_sweep params.same_day_rule 必须是 'sl_first' 或 'tp_first'，实际 ${JSON.stringify(params.same_day_rule)}`,
    );
  }

  // rs_benchmark：只允许 hs300/zz500（industry 暂未接通，禁止提交）
  const rsb = params.rs_benchmark;
  if (!Array.isArray(rsb) || rsb.length === 0) {
    throw new BadRequestException(
      "kelly_sweep params.rs_benchmark 必须是非空数组，成员 ∈ ['hs300','zz500']",
    );
  }
  for (const b of rsb as unknown[]) {
    if (b !== 'hs300' && b !== 'zz500') {
      throw new BadRequestException(
        `kelly_sweep params.rs_benchmark 成员只允许 'hs300'|'zz500'（'industry' 暂未接通，禁止提交），实际 ${JSON.stringify(b)}`,
      );
    }
  }

  // exit_families：非空 ⊆ {fixed_n,tp_sl,trailing,atr_stop}
  const ef = params.exit_families;
  if (!Array.isArray(ef) || (ef as unknown[]).length === 0) {
    throw new BadRequestException(
      `kelly_sweep params.exit_families 必须是非空数组，成员 ∈ {${[...KELLY_SWEEP_EXIT_FAMILIES].join(',')}}`,
    );
  }
  for (const f of ef as unknown[]) {
    if (typeof f !== 'string' || !KELLY_SWEEP_EXIT_FAMILIES.has(f)) {
      throw new BadRequestException(
        `kelly_sweep params.exit_families 成员必须 ∈ {${[...KELLY_SWEEP_EXIT_FAMILIES].join(',')}}，实际 ${JSON.stringify(f)}`,
      );
    }
  }
}

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
  /**
   * true → create() 落 status=draft；缺省 / false 落 pending（向后兼容，M2 草稿态）。
   * validateCreateJob 始终回填布尔值；声明为可选仅为兼容直接构造 dto 的内部调用方（如单测 / cron）。
   */
  asDraft?: boolean;
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

  // as_draft：可选布尔，默认 false（向后兼容，M2 草稿态）。非布尔显式传入则 400。
  let asDraft = false;
  if (body.as_draft !== undefined && body.as_draft !== null) {
    if (typeof body.as_draft !== 'boolean') {
      throw new BadRequestException('as_draft 必须为布尔值');
    }
    asDraft = body.as_draft;
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

  // ---- kelly_sweep params 深度校验 ----
  if (rt === 'kelly_sweep') {
    validateKellySweepParams(params);
  }

  return {
    runType: rt,
    params,
    priority,
    maxAttempts,
    parentJobId,
    createdBy,
    labelRef,
    asDraft,
  };
}
