/**
 * a-shares API client unit test.
 *
 * Verifies aSharesApi.recalcKlines wire shape:
 *  - POST /api/a-shares/:tsCode/klines/recalc?limit=&priceMode=&startDate=&endDate=
 *  - query building mirrors getKlines
 *  - body carries kdjParams when provided
 *  - returns { bars, suspend } (legacy array wrapped by parseAShareKlinesResponse)
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { aSharesApi } from '../aShares'

function mockFetchOnce(jsonBody: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(jsonBody)),
  } as unknown as Response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const bar = {
  open_time: '2024-01-01',
  open: 10,
  high: 11,
  low: 9,
  close: 10.5,
  volume: 1000,
  pctChg: 0.05,
  quote_volume: 10000,
  '10_quote_volume': null,
  atr_14: null,
  loss_atr_14: null,
  low_9: null,
  high_9: null,
  stop_loss_pct: null,
  risk_reward_ratio: null,
  turnoverRate: null,
  volumeRatio: null,
  pe: null,
  peTtm: null,
  pb: null,
  totalMv: null,
  circMv: null,
  MA5: null,
  MA30: null,
  MA60: null,
  MA120: null,
  MA240: null,
  'KDJ.K': 50,
  'KDJ.D': 50,
  'KDJ.J': 50,
  DIF: null,
  DEA: null,
  MACD: null,
  BBI: null,
}

describe('aSharesApi.getKlines', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('解析新版 { bars, suspend } 响应', async () => {
    const fetchMock = mockFetchOnce({
      bars: [bar],
      suspend: {
        status: 'suspended',
        sinceDate: '20260707',
        timing: '全天',
        lastQuoteTradeDate: '20260706',
        asOfTradeDate: '20260710',
      },
    })
    const res = await aSharesApi.getKlines('000008.SZ')

    expect(res.bars).toEqual([bar])
    expect(res.suspend.status).toBe('suspended')
    expect(res.suspend.sinceDate).toBe('20260707')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/a-shares/000008.SZ/klines?limit=300&priceMode=qfq')
  })

  it('兼容旧版数组响应，suspend 降级为 none', async () => {
    mockFetchOnce([bar])
    const res = await aSharesApi.getKlines('000001.SZ')
    expect(res.bars).toEqual([bar])
    expect(res.suspend.status).toBe('none')
  })
})

describe('aSharesApi.recalcKlines', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POST /api/a-shares/:tsCode/klines/recalc with default query and empty body', async () => {
    const fetchMock = mockFetchOnce([bar])
    const res = await aSharesApi.recalcKlines('000001.SZ')

    expect(res).toEqual({ bars: [bar], suspend: expect.objectContaining({ status: 'none' }) })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/a-shares/000001.SZ/klines/recalc?limit=300&priceMode=qfq')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({})
  })

  it('builds query string like getKlines and passes kdjParams in body', async () => {
    const fetchMock = mockFetchOnce([bar])
    await aSharesApi.recalcKlines(
      '000001.SZ',
      100,
      'raw',
      { startDate: '20240101', endDate: '20240131' },
      { kdjParams: { n: 5, m1: 2, m2: 2 } },
    )

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      '/api/a-shares/000001.SZ/klines/recalc?limit=100&priceMode=raw&startDate=20240101&endDate=20240131',
    )
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      kdjParams: { n: 5, m1: 2, m2: 2 },
    })
  })

  it('encodeURIComponent on tsCode', async () => {
    const fetchMock = mockFetchOnce([bar])
    await aSharesApi.recalcKlines('000001 SH')

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/a-shares/000001%20SH/klines/recalc?limit=300&priceMode=qfq',
    )
  })
})
