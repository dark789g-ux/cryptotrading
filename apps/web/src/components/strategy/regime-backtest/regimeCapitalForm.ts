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
