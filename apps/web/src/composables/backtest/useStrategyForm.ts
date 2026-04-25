import { ref, watch } from 'vue'
import type { MaCondition } from '../../components/backtest/strategy/EntrySignalSection.vue'

export type SortFactorType = 'risk_reward' | 'momentum' | 'freshness' | 'liquidity' | 'volatility'

export interface SortFactor {
  factor: SortFactorType
  weight: number
  direction: 'asc' | 'desc'
  enabled: boolean
  /** 因子级扩展参数，当前仅 momentum 使用（maPeriod） */
  params?: Record<string, unknown>
}

export interface StrategyParams {
  initialCapital: number
  positionRatio: number
  maxPositions: number
  timeframe: string
  dateStart: string | null
  dateEnd: string | null
  kdjN: number
  kdjM1: number
  kdjM2: number
  kdjJOversold: number
  kdjOversoldJOffset: number
  maConditions: MaCondition[]
  brickXgEnabled: boolean
  brickDeltaMin: number
  recentLowWindow: number
  recentLowBuffer: number
  entryMaxDistFromLowPct: number
  recentHighWindow: number
  recentHighBuffer: number
  stopLossMode: 'atr' | 'fixed' | 'signal_midpoint'
  fixedStopLossPct: number
  enablePartialProfit: boolean
  partialProfitRatio: number
  enableTrailingStop: boolean
  trailingDrawdownPct: number
  enableBreakevenStop: boolean
  breakevenTriggerR: number
  takeProfitTargets: Array<{ rrRatio: number; sellRatio: number }>
  enableTrailingProfit: boolean
  trailingProfitTriggerR: number
  trailingProfitDrawdownPct: number
  stopLossFactor: number
  enableProfitStopAdjust: boolean
  profitStopAdjustTo: 'midpoint' | 'breakeven'
  enableMa5StopAdjust: boolean
  ma5StopAdjustTo: 'midpoint' | 'breakeven'
  enableLadderStopLoss: boolean
  minRiskRewardRatio: number
  maxInitLoss: number
  requireAllPositionsProfitable: boolean
  enableCooldown: boolean
  baseCooldownCandles: number
  consecutiveLossesThreshold: number
  maxCooldownCandles: number
  cooldownExtendOnLoss: number
  cooldownReduceOnProfit: number
  entrySortMode: 'single' | 'composite'
  entrySortFactors: SortFactor[]
}

export interface StrategyFormData {
  name: string
  typeId: string
  symbols: string[]
  params: StrategyParams
}

const defaultParams = (): StrategyParams => ({
  initialCapital: 1000000,
  positionRatio: 0.4,
  maxPositions: 2,
  timeframe: '1h',
  dateStart: null,
  dateEnd: null,
  kdjN: 9,
  kdjM1: 3,
  kdjM2: 3,
  kdjJOversold: 0,
  kdjOversoldJOffset: 0,
  maConditions: [],
  brickXgEnabled: false,
  brickDeltaMin: 0,
  recentLowWindow: 9,
  recentLowBuffer: 5,
  entryMaxDistFromLowPct: 0,
  recentHighWindow: 9,
  recentHighBuffer: 5,
  stopLossMode: 'atr',
  fixedStopLossPct: 2,
  enablePartialProfit: false,
  partialProfitRatio: 0.5,
  enableTrailingStop: false,
  trailingDrawdownPct: 3,
  enableBreakevenStop: false,
  breakevenTriggerR: 1.0,
  takeProfitTargets: [],
  enableTrailingProfit: false,
  trailingProfitTriggerR: 2.0,
  trailingProfitDrawdownPct: 5,
  stopLossFactor: 1.0,
  enableProfitStopAdjust: true,
  profitStopAdjustTo: 'midpoint',
  enableMa5StopAdjust: true,
  ma5StopAdjustTo: 'midpoint',
  enableLadderStopLoss: false,
  minRiskRewardRatio: 0,
  maxInitLoss: 0.01,
  requireAllPositionsProfitable: false,
  enableCooldown: false,
  baseCooldownCandles: 5,
  consecutiveLossesThreshold: 3,
  maxCooldownCandles: 20,
  cooldownExtendOnLoss: 1,
  cooldownReduceOnProfit: 1,
  entrySortMode: 'single',
  entrySortFactors: [
    { factor: 'risk_reward', weight: 1, direction: 'desc', enabled: true },
    { factor: 'momentum', weight: 0, direction: 'desc', enabled: false, params: { maPeriod: 5 } },
    { factor: 'freshness', weight: 0, direction: 'desc', enabled: false },
    { factor: 'liquidity', weight: 0, direction: 'desc', enabled: false },
    { factor: 'volatility', weight: 0, direction: 'desc', enabled: false },
  ],
})

const normalizeDate = (v: unknown, tf: string): string | null => {
  if (typeof v !== 'string' || !v) return null
  const needsTime = tf !== '1d'
  const hasTime = v.includes(' ')
  if (needsTime && !hasTime) return `${v} 00:00:00`
  if (!needsTime && hasTime) return v.split(' ')[0]
  return v
}

const buildFormData = (strategy?: Record<string, unknown>): StrategyFormData => {
  const params = { ...defaultParams(), ...((strategy?.params as Record<string, unknown>) ?? {}) }
  params.dateStart = normalizeDate(params.dateStart, params.timeframe)
  params.dateEnd = normalizeDate(params.dateEnd, params.timeframe)

  if (strategy?.params) {
    const sp = strategy.params as Record<string, unknown>
    if (sp.enableCooldown !== undefined) {
      params.enableCooldown = !!sp.enableCooldown
    } else {
      params.enableCooldown =
        ((sp.baseCooldownCandles as number) ?? 0) > 0 ||
        ((sp.consecutiveLossesThreshold as number) ?? 9999) < 9999 ||
        ((sp.cooldownBars as number) ?? 0) > 0
    }
  }

  return {
    name: (strategy?.name as string) ?? '',
    typeId: (strategy?.typeId as string) ?? 'ma_kdj',
    symbols: ((strategy?.symbols as string[]) ?? []),
    params,
  }
}

export function useStrategyForm(strategyRef: { value?: unknown }, isEditRef: { value: boolean }) {
  const formData = ref<StrategyFormData>(buildFormData())

  const resetForm = () => {
    formData.value = buildFormData()
  }

  const loadStrategy = (s: unknown) => {
    formData.value = buildFormData(s as Record<string, unknown>)
  }

  const mergeImportedParams = (imported: StrategyFormData, preserve: { name: string; symbols: string[]; dateStart: string | null; dateEnd: string | null }) => {
    formData.value = {
      ...imported,
      name: preserve.name,
      symbols: preserve.symbols,
      params: {
        ...imported.params,
        dateStart: preserve.dateStart,
        dateEnd: preserve.dateEnd,
      },
    }
  }

  const clearDates = () => {
    formData.value.params.dateStart = null
    formData.value.params.dateEnd = null
  }

  const setDates = (start: string | null, end: string | null) => {
    formData.value.params.dateStart = start
    formData.value.params.dateEnd = end
  }

  watch(
    () => strategyRef.value,
    (s) => {
      if (s) loadStrategy(s)
    },
    { immediate: true }
  )

  return {
    formData,
    resetForm,
    loadStrategy,
    mergeImportedParams,
    clearDates,
    setDates,
  }
}
