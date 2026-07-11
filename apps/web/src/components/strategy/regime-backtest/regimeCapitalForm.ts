import type {
  RegimeBacktestCapital,
  RegimeCircuitBreaker,
  RegimeKellyConfig,
  RegimeSizingConfig,
} from '@/api/modules/strategy/regimeEngine'

export interface RegimeCapitalFormState {
  requireAllPositionsProfitable: boolean
  enableKellySizing: boolean
  simTrades: number
  windowTrades: number
  stepTrades: number
  kellyFraction: number
  kellyMaxMult: number
  enableProbe: boolean
  enableCooldown: boolean
  consecutiveLossesThreshold: number
  baseCooldownDays: number
  maxCooldownDays: number
  extendOnLoss: number
  reduceOnProfit: number
  enableDrawdownHalt: boolean
  drawdownHaltPct: number
  drawdownResumePct: number
}

const DEFAULT_SIZING: RegimeSizingConfig = {
  mode: 'fixed',
  floorMult: 0.5,
  capMult: 1.5,
  kellyFraction: 0.5,
  kellyMaxMult: 1,
}

export function defaultCapitalFormState(): RegimeCapitalFormState {
  return {
    requireAllPositionsProfitable: false,
    enableKellySizing: false,
    simTrades: 50,
    windowTrades: 50,
    stepTrades: 1,
    kellyFraction: 0.5,
    kellyMaxMult: 1,
    enableProbe: true,
    enableCooldown: false,
    consecutiveLossesThreshold: 3,
    baseCooldownDays: 3,
    maxCooldownDays: 10,
    extendOnLoss: 1,
    reduceOnProfit: 1,
    enableDrawdownHalt: false,
    drawdownHaltPct: 0.15,
    drawdownResumePct: 0.1,
  }
}

/** 从回测 capital 快照还原表单状态（缺省字段用默认值） */
export function hydrateCapitalFormState(
  capital: RegimeBacktestCapital | null | undefined,
): RegimeCapitalFormState {
  const base = defaultCapitalFormState()
  if (!capital) return base

  const kelly = capital.kelly
  const cb = capital.circuitBreaker
  const enableKelly =
    kelly?.enabled === true || capital.sizing?.mode === 'source_kelly'

  return {
    requireAllPositionsProfitable: capital.requireAllPositionsProfitable === true,
    enableKellySizing: enableKelly,
    simTrades: kelly?.simTrades ?? base.simTrades,
    windowTrades: kelly?.windowTrades ?? base.windowTrades,
    stepTrades: kelly?.stepTrades ?? base.stepTrades,
    kellyFraction: kelly?.kellyFraction ?? capital.sizing?.kellyFraction ?? base.kellyFraction,
    kellyMaxMult: kelly?.kellyMaxMult ?? capital.sizing?.kellyMaxMult ?? base.kellyMaxMult,
    enableProbe: kelly?.enableProbe ?? base.enableProbe,
    enableCooldown: cb?.enableCooldown ?? base.enableCooldown,
    consecutiveLossesThreshold:
      cb?.consecutiveLossesThreshold ?? base.consecutiveLossesThreshold,
    baseCooldownDays: cb?.baseCooldownDays ?? base.baseCooldownDays,
    maxCooldownDays: cb?.maxCooldownDays ?? base.maxCooldownDays,
    extendOnLoss: cb?.extendOnLoss ?? base.extendOnLoss,
    reduceOnProfit: cb?.reduceOnProfit ?? base.reduceOnProfit,
    enableDrawdownHalt: cb?.enableDrawdownHalt ?? base.enableDrawdownHalt,
    drawdownHaltPct: cb?.drawdownHaltPct ?? base.drawdownHaltPct,
    drawdownResumePct: cb?.drawdownResumePct ?? base.drawdownResumePct,
  }
}

export function buildCapitalPayload(state: RegimeCapitalFormState): Partial<RegimeBacktestCapital> {
  const sizing: RegimeSizingConfig = state.enableKellySizing
    ? {
        mode: 'source_kelly',
        floorMult: DEFAULT_SIZING.floorMult,
        capMult: DEFAULT_SIZING.capMult,
        kellyFraction: state.kellyFraction,
        kellyMaxMult: state.kellyMaxMult,
      }
    : { ...DEFAULT_SIZING }

  const kelly: RegimeKellyConfig = {
    enabled: state.enableKellySizing,
    simTrades: state.simTrades,
    windowTrades: state.windowTrades,
    stepTrades: state.stepTrades,
    kellyFraction: state.kellyFraction,
    kellyMaxMult: state.kellyMaxMult,
    enableProbe: state.enableProbe,
  }

  const circuitBreaker: RegimeCircuitBreaker = {
    enableCooldown: state.enableCooldown,
    consecutiveLossesThreshold: state.consecutiveLossesThreshold,
    baseCooldownDays: state.baseCooldownDays,
    maxCooldownDays: state.maxCooldownDays,
    extendOnLoss: state.extendOnLoss,
    reduceOnProfit: state.reduceOnProfit,
    enableDrawdownHalt: state.enableDrawdownHalt,
    drawdownHaltPct: state.drawdownHaltPct,
    drawdownResumePct: state.drawdownResumePct,
  }

  const payload: Partial<RegimeBacktestCapital> = { sizing, kelly, circuitBreaker }
  if (state.requireAllPositionsProfitable) {
    payload.requireAllPositionsProfitable = true
  }
  return payload
}
