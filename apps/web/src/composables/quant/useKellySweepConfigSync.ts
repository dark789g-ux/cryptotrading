/**
 * useKellySweepConfigSync
 *
 * 管理 KellySweepConfigForm 中 universe / 日期区间的本地 ref ↔ config 双向同步逻辑。
 * 抽出后 ConfigForm 减重约 55 行，同时给 resyncLocalRefs 加"值真变才写"守卫，
 * 消除 config deep watch → resync 写回相同值的冗余往返。
 */
import { ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { SweepParams } from '@/api/modules/quant/kellySweep'

// ---------- 日期 helper（本地 TZ，供日期选择器使用；不适用于 DB 入库） ----------

/** 本地 TZ 提取日历日 → YYYYMMDD（trade_date 格式） */
function tsToYYYYMMDD(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

/** YYYYMMDD → 本地午夜 ms（native-ui daterange 值格式） */
function yyyymmddToTs(s: string): number {
  const y = Number(s.slice(0, 4))
  const m = Number(s.slice(4, 6)) - 1
  const d = Number(s.slice(6, 8))
  return new Date(y, m, d).getTime()
}

function initDateRange(range: [string, string]): [number, number] | null {
  const [s, e] = range
  return s && e ? [yyyymmddToTs(s), yyyymmddToTs(e)] : null
}

// ---------- 辅助：按值比较 [number,number]|null ----------
function rangeEqual(
  a: [number, number] | null,
  b: [number, number] | null,
): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a[0] === b[0] && a[1] === b[1]
}

// ---------- composable ----------
export function useKellySweepConfigSync(config: Ref<SweepParams>) {
  // universe 辅助 ref
  const universeMode = ref<'all' | 'list'>(
    Array.isArray(config.value.universe) ? 'list' : 'all',
  )
  const universeListText = ref(
    Array.isArray(config.value.universe) ? config.value.universe.join(',') : '',
  )

  // 日期区间辅助 ref
  const trainRange = ref<[number, number] | null>(initDateRange(config.value.train_range))
  const validRange = ref<[number, number] | null>(initDateRange(config.value.valid_range))

  // universeMode → config
  watch(universeMode, (m) => {
    if (m === 'all') {
      config.value = { ...config.value, universe: 'all' }
    } else {
      config.value = {
        ...config.value,
        universe: universeListText.value.split(',').map(s => s.trim()).filter(Boolean),
      }
    }
  })

  // universeListText → config
  watch(universeListText, (t) => {
    if (universeMode.value === 'list') {
      config.value = {
        ...config.value,
        universe: t.split(',').map(s => s.trim()).filter(Boolean),
      }
    }
  })

  // config deep watch → 同步局部 ref（父覆写历史 job 时触发）
  // 加"值真变才写"守卫：避免自身写 config → resync → 再写相同值的冗余往返
  function resyncLocalRefs(newConfig: SweepParams) {
    // universe
    if (Array.isArray(newConfig.universe)) {
      if (universeMode.value !== 'list') universeMode.value = 'list'
      const text = newConfig.universe.join(',')
      if (universeListText.value !== text) universeListText.value = text
    } else {
      if (universeMode.value !== 'all') universeMode.value = 'all'
      if (universeListText.value !== '') universeListText.value = ''
    }
    // 日期区间
    const newTrain = initDateRange(newConfig.train_range)
    if (!rangeEqual(trainRange.value, newTrain)) trainRange.value = newTrain

    const newValid = initDateRange(newConfig.valid_range)
    if (!rangeEqual(validRange.value, newValid)) validRange.value = newValid
  }

  watch(
    () => config.value,
    (newConfig) => {
      resyncLocalRefs(newConfig)
    },
    { deep: true },
  )

  // 日期 handler（模板 @update:value 绑定）
  function onTrainRangeChange(v: [number, number] | null) {
    if (v) {
      config.value = { ...config.value, train_range: [tsToYYYYMMDD(v[0]), tsToYYYYMMDD(v[1])] }
    }
  }

  function onValidRangeChange(v: [number, number] | null) {
    if (v) {
      config.value = { ...config.value, valid_range: [tsToYYYYMMDD(v[0]), tsToYYYYMMDD(v[1])] }
    }
  }

  return {
    universeMode,
    universeListText,
    trainRange,
    validRange,
    onTrainRangeChange,
    onValidRangeChange,
  }
}
