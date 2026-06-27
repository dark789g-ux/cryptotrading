import { Between, FindOptionsWhere, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm'
import type { AmvSeriesRow } from './active-mv.types'

/** AMV 日线宽表公共列（stock / industry / concept / sw 同构）。 */
export interface AmvDailyEntityLike {
  tsCode: string
  tradeDate: string
  amvOpen: number | null
  amvHigh: number | null
  amvLow: number | null
  amvClose: number | null
  amvDif: number | null
  amvDea: number | null
  amvMacd: number | null
  amvZdf: number | null
  signal: number
  memberCount?: number | null
}

export interface AmvSeriesRange {
  startDate?: string
  endDate?: string
}

export function mapAmvEntityToSeriesRow(r: AmvDailyEntityLike): AmvSeriesRow {
  return {
    tradeDate: r.tradeDate,
    amvOpen: r.amvOpen ?? NaN,
    amvHigh: r.amvHigh ?? NaN,
    amvLow: r.amvLow ?? NaN,
    amvClose: r.amvClose ?? NaN,
    amvDif: r.amvDif ?? NaN,
    amvDea: r.amvDea ?? NaN,
    amvMacd: r.amvMacd ?? NaN,
    amvZdf: r.amvZdf,
    signal: r.signal as AmvSeriesRow['signal'],
    memberCount: r.memberCount ?? undefined,
  }
}

/**
 * 查询单标的 AMV 序列。
 * - 有 range（startDate/endDate）：按 trade_date 闭区间/半区间过滤、升序返回，忽略 days
 * - 无 range：最近 days 条 DESC take 后 reverse ASC
 */
export async function getSeriesWithRange<E extends AmvDailyEntityLike>(
  repo: Repository<E>,
  tsCode: string,
  days: number,
  range?: AmvSeriesRange,
): Promise<AmvSeriesRow[]> {
  if (range && (range.startDate || range.endDate)) {
    const where = { tsCode } as FindOptionsWhere<E>
    if (range.startDate && range.endDate) {
      ;(where as AmvDailyEntityLike).tradeDate = Between(range.startDate, range.endDate) as never
    } else if (range.startDate) {
      ;(where as AmvDailyEntityLike).tradeDate = MoreThanOrEqual(range.startDate) as never
    } else if (range.endDate) {
      ;(where as AmvDailyEntityLike).tradeDate = LessThanOrEqual(range.endDate) as never
    }
    const rows = await repo.find({ where, order: { tradeDate: 'ASC' } as never })
    return rows.map(mapAmvEntityToSeriesRow)
  }

  const take = days > 0 ? days : 250
  const rows = await repo.find({
    where: { tsCode } as FindOptionsWhere<E>,
    order: { tradeDate: 'DESC' } as never,
    take,
  })
  return rows.reverse().map(mapAmvEntityToSeriesRow)
}
