// apps/web/src/composables/kline/klineDateRange.ts
//
// KlineChart 工具栏日期选择器（update:range）共享工具：ms → 日期串转换 + A 类客户端裁切。
//
// 关键 TZ 约束（必读 .claude/rules/datetime.md「日期选择器是本地 TZ 例外」）：
// naive-ui n-date-picker 的 [number, number] 值是【本地午夜 ms】（用户在日历上指的那天，
// 本地语义）。提取年月日【只能】用 getFullYear/getMonth/getDate，禁 getUTC*，否则 CST
// 用户的选区会整体漂前 1 天。本文件是全项目唯一的 picker-ms→日期串转换源头，杜绝各处复制走样。

/** 本地午夜 ms → 'YYYYMMDD'（A股/美股 klines、0AMV 等后端入参格式）。本地 getter，见上文 TZ 约束。 */
export function msToYyyymmdd(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

/** 本地午夜 ms → 'YYYY-MM-DD'（A股/美股/0AMV 日线 bar.open_time 的字面格式，供客户端字符串闭区间比较）。 */
export function msToYyyyMmDd(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * A 类客户端裁切：bar.open_time 为 'YYYY-MM-DD' 字面日期串（A股/美股/0AMV 日线、us-index）。
 * 按本地日历日做闭区间过滤——open_time 与选区两端都化为本地日历日串后做字面比较（等价于时间序），
 * 全程本地语义、TZ 无关。range=null 返回全量（默认窗口由调用方决定）。
 */
export function sliceDateStringBarsByRange<T extends { open_time: string }>(
  bars: T[],
  range: [number, number] | null,
): T[] {
  if (!range) return bars
  const startStr = msToYyyyMmDd(range[0])
  const endStr = msToYyyyMmDd(range[1])
  return bars.filter((b) => b.open_time >= startStr && b.open_time <= endStr)
}

/**
 * A 类客户端裁切：bar.open_time 为【ISO 时间戳串】（crypto klines —— timestamptz 序列化结果，
 * 如 '2024-01-02T00:00:00.000Z'）。选区两端是本地午夜/本地 datetime 的 ms（见上文 TZ 约束）：
 *   - date 粒度：按 bar 的【本地日历日】归桶，纳入本地日 ∈ [startDay, endDay]（含两端）。
 *     选区两端与 bar 都化为本地日历日串后字面比较（全程本地语义，同 sliceDateStringBarsByRange），
 *     不混用本地 ms 与 UTC instant。每根 bar 按其 instant 唯一归到一个本地日，无静默丢失。
 *   - hour/minute 粒度：选区两端是精确本地 datetime，bar 与选区都是绝对时刻，按 instant 闭区间
 *     [startMs, endMs] 比较。
 * range=null 返回全量。open_time 解析失败的 bar 丢弃（防 NaN 污染比较）。
 */
export function sliceTimestampBarsByRange<T extends { open_time: string }>(
  bars: T[],
  range: [number, number] | null,
  granularity: 'date' | 'hour' | 'minute',
): T[] {
  if (!range) return bars
  const [startMs, endMs] = range
  if (granularity === 'date') {
    const startStr = msToYyyyMmDd(startMs)
    const endStr = msToYyyyMmDd(endMs)
    return bars.filter((b) => {
      const t = new Date(b.open_time).getTime()
      if (Number.isNaN(t)) return false
      const dayStr = msToYyyyMmDd(t) // bar 的本地日历日
      return dayStr >= startStr && dayStr <= endStr
    })
  }
  return bars.filter((b) => {
    const t = new Date(b.open_time).getTime()
    if (Number.isNaN(t)) return false
    return t >= startMs && t <= endMs
  })
}
