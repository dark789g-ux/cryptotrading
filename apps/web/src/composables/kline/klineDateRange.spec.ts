import { describe, it, expect } from 'vitest'
import {
  msToYyyymmdd,
  msToYyyyMmDd,
  sliceDateStringBarsByRange,
  sliceTimestampBarsByRange,
} from './klineDateRange'

// 所有 ms 都用 new Date(y, m, d[, h, min]) 本地构造，提取也用本地 getter，
// 故 round-trip 与运行 TZ 无关：锁的是"picker 本地午夜 ms ↔ 本地日历日串"的本地语义不变量。
// （若有人把实现误改成 getUTC*，在非 UTC 运行环境下本组断言即失败。）

describe('msToYyyymmdd / msToYyyyMmDd', () => {
  it('本地午夜 ms → 本地日历日串（含补零）', () => {
    const ms = new Date(2024, 0, 2).getTime() // 本地 2024-01-02 00:00
    expect(msToYyyymmdd(ms)).toBe('20240102')
    expect(msToYyyyMmDd(ms)).toBe('2024-01-02')
  })

  it('个位月/日补零', () => {
    const ms = new Date(2026, 8, 9).getTime() // 2026-09-09
    expect(msToYyyymmdd(ms)).toBe('20260909')
    expect(msToYyyyMmDd(ms)).toBe('2026-09-09')
  })
})

describe('sliceDateStringBarsByRange（A 类，open_time = YYYY-MM-DD 字面串）', () => {
  const bars = ['2024-01-01', '2024-01-05', '2024-01-10', '2024-01-15'].map((open_time) => ({
    open_time,
  }))

  it('range=null 返回全量', () => {
    expect(sliceDateStringBarsByRange(bars, null)).toHaveLength(4)
  })

  it('闭区间过滤（含两端）', () => {
    const r: [number, number] = [new Date(2024, 0, 5).getTime(), new Date(2024, 0, 10).getTime()]
    const out = sliceDateStringBarsByRange(bars, r)
    expect(out.map((b) => b.open_time)).toEqual(['2024-01-05', '2024-01-10'])
  })

  it('区间无交集返回空', () => {
    const r: [number, number] = [new Date(2025, 0, 1).getTime(), new Date(2025, 0, 31).getTime()]
    expect(sliceDateStringBarsByRange(bars, r)).toHaveLength(0)
  })
})

describe('sliceTimestampBarsByRange（A 类，open_time = ISO 时间戳串，crypto）', () => {
  // 一组 UTC 整点 bar（模拟 binance 日线/小时线 timestamptz 序列化）
  const hourlyBars = [
    '2024-01-02T00:00:00.000Z',
    '2024-01-02T04:00:00.000Z',
    '2024-01-02T08:00:00.000Z',
    '2024-01-03T00:00:00.000Z',
  ].map((open_time) => ({ open_time }))

  it('range=null 返回全量', () => {
    expect(sliceTimestampBarsByRange(hourlyBars, null, 'hour')).toHaveLength(4)
  })

  it('hour 粒度：按 instant 精确闭区间', () => {
    const start = new Date('2024-01-02T04:00:00.000Z').getTime()
    const end = new Date('2024-01-02T08:00:00.000Z').getTime()
    const out = sliceTimestampBarsByRange(hourlyBars, [start, end], 'hour')
    expect(out.map((b) => b.open_time)).toEqual([
      '2024-01-02T04:00:00.000Z',
      '2024-01-02T08:00:00.000Z',
    ])
  })

  it('date 粒度：按 bar 本地日历日归桶，纳入本地日 ∈ [startDay, endDay]（非循环断言）', () => {
    // 构造落在确定本地日的 bar：本地午夜 + 5h（任何真实 TZ 下仍是同一本地日的 05:00），
    // 故断言独立于运行 TZ，也独立于被测函数自身实现（非循环）。
    const barAtLocalDay = (y: number, m: number, d: number) =>
      new Date(new Date(y, m, d).getTime() + 5 * 3600_000).toISOString()
    const b2 = barAtLocalDay(2024, 0, 2)
    const b3 = barAtLocalDay(2024, 0, 3)
    const b5 = barAtLocalDay(2024, 0, 5)
    const bars = [{ open_time: b2 }, { open_time: b3 }, { open_time: b5 }]

    // 选本地 [2024-01-02, 2024-01-03]：应纳入 b2、b3，排除本地 01-05 的 b5。
    const r: [number, number] = [new Date(2024, 0, 2).getTime(), new Date(2024, 0, 3).getTime()]
    const out = sliceTimestampBarsByRange(bars, r, 'date')
    expect(out.map((b) => b.open_time)).toEqual([b2, b3])
  })

  it('open_time 解析失败的 bar 被丢弃', () => {
    const bad = [{ open_time: 'not-a-date' }, { open_time: '2024-01-02T00:00:00.000Z' }]
    const start = new Date('2024-01-01T00:00:00.000Z').getTime()
    const end = new Date('2024-01-31T00:00:00.000Z').getTime()
    const out = sliceTimestampBarsByRange(bad, [start, end], 'hour')
    expect(out).toHaveLength(1)
    expect(out[0].open_time).toBe('2024-01-02T00:00:00.000Z')
  })
})
