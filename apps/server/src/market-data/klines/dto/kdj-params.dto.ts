import { BadRequestException } from '@nestjs/common';

/**
 * KlineChart KDJ 参数 DTO，供 Crypto / A 股 recalc 端点复用。
 *
 * 规则等价于 class-validator 装饰器：
 *   n:  整数，2..99
 *   m1: 整数，1..50
 *   m2: 整数，1..50
 *
 * 项目当前未引入 class-validator（见 apps/server/package.json），沿用既有 DTO
 * 手写校验约定；controller / service 调用 validateKdjParams 做 fail-fast 校验。
 */
export class KdjParamsDto {
  n!: number;
  m1!: number;
  m2!: number;
}

function assertIntInRange(
  obj: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new BadRequestException(`kdjParams.${key} 必须是整数`);
  }
  if (v < min || v > max) {
    throw new BadRequestException(`kdjParams.${key} 必须在 ${min}..${max} 之间`);
  }
  return v;
}

export function validateKdjParams(input: unknown): KdjParamsDto {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('kdjParams 必须是对象 { n, m1, m2 }');
  }
  const body = input as Record<string, unknown>;

  return {
    n: assertIntInRange(body, 'n', 2, 99),
    m1: assertIntInRange(body, 'm1', 1, 50),
    m2: assertIntInRange(body, 'm2', 1, 50),
  };
}
