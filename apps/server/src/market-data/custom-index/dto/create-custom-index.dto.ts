import { BadRequestException } from '@nestjs/common';
import type { CustomIndexType, CustomIndexWeightMethod } from '../../../entities/custom-index/custom-index-definition.entity';
import type { MemberInput } from '../custom-index.types';
import { MAX_CUSTOM_INDEX_MEMBERS, MIN_CUSTOM_INDEX_MEMBERS } from '../custom-index.types';

export interface CreateCustomIndexBody {
  name: string;
  description?: string | null;
  index_type: CustomIndexType;
  base_date: string;
  base_point?: number;
  weight_method: CustomIndexWeightMethod;
  effective_date: string;
  members: MemberInput[];
  custom_weights?: Record<string, number> | null;
}

export function validateCreateCustomIndexBody(body: unknown): CreateCustomIndexBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('请求体须为 JSON 对象');
  }
  const b = body as Record<string, unknown>;

  const name = requireString(b.name, 'name');
  if (name.length === 0 || name.length > 100) {
    throw new BadRequestException('name 长度须在 1–100');
  }

  const indexType = requireEnum(b.index_type, ['price', 'total_return'], 'index_type') as CustomIndexType;
  const baseDate = requireYmd(b.base_date, 'base_date');
  const weightMethod = requireEnum(
    b.weight_method,
    ['equal', 'float_mv', 'custom'],
    'weight_method',
  ) as CustomIndexWeightMethod;
  const effectiveDate = requireYmd(b.effective_date, 'effective_date');

  let basePoint = 1000;
  if (b.base_point !== undefined && b.base_point !== null) {
    basePoint = requirePositiveNumber(b.base_point, 'base_point');
  }

  const members = requireMembers(b.members);
  validateMemberCount(members.length);

  if (weightMethod === 'custom') {
    for (const m of members) {
      if (m.weight === undefined) {
        throw new BadRequestException('weight_method=custom 时 members 每项须带 weight');
      }
    }
  }

  const description =
    b.description === undefined || b.description === null
      ? null
      : String(b.description);

  return {
    name,
    description,
    index_type: indexType,
    base_date: baseDate,
    base_point: basePoint,
    weight_method: weightMethod,
    effective_date: effectiveDate,
    members,
    custom_weights: null,
  };
}

export interface UpdateCustomIndexBody {
  name?: string;
  description?: string | null;
  index_type?: CustomIndexType;
  members?: MemberInput[];
  weight_method?: CustomIndexWeightMethod;
  custom_weights?: Record<string, number> | null;
  effective_date?: string;
}

export function validateUpdateCustomIndexBody(body: unknown): UpdateCustomIndexBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('请求体须为 JSON 对象');
  }
  const b = body as Record<string, unknown>;
  const out: UpdateCustomIndexBody = {};

  if (b.name !== undefined) {
    const name = requireString(b.name, 'name');
    if (name.length === 0 || name.length > 100) {
      throw new BadRequestException('name 长度须在 1–100');
    }
    out.name = name;
  }
  if (b.description !== undefined) {
    out.description = b.description === null ? null : String(b.description);
  }
  if (b.index_type !== undefined) {
    out.index_type = requireEnum(b.index_type, ['price', 'total_return'], 'index_type') as CustomIndexType;
  }
  if (b.weight_method !== undefined) {
    out.weight_method = requireEnum(
      b.weight_method,
      ['equal', 'float_mv', 'custom'],
      'weight_method',
    ) as CustomIndexWeightMethod;
  }
  if (b.effective_date !== undefined) {
    out.effective_date = requireYmd(b.effective_date, 'effective_date');
  }
  if (b.members !== undefined) {
    const members = requireMembers(b.members);
    validateMemberCount(members.length);
    out.members = members;
  }

  return out;
}

export interface PreviewWeightsBody {
  weight_method: CustomIndexWeightMethod;
  members: MemberInput[];
  effective_date: string;
}

export function validatePreviewWeightsBody(body: unknown): PreviewWeightsBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('请求体须为 JSON 对象');
  }
  const b = body as Record<string, unknown>;
  const weightMethod = requireEnum(
    b.weight_method,
    ['equal', 'float_mv', 'custom'],
    'weight_method',
  ) as CustomIndexWeightMethod;
  const members = requireMembers(b.members);
  validateMemberCount(members.length);
  const effectiveDate = requireYmd(b.effective_date, 'effective_date');

  if (weightMethod === 'custom') {
    for (const m of members) {
      if (m.weight === undefined) {
        throw new BadRequestException('weight_method=custom 时 members 每项须带 weight');
      }
    }
  }

  return { weight_method: weightMethod, members, effective_date: effectiveDate };
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string') {
    throw new BadRequestException(`${field} 须为字符串`);
  }
  return v.trim();
}

function requireYmd(v: unknown, field: string): string {
  const s = requireString(v, field);
  if (!/^\d{8}$/.test(s)) {
    throw new BadRequestException(`${field} 须为 YYYYMMDD`);
  }
  return s;
}

function requirePositiveNumber(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BadRequestException(`${field} 须为正数`);
  }
  return n;
}

function requireEnum(v: unknown, allowed: string[], field: string): string {
  if (typeof v !== 'string' || !allowed.includes(v)) {
    throw new BadRequestException(`${field} 须 ∈ {${allowed.join('|')}}`);
  }
  return v;
}

function requireMembers(v: unknown): MemberInput[] {
  if (!Array.isArray(v)) {
    throw new BadRequestException('members 须为数组');
  }
  return v.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new BadRequestException(`members[${i}] 须为对象`);
    }
    const row = item as Record<string, unknown>;
    const conCode = requireString(row.con_code, `members[${i}].con_code`);
    const out: MemberInput = { con_code: conCode };
    if (row.weight !== undefined && row.weight !== null) {
      const w = Number(row.weight);
      if (!Number.isFinite(w) || w < 0 || w > 1) {
        throw new BadRequestException(`members[${i}].weight 须在 0–1`);
      }
      out.weight = w;
    }
    return out;
  });
}

function validateMemberCount(count: number): void {
  if (count < MIN_CUSTOM_INDEX_MEMBERS || count > MAX_CUSTOM_INDEX_MEMBERS) {
    throw new BadRequestException(
      `成分数量须在 ${MIN_CUSTOM_INDEX_MEMBERS}–${MAX_CUSTOM_INDEX_MEMBERS} 之间，实际 ${count}`,
    );
  }
}
