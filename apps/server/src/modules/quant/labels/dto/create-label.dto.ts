import { BadRequestException } from '@nestjs/common';

/**
 * `POST /api/quant/labels` 请求体校验。
 *
 * 沿用项目约定（未引入 class-validator）：
 *   - interface 仅声明类型
 *   - `validate*` 函数做实际校验，controller 显式调用
 *
 * base_type / classify_mode 合法枚举权威在 Python labels 模块，
 * 后端枚举为**镜像**，注释指向权威源：
 *   `apps/quant-pipeline/src/quant_pipeline/labels/`
 * 不在 DB 加 CHECK（避免三处真相源；加新类型需改 migration）。
 *
 * 组合校验（spec 03-backend.md）：
 *   fwd_ret      → base_params.horizon ≥ 1 整数
 *   strategy_aware → base_params.{strategy_id, strategy_version}（引用出场策略定义；
 *                    存在且 enabled=true 的引用完整性校验在 labels.service.create，
 *                    spec 2026-06-06-quant-strategy-management-design 04 §6）
 *   band         → classify_params.eps > 0
 *   tercile      → 无额外参数（classify_params 忽略）
 *   custom       → classify_params.thresholds 为数字数组（不为空）
 */

/** 权威在 Python `labels/` 模块 */
export const LABEL_BASE_TYPES = ['fwd_ret', 'strategy_aware'] as const;
export type LabelBaseType = (typeof LABEL_BASE_TYPES)[number];

/** 权威在 Python `labels/classify.py` */
export const LABEL_CLASSIFY_MODES = ['band', 'tercile', 'custom'] as const;
export type LabelClassifyMode = (typeof LABEL_CLASSIFY_MODES)[number];

export interface CreateLabelDto {
  label_id: string;
  label_version: string;
  name: string;
  base_type: LabelBaseType;
  base_params?: Record<string, unknown>;
  classify_mode?: LabelClassifyMode | null;
  classify_params?: Record<string, unknown>;
  description?: string | null;
  enabled?: boolean;
  display_order?: number;
}

/** 内部已校验形态（驼峰，与 entity 属性对齐） */
export interface ValidatedCreateLabel {
  labelId: string;
  labelVersion: string;
  name: string;
  baseType: string;
  baseParams: Record<string, unknown>;
  classifyMode: string | null;
  classifyParams: Record<string, unknown>;
  description?: string | null;
  enabled: boolean;
  displayOrder: number;
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1;
}

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n);
}

/**
 * 按 base_type 校验 base_params 组合规则。
 *
 * 权威：Python `labels/_validate_params()`；后端第一层即时反馈。
 */
function validateBaseParams(
  baseType: string,
  baseParams: Record<string, unknown>,
): void {
  if (baseType === 'fwd_ret') {
    const horizon = baseParams.horizon;
    if (!isPositiveInt(horizon)) {
      throw new BadRequestException(
        'base_type=fwd_ret 时 base_params.horizon 必须为 ≥1 的整数',
      );
    }
  } else if (baseType === 'strategy_aware') {
    // 引用出场策略定义（factors.strategy_definitions），形状校验在此；
    // 引用完整性（策略存在且 enabled=true）在 labels.service.create 二次校验
    // （需查 DB，DTO 层做不到，spec 04 §6.2）。
    const strategyId = baseParams.strategy_id;
    const strategyVersion = baseParams.strategy_version;
    if (typeof strategyId !== 'string' || !/^[a-z0-9_]{1,64}$/.test(strategyId)) {
      throw new BadRequestException(
        'base_type=strategy_aware 时 base_params.strategy_id 必须匹配 /^[a-z0-9_]{1,64}$/',
      );
    }
    if (typeof strategyVersion !== 'string' || !/^v\d+$/.test(strategyVersion)) {
      throw new BadRequestException(
        'base_type=strategy_aware 时 base_params.strategy_version 必须匹配 /^v\\d+$/（如 v1）',
      );
    }
  }
  // 未来新 base_type 由 Python 做最终防线；后端不强断未知 base_type 的 params（forward-compatible）
}

/**
 * 按 classify_mode 校验 classify_params 组合规则。
 *
 * 权威：Python `labels/classify.py`；后端第一层即时反馈。
 */
