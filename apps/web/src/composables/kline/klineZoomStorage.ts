/**
 * KlineChart 水平缩放记忆（全局共享）
 *
 * 用户选择：全局共享 + 记忆 dataZoom 的 start/end 百分比 + 缩放与位置都记。
 * 切换任意股票时，图表重建（dispose + init + setOption）后套用此 {start, end}。
 *
 * 设计要点：
 *  - 全局单一 key，不按 prefsKey / symbol 隔离（用户决策）
 *  - localStorage 读写均 try/catch（SSR / 隐私模式 / quota exceeded 不应炸）
 *  - write 做 150ms debounce，避免拖动 slider / 滚轮连续触发 datazoom 时高频写入
 *  - 数值钳制 [0,100] 且 start < end，非法值一律视为无记忆（返回 null，调用方回退默认 sliderStart）
 */

const STORAGE_KEY = 'kline-chart-zoom'
const DEBOUNCE_MS = 150

export interface KlineZoom {
  start: number
  end: number
}

let timer: ReturnType<typeof setTimeout> | null = null
let pending: KlineZoom | null = null

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < 0) return 0
  if (v > 100) return 100
  return v
}

export function readKlineZoom(): KlineZoom | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw == null) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const obj = parsed as Partial<KlineZoom>
    const start = typeof obj.start === 'number' ? clamp(obj.start) : NaN
    const end = typeof obj.end === 'number' ? clamp(obj.end) : NaN
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    if (start >= end) return null
    return { start, end }
  } catch {
    return null
  }
}

export function writeKlineZoom(zoom: KlineZoom): void {
  const start = clamp(zoom.start)
  const end = clamp(zoom.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return
  pending = { start, end }
  if (timer != null) return
  timer = setTimeout(() => {
    timer = null
    const value = pending
    pending = null
    if (!value) return
    try {
      if (typeof window === 'undefined' || !window.localStorage) return
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    } catch {
      // 隐私模式 / quota exceeded — 静默忽略
    }
  }, DEBOUNCE_MS)
}
