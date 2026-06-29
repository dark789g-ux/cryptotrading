/**
 * AMV worker 线程入口（镜像 indicators/indicator-worker.ts）。
 *
 * 收 { tsCode, rows, seedState }：
 *   - rows 已由 service 用 this.num() 转成 number（含 NaN，千元 amount / qfq OHLC）；
 *   - worker 内 amount ×1000（避双换算）→ calcAmvStreaming(seedState) → postMessage。
 *
 * seedState 非法（normalizeAmvCalcState→null）时全量重算；合法时从该状态续算（dirty 用）。
 */
import { parentPort } from 'worker_threads'
import type { AmvSeriesInput } from '../market-data/active-mv/active-mv.types'
import {
  calcAmvStreaming,
  normalizeAmvCalcState,
  type AmvCalcState,
  type AmvStreamRow,
} from '../market-data/active-mv/amv-stream'

/** worker 入参单行：tradeDate + 已 num 化的 amount(千元)/OHLC（NaN 表示无效）。 */
export interface AmvWorkerRow {
  tradeDate: string
  /** 成交额，千元（worker 内 ×1000 到元） */
  amount: number
  open: number
  high: number
  low: number
  close: number
}

/** worker 出参单行：tradeDate + AMV 全字段（AmvStreamRow）。 */
export interface AmvWorkerOutRow extends AmvStreamRow {
  tradeDate: string
}

export interface AmvWorkerMessage {
  tsCode: string
  rows: AmvWorkerRow[]
  seedState: unknown
}

export interface AmvWorkerResult {
  tsCode: string
  rows: AmvWorkerOutRow[]
  finalState: AmvCalcState
}

parentPort?.on('message', ({ tsCode, rows, seedState }: AmvWorkerMessage) => {
  const seed = normalizeAmvCalcState(seedState)
  const input: AmvSeriesInput = {
    amountInYuan: rows.map((r) => r.amount * 1000),
    open: rows.map((r) => r.open),
    high: rows.map((r) => r.high),
    low: rows.map((r) => r.low),
    close: rows.map((r) => r.close),
  }
  const { rows: streamRows, finalState } = calcAmvStreaming(input, seed)
  const out: AmvWorkerOutRow[] = rows.map((r, i) => ({
    tradeDate: r.tradeDate,
    ...streamRows[i],
  }))
  parentPort?.postMessage({ tsCode, rows: out, finalState } satisfies AmvWorkerResult)
})
