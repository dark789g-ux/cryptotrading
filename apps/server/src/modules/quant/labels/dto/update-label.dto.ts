import { BadRequestException } from '@nestjs/common';

/**
 * `PATCH /api/quant/labels/:id/:version` 请求体校验。
 *
 * 版本化策略（spec 03-backend.md）：
 *   语义字段（base_type / base_params / classify_mode / classify_params）不可原地改。
 *   改了即另一个训练目标，会让旧 model_run 追溯失真。
 *   → PATCH 收到这些字段 → 拒绝 400，提示新建版本。
 *
 *   可 PATCH 的展示元数据：name / description / enabled / display_order
 */

/** 语义字段列表：PATCH 时若出现任何一个 → 400 */
export const SEMANTIC_FIELDS: ReadonlyArray<string> = [
  'base_type',
  'base_params',
  'classify_mode',
  'classify_params',
] as const;

export interface UpdateLabelDto {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  display_order?: number;
}

/** 内部已校验形态（驼峰） */
export interface ValidatedUpdateLabel {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  displayOrder?: number;
}

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n);
}

export function validateUpdateLabel(input: unknown): ValidatedUpdateLabel {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('body 必须是对象');
  }
  const body = input as Record<string, unknown>;

  // 检查语义字段：一旦出现任何一个 → 400 提示新建版本
  const illegalFields = SEMANTIC_FIELDS.filter((f) => f in body);
  if (illegalFields.length > 0) {
    throw new BadRequestException(
      `字段 [${illegalFields.join(', ')}] 为语义字段，不可原地修改。` +
        '若需变更训练目标，请 POST 新建版本（同 label_id，递增 label_version）。',
    );
  }

  const out: ValidatedUpdateLabel = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.length === 0) {
      throw new BadRequestException('name 不得为空字符串');
    }
    out.name = body.name;
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      throw new BadRequestException('description 必须为字符串或 null');
    }
    out.description = body.description as string | null;
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      throw new BadRequestException('enabled 必须为 boolean');
    }
    out.enabled = body.enabled;
  }

  if (body.display_order !== undefined && body.display_order !== null) {
    if (!isInt(body.display_order) || body.display_order < 0 || body.display_order > 9999) {
      throw new BadRequestException('display_order 必须为 0..9999 之间的整数');
    }
    out.displayOrder = body.display_order;
  }

  return out;
}
