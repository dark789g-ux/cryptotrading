import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';

/**
 * `PATCH /api/quant/strategies/:id/:version` 请求体校验。
 *
 * 不可变版本模型（spec 02 §3 / 04 §5）：
 *   语义字段 `exit_rules`（及 PK `strategy_id` / `strategy_version`）不可原地改——
 *   改了即另一套出场规则，会让引用该策略的历史 `factors.labels` 与定义不一致、不可复现。
 *   → PATCH 收到这些字段 → 拒绝 422，提示新建版本（同 strategy_id，递增 strategy_version）。
 *
 *   可 PATCH 的展示元数据：name / description / enabled / display_order
 *
 * 与 update-label.dto.ts 同风格（labels 用 400；本任务 spec 明确语义字段不可改 → 422，
 * 由 controller 把 BadRequestException 映射为 422，见 strategies.controller.ts 注释）。
 */

/** 语义字段列表：PATCH 时若出现任何一个 → 422 */
export const SEMANTIC_FIELDS: ReadonlyArray<string> = [
  'exit_rules',
  'strategy_id',
  'strategy_version',
] as const;

export interface UpdateStrategyDto {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  display_order?: number;
}

/** 内部已校验形态（驼峰） */
export interface ValidatedUpdateStrategy {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  displayOrder?: number;
}

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n);
}

const NAME_MAX = 100;
const DESCRIPTION_MAX = 500;

/**
 * @throws BadRequestException 语义字段出现 / 校验失败。
 *   controller 把语义字段错误映射为 422（UnprocessableEntity），见 controller 注释。
 */
export function validateUpdateStrategy(input: unknown): ValidatedUpdateStrategy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('body 必须是对象');
  }
  const body = input as Record<string, unknown>;

  // 检查语义字段：一旦出现任何一个 → 拒绝（语义字段不可原地改）
  const illegalFields = SEMANTIC_FIELDS.filter((f) => f in body);
  if (illegalFields.length > 0) {
    throw new UnprocessableEntityException(
      `字段 [${illegalFields.join(', ')}] 为语义字段，不可原地修改。` +
        '若需变更出场规则，请 POST 新建版本（同 strategy_id，递增 strategy_version）。',
    );
  }

  const out: ValidatedUpdateStrategy = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.length === 0) {
      throw new BadRequestException('name 不得为空字符串');
    }
    if (body.name.length > NAME_MAX) {
      throw new BadRequestException(`name 长度不得超过 ${NAME_MAX}`);
    }
    out.name = body.name;
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      throw new BadRequestException('description 必须为字符串或 null');
    }
    if (typeof body.description === 'string' && body.description.length > DESCRIPTION_MAX) {
      throw new BadRequestException(`description 长度不得超过 ${DESCRIPTION_MAX}`);
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
