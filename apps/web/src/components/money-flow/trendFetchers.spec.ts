import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock 工厂会被提升到 import 之前，工厂内不能引用顶层局部变量；
// 用 vi.hoisted 把 mock fn 也提升到同一阶段，规避「Cannot access before init」。
const { queryMock, queryIndustriesMock, querySectorsMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  queryIndustriesMock: vi.fn(),
  querySectorsMock: vi.fn(),
}))

vi.mock('@/api/modules/market/thsIndexDaily', () => ({
  thsIndexDailyApi: { query: queryMock },
}))

vi.mock('@/api/modules/market/moneyFlow', () => ({
  moneyFlowApi: {
    queryIndustries: queryIndustriesMock,
    querySectors: querySectorsMock,
  },
}))

import { fetchIndustryTrend, fetchSectorTrend } from './trendFetchers'

const BASE_PARAMS = {
  ts_code: '881101.TI',
  start_date: '20260101',
  end_date: '20260516',
}

describe('trendFetchers', () => {
  beforeEach(() => {
    queryMock.mockReset()
    queryIndustriesMock.mockReset()
    querySectorsMock.mockReset()
  })

  it('fetchIndustryTrend 并发拉 K 线 + 行业净流入，并把 tradeDate/netAmount 映射为 trade_date/net_amount', async () => {
    const klineFixture = [{ open_time: '20260105', open: 1, high: 2, low: 1, close: 2, volume: 100 }]
    const flowFixture = [
      { tradeDate: '20260105', netAmount: '12.3456' },
      { tradeDate: '20260106', netAmount: '-5.6789' },
      { tradeDate: '20260107', netAmount: null }, // 非数值兜底为 0
    ]
    queryMock.mockResolvedValue(klineFixture)
    queryIndustriesMock.mockResolvedValue(flowFixture)

    const result = await fetchIndustryTrend(BASE_PARAMS)

    // 并发：两个 API 都被调用，且仅各一次
    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(queryIndustriesMock).toHaveBeenCalledTimes(1)
    // K 线只接受 ranged 三参数
    expect(queryMock).toHaveBeenCalledWith({
      ts_code: '881101.TI',
      start_date: '20260101',
      end_date: '20260516',
    })
    // money-flow 接受完整 params（含未来扩展字段）
    expect(queryIndustriesMock).toHaveBeenCalledWith(BASE_PARAMS)

    expect(result.kline).toBe(klineFixture)
    expect(result.moneyFlow).toEqual([
      { trade_date: '20260105', net_amount: 12.3456 },
      { trade_date: '20260106', net_amount: -5.6789 },
      { trade_date: '20260107', net_amount: 0 },
    ])
  })

  it('fetchSectorTrend 走 querySectors 而非 queryIndustries', async () => {
    queryMock.mockResolvedValue([])
    querySectorsMock.mockResolvedValue([{ tradeDate: '20260105', netAmount: '1' }])

    const result = await fetchSectorTrend(BASE_PARAMS)

    expect(querySectorsMock).toHaveBeenCalledTimes(1)
    expect(queryIndustriesMock).not.toHaveBeenCalled()
    expect(result.kline).toEqual([])
    expect(result.moneyFlow).toEqual([{ trade_date: '20260105', net_amount: 1 }])
  })

  it('K 线为空但资金流非空仍按合约返回（前端会走空状态分支）', async () => {
    queryMock.mockResolvedValue([])
    queryIndustriesMock.mockResolvedValue([{ tradeDate: '20260105', netAmount: '3.14' }])

    const result = await fetchIndustryTrend(BASE_PARAMS)
    expect(result.kline).toEqual([])
    expect(result.moneyFlow).toHaveLength(1)
  })

  it('缺少必填日期参数时抛错（避免向后端发空字符串）', async () => {
    await expect(
      fetchIndustryTrend({ ts_code: '881101.TI', start_date: '20260101' } as any),
    ).rejects.toThrow(/ts_code\/start_date\/end_date/)
    // 抛错时不应触发任何下游请求
    expect(queryMock).not.toHaveBeenCalled()
    expect(queryIndustriesMock).not.toHaveBeenCalled()
  })
})
