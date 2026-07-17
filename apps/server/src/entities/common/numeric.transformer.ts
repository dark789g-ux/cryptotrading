import { ValueTransformer } from 'typeorm';

/**
 * PostgreSQL numeric 列经 node-postgres 默认返回 string（防精度丢失）。
 * 本 transformer 把读取值统一转回 number；写入接受 number（或 string 兼容历史调用）。
 *
 * 仅用于 entity 字段类型已声明为 `number | null` 的场景。
 * 不要给 aSharesFormatters 等"故意按 string 处理"的模块使用。
 */
export class NumericTransformer implements ValueTransformer {
  /** DB → entity：string → number；null/undefined/空字符串 保持 null */
  from(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /** entity → DB：number 原样透传（PG numeric 列接受 JS number）；
   *  兼容历史代码可能传入 string 的情况（不强制转换，由 PG driver 处理） */
  to(value: number | string | null | undefined): number | string | null {
    if (value === null || value === undefined) return null;
    return value;
  }
}
