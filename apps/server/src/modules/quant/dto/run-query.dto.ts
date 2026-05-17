import { BadRequestException } from '@nestjs/common';

/**
 * `GET /quant/runs*` 查询 DTO。
 *
 * 沿用 module 既有手写校验风格（见 create-job.dto.ts），不引入 class-validator。
 */

const MODEL_VERSION_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Service / Controller 接受的排序字段白名单（前端字段名 → 列名见 RUNS_FIELD_COL_MAP） */
const ALLOWED_SORT_FIELDS: readonly string[] = [
  'created_at',
  'model_version',
] as const;
const ALLOWED_SORT_DIRS: readonly string[] = ['ASC', 'DESC'] as const;

export class RunQueryDto {
  model_version?: string;
  /** 形如 `created_at:DESC` 或 `model_version:ASC` */
  sort_by?: string;
  page?: number;
  page_size?: number;
}

export interface ValidatedRunQuery {
  modelVersion?: string;
  sortField?: string; // 前端字段名（未翻译为列名），交给 service 走 FIELD_COL_MAP
  sortDir?: 'ASC' | 'DESC';
  page: number;
  pageSize: number;
}

export function validateRunQuery(query: Record<string, unknown>): ValidatedRunQuery {
  const out: ValidatedRunQuery = { page: 1, pageSize: 20 };

  if (query.model_version !== undefined && query.model_version !== null && query.model_version !== '') {
    const v = String(query.model_version);
    if (!MODEL_VERSION_RE.test(v)) {
      throw new BadRequestException(
        'model_version 必须为 1..128 长度，且仅含字母/数字/下划线/短横线',
      );
    }
    out.modelVersion = v;
  }

  if (query.sort_by !== undefined && query.sort_by !== null && query.sort_by !== '') {
    const raw = String(query.sort_by);
    const [field, dirRaw] = raw.split(':');
    if (!field) {
      throw new BadRequestException('sort_by 必须形如 `field:ASC|DESC`');
    }
    if (!ALLOWED_SORT_FIELDS.includes(field)) {
      throw new BadRequestException(
        `sort_by.field 必须 ∈ {${ALLOWED_SORT_FIELDS.join('|')}}`,
      );
    }
    const dir = (dirRaw ?? 'DESC').toUpperCase();
    if (!ALLOWED_SORT_DIRS.includes(dir)) {
      throw new BadRequestException(`sort_by.dir 必须 ∈ {${ALLOWED_SORT_DIRS.join('|')}}`);
    }
    out.sortField = field;
    out.sortDir = dir as 'ASC' | 'DESC';
  }

  if (query.page !== undefined && query.page !== null && query.page !== '') {
    const p = parseInt(String(query.page), 10);
    if (!Number.isFinite(p) || p < 1) {
      throw new BadRequestException('page 必须为 >=1 的整数');
    }
    out.page = p;
  }

  if (query.page_size !== undefined && query.page_size !== null && query.page_size !== '') {
    const ps = parseInt(String(query.page_size), 10);
    if (!Number.isFinite(ps) || ps < 1 || ps > 200) {
      throw new BadRequestException('page_size 必须为 1..200 之间的整数');
    }
    out.pageSize = ps;
  }

  return out;
}

export const ALLOWED_RUN_SORT_FIELDS = ALLOWED_SORT_FIELDS;
