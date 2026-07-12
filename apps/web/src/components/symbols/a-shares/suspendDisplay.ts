import { formatTradeDate } from './aSharesFormatters'
import type { AShareKlineSuspend, AShareSuspendStatus } from '@/api/modules/market/aShares'

export function isSuspended(status: AShareSuspendStatus | undefined): boolean {
  return status === 'suspended'
}

/** 列表 Tag / 工具栏 Badge 的 Tooltip：自 YYYY-MM-DD 停牌 · 时段 */
export function buildSuspendTooltip(sinceDate: string | null, timing: string | null): string {
  const parts: string[] = []
  if (sinceDate) parts.push(`自 ${formatTradeDate(sinceDate)} 停牌`)
  if (timing) parts.push(timing)
  return parts.length > 0 ? parts.join(' · ') : '停牌中'
}

/** K 线工具栏副文案：行情截至 … · 自 … 停牌 */
export function buildSuspendToolbarCaption(suspend: AShareKlineSuspend): string {
  const parts: string[] = []
  if (suspend.lastQuoteTradeDate) {
    parts.push(`行情截至 ${formatTradeDate(suspend.lastQuoteTradeDate)}`)
  }
  if (suspend.sinceDate) {
    parts.push(`自 ${formatTradeDate(suspend.sinceDate)} 停牌`)
  }
  return parts.join(' · ')
}

/** 信息栏「停牌状态」文案 */
export function formatSuspendStatusLabel(status: AShareSuspendStatus | undefined): string {
  return isSuspended(status) ? '停牌中' : '正常交易'
}
