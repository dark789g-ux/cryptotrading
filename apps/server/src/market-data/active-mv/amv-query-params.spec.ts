import { BadRequestException } from '@nestjs/common'
import { assertSwIndexSuffix, parseAmvDaysAndRange } from './amv-query-params'

describe('parseAmvDaysAndRange', () => {
  it('无区间时返回 days', () => {
    expect(parseAmvDaysAndRange('120')).toEqual({
      daysNum: 120,
      range: undefined,
    })
  })

  it('有 startDate/endDate 时进入 range 模式', () => {
    expect(parseAmvDaysAndRange('250', '20240101', '20241231')).toEqual({
      daysNum: 250,
      range: { startDate: '20240101', endDate: '20241231' },
    })
  })

  it('非法 startDate 抛 BadRequestException', () => {
    expect(() => parseAmvDaysAndRange(undefined, '2024-01-01')).toThrow(BadRequestException)
  })
})

describe('assertSwIndexSuffix', () => {
  it('非 .SI 后缀抛 BadRequestException', () => {
    expect(() => assertSwIndexSuffix('885001.TI')).toThrow(BadRequestException)
  })

  it('.SI 后缀通过', () => {
    expect(() => assertSwIndexSuffix('801750.SI')).not.toThrow()
  })
})
