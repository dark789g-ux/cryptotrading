import type { OamvData } from '@/api/modules/market/oamv'
import type { KlineChartBar } from '@/api/modules/market/symbols'

/**
 * 将单条 OamvData 映射为 KlineChartBar。
 * 纯函数，与 Vue 组件解耦，供 vitest 直接 import 测试。
 *
 * 错误处理约定（spec §7）：
 * - 后端未升级时新字段缺失 → `?? null` 兜底，不报错，回退到空白显示。
 */
export function mapOamvToChartBar(d: OamvData): KlineChartBar {
  // YYYYMMDD → YYYY-MM-DD
  const open_time = `${d.tradeDate.slice(0, 4)}-${d.tradeDate.slice(4, 6)}-${d.tradeDate.slice(6, 8)}`

  return {
    open_time,
    open: Number(d.open),
    high: Number(d.high),
    low: Number(d.low),
    close: Number(d.close),
    volume: 0, // 0AMV 无成交量概念
    MA5: d.ma5 ?? null,
    MA30: d.ma30 ?? null,
    MA60: d.ma60 ?? null,
    MA120: d.ma120 ?? null,
    MA240: d.ma240 ?? null,
    'KDJ.K': d.kdjK ?? null,
    'KDJ.D': d.kdjD ?? null,
    'KDJ.J': d.kdjJ ?? null,
    DIF: d.amvDif ?? null,
    DEA: d.amvDea ?? null,
    MACD: d.amvMacd ?? null,
    BBI: null,
    brickChart: undefined,
  }
}
