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
  { title: '资金与仓位', fields: [
    { key: 'initialCapital', label: '初始资金' },
    { key: 'positionRatio', label: '仓位比例 / 最大仓位上限' },
    { key: 'maxPositions', label: '最大持仓' },
    { key: 'requireAllPositionsProfitable', label: '仅全部盈利时开新仓' },
    { key: 'enableKellySizing', label: '启用凯利公式仓位管理' },
    { key: 'kellySimTrades', label: '凯利模拟期笔数' },
    { key: 'kellyWindowTrades', label: '凯利滑动窗口大小' },
    { key: 'kellyStepTrades', label: '凯利统计更新步长' },
    { key: 'kellyFraction', label: '凯利分数' },
    { key: 'kellyMaxPositionRatio', label: '凯利仓位硬上限' },
    { key: 'enableKellyProbe', label: '凯利探针交易' },
  ] },
  { title: '基础配置', fields: [
    { key: 'recentLowWindow', label: '低点扫描(K线)' },
    { key: 'recentLowBuffer', label: '低点追溯缓冲' },
    { key: 'recentHighWindow', label: '高点窗口(K线)' },
    { key: 'recentHighBuffer', label: '高点回溯缓冲' },
  ] },
  { title: '入场信号', fields: [
    { key: 'kdjN', label: 'KDJ N' },
    { key: 'kdjM1', label: 'KDJ M1' },
    { key: 'kdjM2', label: 'KDJ M2' },
    { key: 'kdjJOversold', label: 'J 阈值' },
    { key: 'kdjOversoldJOffset', label: 'J 取值偏移' },
    { key: 'maPeriods', label: 'MA 周期' },
    { key: 'maConditions', label: 'MA 条件' },
    { key: 'entryMaxDistFromLowPct', label: '最大初始止损' },
    { key: 'minRiskRewardRatio', label: '最小盈亏比' },
    { key: 'brickXgEnabled', label: '砖型图 XG' },
    { key: 'brickDeltaMin', label: 'DELTA 加速阈值' },
  ] },
  { title: '入场排序', fields: [
    { key: 'entrySortMode', label: '排序模式' },
    { key: 'entrySortFactors', label: '排序因子' },
  ] },
  { title: '止损与出场', fields: [
    { key: 'stopLossMode', label: '止损类型' },
    { key: 'fixedStopLossPct', label: '固定止损' },
    { key: 'stopLossFactor', label: '止损因子' },
    { key: 'enableProfitStopAdjust', label: '阶段止盈后上调止损' },
    { key: 'profitStopAdjustTo', label: '阶段止盈上调至' },
    { key: 'enableMa5StopAdjust', label: 'MA5 上升后上调止损' },
    { key: 'ma5StopAdjustTo', label: 'MA5 上调至' },
    { key: 'enableLadderStopLoss', label: '阶梯追踪止损' },
    { key: 'enablePartialProfit', label: '阶段止盈' },
    { key: 'partialProfitRatio', label: '阶段止盈比例' },
    { key: 'enableTrailingStop', label: '移动止损' },
    { key: 'trailingDrawdownPct', label: '移动止损回撤' },
    { key: 'enableBreakevenStop', label: '保本止损' },
    { key: 'breakevenTriggerR', label: '保本触发 R' },
    { key: 'takeProfitTargets', label: '分段止盈目标' },
    { key: 'enableTrailingProfit', label: '盈利回撤止盈' },
    { key: 'trailingProfitTriggerR', label: '盈利回撤触发 R' },
    { key: 'trailingProfitDrawdownPct', label: '盈利回撤比例' },
  ] },
  { title: '风控与回测', fields: [
    { key: 'maxInitLoss', label: '最大初始亏损' },
    { key: 'enableCooldown', label: '启用冷却期' },
    { key: 'baseCooldownCandles', label: '基础冷却根数' },
    { key: 'consecutiveLossesThreshold', label: '连亏触发阈值' },
    { key: 'maxCooldownCandles', label: '最大冷却根数' },
    { key: 'cooldownExtendOnLoss', label: '亏损时冷却延长（根）' },
    { key: 'cooldownReduceOnProfit', label: '盈利时冷却缩短（根）' },
    { key: 'timeframe', label: '时间周期' },
    { key: 'dateStart', label: '开始日期' },
    { key: 'dateEnd', label: '结束日期' },
    { key: 'warmupBars', label: '预热根数' },
    { key: 'lookbackBuffer', label: '回看缓冲' },
    { key: 'maxBacktestBars', label: '最大回测根数' },
    { key: 'minOpenCash', label: '最小开仓资金' },
    { key: 'cooldownBars', label: '冷却周期数（已废弃）', deprecated: true },
    { key: 'consecutiveLossesReduceOnProfit', label: '盈利后冷却削减（已废弃）', deprecated: true },
  ] },
]

