/**
 * symbols API client unit test.
 *
 * Verifies klinesApi.recalcKlines wire shape:
 *  - POST /api/klines/:symbol/:interval/recalc
 *  - body carries kdjParams when provided
 *  - returns KlineChartBar[]
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { klinesApi } from '../symbols'

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

describe('klinesApi.recalcKlines', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POST /api/klines/:symbol/:interval/recalc with default empty body', async () => {
    const fetchMock = mockFetchOnce([bar])
    const res = await klinesApi.recalcKlines('BTCUSDT', '1d')

    expect(res).toEqual([bar])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/klines/BTCUSDT/1d/recalc')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({})
  })

  it('passes kdjParams through body', async () => {
    const fetchMock = mockFetchOnce([bar])
    await klinesApi.recalcKlines('BTCUSDT', '1h', { kdjParams: { n: 9, m1: 3, m2: 3 } })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({
      kdjParams: { n: 9, m1: 3, m2: 3 },
    })
  })
})
