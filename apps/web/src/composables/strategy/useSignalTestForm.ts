/**
 * useSignalTestForm.ts —— 信号前向统计方案表单状态（仿 useStrategyForm）。
 *
 * 管理：表单 model 默认值 + backtestConfig 默认值、编辑/导入回填、DTO 组装
 * （含可选 backtestConfig）。日期归一沿用 SignalTestForm 既有本地午夜 ms ↔ YYYYMMDD。
 *
 * 关键契约：
 * - 出场专属参数「全默认时一个都不送」→ 后端存 null（零漂移），逻辑沿用既有 SignalTestForm。
 * - lookback 仅 phase_lock 有效；UI 归属「基础配置」tab，提交时仍写回 phase_lock_params。
 * - backtestConfig：enableBacktest 关 → 提交 null（不跑回测层）；开 → 组装完整合法 config
 *   （后端 fail-fast 要求 initialCapital/positionRatio/cost/anchorMode/rankSpec/sizing 齐全）。
 */
import { ref, watch } from 'vue'
import type { StrategyConditionItem } from '../../api/modules/strategy/strategyConditions'
import type {
  SignalTest,
  CreateSignalTestDto,
  SignalTestExitMode,
  SignalTestBacktestConfig,
} from '../../api/modules/strategy/signalStats'
import type {
  PortfolioSimCostRates,
  RankFactor,
  SizingConfig,
  CircuitBreaker,
  RegimeRule,
} from '../../api/modules/strategy/portfolioSim'
import {
  COST_PRESET_REALISTIC,
  DEFAULT_SIZING,
  DEFAULT_CIRCUIT_BREAKER,
} from '../../components/portfolio-sim/portfolioSimPresets'

// ── 出场专属参数默认值（与后端 DTO/spec 一致；全默认 → 不上送）─────────────────

const BAND_LOCK_DEFAULTS = {
  stopRatio: 0.999,
  floorRatio: 0.999,
  floorEnabled: true,
  ma5RequireDown: true,
}

const PHASE_LOCK_DEFAULTS = {
  initFactor: 0.999,
  lockFactor: 0.999,
  lookback: 10,
}

/** 回测配置默认值（开启回测时的初值，后端 fail-fast 全字段合法）。 */
function buildDefaultBacktestConfig(): {
  initialCapital: number
  cost: PortfolioSimCostRates
  anchorMode: boolean
  positionRatio: number
  maxPositions: number | null
  exposureCap: number | null
  rankFactors: RankFactor[]
  sizing: SizingConfig
  circuitBreaker: CircuitBreaker
  regimes: RegimeRule[]
} {
  return {
    initialCapital: 1_000_000,
    cost: { ...COST_PRESET_REALISTIC },
    anchorMode: false,
    positionRatio: 0.1,
    maxPositions: 10,
    exposureCap: null,
    rankFactors: [],
    sizing: { ...DEFAULT_SIZING },
    circuitBreaker: { ...DEFAULT_CIRCUIT_BREAKER },
    regimes: [],
  }
}

/** 整个表单 model 形状（含出场专属 + 回测配置扁平字段）。 */
export interface SignalTestFormModel {
  name: string
  buyConditions: StrategyConditionItem[]
  exitMode: SignalTestExitMode
  horizonN: number | null
  exitConditions: StrategyConditionItem[]
  maxHold: number | null
  // trailing_lock 专属
  stopRatio: number
  floorRatio: number
  floorEnabled: boolean
  ma5RequireDown: boolean
  // phase_lock 专属（lookback 上浮到「基础配置」tab，但仍属 phase_lock_params）
  initFactor: number
  lockFactor: number
  lookback: number | null
  dateRange: [number, number] | null
  universeType: 'all' | 'list'
  tsCodesText: string
  // ── 回测层 ──
  enableBacktest: boolean
  btInitialCapital: number
  btCost: PortfolioSimCostRates
  btAnchorMode: boolean
  btPositionRatio: number
  btMaxPositions: number | null
  btExposureCap: number | null
  btRankFactors: RankFactor[]
  btSizing: SizingConfig
  btCircuitBreaker: CircuitBreaker
  btRegimes: RegimeRule[]
}

/** YYYYMMDD → 本地午夜 ms（日历日，沿用既有口径，禁 UTC）。 */
function parseDateStr(s: string): number {
  const y = parseInt(s.slice(0, 4), 10)
  const m = parseInt(s.slice(4, 6), 10) - 1
  const d = parseInt(s.slice(6, 8), 10)
  return new Date(y, m, d).getTime()
}

