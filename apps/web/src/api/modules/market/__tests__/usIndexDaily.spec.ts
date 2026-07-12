/**
 * usIndexDaily API client unit test (spec 04 §3 / 02 endpoint contract).
 *
 * Mocks global fetch and asserts wire shape:
 *  - query({index_code,start_date,end_date}) -> GET /api/us-index-daily?... (encoded index_code), passthrough
 *  - getDateRange(index_code) -> GET /api/us-index-daily/date-range?index_code=... , returns {start,end}
 *  - triggerSync() (no body) -> POST /api/us-index-daily/sync, returns {jobId}
 *  - triggerSync({dateRange,symbols}) -> body passthrough
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { usIndexDailyApi } from '../usIndexDaily'
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

describe('usIndexDailyApi.query', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('GET /api/us-index-daily with index_code/start_date/end_date and passthrough', async () => {
    const rows: KlineChartBar[] = [
      {
        open_time: '2024-01-02',
        open: 1, high: 2, low: 0.5, close: 1.5, volume: 100,
        MA5: null, MA30: null, MA60: null, MA120: null, MA240: null,
        'KDJ.K': 10, 'KDJ.D': 20, 'KDJ.J': 30,
        DIF: null, DEA: null, MACD: null, BBI: null,
        VWAP5: null, VWAP10: null, VWAP20: null,
      },
    ]
    const fetchMock = mockFetchOnce(rows)
    const res = await usIndexDailyApi.query({
      index_code: '.NDX',
      start_date: '20240101',
      end_date: '20240131',
    })

    expect(res).toEqual(rows)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      '/api/us-index-daily?index_code=.NDX&start_date=20240101&end_date=20240131',
    )
    expect((init as RequestInit | undefined)?.method ?? 'GET').toBe('GET')
  })

  it('encodeURIComponent on index_code', async () => {
    const fetchMock = mockFetchOnce([])
    await usIndexDailyApi.query({
      index_code: '^IXIC',
      start_date: '20240101',
      end_date: '20240131',
    })
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/us-index-daily?index_code=%5EIXIC&start_date=20240101&end_date=20240131',
    )
  })
})

describe('usIndexDailyApi.getDateRange', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('GET /api/us-index-daily/date-range?index_code= and returns {start,end}', async () => {
    const fetchMock = mockFetchOnce({ start: '20200101', end: '20240131' })
    const res = await usIndexDailyApi.getDateRange('.NDX')

    expect(res).toEqual({ start: '20200101', end: '20240131' })
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/us-index-daily/date-range?index_code=.NDX',
    )
  })

  it('passes through null range (empty table)', async () => {
    mockFetchOnce({ start: null, end: null })
    const res = await usIndexDailyApi.getDateRange('.NDX')
    expect(res).toEqual({ start: null, end: null })
  })
})

describe('usIndexDailyApi.triggerSync', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POST /api/us-index-daily/sync with no args -> empty body, returns {jobId}', async () => {
    const fetchMock = mockFetchOnce({ jobId: 'job-1' })
    const res = await usIndexDailyApi.triggerSync()

    expect(res).toEqual({ jobId: 'job-1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/us-index-daily/sync')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({})
  })

  it('passes dateRange + symbols through body', async () => {
    const fetchMock = mockFetchOnce({ jobId: 'job-2' })
    await usIndexDailyApi.triggerSync({
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
