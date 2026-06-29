import { describe, expect, it } from 'vitest'
import {
  COLUMN_GROUPS,
  DEFAULT_EXPANDED_GROUPS,
  resolveColumnGroup,
  getColumnGroupLabel,
} from './columnGroupMeta'

describe('columnGroupMeta', () => {
  it('COLUMN_GROUPS 含新增 amv / brick 两组，且位置在 risk 与 signal 之间', () => {
    const keys = COLUMN_GROUPS.map((g) => g.key)
    expect(keys).toContain('amv')
    expect(keys).toContain('brick')

    const idxRisk = keys.indexOf('risk')
    const idxAmv = keys.indexOf('amv')
    const idxBrick = keys.indexOf('brick')
    const idxSignal = keys.indexOf('signal')
    expect(idxRisk).toBeLessThan(idxAmv)
    expect(idxAmv).toBeLessThan(idxBrick)
    expect(idxBrick).toBeLessThan(idxSignal)
  })

  it('新组 label 正确', () => {
    expect(getColumnGroupLabel('amv')).toBe('活跃市值')
    expect(getColumnGroupLabel('brick')).toBe('砖块图')
  })

  it('amv 三列归入 amv 组', () => {
    expect(resolveColumnGroup('amvDif')).toBe('amv')
    expect(resolveColumnGroup('amvDea')).toBe('amv')
    expect(resolveColumnGroup('amvMacd')).toBe('amv')
  })

  it('brick 三列归入 brick 组', () => {
    expect(resolveColumnGroup('brick')).toBe('brick')
    expect(resolveColumnGroup('brickDelta')).toBe('brick')
    expect(resolveColumnGroup('brickXg')).toBe('brick')
  })

  it('既有映射回归未漂移', () => {
    expect(resolveColumnGroup('ma5')).toBe('ma')
    expect(resolveColumnGroup('ma240')).toBe('ma')
    expect(resolveColumnGroup('bbi')).toBe('ma')
    expect(resolveColumnGroup('kdjJ')).toBe('kdjMacd')
    expect(resolveColumnGroup('macd')).toBe('kdjMacd')
    expect(resolveColumnGroup('atr14')).toBe('risk')
    expect(resolveColumnGroup('stopLossPct')).toBe('risk')
    expect(resolveColumnGroup('quoteVolume10')).toBe('quote')
  })

  it('未知 key → meta', () => {
    expect(resolveColumnGroup('whateverUnknown')).toBe('meta')
  })

  it('DEFAULT_EXPANDED_GROUPS 保持 [basic, quote]（新组默认折叠）', () => {
    expect(DEFAULT_EXPANDED_GROUPS).toEqual(['basic', 'quote'])
  })
})
