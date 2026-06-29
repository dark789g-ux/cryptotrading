/**
 * 活跃市值（Active MV / AMV）公共纯函数。
 *
 * 全部为通达信式递推，无副作用、可单测。口径与指数级 0AMV（market-data/oamv）一致：
 * - tdSma：通达信 SMA(X, N, M) 递推
 * - tdEma：通达信 EMA(X, N) 递推，首值以第一个有效数据为种子，分母 N+1
 * - calcMacd：DIF = tdEma(fast) - tdEma(slow)，DEA = tdEma(DIF, signal)，柱 = 2×(DIF-DEA)
 *
 * 注意：本文件**照抄** oamv 的 tdSma/tdEma 逻辑，不修改 oamv 模块（spec §6）。
 * indicators.ts 仅导出整包 calcIndicators，无独立 MACD/EMA 导出，故 calcMacd 自写
 * （其 EMA k=2/(period+1) 与本文件 tdEma 分母 n+1 代数等价，同口径）。
 */

import type { AmvSeriesInput, AmvSeriesResult, AmvSignal } from './active-mv.types'

/**
 * 通达信风格 SMA 递推：SMA(X, N, M) = (M*X + (N-M)*prev) / N。
 * 首值以第一个有效数据为种子。无效值（null/undefined/NaN）落 NaN 且不推进种子。
 */
export function tdSma(values: number[], n = 10, m = 1): number[] {
  const result: number[] = []
  let sma: number | null = null

  for (const x of values) {
    if (x === null || x === undefined || isNaN(x)) {
      result.push(NaN)
      continue
    }
    if (sma === null) {
      sma = x
    } else {
      sma = (m * x + (n - m) * sma) / n
    }
    result.push(sma)
  }

  return result
}

/**
 * 通达信风格 EMA 递推：EMA(X, N) = (2*X + (N-1)*prev) / (N+1)。
 * 首值以第一个有效数据为种子。无效值落 NaN 且不推进种子。
 */
export function tdEma(values: number[], n = 12): number[] {
  const result: number[] = []
  let ema: number | null = null

  for (const x of values) {
    if (x === null || x === undefined || isNaN(x)) {
      result.push(NaN)
      continue
    }
    if (ema === null) {
      ema = x
    } else {
      ema = (2 * x + (n - 1) * ema) / (n + 1)
    }
    result.push(ema)
  }

  return result
}

export interface MacdResult {
  dif: number[]
  dea: number[]
  /** MACD 柱 = 2×(DIF-DEA) */
  macd: number[]
}

/**
 * 在给定数值序列上自写 MACD（通达信式 tdEma）。
 * DIF = tdEma(values, fast) - tdEma(values, slow)
 * DEA = tdEma(DIF, signal)
 * 柱   = 2×(DIF - DEA)
 */
export function calcMacd(
  values: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): MacdResult {
  const emaFast = tdEma(values, fast)
  const emaSlow = tdEma(values, slow)
  const dif = emaFast.map((v, i) => v - emaSlow[i])
  const dea = tdEma(dif, signal)
  const macd = dif.map((d, i) => 2 * (d - dea[i]))
  return { dif, dea, macd }
}

/**
 * 三态信号判据（含边界）：
 * - 多头 +1：DIF > 0 且 柱 > 0
 * - 空头 -1：DIF < 0 且 柱 < 0
 * - 中性  0：其余（含 DIF=0 或 柱=0 边界、NaN）
 */
export function calcSignal(dif: number, macdBar: number): AmvSignal {
  if (isNaN(dif) || isNaN(macdBar)) return 0
  if (dif > 0 && macdBar > 0) return 1
  if (dif < 0 && macdBar < 0) return -1
  return 0
}

/**
 * 在指定窗口上做 5 日简单滑动均值（不足 5 日时取已有有效值均值，全 NaN 落 NaN）。
 * 用于 v3 = MA5(REF(close,1))。
 */
function ma5(values: number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - 4)
    const window = values.slice(start, i + 1).filter((v) => !isNaN(v))
    out.push(window.length > 0 ? window.reduce((a, b) => a + b, 0) / window.length : NaN)
  }
  return out
}

/**
 * AMV 序列合成（个股 / 行业通用）。spec §3：
 *   v1   = tdSma(amountInYuan, 10)           // amountInYuan 已换算到元
 *   v3   = MA5(REF(close, 1))                // 前一日收盘价的 5 日均
 *   AMVc = v1 × close / v3 × 0.1             // 不做 /1e6
 *   AMVo/h/l 同理用 open/high/low
 *
 * 异常处置：v3 ≤ 0 或 AMVc ≤ 0（停牌/脏数据）→ 当日四价落 NaN，标记 invalid[t]=true。
 *
 * @param input.amountInYuan 量序列（**已换算到元**，调用方负责换算）
 * @param input.open/high/low/close 价序列（个股=前复权 qfq；行业=指数点位）
 */
export function calcAmvSeries(input: AmvSeriesInput): AmvSeriesResult {
  const { amountInYuan, open, high, low, close } = input
  const len = close.length

  const v1 = tdSma(amountInYuan, 10, 1)

  // v3 = MA5(REF(close, 1))：先取前一日收盘（首行 NaN），再 5 日均
  const refClose1 = [NaN, ...close.slice(0, len - 1)]
  const v3 = ma5(refClose1)

  const amvOpen: number[] = new Array(len)
  const amvHigh: number[] = new Array(len)
  const amvLow: number[] = new Array(len)
  const amvClose: number[] = new Array(len)
  const invalid: boolean[] = new Array(len)

  const MULT = 0.1

  for (let i = 0; i < len; i++) {
    const v3i = v3[i]
    const v1i = v1[i]
    // v3 ≤ 0 视为异常（停牌/脏数据），整日不产指标
    if (!(v3i > 0)) {
      amvOpen[i] = NaN
      amvHigh[i] = NaN
      amvLow[i] = NaN
      amvClose[i] = NaN
      invalid[i] = true
      continue
    }
    const c = (v1i * close[i]) / v3i * MULT
    // AMVc ≤ 0 视为异常
    if (!(c > 0) || isNaN(c)) {
      amvOpen[i] = NaN
      amvHigh[i] = NaN
      amvLow[i] = NaN
      amvClose[i] = NaN
      invalid[i] = true
      continue
    }
    amvOpen[i] = (v1i * open[i]) / v3i * MULT
    amvHigh[i] = (v1i * high[i]) / v3i * MULT
    amvLow[i] = (v1i * low[i]) / v3i * MULT
    amvClose[i] = c
    invalid[i] = false
  }

  return { amvOpen, amvHigh, amvLow, amvClose, invalid }
}

/**
 * 涨跌幅（仅展示，不驱动信号）：zdf[t] = (AMVc[t] - AMVc[t-1]) / AMVc[t-1] × 100。
 * 分母 ≤ 0 或 NaN → 落 null（不写 Inf/NaN，spec §3.1）。
 */
export function calcZdf(amvClose: number[]): Array<number | null> {
  const out: Array<number | null> = []
  for (let i = 0; i < amvClose.length; i++) {
    if (i === 0) {
      out.push(null)
      continue
    }
    const prev = amvClose[i - 1]
    const cur = amvClose[i]
    if (!(prev > 0) || isNaN(cur)) {
      out.push(null)
      continue
    }
    out.push(((cur - prev) / prev) * 100)
  }
  return out
}
