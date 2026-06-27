import { BadRequestException } from '@nestjs/common'
import type { AmvSeriesRange } from './amv-series-query'

export const TRADE_DATE_RE = /^\d{8}$/
export const SW_INDEX_SUFFIX_RE = /\.SI$/i

export function parseAmvDaysAndRange(
  days?: string,
  startDate?: string,
  endDate?: string,
): { daysNum: number; range?: AmvSeriesRange } {
  if (startDate && !TRADE_DATE_RE.test(startDate)) {
    throw new BadRequestException('startDate 必须为 8 位 YYYYMMDD')
  }
  if (endDate && !TRADE_DATE_RE.test(endDate)) {
    throw new BadRequestException('endDate 必须为 8 位 YYYYMMDD')
  }
  const daysNum = days ? parseInt(days, 10) : 250
  const range = startDate || endDate ? { startDate, endDate } : undefined
  return { daysNum, range }
}

export function assertSwIndexSuffix(tsCode: string): void {
  if (!SW_INDEX_SUFFIX_RE.test(tsCode)) {
    throw new BadRequestException('申万指数 tsCode 必须以 .SI 结尾')
  }
}
