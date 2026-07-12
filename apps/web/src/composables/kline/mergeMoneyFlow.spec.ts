import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mergeKlineWithMoneyFlow, type MoneyFlowRowLike } from './mergeMoneyFlow'
import type { KlineChartBar } from '@/api'

// 构造最小可用 KlineChartBar
function makeBar(open_time: string, overrides: Partial<KlineChartBar> = {}): KlineChartBar {
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
    ...overrides,
  }
}

describe('mergeKlineWithMoneyFlow', () => {
  beforeEach(() => {
    // 默认让 DEV 路径可触发，由具体 case 在需要时覆盖
    vi.stubEnv('DEV', true)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('1) 基本合并：A 股形态 — kline open_time 是 "YYYY-MM-DD"，flow tradeDate 是 "YYYYMMDD"，归一化后命中', () => {
    const kline = [
      makeBar('2026-01-05'),
      makeBar('2026-01-06'),
      makeBar('2026-01-07'),
    ]
    const flow: MoneyFlowRowLike[] = [
      { tradeDate: '20260105', netAmount: '1.1' },
      { tradeDate: '20260106', netAmount: '-2.2' },
      { tradeDate: '20260107', netAmount: 3.3 },
    ]

    const result = mergeKlineWithMoneyFlow(kline, flow)

    expect(result.map(b => b.moneyFlow)).toEqual([1.1, -2.2, 3.3])
    expect(result.map(b => b.open_time)).toEqual(['2026-01-05', '2026-01-06', '2026-01-07'])
  })

  it('2) 双方同格式（行业形态）：两侧均为 "YYYYMMDD"', () => {
    const kline = [
      makeBar('20260105'),
      makeBar('20260106'),
    ]
    const flow: MoneyFlowRowLike[] = [
      { tradeDate: '20260105', netAmount: 5 },
      { tradeDate: '20260106', netAmount: -1 },
    ]

    const result = mergeKlineWithMoneyFlow(kline, flow)

    expect(result.map(b => b.moneyFlow)).toEqual([5, -1])
  })

  it('3) 部分缺失：K 线 5 根 + 资金流 3 根 → 3 命中 + 2 个 null', () => {
    const kline = [
      makeBar('2026-01-05'),
      makeBar('2026-01-06'),
      makeBar('2026-01-07'),
      makeBar('2026-01-08'),
      makeBar('2026-01-09'),
    ]
    const flow: MoneyFlowRowLike[] = [
      { tradeDate: '20260106', netAmount: '2' },
      { tradeDate: '20260107', netAmount: '3' },
      { tradeDate: '20260109', netAmount: '5' },
    ]

    const result = mergeKlineWithMoneyFlow(kline, flow)

    expect(result.map(b => b.moneyFlow)).toEqual([null, 2, 3, null, 5])
  })

  it('4) 资金流全无：flowRows=[] → 所有 moneyFlow=null，且不触发 R3 探针', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const kline = [makeBar('2026-01-05'), makeBar('2026-01-06')]

    const result = mergeKlineWithMoneyFlow(kline, [])

    expect(result.map(b => b.moneyFlow)).toEqual([null, null])
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('5) null netAmount 回退为 0', () => {
    const kline = [makeBar('2026-01-05'), makeBar('2026-01-06')]
    const flow: MoneyFlowRowLike[] = [
      { tradeDate: '20260105', netAmount: null },
      { tradeDate: '20260106', netAmount: '2.5' },
    ]

    const result = mergeKlineWithMoneyFlow(kline, flow)

    expect(result[0].moneyFlow).toBe(0)
    expect(result[1].moneyFlow).toBe(2.5)
  })

  it('6) 不修改原对象：merged[0] !== kline[0]，且原对象上没有挂 moneyFlow', () => {
    const kline = [makeBar('2026-01-05')]
    const flow: MoneyFlowRowLike[] = [{ tradeDate: '20260105', netAmount: '1' }]

    const result = mergeKlineWithMoneyFlow(kline, flow)

    expect(result[0]).not.toBe(kline[0])
    expect(result[0].moneyFlow).toBe(1)
    // 原对象未被赋值新字段
    expect((kline[0] as KlineChartBar).moneyFlow).toBeUndefined()
  })

  it('7) 非 8 位 tradeDate 两侧归一化稳定（容错回归）：已带短横/空串均能正确命中或忽略', () => {
    const kline = [
      makeBar('2026-05-15'),
      makeBar(''),
    ]
    // 上游可能传入已带短横或空串，归一化后仍能与 kline 对齐
    const flow: MoneyFlowRowLike[] = [
      { tradeDate: '2026-05-15', netAmount: '1.5' },  // 已带短横
      { tradeDate: '', netAmount: '9.9' },             // 空串两侧也归一化为空串
    ]

    const result = mergeKlineWithMoneyFlow(kline, flow)

    // '2026-05-15' 与 '20260515' 归一化后相同
    expect(result[0].moneyFlow).toBe(1.5)
    // 空串两侧 normalize 后仍是空串，能匹配
    expect(result[1].moneyFlow).toBe(9.9)
  })

  it('8) R3 探针正面：flowRows 非空且 kline 非空但 0 命中 → console.error，payload 含样本字段', () => {
    vi.stubEnv('DEV', true)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const kline = [makeBar('2026-05-15'), makeBar('2026-05-16')]
    const flow: MoneyFlowRowLike[] = [
      { tradeDate: '20250515', netAmount: '1' },  // 故意年份不同 → 0 命中
      { tradeDate: '20250516', netAmount: '2' },
    ]

    const result = mergeKlineWithMoneyFlow(kline, flow)

    expect(result.every(b => b.moneyFlow == null)).toBe(true)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const args = errorSpy.mock.calls[0]
    expect(args[0]).toContain('[mergeKlineWithMoneyFlow]')
    const payload = args[1] as Record<string, unknown>
    expect(payload.klineLen).toBe(2)
    expect(payload.flowLen).toBe(2)
    expect(payload.sampleKlineOpenTime).toBe('2026-05-15')
    expect(payload.sampleFlowTradeDate).toBe('20250515')
  })

  it('9) R3 探针负面：合法 0 行（flowRows=[]）不触发；K 线为空也不触发', () => {
    vi.stubEnv('DEV', true)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // 9a: 资金流为空 → 不触发
    mergeKlineWithMoneyFlow([makeBar('2026-05-15')], [])
    expect(errorSpy).not.toHaveBeenCalled()

    // 9b: K 线为空 → 不触发
    mergeKlineWithMoneyFlow([], [{ tradeDate: '20260515', netAmount: '1' }])
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
