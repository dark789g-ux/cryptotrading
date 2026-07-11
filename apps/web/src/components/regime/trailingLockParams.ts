export interface TrailingLockExitParams {
  maxHold: number | null
  stopRatio: number
  floorEnabled: boolean
  floorRatio: number
  ma5RequireDown: boolean
}

export const TRAILING_LOCK_DEFAULTS: TrailingLockExitParams = {
  maxHold: null,
  stopRatio: 0.999,
  floorEnabled: true,
  floorRatio: 0.999,
  ma5RequireDown: true,
}

/** 缺字段用默认值填入（展示层 hydrate） */
export function hydrateTrailingLockParams(
  raw: Record<string, unknown> | null | undefined,
): TrailingLockExitParams {
  const maxHold = raw?.maxHold
  return {
    maxHold: typeof maxHold === 'number' && maxHold >= 1 ? maxHold : null,
    stopRatio:
      typeof raw?.stopRatio === 'number' ? raw.stopRatio : TRAILING_LOCK_DEFAULTS.stopRatio,
    floorEnabled:
      typeof raw?.floorEnabled === 'boolean'
        ? raw.floorEnabled
        : TRAILING_LOCK_DEFAULTS.floorEnabled,
    floorRatio:
      typeof raw?.floorRatio === 'number' ? raw.floorRatio : TRAILING_LOCK_DEFAULTS.floorRatio,
    ma5RequireDown:
      typeof raw?.ma5RequireDown === 'boolean'
        ? raw.ma5RequireDown
        : TRAILING_LOCK_DEFAULTS.ma5RequireDown,
  }
}

export function asExitParamsRecord(params: TrailingLockExitParams): Record<string, unknown> {
  return { ...params }
}
