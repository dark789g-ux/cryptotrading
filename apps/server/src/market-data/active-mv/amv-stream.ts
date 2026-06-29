/**
 * AMV 流式递推（streaming）—— calcAmvSeries + calcMacd + calcZdf 的单遍递推版。
 *
 * 与 amv-formula.ts 的数组版**逐行等价**（amv-stream.spec.ts 锁死）：
 *   - v1   = tdSma(amountInYuan, 10, 1)
 *   - v3   = MA5(REF(close, 1)) = avg(前 5 个 close 的有效值)
 *   - AMVc = v1 × close / v3 × 0.1（v3≤0 或 AMVc≤0 → 当日四价 NaN + invalid）
 *   - DIF  = tdEma(amvClose, 12) - tdEma(amvClose, 26)
 *   - DEA  = tdEma(DIF, 9)
 *   - 柱   = 2 × (DIF - DEA)
 *   - zdf[t] = (amvClose[t] - amvClose[t-1]) / amvClose[t-1] × 100（首行/分母≤0/NaN → null）
 *
 * 用于 amv-worker（多线程全量）与个股 AMV dirty 续算（带 seed 续算）。
 * 镜像 indicators/indicators-stream.ts 的结构（AmvCalcState / calcAmvStreaming /
 * normalizeAmvCalcState / AmvStreamCalculator.next），公式内核按 amv-formula.ts 实现。
 */

import type { AmvSeriesInput } from './active-mv.types'

const SMA_N = 10
const SMA_M = 1
const EMA_FAST = 12
const EMA_SLOW = 26
const EMA_SIGNAL = 9
/** v3 = MA5(REF(close,1)) 的窗口：REF(close,1) 的最近 5 个 = close 的前 5 个 */
const V3_WINDOW = 5
const MULT = 0.1

/** AMV 递推状态（seed / checkpoint）。逐字段对应数组版递推前值。 */
export interface AmvCalcState {
  /** 已处理行数（seed 有效性判据 + 首行 zdf=null 判据） */
  count: number
  /** tdSma(amountInYuan,10,1) 递推前值；null=种子未初始化 */
  v1Prev: number | null
  /** 最近 V3_WINDOW 个已处理 close（含 NaN，位置敏感，供 v3=MA5(REF(close,1))） */
  recentCloses: number[]
  /** tdEma(amvClose,12) 前值（DIF fast）；null=种子未初始化 */
  emaFastPrev: number | null
  /** tdEma(amvClose,26) 前值（DIF slow） */
  emaSlowPrev: number | null
  /** tdEma(DIF,9) 前值（DEA） */
  deaPrev: number | null
  /** 上一行 amvClose（含 NaN），供 zdf[t]=(amvClose[t]-prev)/prev */
  prevAmvClose: number | null
}

/** 单行 streaming 输出（等价于 calcAmvSeries+calcMacd+calcZdf 在该行的结果）。 */
export interface AmvStreamRow {
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

export interface AmvStreamResult {
  rows: AmvStreamRow[]
  /** 末行处理后的状态，用于 dirty 续算 checkpoint */
  finalState: AmvCalcState
}

/** 单行输入（calcAmvStreaming 内部把 AmvSeriesInput 拆成逐行）。 */
interface AmvStreamInputRow {
  amountInYuan: number
  open: number
  high: number
  low: number
  close: number
}

/**
 * 单遍递推计算 AMV 全序列。seed 非空时从该状态续算（dirty 续算用）。
 * seed=null/undefined 从零开始（全量）。结果与数组版逐行等价。
 */
export function calcAmvStreaming(
  input: AmvSeriesInput,
  seed?: AmvCalcState | null,
): AmvStreamResult {
  const calc = new AmvStreamCalculator(seed ?? undefined)
  const len = input.close.length
  const rows: AmvStreamRow[] = []
  for (let i = 0; i < len; i++) {
    rows.push(
      calc.next({
        amountInYuan: input.amountInYuan[i],
        open: input.open[i],
        high: input.high[i],
        low: input.low[i],
        close: input.close[i],
      }),
    )
  }
  return { rows, finalState: calc.state }
}

/**
 * 把 jsonb/未知来源的 state 规整成可用 AmvCalcState。
 * 非法（null / 非对象 / count 缺失 / count<0）→ null（normalize 失败，调用方当无 seed 全量重算）。
 * recentCloses 保留 NaN（位置敏感），numOrNull 把非有限数统一 null（种子未初始化语义）。
 */
export function normalizeAmvCalcState(value: unknown): AmvCalcState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<AmvCalcState>
  if (typeof raw.count !== 'number' || raw.count < 0) return null
  return {
    count: raw.count,
    v1Prev: numOrNull(raw.v1Prev),
    recentCloses: closArr(raw.recentCloses),
    emaFastPrev: numOrNull(raw.emaFastPrev),
    emaSlowPrev: numOrNull(raw.emaSlowPrev),
    deaPrev: numOrNull(raw.deaPrev),
    prevAmvClose: numOrNull(raw.prevAmvClose),
  }
}

class AmvStreamCalculator {
  state: AmvCalcState