/** 本地午夜 ms → YYYYMMDD（日历日，禁 UTC）。 */
function formatDateMs(ms: number): string {
  const dt = new Date(ms)
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const d = String(dt.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function buildDefaultRange(): [number, number] {
  const end = new Date()
  end.setHours(0, 0, 0, 0)
  const start = new Date(end)
  start.setFullYear(start.getFullYear() - 2)
  return [start.getTime(), end.getTime()]
}

function buildDefaultModel(): SignalTestFormModel {
  const bt = buildDefaultBacktestConfig()
  return {
    name: '',
    buyConditions: [],
    exitMode: 'fixed_n',
    horizonN: 5,
    exitConditions: [],
    maxHold: 20,
    stopRatio: BAND_LOCK_DEFAULTS.stopRatio,
    floorRatio: BAND_LOCK_DEFAULTS.floorRatio,
    floorEnabled: BAND_LOCK_DEFAULTS.floorEnabled,
    ma5RequireDown: BAND_LOCK_DEFAULTS.ma5RequireDown,
    initFactor: PHASE_LOCK_DEFAULTS.initFactor,
    lockFactor: PHASE_LOCK_DEFAULTS.lockFactor,
    lookback: PHASE_LOCK_DEFAULTS.lookback,
    dateRange: buildDefaultRange(),
    universeType: 'all',
    tsCodesText: '',
    enableBacktest: false,
    btInitialCapital: bt.initialCapital,
    btCost: bt.cost,
    btAnchorMode: bt.anchorMode,
    btPositionRatio: bt.positionRatio,
    btMaxPositions: bt.maxPositions,
    btExposureCap: bt.exposureCap,
    btRankFactors: bt.rankFactors,
    btSizing: bt.sizing,
    btCircuitBreaker: bt.circuitBreaker,
    btRegimes: bt.regimes,
  }
}

export function useSignalTestForm(
  initialData: { value: SignalTest | undefined },
  prefillData: { value: SignalTest | undefined },
) {
  const form = ref<SignalTestFormModel>(buildDefaultModel())

  /** 回填出场专属 + 回测配置；data 为编辑或导入来源。copyName=true 时加「(副本)」。 */
  function applyData(data: SignalTest, copyName: boolean) {
    form.value.name = copyName
      ? data.name.replace(/\s*\(副本\)\s*$/, '') + ' (副本)'
      : data.name
    form.value.buyConditions = data.buyConditions.map((c) => ({ ...c }))
    form.value.exitMode = data.exitMode
    form.value.horizonN = data.horizonN
    form.value.exitConditions = (data.exitConditions ?? []).map((c) => ({ ...c }))
    form.value.maxHold = data.maxHold
    applyBandLockParams(data.bandLockParams)
    applyPhaseLockParams(data.phaseLockParams)
    applyBacktestConfig(data.backtestConfig)
    form.value.universeType = data.universe.type
    form.value.tsCodesText = (data.universe.tsCodes ?? []).join('\n')
    if (data.dateStart && data.dateEnd) {
      form.value.dateRange = [parseDateStr(data.dateStart), parseDateStr(data.dateEnd)]
    }
  }

  function applyBandLockParams(p: SignalTest['bandLockParams']) {
    form.value.stopRatio = p?.stopRatio ?? BAND_LOCK_DEFAULTS.stopRatio
    form.value.floorRatio = p?.floorRatio ?? BAND_LOCK_DEFAULTS.floorRatio
    form.value.floorEnabled = p?.floorEnabled ?? BAND_LOCK_DEFAULTS.floorEnabled
    form.value.ma5RequireDown = p?.ma5RequireDown ?? BAND_LOCK_DEFAULTS.ma5RequireDown
  }

  function applyPhaseLockParams(p: SignalTest['phaseLockParams']) {
    form.value.initFactor = p?.initFactor ?? PHASE_LOCK_DEFAULTS.initFactor
    form.value.lockFactor = p?.lockFactor ?? PHASE_LOCK_DEFAULTS.lockFactor
    form.value.lookback = p?.lookback ?? PHASE_LOCK_DEFAULTS.lookback
  }

  /** 回填回测配置：null → 关闭回测（用默认值占位）；非 null → 开启并回填。 */
  function applyBacktestConfig(bc: SignalTest['backtestConfig']) {
    const def = buildDefaultBacktestConfig()
    if (!bc) {
      form.value.enableBacktest = false
      form.value.btInitialCapital = def.initialCapital
      form.value.btCost = def.cost
      form.value.btAnchorMode = def.anchorMode
      form.value.btPositionRatio = def.positionRatio
      form.value.btMaxPositions = def.maxPositions
      form.value.btExposureCap = def.exposureCap
      form.value.btRankFactors = def.rankFactors
      form.value.btSizing = def.sizing
      form.value.btCircuitBreaker = def.circuitBreaker
      form.value.btRegimes = def.regimes
      return
    }
    form.value.enableBacktest = true
    form.value.btInitialCapital = bc.initialCapital
    form.value.btCost = { ...bc.cost }
    form.value.btAnchorMode = bc.anchorMode
    form.value.btPositionRatio = bc.positionRatio
    form.value.btMaxPositions = bc.maxPositions
    form.value.btExposureCap = bc.exposureCap
    form.value.btRankFactors = (bc.rankSpec?.factors ?? []).map((f) => ({ ...f }))
    form.value.btSizing = { ...DEFAULT_SIZING, ...bc.sizing }
    form.value.btCircuitBreaker = bc.circuitBreaker
      ? { ...DEFAULT_CIRCUIT_BREAKER, ...bc.circuitBreaker }
      : { ...DEFAULT_CIRCUIT_BREAKER }
    form.value.btRegimes = (bc.regimes ?? []).map((r) => ({
      ...r,
      conditions: r.conditions.map((c) => ({ ...c })),
    }))
  }

  watch(
    () => initialData.value,
    (data) => {
      if (!data) return
      applyData(data, false)
    },
    { immediate: true },
  )

  watch(
    () => prefillData.value,
    (data) => {
      if (!data || initialData.value) return
      applyData(data, true)
    },
    { immediate: true },
  )

  // 切换出场模式时复位 maxHold：trailing_lock/phase_lock 默认空=不封顶；strategy 必填回 20。
  // 懒执行——不冲掉初始化回填的 maxHold。
  watch(
    () => form.value.exitMode,
    (mode) => {
      if (mode === 'trailing_lock' || mode === 'phase_lock') {
        form.value.maxHold = null
      } else if (mode === 'strategy' && form.value.maxHold == null) {
        form.value.maxHold = 20
      }
    },
  )

  function parseTsCodes(): string[] {
    return form.value.tsCodesText
      .split(/[\n,，]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  /** 组装回测配置；enableBacktest 关 → null。开 → 完整合法 config。 */
  function buildBacktestConfig(): SignalTestBacktestConfig | null {
    if (!form.value.enableBacktest) return null
    const config: SignalTestBacktestConfig = {
      initialCapital: form.value.btInitialCapital,
      cost: { ...form.value.btCost },
      anchorMode: form.value.btAnchorMode,
      positionRatio: form.value.btPositionRatio,
      maxPositions: form.value.btMaxPositions,
      exposureCap: form.value.btExposureCap,
      rankSpec: { factors: form.value.btRankFactors.map((f) => ({ ...f })) },
      sizing: { ...form.value.btSizing },
      circuitBreaker: form.value.btCircuitBreaker.enableCooldown ||
        form.value.btCircuitBreaker.enableDrawdownHalt
        ? { ...form.value.btCircuitBreaker }
        : null,
    }
    // regime：anchorMode 旁路 + 空=不启用 → 不带该字段（零漂移）；否则深拷贝下发。
    if (!form.value.btAnchorMode && form.value.btRegimes.length > 0) {
      config.regimes = form.value.btRegimes.map((r) => ({
        ...r,
        conditions: r.conditions.map((c) => ({ ...c })),
      }))
    }
    return config
  }

  /**
   * 组装 CreateSignalTestDto；dateRange 必须已校验非空（调用方先校验）。
   * 出场专属参数「全默认则不上送」逻辑同既有 SignalTestForm。
   */
  function buildDto(): CreateSignalTestDto {
    const range = form.value.dateRange
    if (!range) throw new Error('dateRange 未设置')
    const [startMs, endMs] = range
    const dto: CreateSignalTestDto = {
      name: form.value.name,
      buyConditions: form.value.buyConditions,
      exitMode: form.value.exitMode,
      universe:
        form.value.universeType === 'all'
          ? { type: 'all' }
          : { type: 'list', tsCodes: parseTsCodes() },
      dateStart: formatDateMs(startMs),
      dateEnd: formatDateMs(endMs),
    }

    if (form.value.exitMode === 'fixed_n') {
      dto.horizonN = form.value.horizonN ?? undefined
    } else if (form.value.exitMode === 'strategy') {
      dto.exitConditions = form.value.exitConditions
      dto.maxHold = form.value.maxHold ?? undefined
    } else if (form.value.exitMode === 'trailing_lock') {
      dto.maxHold = form.value.maxHold ?? undefined
      if (form.value.stopRatio !== BAND_LOCK_DEFAULTS.stopRatio)
        dto.stopRatio = form.value.stopRatio
      if (form.value.floorRatio !== BAND_LOCK_DEFAULTS.floorRatio)
        dto.floorRatio = form.value.floorRatio
      if (form.value.floorEnabled !== BAND_LOCK_DEFAULTS.floorEnabled)
        dto.floorEnabled = form.value.floorEnabled
      if (form.value.ma5RequireDown !== BAND_LOCK_DEFAULTS.ma5RequireDown)
        dto.ma5RequireDown = form.value.ma5RequireDown
    } else {
      // phase_lock
      if (form.value.initFactor !== PHASE_LOCK_DEFAULTS.initFactor)
        dto.initFactor = form.value.initFactor
      if (form.value.lockFactor !== PHASE_LOCK_DEFAULTS.lockFactor)
        dto.lockFactor = form.value.lockFactor
      if (
        form.value.lookback != null &&
        form.value.lookback !== PHASE_LOCK_DEFAULTS.lookback
      )
        dto.lookback = form.value.lookback
    }

    // 回测层（可选）：关 → null（不跑回测，零漂移）；开 → 完整 config。
    dto.backtestConfig = buildBacktestConfig()

    return dto
  }

  return {
    form,
    parseTsCodes,
    buildDto,
    buildBacktestConfig,
  }
}
