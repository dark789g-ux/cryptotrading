import { BadRequestException } from '@nestjs/common';

/**
 * `PATCH /api/quant/factors/:id/:version` 请求体校验。
 *
 * 仓库未引入 class-validator（参考 `create-job.dto.ts`），沿用同款约定：
 *   - interface 仅声明类型
 *   - `validate*` 函数做实际校验，controller 显式调用
 *
 * 规则（spec 03-backend.md「PATCH DTO」 + 2026-05-23-pit-window-guard §4.1.1）：
 *   description?       string  @MaxLength(500)
 *   formula?           string | null  @MaxLength(500)
 *   data_source?       string[] | null（每项 ≤200 字符）
 *   category?          'price' | 'industry' | 'fundamental' | 'mixed'
 *   pit_window_days?   int 1..400（与 min_trade_days 的跨字段校验见 factors.service.ts:update）
 *   pit_anchor?        'trade_date' | 'ann_date'
 *   enabled?           boolean
 *   display_order?     int 0..9999
 *
 * **`min_trade_days` 故意不出现在本 DTO**：它是 Python 子类 `@register` 声明的契约，
 * 由 DB migration 单点定义，不接受 PATCH。前端误传该字段会被静默忽略（不在 out 里），
 * service 内部仍按 DB 当前值参与跨字段校验。
 *
 * - 全部 optional，未传字段保持原值
 * - service 内强写 `updated_at = NOW()` / `updated_by = req.user.id`，
 *   dto 中即使误传这两字段也会被忽略（见 `factors.service.ts` `update()`）
 * - 响应字段保持 snake_case（与 DB / 前端契约对齐）
 */
export const FACTOR_CATEGORIES = ['price', 'industry', 'fundamental', 'mixed'] as const;
export type FactorCategory = (typeof FACTOR_CATEGORIES)[number];

export const FACTOR_PIT_ANCHORS = ['trade_date', 'ann_date'] as const;
export type FactorPitAnchor = (typeof FACTOR_PIT_ANCHORS)[number];

export interface UpdateFactorDefinitionDto {
  description?: string;
  formula?: string | null;
  data_source?: string[] | null;
  category?: FactorCategory;
  pit_window_days?: number;
  pit_anchor?: FactorPitAnchor;
  enabled?: boolean;
  display_order?: number;
}

/** 内部使用的"已校验"形态，沿用其它 quant DTO 的命名 */
export interface ValidatedUpdateFactor {
  description?: string;
  formula?: string | null;
  dataSource?: string[] | null;
  category?: FactorCategory;
  pitWindowDays?: number;
  pitAnchor?: FactorPitAnchor;
  enabled?: boolean;
  displayOrder?: number;
}

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n);
}

export function validateUpdateFactor(input: unknown): ValidatedUpdateFactor {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('body 必须是对象');
  }
  const body = input as Record<string, unknown>;
  const out: ValidatedUpdateFactor = {};

  if (body.description !== undefined) {
    if (typeof body.description !== 'string') {
      throw new BadRequestException('description 必须为字符串');
    }
    if (body.description.length > 500) {
      throw new BadRequestException('description 长度不得超过 500');
    }
    out.description = body.description;
  }

  if (body.formula !== undefined) {
    if (body.formula !== null && typeof body.formula !== 'string') {
      throw new BadRequestException('formula 必须为字符串或 null');
    }
    if (typeof body.formula === 'string' && body.formula.length > 500) {
      throw new BadRequestException('formula 长度不得超过 500');
    }
    out.formula = body.formula as string | null;
  }

  if (body.data_source !== undefined) {
    if (body.data_source === null) {
      out.dataSource = null;
    } else if (!Array.isArray(body.data_source)) {
      throw new BadRequestException('data_source 必须为字符串数组或 null');
    } else {
      const arr = body.data_source as unknown[];
      for (const v of arr) {
        if (typeof v !== 'string') {
          throw new BadRequestException('data_source 每项必须为字符串');
        }
        if ((v as string).length > 200) {
          throw new BadRequestException('data_source 每项长度不得超过 200');
        }
      }
      out.dataSource = arr as string[];
    }
  }

  if (body.category !== undefined) {
    if (
      typeof body.category !== 'string' ||
      !FACTOR_CATEGORIES.includes(body.category as FactorCategory)
    ) {
      throw new BadRequestException(
        `category 必须 ∈ {${FACTOR_CATEGORIES.join('|')}}，实际 ${JSON.stringify(body.category)}`,
      );
    }
    out.category = body.category as FactorCategory;
  }

  if (body.pit_window_days !== undefined) {
    if (!isInt(body.pit_window_days) || body.pit_window_days < 1 || body.pit_window_days > 400) {
      throw new BadRequestException('pit_window_days 必须为 1..400 之间的整数');
    }
    out.pitWindowDays = body.pit_window_days;
  }

  if (body.pit_anchor !== undefined) {
    if (
      typeof body.pit_anchor !== 'string' ||
      !FACTOR_PIT_ANCHORS.includes(body.pit_anchor as FactorPitAnchor)
    ) {
      throw new BadRequestException(
        `pit_anchor 必须 ∈ {${FACTOR_PIT_ANCHORS.join('|')}}`,
      );
    }
    out.pitAnchor = body.pit_anchor as FactorPitAnchor;
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      throw new BadRequestException('enabled 必须为 boolean');
    }
    out.enabled = body.enabled;
  }

  if (body.display_order !== undefined) {
    if (!isInt(body.display_order) || body.display_order < 0 || body.display_order > 9999) {
      throw new BadRequestException('display_order 必须为 0..9999 之间的整数');
    }
    out.displayOrder = body.display_order;
  }

  return out;
}
