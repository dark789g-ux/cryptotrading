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
  mapMoneyFlowBars,
} from './aShareDetailFetcher'

const TS_CODE = '000001.SZ'
const LIMIT = 360

describe('aShareDetailFetcher', () => {
  beforeEach(() => {
    getKlinesMock.mockReset()
    queryStocksMock.mockReset()
  })

  it('fetchAShareDetail 用 Promise.all 并发触发两次 API 调用', async () => {
    const klineFixture = [{ open_time: '20260105', open: 1, high: 2, low: 1, close: 2, volume: 100 }]
    const flowFixture = [
      { id: 'a', tsCode: TS_CODE, tradeDate: '20260107', name: '平安', pctChange: null, latest: null, netAmount: '3.1', netD5Amount: null, buyLgAmount: null, buyLgAmountRate: null, buyMdAmount: null, buyMdAmountRate: null, buySmAmount: null, buySmAmountRate: null },
      { id: 'b', tsCode: TS_CODE, tradeDate: '20260106', name: '平安', pctChange: null, latest: null, netAmount: '-2.2', netD5Amount: null, buyLgAmount: null, buyLgAmountRate: null, buyMdAmount: null, buyMdAmountRate: null, buySmAmount: null, buySmAmountRate: null },
      { id: 'c', tsCode: TS_CODE, tradeDate: '20260105', name: '平安', pctChange: null, latest: null, netAmount: '1.1', netD5Amount: null, buyLgAmount: null, buyLgAmountRate: null, buyMdAmount: null, buyMdAmountRate: null, buySmAmount: null, buySmAmountRate: null },
    ]
    getKlinesMock.mockResolvedValue(klineFixture)
    queryStocksMock.mockResolvedValue(flowFixture)

    const result = await fetchAShareDetail(TS_CODE, LIMIT, 'qfq')

    // 并发：两个 API 都被调用，且仅各一次
    expect(getKlinesMock).toHaveBeenCalledTimes(1)
    expect(queryStocksMock).toHaveBeenCalledTimes(1)
    expect(getKlinesMock).toHaveBeenCalledWith(TS_CODE, LIMIT, 'qfq')
    expect(queryStocksMock).toHaveBeenCalledWith({ ts_code: TS_CODE, limit: LIMIT })

    expect(result.kline).toBe(klineFixture)
    // 后端 DESC 返回 → 前端 ASC 展示，需 reverse
    expect(result.moneyFlow).toEqual([
      { trade_date: '20260105', net_amount: 1.1 },
      { trade_date: '20260106', net_amount: -2.2 },
      { trade_date: '20260107', net_amount: 3.1 },
    ])
  })

  it('mapMoneyFlowBars 正确 reverse + 数值透传 + null 回退 0', () => {
    const rows = [
      { id: '1', tsCode: TS_CODE, tradeDate: '20260107', name: null, pctChange: null, latest: null, netAmount: null, netD5Amount: null, buyLgAmount: null, buyLgAmountRate: null, buyMdAmount: null, buyMdAmountRate: null, buySmAmount: null, buySmAmountRate: null },
      { id: '2', tsCode: TS_CODE, tradeDate: '20260106', name: null, pctChange: null, latest: null, netAmount: '12.3456', netD5Amount: null, buyLgAmount: null, buyLgAmountRate: null, buyMdAmount: null, buyMdAmountRate: null, buySmAmount: null, buySmAmountRate: null },
      { id: '3', tsCode: TS_CODE, tradeDate: '20260105', name: null, pctChange: null, latest: null, netAmount: '-5.6789', netD5Amount: null, buyLgAmount: null, buyLgAmountRate: null, buyMdAmount: null, buyMdAmountRate: null, buySmAmount: null, buySmAmountRate: null },
    ]

    const out = mapMoneyFlowBars(rows)

    // 1) reverse：原 DESC → ASC
    expect(out.map(b => b.trade_date)).toEqual(['20260105', '20260106', '20260107'])
    // 2) 数值透传（含正负 + 小数）
    expect(out[0].net_amount).toBe(-5.6789)
    expect(out[1].net_amount).toBe(12.3456)
    // 3) null 回退为 0
    expect(out[2].net_amount).toBe(0)
  })

  it('资金流 0 行时 moneyFlow 为空数组', async () => {
    const klineFixture = [{ open_time: '20260105', open: 1, high: 2, low: 1, close: 2, volume: 100 }]
    getKlinesMock.mockResolvedValue(klineFixture)
    queryStocksMock.mockResolvedValue([])

    const result = await fetchAShareDetail(TS_CODE, LIMIT, 'qfq')

    expect(result.kline).toBe(klineFixture)
    expect(result.moneyFlow).toEqual([])
  })

  it('fetchAShareKlineOnly 不触发 moneyFlowApi.queryStocks', async () => {
    const klineFixture = [{ open_time: '20260105', open: 1, high: 2, low: 1, close: 2, volume: 100 }]
    getKlinesMock.mockResolvedValue(klineFixture)

    const result = await fetchAShareKlineOnly(TS_CODE, LIMIT, 'raw')

    expect(getKlinesMock).toHaveBeenCalledTimes(1)
    expect(getKlinesMock).toHaveBeenCalledWith(TS_CODE, LIMIT, 'raw')
    expect(queryStocksMock).not.toHaveBeenCalled()
    expect(result).toBe(klineFixture)
  })
})
