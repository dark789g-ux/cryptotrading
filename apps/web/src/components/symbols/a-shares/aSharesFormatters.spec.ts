import { describe, expect, it } from 'vitest'
import { formatVolumeRatio } from './aSharesFormatters'

describe('formatVolumeRatio', () => {
  it('正常小数保留 2 位并加"倍"后缀', () => {
    expect(formatVolumeRatio('1.2345')).toBe('1.23倍')
  })

  it('整数补齐 2 位小数', () => {
    expect(formatVolumeRatio('2')).toBe('2.00倍')
  })

  it('null 返回 "-"（不返回 "-倍"）', () => {
    expect(formatVolumeRatio(null)).toBe('-')
  })

  it('非有限数返回 "-"（不返回 "-倍"）', () => {
    expect(formatVolumeRatio('abc')).toBe('-')
  })
})
