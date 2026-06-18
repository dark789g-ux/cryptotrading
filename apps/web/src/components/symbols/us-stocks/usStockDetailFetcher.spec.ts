import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getKlinesMock } = vi.hoisted(() => ({ getKlinesMock: vi.fn() }))

vi.mock('@/api/modules/market/usStocks', () => ({
  usStocksApi: { getKlines: getKlinesMock },
}))

import { fetchUsStockKline } from './usStockDetailFetcher'

const TICKER = 'AVGO'

describe('usStockDetailFetcher.fetchUsStockKline', () => {
  beforeEach(() => {
    getKlinesMock.mockReset()
    getKlinesMock.mockResolvedValue([])
  })

  it('不传 range：getKlines(ticker, limit, priceMode, undefined)', async () => {
    await fetchUsStockKline(TICKER, 360, 'qfq')
    expect(getKlinesMock).toHaveBeenCalledWith(TICKER, 360, 'qfq', undefined)
  })

  it('传 range：透传给 getKlines', async () => {
    const range = { startDate: '20240101', endDate: '20240201' }
    await fetchUsStockKline(TICKER, 1000, 'raw', range)
    expect(getKlinesMock).toHaveBeenCalledWith(TICKER, 1000, 'raw', range)
  })
})
