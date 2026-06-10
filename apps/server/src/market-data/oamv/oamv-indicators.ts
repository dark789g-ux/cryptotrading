import { calcMacd } from '../active-mv/amv-formula'
import { calcIndicators } from '../../indicators/indicators'
import type { KlineRow } from '../../indicators/indicators'

export interface OamvIndicatorRow {
  tradeDate: string
  open: string
  high: string
  low: string
  close: string
}

export interface OamvIndicatorArrays {
  tradeDates: string[]
  dif: (number | null)[]
  dea: (number | null)[]
  macd: (number | null)[]
  ma5: (number | null)[]
  ma30: (number | null)[]
  ma60: (number | null)[]
  ma120: (number | null)[]
  ma240: (number | null)[]
  kdjK: (number | null)[]
  kdjD: (number | null)[]
  kdjJ: (number | null)[]
}

const toNullable = (v: number): number | null => (Number.isFinite(v) ? v : null)

/**
 * 从 oamv_daily 行数组批量计算所有指标，返回各指标的并行数组。
 *
 * - MACD：使用通达信式 tdEma（calcMacd，amv-formula），与落库权威口径一致；
 * - MA5/MA30/MA60/MA120/MA240：严格 SMA，不足期为 null；
 * - KDJ K/D/J：9日窗口，初始种子 prevK=prevD=50；
 * - NaN → null。
 *
 * 纯函数，无副作用，可在 jest 中直接 import。
 */
export function buildIndicatorArrays(rows: OamvIndicatorRow[]): OamvIndicatorArrays {
  const tradeDates = rows.map((r) => r.tradeDate)

  // ── MACD：通达信 tdEma，硬约束不换实现 ──────────────────────────────────
  const closes = rows.map((r) => Number(r.close))
  const { dif, dea, macd } = calcMacd(closes)
  const difArr = dif.map(toNullable)
  const deaArr = dea.map(toNullable)
  const macdArr = macd.map(toNullable)

  // ── MA / KDJ：共享 calcIndicators（严格 SMA + 9日 KDJ） ─────────────────
  const klineRows: KlineRow[] = rows.map((r) => ({
    open_time: r.tradeDate,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: 0,
  }))
  const withIndicators = calcIndicators(klineRows)

  const ma5Arr = withIndicators.map((r) => (r.MA5 != null && Number.isFinite(r.MA5) ? r.MA5 : null))
  const ma30Arr = withIndicators.map((r) => (r.MA30 != null && Number.isFinite(r.MA30) ? r.MA30 : null))
  const ma60Arr = withIndicators.map((r) => (r.MA60 != null && Number.isFinite(r.MA60) ? r.MA60 : null))
  const ma120Arr = withIndicators.map((r) => (r.MA120 != null && Number.isFinite(r.MA120) ? r.MA120 : null))
  const ma240Arr = withIndicators.map((r) => (r.MA240 != null && Number.isFinite(r.MA240) ? r.MA240 : null))

  const kdjKArr: (number | null)[] = withIndicators.map((r) =>
    toNullable(r['KDJ.K']),
  )
  const kdjDArr: (number | null)[] = withIndicators.map((r) =>
    toNullable(r['KDJ.D']),
  )
  const kdjJArr: (number | null)[] = withIndicators.map((r) =>
    toNullable(r['KDJ.J']),
  )

  return {
    tradeDates,
    dif: difArr,
    dea: deaArr,
    macd: macdArr,
    ma5: ma5Arr,
    ma30: ma30Arr,
    ma60: ma60Arr,
    ma120: ma120Arr,
    ma240: ma240Arr,
    kdjK: kdjKArr,
    kdjD: kdjDArr,
    kdjJ: kdjJArr,
  }
}
