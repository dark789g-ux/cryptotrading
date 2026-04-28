import { computed } from 'vue'
import { useMessage } from 'naive-ui'
import { symbolApi } from '@/api'

const pad = (n: number) => n.toString().padStart(2, '0')

const formatLocal = (iso: string, withTime: boolean) => {
  const d = new Date(iso)
  const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return withTime ? `${s} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : s
}

export function useDateRange(formDataRef: { params: { timeframe: string; dateStart: string | null; dateEnd: string | null } }) {
  const message = useMessage()

  const datePickerType = computed(() => (formDataRef.params.timeframe === '1d' ? 'date' : 'datetime'))
  const dateFormat = computed(() =>
    formDataRef.params.timeframe === '1d' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm:ss'
  )

  const applyDateRangeDefaults = async (tf: string, setDates: (start: string | null, end: string | null) => void) => {
    try {
      const { min, max } = await symbolApi.getDateRange(tf)
      if (!min || !max) {
        setDates(null, null)
        message.warning(`时间周期 ${tf} 暂无数据`)
        return
      }
      const withTime = tf !== '1d'
      setDates(formatLocal(min, withTime), formatLocal(max, withTime))
    } catch (err: unknown) {
      message.error((err as Error).message || '加载数据区间失败')
    }
  }

  return {
    datePickerType,
    dateFormat,
    applyDateRangeDefaults,
  }
}