  constructor(seed?: AmvCalcState) {
    this.state = seed
      ? { ...seed, recentCloses: [...seed.recentCloses] }
      : {
          count: 0,
          v1Prev: null,
          recentCloses: [],
          emaFastPrev: null,
          emaSlowPrev: null,
          deaPrev: null,
          prevAmvClose: null,
        }
  }

  next(row: AmvStreamInputRow): AmvStreamRow {
    const prev = this.state
    const i = prev.count

    // v1 = tdSma(amountInYuan, 10, 1)
    const v1Step = smaStep(row.amountInYuan, SMA_N, SMA_M, prev.v1Prev)
    const v1 = v1Step.value

    // v3 = MA5(REF(close,1)) = avg(前 V3_WINDOW 个 close 的有效值)
    const v3 = avgCloses(prev.recentCloses)

    // AMV 四价 + invalid（与 calcAmvSeries 同口径：v3≤0 或 AMVc≤0 → NaN + invalid）
    let amvOpen = NaN
    let amvHigh = NaN
    let amvLow = NaN
    let amvClose = NaN
    let invalid = true
    if (v3 > 0) {
      const c = (v1 * row.close) / v3 * MULT
      if (c > 0 && !isNaN(c)) {
        amvOpen = (v1 * row.open) / v3 * MULT
        amvHigh = (v1 * row.high) / v3 * MULT
        amvLow = (v1 * row.low) / v3 * MULT
        amvClose = c
        invalid = false
      }
    }

    // MACD（对 amvClose）：DIF=tdEma(fast)-tdEma(slow)，DEA=tdEma(DIF,signal)，柱=2*(DIF-DEA)
    const emaFastStep = emaStep(amvClose, EMA_FAST, prev.emaFastPrev)
    const emaSlowStep = emaStep(amvClose, EMA_SLOW, prev.emaSlowPrev)
    const dif = emaFastStep.value - emaSlowStep.value
    const deaStep = emaStep(dif, EMA_SIGNAL, prev.deaPrev)
    const macd = 2 * (dif - deaStep.value)

    // zdf（首行 null；分母 prevAmvClose≤0 或 amvClose NaN → null）
    let zdf: number | null = null
    if (i > 0) {
      const prevC = prev.prevAmvClose
      if (prevC !== null && prevC > 0 && !isNaN(amvClose)) {
        zdf = ((amvClose - prevC) / prevC) * 100
      }
    }

    this.state = {
      count: i + 1,
      v1Prev: v1Step.nextPrev,
      recentCloses: appendWindow(prev.recentCloses, row.close, V3_WINDOW),
      emaFastPrev: emaFastStep.nextPrev,
      emaSlowPrev: emaSlowStep.nextPrev,
      deaPrev: deaStep.nextPrev,
      prevAmvClose: amvClose,
    }

    return {
      amvOpen,
      amvHigh,
      amvLow,
      amvClose,
      amvDif: dif,
      amvDea: deaStep.value,
      amvMacd: macd,
      amvZdf: zdf,
      invalid,
    }
  }
}

// ── 递推工具（与 amv-formula.ts 的 tdSma/tdEma 逐位等价）──────────────────────

interface StepResult {
  value: number
  /** 递推后的前值（无效输入时不推进，原样返回 prev） */
  nextPrev: number | null
}

/** tdSma 单步：SMA(X,N,M)=(M*X+(N-M)*prev)/N；首值以首个有效数据为种子；无效值落 NaN 不推进。 */
function smaStep(x: number, n: number, m: number, prev: number | null): StepResult {
  if (x === null || x === undefined || isNaN(x)) return { value: NaN, nextPrev: prev }
  if (prev === null) return { value: x, nextPrev: x }
  const v = (m * x + (n - m) * prev) / n
  return { value: v, nextPrev: v }
}

/** tdEma 单步：EMA(X,N)=(2*X+(N-1)*prev)/(N+1)；首值以首个有效数据为种子；无效值落 NaN 不推进。 */
function emaStep(x: number, n: number, prev: number | null): StepResult {
  if (x === null || x === undefined || isNaN(x)) return { value: NaN, nextPrev: prev }
  if (prev === null) return { value: x, nextPrev: x }
  const v = (2 * x + (n - 1) * prev) / (n + 1)
  return { value: v, nextPrev: v }
}

/** 最近 N 个 close 的有效值均值（ma5 口径：filter NaN 后均值，空→NaN）。 */
function avgCloses(closes: number[]): number {
  const valid = closes.filter((v) => !isNaN(v))
  return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : NaN
}

/** 追加并截断到最近 limit 个（保留 NaN，位置敏感）。 */
function appendWindow(values: number[], value: number, limit: number): number[] {
  const next = [...values, value]
  return next.length > limit ? next.slice(next.length - limit) : next
}

// ── normalize 兜底 ──────────────────────────────────────────────────────────

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** recentCloses 规整：保留 NaN（位置敏感），非 number→NaN，截断最近 V3_WINDOW 个。 */
function closArr(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  return v.map((item) => (typeof item === 'number' ? item : NaN)).slice(-V3_WINDOW)
}
