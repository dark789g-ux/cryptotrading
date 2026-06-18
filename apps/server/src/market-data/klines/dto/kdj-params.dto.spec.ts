import { BadRequestException } from '@nestjs/common';
import { validateKdjParams } from './kdj-params.dto';

describe('validateKdjParams', () => {
  it('接受合法参数', () => {
    expect(validateKdjParams({ n: 9, m1: 3, m2: 3 })).toEqual({ n: 9, m1: 3, m2: 3 });
    expect(validateKdjParams({ n: 2, m1: 1, m2: 1 })).toEqual({ n: 2, m1: 1, m2: 1 });
    expect(validateKdjParams({ n: 99, m1: 50, m2: 50 })).toEqual({ n: 99, m1: 50, m2: 50 });
  });

  it('拒绝非对象', () => {
    expect(() => validateKdjParams(null)).toThrow(BadRequestException);
    expect(() => validateKdjParams(undefined)).toThrow(BadRequestException);
    expect(() => validateKdjParams([1, 2, 3])).toThrow(BadRequestException);
  });

  it('n 越界或类型错误 → BadRequestException', () => {
    expect(() => validateKdjParams({ n: 1, m1: 3, m2: 3 })).toThrow(BadRequestException);
    expect(() => validateKdjParams({ n: 100, m1: 3, m2: 3 })).toThrow(BadRequestException);
    expect(() => validateKdjParams({ n: 9.5, m1: 3, m2: 3 })).toThrow(BadRequestException);
    expect(() => validateKdjParams({ n: '9', m1: 3, m2: 3 } as any)).toThrow(BadRequestException);
  });

  it('m1 / m2 越界或类型错误 → BadRequestException', () => {
    expect(() => validateKdjParams({ n: 9, m1: 0, m2: 3 })).toThrow(BadRequestException);
    expect(() => validateKdjParams({ n: 9, m1: 51, m2: 3 })).toThrow(BadRequestException);
    expect(() => validateKdjParams({ n: 9, m1: 3, m2: 0 })).toThrow(BadRequestException);
    expect(() => validateKdjParams({ n: 9, m1: 3, m2: 51 })).toThrow(BadRequestException);
    expect(() => validateKdjParams({ n: 9, m1: 3.5, m2: 3 })).toThrow(BadRequestException);
  });
});
