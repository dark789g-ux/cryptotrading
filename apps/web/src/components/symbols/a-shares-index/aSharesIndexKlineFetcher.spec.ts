import { describe, it, expect, vi } from 'vitest'
import { buildAmvQueryString } from '@/api/modules/market/active-mv'

describe('buildAmvQueryString', () => {
  it('无 opts 时默认 days=250', () => {
    expect(buildAmvQueryString()).toBe('?days=250')
  })

  it('传 days 时用 days 参数', () => {
    expect(buildAmvQueryString({ days: 120 })).toBe('?days=120')
  })

  it('有 startDate/endDate 时忽略 days', () => {
    expect(
      buildAmvQueryString({ days: 250, startDate: '20240101', endDate: '20241231' }),
    ).toBe('?startDate=20240101&endDate=20241231')
  })
})

describe('fetchIndexKline', () => {
  it('sw 并行拉 K 线 + getSw 并 merge AMV 字段', async () => {
    vi.resetModules()
    const queryKline = vi.fn().mockResolvedValue([
      { open_time: '20240102', close: 1, volume: 10 },
    ])
    const getSw = vi.fn().mockResolvedValue([
      {
        tradeDate: '20240102',
        amvClose: 100,
        amvDif: 1,
        amvDea: 0.5,
        amvMacd: 1,
        amvOpen: 90,
        amvHigh: 110,
        amvLow: 80,
        amvZdf: 0.1,
        signal: 1 as const,
      },
    ])

    vi.doMock('@/api/modules/market/indexDaily', () => ({
      indexDailyApi: { queryKline },
    }))
    vi.doMock('@/api/modules/market/active-mv', () => ({
      activeMvApi: { getSw, getIndustry: vi.fn(), getConcept: vi.fn() },
    }))

    const { fetchIndexKline } = await import('./aSharesIndexKlineFetcher')
    const bars = await fetchIndexKline(
      {
        tsCode: '801750.SI',
        name: '半导体',
        category: 'sw',
        tradeDate: '20240102',
        close: 1,
        pctChange: 0,
        vol: null,
        amount: null,
        totalMvWan: null,
        pe: null,
        pb: null,
        count: null,
        netAmount: null,
        netAmount5d: null,
        netAmount10d: null,
        netAmount20d: null,
        buyLgAmount: null,
        buyMdAmount: null,
        buySmAmount: null,
      },
      '20240101',
      '20240131',
    )

    expect(queryKline).toHaveBeenCalledWith({
      ts_code: '801750.SI',
      start_date: '20240101',
      end_date: '20240131',
    })
    expect(getSw).toHaveBeenCalledWith('801750.SI', {
      startDate: '20240101',
      endDate: '20240131',
    })
    expect(bars[0]['0AMV']).toBe(100)
    expect(bars[0]['0AMV.DIF']).toBe(1)
  })

  it('market 不请求 AMV', async () => {
    vi.resetModules()
    const queryKline = vi.fn().mockResolvedValue([{ open_time: '20240102', close: 1 }])
    const getSw = vi.fn()

    vi.doMock('@/api/modules/market/indexDaily', () => ({
      indexDailyApi: { queryKline },
    }))
    vi.doMock('@/api/modules/market/active-mv', () => ({
      activeMvApi: { getSw, getIndustry: vi.fn(), getConcept: vi.fn() },
    }))

    const { fetchIndexKline } = await import('./aSharesIndexKlineFetcher')
    await fetchIndexKline(
      {
        tsCode: '000001.SH',
        name: '上证指数',
        category: 'market',
        tradeDate: '20240102',
        close: 1,
        pctChange: 0,
        vol: null,
        amount: null,
        totalMvWan: null,
        pe: null,
        pb: null,
        count: null,
        netAmount: null,
        netAmount5d: null,
        netAmount10d: null,
        netAmount20d: null,
        buyLgAmount: null,
        buyMdAmount: null,
        buySmAmount: null,
      },
      '20240101',
      '20240131',
    )

    expect(getSw).not.toHaveBeenCalled()
  })

  it('AMV 失败降级为空序列', async () => {
    vi.resetModules()
    vi.doMock('@/api/modules/market/indexDaily', () => ({
      indexDailyApi: {
        queryKline: vi.fn().mockResolvedValue([{ open_time: '20240102', close: 1 }]),
      },
    }))
    vi.doMock('@/api/modules/market/active-mv', () => ({
      activeMvApi: {
        getIndustry: vi.fn().mockRejectedValue(new Error('network')),
        getSw: vi.fn(),
        getConcept: vi.fn(),
      },
    }))

    const { fetchIndexKline } = await import('./aSharesIndexKlineFetcher')
    const bars = await fetchIndexKline(
      {
        tsCode: '885001.TI',
        name: '测试行业',
        category: 'industry',
        tradeDate: '20240102',
        close: 1,
        pctChange: 0,
        vol: null,
        amount: null,
        totalMvWan: null,
        pe: null,
        pb: null,
        count: null,
        netAmount: null,
        netAmount5d: null,
        netAmount10d: null,
        netAmount20d: null,
        buyLgAmount: null,
        buyMdAmount: null,
        buySmAmount: null,
      },
      '20240101',
      '20240131',
    )

    expect(bars[0]['0AMV']).toBeNull()
  })
})
