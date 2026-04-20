import { ref, computed, type Ref } from 'vue'
import { useMessage } from 'naive-ui'

interface ConfigField {
  key: string
  label: string
  deprecated?: boolean
}

interface ConfigGroup {
  title: string
  fields: ConfigField[]
}

const configGroups: ConfigGroup[] = [
  { title: '基础参数', fields: [
    { key: 'initialCapital', label: '初始资金' },
    { key: 'positionRatio', label: '单仓资金占比' },
    { key: 'maxPositions', label: '最大持仓数' },
    { key: 'minOpenCash', label: '最小开仓资金' },
  ] },
  { title: '数据范围', fields: [
    { key: 'timeframe', label: '时间周期' },
    { key: 'dateStart', label: '开始日期' },
    { key: 'dateEnd', label: '结束日期' },
    { key: 'warmupBars', label: '预热根数' },
    { key: 'maxBacktestBars', label: '最大回测根数' },
    { key: 'lookbackBuffer', label: '回看缓冲' },
  ] },
  { title: '入场条件', fields: [
    { key: 'maPeriods', label: 'MA 周期' },
    { key: 'minRiskRewardRatio', label: '最小盈亏比' },
    { key: 'maxInitLoss', label: '最大初始亏损' },
  ] },
  { title: '出场与止损', fields: [
    { key: 'stopLossFactor', label: '止损系数' },
    { key: 'enablePartialProfit', label: '启用分批止盈' },
  ] },
  { title: '冷却与风控', fields: [
    { key: 'enableCooldown', label: '启用冷却期' },
    { key: 'baseCooldownCandles', label: '基础冷却根数' },
    { key: 'consecutiveLossesThreshold', label: '连亏触发阈值' },
    { key: 'maxCooldownCandles', label: '最大冷却根数' },
    { key: 'cooldownExtendOnLoss', label: '亏损时冷却延长（根）' },
    { key: 'cooldownReduceOnProfit', label: '盈利时冷却缩短（根）' },
    { key: 'cooldownBars', label: '冷却周期数（已废弃）', deprecated: true },
    { key: 'consecutiveLossesReduceOnProfit', label: '盈利后冷却削减（已废弃）', deprecated: true },
  ] },
]

const PERCENT_KEYS = new Set(['positionRatio', 'maxInitLoss'])

export function useBacktestConfigSnapshot(
  allRuns: Ref<any[]>,
  selectedRunId: Ref<string | null>,
) {
  const message = useMessage()

  const configView = ref<'form' | 'json'>('form')
  const foldedKeys = ref<Set<string>>(new Set())
  const jsonViewRef = ref<HTMLElement | null>(null)

  const configSnapshot = computed<Record<string, unknown> | null>(() => {
    const r = allRuns.value.find((x) => x.id === selectedRunId.value)
    return (r?.configSnapshot as Record<string, unknown>) ?? null
  })

  const visibleConfigGroups = computed(() => {
    const snap = configSnapshot.value
    if (!snap) return configGroups
    return configGroups.map((grp) => ({
      ...grp,
      fields: grp.fields.filter((f) => {
        if (f.deprecated && !(f.key in snap)) return false
        return true
      }),
    }))
  })

  const jsonKeys = computed(() =>
    configSnapshot.value ? Object.keys(configSnapshot.value) : [],
  )

  const arrayKeys = computed(() =>
    jsonKeys.value.filter((k) => Array.isArray(configSnapshot.value?.[k])),
  )

  const allFolded = computed(() =>
    arrayKeys.value.length > 0 && arrayKeys.value.every((k) => foldedKeys.value.has(k)),
  )

  const formatConfigValue = (key: string, value: unknown): string => {
    if (value === null || value === undefined || value === '') return '—'
    if (typeof value === 'boolean') return value ? '是' : '否'
    if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
    if (typeof value === 'number' && PERCENT_KEYS.has(key)) return `${(value * 100).toFixed(2)}%`
    return String(value)
  }

  const isArray = (v: unknown): v is unknown[] => Array.isArray(v)

  const primClass = (v: unknown): string => {
    if (v === null || v === undefined) return 'json-null'
    if (typeof v === 'string') return 'json-string'
    if (typeof v === 'number') return 'json-number'
    if (typeof v === 'boolean') return 'json-boolean'
    return ''
  }

  const primText = (v: unknown): string => {
    if (v === null || v === undefined) return 'null'
    if (typeof v === 'string') return `"${v}"`
    return String(v)
  }

  const toggleConfigView = () => {
    configView.value = configView.value === 'form' ? 'json' : 'form'
  }

  const toggleFold = (key: string) => {
    const set = new Set(foldedKeys.value)
    if (set.has(key)) set.delete(key); else set.add(key)
    foldedKeys.value = set
  }

  const toggleFoldAll = () => {
    foldedKeys.value = allFolded.value ? new Set() : new Set(arrayKeys.value)
  }

  const selectAllJson = () => {
    const el = jsonViewRef.value
    if (!el) return
    const sel = window.getSelection()
    if (!sel) return
    const range = document.createRange()
    range.selectNodeContents(el)
    sel.removeAllRanges()
    sel.addRange(range)
  }

  const copyConfig = async () => {
    const snap = configSnapshot.value
    if (!snap) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(snap, null, 2))
      message.success('已复制')
    } catch {
      message.error('复制失败')
    }
  }

  return {
    configSnapshot,
    visibleConfigGroups,
    configView,
    foldedKeys,
    jsonViewRef,
    jsonKeys,
    allFolded,
    formatConfigValue,
    isArray,
    primClass,
    primText,
    toggleConfigView,
    toggleFold,
    toggleFoldAll,
    selectAllJson,
    copyConfig,
  }
}
