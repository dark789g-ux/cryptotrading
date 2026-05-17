import { BadRequestException } from '@nestjs/common';
import type { MlQualityLevel } from '../../../entities/ml/ml-quality-report.entity';

/**
 * `GET /quant/quality/*` 查询 DTO。
 *
 * 沿用 module 既有手写校验风格（见 create-job.dto.ts），不引入 class-validator。
 */

const TRADE_DATE_RE = /^\d{8}$/;
const ALLOWED_LEVELS: readonly MlQualityLevel[] = ['info', 'warn', 'critical'] as const;
// `level=warn` 与 `level=warn,critical` 两种形式均支持
const LEVEL_TOKEN_RE = /^(info|warn|critical)(,(info|warn|critical))*$/;

export function validateQualityByDateParam(dateRaw: string): string {
  if (typeof dateRaw !== 'string' || !TRADE_DATE_RE.test(dateRaw)) {
    throw new BadRequestException('date 必须为 8 位数字串 YYYYMMDD');
  }
  return dateRaw;
}

/**
 * 解析 `?level=warn,critical` —— 与 recent 同一约束（spec M3 §5）。
 * 不传 → undefined（service 端不加 level 过滤）。
 */
export function validateQualityLevelQuery(
  raw: unknown,
): MlQualityLevel[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const s = String(raw);
  if (!LEVEL_TOKEN_RE.test(s)) {
    throw new BadRequestException(
      `level 必须为 {${ALLOWED_LEVELS.join('|')}} 的逗号分隔列表`,
    );
  }
  const parts = s.split(',').map((t) => t.trim()) as MlQualityLevel[];
  return Array.from(new Set(parts));
}

export class QualityRecentQueryDto {
  /** 1..90 天，默认 7 */
  days?: number;
  /** 多个 level 逗号分隔，如 `warn,critical`；不传表示不过滤 */
  level?: string;
}

export interface ValidatedQualityRecentQuery {
  days: number;
  levels?: MlQualityLevel[];
}

export function validateQualityRecentQuery(
  query: Record<string, unknown>,
): ValidatedQualityRecentQuery {
  const out: ValidatedQualityRecentQuery = { days: 7 };

  if (query.days !== undefined && query.days !== null && query.days !== '') {
    const n = parseInt(String(query.days), 10);
    if (!Number.isFinite(n) || n < 1 || n > 90) {
      throw new BadRequestException('days 必须为 1..90 之间的整数');
    }
    out.days = n;
  }

  if (query.level !== undefined && query.level !== null && query.level !== '') {
    const raw = String(query.level);
    if (!LEVEL_TOKEN_RE.test(raw)) {
      throw new BadRequestException(
        `level 必须为 {${ALLOWED_LEVELS.join('|')}} 的逗号分隔列表`,
      );
    }
    const parts = raw.split(',').map((s) => s.trim()) as MlQualityLevel[];
    out.levels = Array.from(new Set(parts));
  }

  return out;
}

export const ALLOWED_QUALITY_LEVELS = ALLOWED_LEVELS;