const RATIO_KEYS = new Set([
  'positionRatio',
  'partialProfitRatio',
  'kellyMaxPositionRatio',
  'maxInitLoss',
])
const PERCENT_UNIT_KEYS = new Set([
  'fixedStopLossPct',
  'entryMaxDistFromLowPct',
  'trailingDrawdownPct',
  'trailingProfitDrawdownPct',
])

const STOP_LOSS_MODE_LABELS: Record<string, string> = {
  atr: '阶段低点 × 因子',
  fixed: '固定百分比',
  signal_midpoint: '信号K线中点价',
}

const ADJUST_TO_LABELS: Record<string, string> = {
  midpoint: '中点价',
  breakeven: '保本价',
}

const ENTRY_SORT_MODE_LABELS: Record<string, string> = {
  single: '单因子排序',
  composite: '多因子加权',
}

const SORT_FACTOR_LABELS: Record<string, string> = {
  risk_reward: '盈亏比',
  momentum: '动量强度',
  freshness: '信号新鲜度',
  liquidity: '流动性',
  volatility: '波动率适配',
}

const DIRECTION_LABELS: Record<string, string> = {
  asc: '升序',
  desc: '降序',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const formatRatio = (value: number): string => `${(value * 100).toFixed(2)}%`
const formatPercentUnit = (value: number): string => `${value.toFixed(2)}%`

const formatMaConditions = (value: unknown[]): string => {
  const conditions = value
    .filter(isRecord)
    .map((item) => {
      const left = typeof item.left === 'string' ? item.left : ''
      const op = typeof item.op === 'string' ? item.op : ''
      const right = typeof item.right === 'string' ? item.right : ''
      return left && op && right ? `${left} ${op} ${right}` : ''
    })
    .filter((text) => text.length > 0)
  return conditions.length ? conditions.join('\n') : '-'
}

const formatTakeProfitTargets = (value: unknown[]): string => {
  const targets = value
    .filter(isRecord)
    .map((item) => {
      const rrRatio = typeof item.rrRatio === 'number' ? item.rrRatio : null
      const sellRatio = typeof item.sellRatio === 'number' ? item.sellRatio : null
      if (rrRatio === null && sellRatio === null) return ''
      const rrText = rrRatio === null ? 'RR -' : `RR ${rrRatio}`
      const sellText = sellRatio === null ? '卖出 -' : `卖出 ${formatRatio(sellRatio)}`
      return `${rrText} / ${sellText}`
    })
    .filter((text) => text.length > 0)
  return targets.length ? targets.join('\n') : '-'
}

const formatEntrySortFactors = (value: unknown[]): string => {
  const factors = value
    .filter(isRecord)
    .map((item) => {
      const factor = typeof item.factor === 'string' ? item.factor : ''
      const enabled = typeof item.enabled === 'boolean' ? item.enabled : false
      const direction = typeof item.direction === 'string' ? item.direction : ''
      const weight = typeof item.weight === 'number' ? item.weight : null
      const params = isRecord(item.params) ? item.params : null
      const paramText = params
        ? Object.entries(params).map(([k, v]) => `${k}=${String(v)}`).join(', ')
        : ''
      return [
        `${SORT_FACTOR_LABELS[factor] ?? (factor || '未知因子')}：${enabled ? '启用' : '停用'}`,
        direction ? DIRECTION_LABELS[direction] ?? direction : '',
        weight !== null ? `权重 ${weight}` : '',
        paramText,
      ].filter(Boolean).join('，')
    })
  return factors.length ? factors.join('\n') : '-'
}

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
    if (value === null || value === undefined || value === '') return '-'
    if (typeof value === 'boolean') return value ? '是' : '否'
    if (Array.isArray(value)) {
      if (!value.length) return '-'
      if (key === 'maConditions') return formatMaConditions(value)
      if (key === 'takeProfitTargets') return formatTakeProfitTargets(value)
      if (key === 'entrySortFactors') return formatEntrySortFactors(value)
      return value.map((item) => String(item)).join(', ')
    }
    if (typeof value === 'number' && RATIO_KEYS.has(key)) return formatRatio(value)
    if (typeof value === 'number' && PERCENT_UNIT_KEYS.has(key)) return formatPercentUnit(value)
    if (typeof value === 'string' && key === 'stopLossMode') return STOP_LOSS_MODE_LABELS[value] ?? value
    if (typeof value === 'string' && (key === 'profitStopAdjustTo' || key === 'ma5StopAdjustTo')) {
      return ADJUST_TO_LABELS[value] ?? value
    }
    if (typeof value === 'string' && key === 'entrySortMode') return ENTRY_SORT_MODE_LABELS[value] ?? value
    if (isRecord(value)) return JSON.stringify(value)
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
