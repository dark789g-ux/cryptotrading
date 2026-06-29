/**
 * amv-stream.spec.ts
 *
 * 锁死 calcAmvStreaming 与数组版（calcAmvSeries + calcMacd + calcZdf）的逐行等价：
 *   1) 全量：streaming.rows[i] === 数组版第 i 行（amvO/H/L/C + DIF/DEA/MACD + zdf + invalid）
 *   2) seed 续算：从第 k 行带 seed 续算 === 全量切片 [k..]
 *   3) JSON 往返（模拟 jsonb checkpoint 存取）后续算仍等价
 *   4) normalizeAmvCalcState 非法输入 → null
 *
 * 等价性是 PR-5（多线程全量）与 PR-6（dirty 续算）的共同基石。
 */

import type { AmvSeriesInput } from './active-mv.types'
import { calcAmvSeries, calcMacd, calcZdf } from './amv-formula'
import {
  calcAmvStreaming,
  normalizeAmvCalcState,
  type AmvStreamRow,
} from './amv-stream'

/** 含正常段 + close=0（AMVc=0 invalid）+ close 负（AMVc<0 invalid）的混合输入。 */
function makeInput(): AmvSeriesInput {
  const close = [
    10, 10.5, 11, 10.8, 11.2, 11.5, 11, 10.9, 11.3, 11.6, // 0-9 正常建立 v3/EMA
    11.1, 0, 11.2, 11.5, -4, 11, 11.3, 11.6, 11.1, 11.4, // 10-19 含 0 与负（触发 invalid）
    11.7, 11.2, 11.5, 11.8, 11.3, // 20-24 恢复
  ]
  const N = close.length
  return {
    close,
    open: close.map((c) => c * 0.99),
    high: close.map((c) => (c === 0 ? 0 : c * 1.02)),
    low: close.map((c) => (c === 0 ? 0 : c * 0.97)),
    amountInYuan: Array.from({ length: N }, (_, i) => 1e7 + (i % 5) * 1e6),
  }
}

interface ExpectedRow {
  amvOpen: number
  amvHigh: number
  amvLow: number
  amvClose: number
  amvDif: number
  amvDea: number
  amvMacd: number
  amvZdf: number | null
  invalid: boolean
}

/** 用数组版计算期望行（calcAmvSeries + calcMacd + calcZdf）。 */
function expectedRows(input: AmvSeriesInput): ExpectedRow[] {
  const series = calcAmvSeries(input)
  const macd = calcMacd(series.amvClose, 12, 26, 9)
  const zdf = calcZdf(series.amvClose)
  return input.close.map((_, i) => ({
    amvOpen: series.amvOpen[i],
    amvHigh: series.amvHigh[i],
    amvLow: series.amvLow[i],
    amvClose: series.amvClose[i],
    amvDif: macd.dif[i],
    amvDea: macd.dea[i],
    amvMacd: macd.macd[i],
    amvZdf: zdf[i],
    invalid: series.invalid[i],
  }))
}

function sliceInput(input: AmvSeriesInput, start: number, end?: number): AmvSeriesInput {
  return {
    amountInYuan: input.amountInYuan.slice(start, end),
    open: input.open.slice(start, end),
    high: input.high.slice(start, end),
    low: input.low.slice(start, end),
    close: input.close.slice(start, end),
  }
}

function assertNumEqual(actual: number, expected: number): void {
  if (Number.isNaN(expected)) {
    expect(Number.isNaN(actual)).toBe(true)
  } else {
    expect(actual).toBeCloseTo(expected, 8)
  }
}

function assertRowEqual(actual: AmvStreamRow, expected: ExpectedRow): void {
  assertNumEqual(actual.amvOpen, expected.amvOpen)
  assertNumEqual(actual.amvHigh, expected.amvHigh)
  assertNumEqual(actual.amvLow, expected.amvLow)
  assertNumEqual(actual.amvClose, expected.amvClose)
  assertNumEqual(actual.amvDif, expected.amvDif)
  assertNumEqual(actual.amvDea, expected.amvDea)
  assertNumEqual(actual.amvMacd, expected.amvMacd)
  if (expected.amvZdf === null) {
    expect(actual.amvZdf).toBeNull()
  } else {
    expect(actual.amvZdf).toBeCloseTo(expected.amvZdf, 8)
  }
  expect(actual.invalid).toBe(expected.invalid)
}

