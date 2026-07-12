import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mergeKlineWithAmv } from './mergeAmv'
import type { AmvSeriesRow } from '@/api/modules/market/active-mv'
import type { KlineChartBar } from '@/api'

function makeBar(open_time: string): KlineChartBar {
  return {
    open_time,
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 1000,
    MA5: null,
    MA30: null,
    MA60: null,
    MA120: null,
    MA240: null,
    'KDJ.K': null,
    'KDJ.D': null,
    'KDJ.J': null,
    DIF: null,
    DEA: null,
    MACD: null,
    BBI: null,
    VWAP5: null,
    VWAP10: null,
    VWAP20: null,
  }
}

function makeAmv(tradeDate: string, overrides: Partial<AmvSeriesRow> = {}): AmvSeriesRow {
  return {
    tradeDate,
    amvOpen: 100,
    amvHigh: 110,
    amvLow: 90,
    amvClose: 105,
    amvDif: 1.5,
    amvDea: 1.0,
    amvMacd: 1.0,
    amvZdf: null,
    signal: 1,
    ...overrides,
  }
}

describe('mergeKlineWithAmv', () => {
  beforeEach(() => {
    vi.stubEnv('DEV', true)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('A 股 open_time(YYYY-MM-DD) 与 AMV tradeDate(YYYYMMDD) 去短横后字面对齐命中', () => {
    const kline = [makeBar('2026-05-10'), makeBar('2026-05-11')]
    const amv = [makeAmv('20260510', { amvClose: 200, amvDif: 2, amvDea: 1, amvMacd: 2 })]
    const merged = mergeKlineWithAmv(kline, amv)
    expect(merged[0]['0AMV']).toBe(200)
    expect(merged[0]['0AMV.DIF']).toBe(2)
    expect(merged[0]['0AMV.DEA']).toBe(1)
    expect(merged[0]['0AMV.MACD']).toBe(2)
    // 未命中日填 null
    expect(merged[1]['0AMV']).toBeNull()
    expect(merged[1]['0AMV.MACD']).toBeNull()
  })

  it('行业 open_time(YYYYMMDD) 与 AMV tradeDate(YYYYMMDD) 直接命中', () => {
    const kline = [makeBar('20260512')]
    const amv = [makeAmv('20260512', { amvClose: 333 })]
    const merged = mergeKlineWithAmv(kline, amv)
    expect(merged[0]['0AMV']).toBe(333)
  })

  it('amvRows 为空：所有 bar 的 AMV 字段填 null（不抛错）', () => {
    const kline = [makeBar('20260512'), makeBar('20260513')]
    const merged = mergeKlineWithAmv(kline, [])
    expect(merged.every((b) => b['0AMV'] === null)).toBe(true)
    expect(merged.every((b) => b['0AMV.DIF'] === null)).toBe(true)
  })

  it('原对象不被修改（spread 新建）', () => {
    const kline = [makeBar('20260512')]
    mergeKlineWithAmv(kline, [makeAmv('20260512')])
    expect('0AMV' in kline[0]).toBe(false)
  })

  it('DEV 探针：amvRows 非空但 0 命中 → console.error 告警', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const kline = [makeBar('20260512')]
    const amv = [makeAmv('20991231')] // 不命中
    mergeKlineWithAmv(kline, amv)
    expect(spy).toHaveBeenCalledOnce()
  })
})
