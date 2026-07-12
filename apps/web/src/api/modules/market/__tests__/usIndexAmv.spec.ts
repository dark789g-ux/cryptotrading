/**
 * usIndexAmv API client unit test (spec 05 endpoint contract + 06 frontend).
 *
 * Mocks global fetch and asserts wire shape:
 *  - query({index_code,start_date,end_date}) -> GET /api/us-index-amv?... (encoded index_code), passthrough
 *  - getDateRange(index_code) -> GET /api/us-index-amv/date-range?index_code=... , returns {start,end}
 *  - triggerSync() (no body) -> POST /api/us-index-amv/sync, returns {jobId}
 *  - triggerSync({dateRange,symbols}) -> body passthrough
 *
 * Plus a merge sanity check: mergeKlineWithAmv binds US-index bar(open_time='YYYY-MM-DD')
 * to AMV row(tradeDate='YYYYMMDD') via normalizeDateKey (去短横字面相等).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { usIndexAmvApi } from '../usIndexAmv'
import { mergeKlineWithAmv } from '@/composables/kline/mergeAmv'
import type { AmvSeriesRow } from '../active-mv'
import type { KlineChartBar } from '../symbols'

function mockFetchOnce(jsonBody: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(jsonBody)),
  } as unknown as Response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
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
    amvMacd: 0.5,
    amvZdf: null,
    signal: 1,
    ...overrides,
  }
}

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

describe('usIndexAmvApi.query', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('GET /api/us-index-amv with index_code/start_date/end_date and passthrough', async () => {
    const rows = [makeAmv('20240102', { amvClose: 200 })]
    const fetchMock = mockFetchOnce(rows)
    const res = await usIndexAmvApi.query({
      index_code: '.NDX',
      start_date: '20240101',
      end_date: '20240131',
    })

    expect(res).toEqual(rows)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      '/api/us-index-amv?index_code=.NDX&start_date=20240101&end_date=20240131',
    )
    expect((init as RequestInit | undefined)?.method ?? 'GET').toBe('GET')
  })

  it('encodeURIComponent on index_code', async () => {
    const fetchMock = mockFetchOnce([])
    await usIndexAmvApi.query({
      index_code: '^IXIC',
      start_date: '20240101',
      end_date: '20240131',
    })
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/us-index-amv?index_code=%5EIXIC&start_date=20240101&end_date=20240131',
    )
  })
})

describe('usIndexAmvApi.getDateRange', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('GET /api/us-index-amv/date-range?index_code= and returns {start,end}', async () => {
    const fetchMock = mockFetchOnce({ start: '20200101', end: '20240131' })
    const res = await usIndexAmvApi.getDateRange('.NDX')

    expect(res).toEqual({ start: '20200101', end: '20240131' })
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/us-index-amv/date-range?index_code=.NDX',
    )
  })

  it('passes through null range (empty table)', async () => {
    mockFetchOnce({ start: null, end: null })
    const res = await usIndexAmvApi.getDateRange('.NDX')
    expect(res).toEqual({ start: null, end: null })
  })
})

describe('usIndexAmvApi.triggerSync', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POST /api/us-index-amv/sync with no args -> empty body, returns {jobId}', async () => {
    const fetchMock = mockFetchOnce({ jobId: 'job-1' })
    const res = await usIndexAmvApi.triggerSync()

    expect(res).toEqual({ jobId: 'job-1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/us-index-amv/sync')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({})
  })

  it('passes dateRange + symbols through body', async () => {
    const fetchMock = mockFetchOnce({ jobId: 'job-2' })
    await usIndexAmvApi.triggerSync({
      dateRange: ['20240101', '20240131'],
      symbols: ['.NDX'],
    })
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({
      dateRange: ['20240101', '20240131'],
      symbols: ['.NDX'],
    })
  })
})

describe('mergeKlineWithAmv on US-index bars', () => {
  it('US-index bar open_time(YYYY-MM-DD) hits AMV tradeDate(YYYYMMDD) via normalizeDateKey', () => {
    const kline = [makeBar('2024-01-02'), makeBar('2024-01-03')]
    const amv = [makeAmv('20240102', { amvClose: 200, amvDif: 2, amvDea: 1, amvMacd: 1 })]
    const merged = mergeKlineWithAmv(kline, amv)

    expect(merged[0]['0AMV']).toBe(200)
    expect(merged[0]['0AMV.DIF']).toBe(2)
    expect(merged[0]['0AMV.DEA']).toBe(1)
    expect(merged[0]['0AMV.MACD']).toBe(1)
    // 缺日填 null
    expect(merged[1]['0AMV']).toBeNull()
    expect(merged[1]['0AMV.MACD']).toBeNull()
  })
})