describe('calcAmvStreaming vs 数组版（calcAmvSeries+calcMacd+calcZdf）逐行等价', () => {
  it('全量：含 invalid 的混合数据，逐行 9 字段全等', () => {
    const input = makeInput()
    const stream = calcAmvStreaming(input)
    const exp = expectedRows(input)

    expect(stream.rows).toHaveLength(exp.length)
    // 至少有一行 invalid（验证异常路径被覆盖）
    expect(exp.some((r) => r.invalid)).toBe(true)
    for (let i = 0; i < exp.length; i++) {
      assertRowEqual(stream.rows[i], exp[i])
    }
  })

  it('全量：恒定数据（边界）逐行等价', () => {
    const n = 8
    const input: AmvSeriesInput = {
      close: Array(n).fill(10),
      open: Array(n).fill(9),
      high: Array(n).fill(11),
      low: Array(n).fill(8),
      amountInYuan: Array(n).fill(1e8),
    }
    const stream = calcAmvStreaming(input)
    const exp = expectedRows(input)
    for (let i = 0; i < exp.length; i++) {
      assertRowEqual(stream.rows[i], exp[i])
    }
  })
})

describe('calcAmvStreaming seed 续算 == 全量切片', () => {
  it.each([1, 3, 7, 12, 20])('从第 k 行（seed=前 k 行 finalState）续算 == 全量 [k..]', (k) => {
    const input = makeInput()
    const full = calcAmvStreaming(input)
    const seed = calcAmvStreaming(sliceInput(input, 0, k)).finalState
    const cont = calcAmvStreaming(sliceInput(input, k), seed)

    expect(cont.rows).toHaveLength(full.rows.length - k)
    for (let j = 0; j < cont.rows.length; j++) {
      assertRowEqual(cont.rows[j], full.rows[k + j])
    }
  })

  it('JSON 往返（模拟 jsonb checkpoint）后续算仍 == 全量切片', () => {
    const input = makeInput()
    const full = calcAmvStreaming(input)
    const k = 7
    // finalState 经 JSON 序列化/反序列化（NaN → null），normalize 后续算
    const seedRaw = JSON.parse(JSON.stringify(calcAmvStreaming(sliceInput(input, 0, k)).finalState))
    const seed = normalizeAmvCalcState(seedRaw)
    expect(seed).not.toBeNull()
    const cont = calcAmvStreaming(sliceInput(input, k), seed!)

    for (let j = 0; j < cont.rows.length; j++) {
      assertRowEqual(cont.rows[j], full.rows[k + j])
    }
  })
})

describe('normalizeAmvCalcState', () => {
  it('null / undefined / 非对象 / 缺 count → null', () => {
    expect(normalizeAmvCalcState(null)).toBeNull()
    expect(normalizeAmvCalcState(undefined)).toBeNull()
    expect(normalizeAmvCalcState({})).toBeNull()
    expect(normalizeAmvCalcState('nope')).toBeNull()
  })

  it('count<0 → null', () => {
    expect(normalizeAmvCalcState({ count: -1 })).toBeNull()
  })

  it('合法 state 返回规整后的 state（count 保留，recentCloses 截断到 5）', () => {
    const seed = normalizeAmvCalcState({
      count: 9,
      v1Prev: 1.2e8,
      recentCloses: [10, 10.5, 11, 10.8, 11.2, 11.5, 11], // 7 个 → 截最近 5
      emaFastPrev: 9.9,
      emaSlowPrev: 10.1,
      deaPrev: -0.2,
      prevAmvClose: 9.8,
    })
    expect(seed).not.toBeNull()
    expect(seed!.count).toBe(9)
    expect(seed!.v1Prev).toBeCloseTo(1.2e8, 4)
    expect(seed!.recentCloses).toHaveLength(5)
    expect(seed!.recentCloses).toEqual([11, 10.8, 11.2, 11.5, 11])
    expect(seed!.prevAmvClose).toBeCloseTo(9.8, 6)
  })

  it('非有限数（NaN/字符串）字段 → null（种子未初始化语义）', () => {
    const seed = normalizeAmvCalcState({ count: 3, v1Prev: 'bad', emaFastPrev: NaN })
    expect(seed).not.toBeNull()
    expect(seed!.v1Prev).toBeNull()
    expect(seed!.emaFastPrev).toBeNull()
  })
})