function validateClassifyParams(
  classifyMode: string | null,
  classifyParams: Record<string, unknown>,
): void {
  if (classifyMode === 'band') {
    const eps = classifyParams.eps;
    if (typeof eps !== 'number' || eps <= 0) {
      throw new BadRequestException(
        'classify_mode=band 时 classify_params.eps 必须为正数',
      );
    }
  } else if (classifyMode === 'custom') {
    const thresholds = classifyParams.thresholds;
    if (
      !Array.isArray(thresholds) ||
      thresholds.length === 0 ||
      thresholds.some((t) => typeof t !== 'number')
    ) {
      throw new BadRequestException(
        'classify_mode=custom 时 classify_params.thresholds 必须为非空数字数组',
      );
    }
  }
  // tercile 和 NULL 无额外约束
}

export function validateCreateLabel(input: unknown): ValidatedCreateLabel {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('body 必须是对象');
  }
  const body = input as Record<string, unknown>;

  // label_id
  if (typeof body.label_id !== 'string' || body.label_id.length === 0 || body.label_id.length > 64) {
    throw new BadRequestException('label_id 必须为 1..64 字符的字符串');
  }
  const labelId = body.label_id;

  // label_version
  if (typeof body.label_version !== 'string' || body.label_version.length === 0 || body.label_version.length > 16) {
    throw new BadRequestException('label_version 必须为 1..16 字符的字符串（如 v1）');
  }
  const labelVersion = body.label_version;

  // name
  if (typeof body.name !== 'string' || body.name.length === 0) {
    throw new BadRequestException('name 必填，不得为空');
  }
  const name = body.name;

  // base_type
  if (
    typeof body.base_type !== 'string' ||
    !LABEL_BASE_TYPES.includes(body.base_type as LabelBaseType)
  ) {
    throw new BadRequestException(
      `base_type 必须 ∈ {${LABEL_BASE_TYPES.join('|')}}，实际 ${JSON.stringify(body.base_type)}`,
    );
  }
  const baseType = body.base_type as LabelBaseType;

  // base_params
  let baseParams: Record<string, unknown> = {};
  if (body.base_params !== undefined && body.base_params !== null) {
    if (typeof body.base_params !== 'object' || Array.isArray(body.base_params)) {
      throw new BadRequestException('base_params 必须为对象');
    }
    baseParams = body.base_params as Record<string, unknown>;
  }
  validateBaseParams(baseType, baseParams);

  // classify_mode（nullable → NULL = 连续）
  let classifyMode: string | null = null;
  if (body.classify_mode !== undefined && body.classify_mode !== null) {
    if (
      typeof body.classify_mode !== 'string' ||
      !LABEL_CLASSIFY_MODES.includes(body.classify_mode as LabelClassifyMode)
    ) {
      throw new BadRequestException(
        `classify_mode 必须 ∈ {${LABEL_CLASSIFY_MODES.join('|')}} 或 null，实际 ${JSON.stringify(body.classify_mode)}`,
      );
    }
    classifyMode = body.classify_mode;
  }

  // classify_params
  let classifyParams: Record<string, unknown> = {};
  if (body.classify_params !== undefined && body.classify_params !== null) {
    if (typeof body.classify_params !== 'object' || Array.isArray(body.classify_params)) {
      throw new BadRequestException('classify_params 必须为对象');
    }
    classifyParams = body.classify_params as Record<string, unknown>;
  }
  validateClassifyParams(classifyMode, classifyParams);

  // description
  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      throw new BadRequestException('description 必须为字符串');
    }
    description = body.description;
  }

  // enabled
  let enabled = true;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      throw new BadRequestException('enabled 必须为 boolean');
    }
    enabled = body.enabled;
  }

  // display_order
  let displayOrder = 0;
  if (body.display_order !== undefined && body.display_order !== null) {
    if (!isInt(body.display_order) || body.display_order < 0 || body.display_order > 9999) {
      throw new BadRequestException('display_order 必须为 0..9999 之间的整数');
    }
    displayOrder = body.display_order;
  }

  return {
    labelId,
    labelVersion,
    name,
    baseType,
    baseParams,
    classifyMode,
    classifyParams,
    description,
    enabled,
    displayOrder,
  };
}
