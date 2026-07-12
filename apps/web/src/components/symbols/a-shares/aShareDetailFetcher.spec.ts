import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock 工厂会被提升到 import 之前，工厂内不能引用顶层局部变量；
// 用 vi.hoisted 把 mock fn 也提升到同一阶段，规避「Cannot access before init」。
const { getKlinesMock, queryStocksMock } = vi.hoisted(() => ({
  getKlinesMock: vi.fn(),
  queryStocksMock: vi.fn(),
}))

vi.mock('@/api/modules/market/aShares', () => ({
  aSharesApi: { getKlines: getKlinesMock },
}))

vi.mock('@/api/modules/market/moneyFlow', () => ({
  moneyFlowApi: { queryStocks: queryStocksMock },
}))

import {
  fetchAShareDetail,
  fetchAShareKlineOnly,
} from './aShareDetailFetcher'

const TS_CODE = '000001.SZ'
const LIMIT = 360

describe('aShareDetailFetcher', () => {
  beforeEach(() => {
    getKlinesMock.mockReset()
    queryStocksMock.mockReset()
  })

  it('fetchAShareDetail 用 Promise.all 并发触发两次 API 调用，并把 moneyFlow 合并进 kline 行内', async () => {
    // 注意：A 股 K 线后端 a-shares.service.ts:221 用 formatTradeDateLabel
    // 把 trade_date 转成 'YYYY-MM-DD'；fixture 必须 reflect 真实响应。
    // 个股资金流后端直返数据库原值 'YYYYMMDD'。两侧由 mergeKlineWithMoneyFlow
    // 内部 normalizeDateKey 归一化对齐。
    const klineFixture = [
      { open_time: '2026-01-05', open: 1, high: 2, low: 1, close: 2, volume: 100 },
      { open_time: '2026-01-06', open: 1, high: 2, low: 1, close: 2, volume: 100 },
      { open_time: '2026-01-07', open: 1, high: 2, low: 1, close: 2, volume: 100 },
    ]
    const flowFixture = [
      { id: 'a', tsCode: TS_CODE, tradeDate: '20260107', name: '平安', pctChange: null, latest: null, netAmount: '3.1', netD5Amount: null, buyLgAmount: null, buyLgAmountRate: null, buyMdAmount: null, buyMdAmountRate: null, buySmAmount: null, buySmAmountRate: null },
      { id: 'b', tsCode: TS_CODE, tradeDate: '20260106', name: '平安', pctChange: null, latest: null, netAmount: '-2.2', netD5Amount: null, buyLgAmount: null, buyLgAmountRate: null, buyMdAmount: null, buyMdAmountRate: null, buySmAmount: null, buySmAmountRate: null },
      { id: 'c', tsCode: TS_CODE, tradeDate: '20260105', name: '平安', pctChange: null, latest: null, netAmount: '1.1', netD5Amount: null, buyLgAmount: null, buyLgAmountRate: null, buyMdAmount: null, buyMdAmountRate: null, buySmAmount: null, buySmAmountRate: null },
    ]
    getKlinesMock.mockResolvedValue({ bars: klineFixture, suspend: { status: 'none', sinceDate: null, timing: null, lastQuoteTradeDate: null, asOfTradeDate: null } })
    queryStocksMock.mockResolvedValue(flowFixture)

    const result = await fetchAShareDetail(TS_CODE, LIMIT, 'qfq')

    // 并发：两个 API 都被调用，且仅各一次
    expect(getKlinesMock).toHaveBeenCalledTimes(1)
    expect(queryStocksMock).toHaveBeenCalledTimes(1)
    expect(getKlinesMock).toHaveBeenCalledWith(TS_CODE, LIMIT, 'qfq', undefined)
    expect(queryStocksMock).toHaveBeenCalledWith({ ts_code: TS_CODE, limit: LIMIT })

    // K 线已 merge moneyFlow，按 open_time（'YYYY-MM-DD'）归一化与 flow tradeDate 对齐
    expect(result.kline).toHaveLength(3)
    expect(result.kline[0].open_time).toBe('2026-01-05')
    expect(result.kline[0].moneyFlow).toBeCloseTo(1.1, 4)
    expect(result.kline[1].moneyFlow).toBeCloseTo(-2.2, 4)
    expect(result.kline[2].moneyFlow).toBeCloseTo(3.1, 4)

    // flowRows 透出：透传后端原 DESC 顺序，供 priceMode 切换路径复用
    expect(result.flowRows).toBe(flowFixture)
  })

  it('资金流 0 行时 kline 全部 moneyFlow=null，flowRows 为空数组', async () => {
    const klineFixture = [
      { open_time: '2026-01-05', open: 1, high: 2, low: 1, close: 2, volume: 100 },
    ]
    getKlinesMock.mockResolvedValue({ bars: klineFixture, suspend: { status: 'none', sinceDate: null, timing: null, lastQuoteTradeDate: null, asOfTradeDate: null } })
    queryStocksMock.mockResolvedValue([])

    const result = await fetchAShareDetail(TS_CODE, LIMIT, 'qfq')

    expect(result.kline).toHaveLength(1)
    expect(result.kline[0].moneyFlow).toBeNull()
    expect(result.flowRows).toEqual([])
  })

  it('fetchAShareKlineOnly 不触发 moneyFlowApi.queryStocks（priceMode 切换路径）', async () => {
    const klineFixture = [{ open_time: '2026-01-05', open: 1, high: 2, low: 1, close: 2, volume: 100 }]
    getKlinesMock.mockResolvedValue({ bars: klineFixture, suspend: { status: 'none', sinceDate: null, timing: null, lastQuoteTradeDate: null, asOfTradeDate: null } })

    const result = await fetchAShareKlineOnly(TS_CODE, LIMIT, 'raw')

    expect(getKlinesMock).toHaveBeenCalledTimes(1)
    expect(getKlinesMock).toHaveBeenCalledWith(TS_CODE, LIMIT, 'raw', undefined)
    expect(queryStocksMock).not.toHaveBeenCalled()
    expect(result.bars).toBe(klineFixture)
    expect(result.suspend.status).toBe('none')
  })

  it('fetchAShareDetail 传 range 时透传给 getKlines（资金流仍按 limit，无 range）', async () => {
    getKlinesMock.mockResolvedValue({ bars: [], suspend: { status: 'none', sinceDate: null, timing: null, lastQuoteTradeDate: null, asOfTradeDate: null } })
    queryStocksMock.mockResolvedValue([])
    const range = { startDate: '20240101', endDate: '20240201' }

    await fetchAShareDetail(TS_CODE, 1000, 'qfq', range)

    expect(getKlinesMock).toHaveBeenCalledWith(TS_CODE, 1000, 'qfq', range)
    // 资金流接口仅支持 limit（无 range），选区时靠放大的 limit 尽量覆盖窗口
    expect(queryStocksMock).toHaveBeenCalledWith({ ts_code: TS_CODE, limit: 1000 })
  })

  it('fetchAShareKlineOnly 透传 range', async () => {
    getKlinesMock.mockResolvedValue({ bars: [], suspend: { status: 'none', sinceDate: null, timing: null, lastQuoteTradeDate: null, asOfTradeDate: null } })
    const range = { startDate: '20240101', endDate: '20240201' }

    await fetchAShareKlineOnly(TS_CODE, 1000, 'raw', range)

    expect(getKlinesMock).toHaveBeenCalledWith(TS_CODE, 1000, 'raw', range)
  })
})
