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
    // 注意：A 股 K 线后端 a-shares.service.ts:221 用 formatTradeDateLabel
    // 把 trade_date 转成 'YYYY-MM-DD'；fixture 必须 reflect 真实响应
    const klineFixture = [{ open_time: '2026-01-05', open: 1, high: 2, low: 1, close: 2, volume: 100 }]
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
    // 后端 DESC 返回 → 前端 ASC 展示，需 reverse；
    // 同时 trade_date 必须转成 'YYYY-MM-DD' 与 K 线 open_time 对齐，否则
    // KlineChart 副图 flowMap.get(open_time) 全 miss，副图柱形画不出
    expect(result.moneyFlow).toEqual([
      { trade_date: '2026-01-05', net_amount: 1.1 },
      { trade_date: '2026-01-06', net_amount: -2.2 },
      { trade_date: '2026-01-07', net_amount: 3.1 },
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
    expect(out.map(b => b.trade_date)).toEqual(['2026-01-05', '2026-01-06', '2026-01-07'])
    // 2) 数值透传（含正负 + 小数）
    expect(out[0].net_amount).toBe(-5.6789)
    expect(out[1].net_amount).toBe(12.3456)
    // 3) null 回退为 0
    expect(out[2].net_amount).toBe(0)
  })

  // 回归测试：A 股 K 线 open_time 是 'YYYY-MM-DD'（后端 formatTradeDateLabel），
  // 而个股资金流 tradeDate 是 'YYYYMMDD'（数据库原值）。mapMoneyFlowBars 必须
  // 转格式以让 KlineChart 副图 flowMap.get(row.open_time) 命中。
  it('mapMoneyFlowBars 把 trade_date 转 YYYY-MM-DD 以对齐 A 股 K 线 open_time', () => {
    const rows = [
      { id: '1', tsCode: TS_CODE, tradeDate: '20260515', name: null, pctChange: null, latest: null, netAmount: '1.5', netD5Amount: null, buyLgAmount: null, buyLgAmountRate: null, buyMdAmount: null, buyMdAmountRate: null, buySmAmount: null, buySmAmountRate: null },
    ]

    const out = mapMoneyFlowBars(rows)

    expect(out[0].trade_date).toBe('2026-05-15')
    // 反向断言：不再是数据库原值
    expect(out[0].trade_date).not.toBe('20260515')
  })

  it('mapMoneyFlowBars 对非 8 位长度的 tradeDate 原样保留（容错）', () => {
    // 防御：万一上游格式不是 YYYYMMDD（如已带短横、空串），不破坏数据
    const rows = [
      { id: '1', tsCode: TS_CODE, tradeDate: '2026-05-15', name: null, pctChange: null, latest: null, netAmount: '1.0', netD5Amount: null, buyLgAmount: null, buyLgAmountRate: null, buyMdAmount: null, buyMdAmountRate: null, buySmAmount: null, buySmAmountRate: null },
      { id: '2', tsCode: TS_CODE, tradeDate: '', name: null, pctChange: null, latest: null, netAmount: '2.0', netD5Amount: null, buyLgAmount: null, buyLgAmountRate: null, buyMdAmount: null, buyMdAmountRate: null, buySmAmount: null, buySmAmountRate: null },
    ]

    const out = mapMoneyFlowBars(rows)

    // 已是 ISO 格式，原样保留
    expect(out.find(b => b.net_amount === 1.0)?.trade_date).toBe('2026-05-15')
    // 空串原样保留
    expect(out.find(b => b.net_amount === 2.0)?.trade_date).toBe('')
  })

  it('资金流 0 行时 moneyFlow 为空数组', async () => {
    const klineFixture = [{ open_time: '2026-01-05', open: 1, high: 2, low: 1, close: 2, volume: 100 }]
    getKlinesMock.mockResolvedValue(klineFixture)
    queryStocksMock.mockResolvedValue([])

    const result = await fetchAShareDetail(TS_CODE, LIMIT, 'qfq')

    expect(result.kline).toBe(klineFixture)
    expect(result.moneyFlow).toEqual([])
  })

  it('fetchAShareKlineOnly 不触发 moneyFlowApi.queryStocks', async () => {
    const klineFixture = [{ open_time: '2026-01-05', open: 1, high: 2, low: 1, close: 2, volume: 100 }]
    getKlinesMock.mockResolvedValue(klineFixture)

    const result = await fetchAShareKlineOnly(TS_CODE, LIMIT, 'raw')

    expect(getKlinesMock).toHaveBeenCalledTimes(1)
    expect(getKlinesMock).toHaveBeenCalledWith(TS_CODE, LIMIT, 'raw')
    expect(queryStocksMock).not.toHaveBeenCalled()
    expect(result).toBe(klineFixture)
  })
})
