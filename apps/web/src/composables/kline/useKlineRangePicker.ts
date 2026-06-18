// apps/web/src/composables/kline/useKlineRangePicker.ts
//
// KlineChart 工具栏日期选择器（update:range）接线 composable。
//
// 两类调用方共用 range ref + onRangeUpdate + reset：
//   - B 类（服务端重查）：传 onApply。选了区间 → onApply 收到 YYYYMMDD 起止（调用方据此重查）；
//     清空 → onApply(null)（调用方回各自默认窗口）。
//   - A 类（客户端裁切）：可不传 onApply，仅复用 range ref，由自身 computed 读 range.value 裁切
//     已握的全量数据（见 klineDateRange.ts 的 sliceDateStringBarsByRange / sliceTimestampBarsByRange）。
//
// ms→YYYYMMDD 转换收口在 klineDateRange.ts（本地 getter，TZ 例外，见该文件 + datetime.md）。
import { ref } from 'vue'
import { msToYyyymmdd } from './klineDateRange'

export interface KlineRangeDates {
  /** 'YYYYMMDD' */
  startDate: string
  /** 'YYYYMMDD' */
  endDate: string
}

export function useKlineRangePicker(onApply?: (r: KlineRangeDates | null) => void) {
  // 工具栏日期选择器选中区间（[startMs, endMs]，本地午夜 ms）；null = 未选 → 默认窗口。
  const range = ref<[number, number] | null>(null)

  function onRangeUpdate(value: [number, number] | null): void {
    range.value = value
    onApply?.(
      value ? { startDate: msToYyyymmdd(value[0]), endDate: msToYyyymmdd(value[1]) } : null,
    )
  }

  function reset(): void {
    range.value = null
  }

  return { range, onRangeUpdate, reset }
}
