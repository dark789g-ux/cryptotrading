import type {
  QuadrantEntry,
  CreateRegimeConfigDto,
  RegimeConfigMap,
  RegimeBucketCondition,
} from '@/api/modules/strategy/regimeEngine'
import {
  asExitParamsRecord,
  hydrateTrailingLockParams,
} from '@/components/regime/trailingLockParams'
import { RANK_FIELD_VALUES } from '@/components/regime/rankFieldMeta'

export function makeDefaultQuadrant(key: string, label: string): QuadrantEntry {
  return {
    key,
    label,
    action: 'trade',
    match: [],
    entryConditions: [],
    exitMode: null,
    exitParams: null,
    positionRatio: 0.2,
    maxPositions: 4,
    rankField: 'turnover_rate',
    rankDir: 'desc',
  }
}

export function cloneQuadrant(q: QuadrantEntry): QuadrantEntry {
  const exitMode = q.exitMode ?? null
  let exitParams: Record<string, unknown> | null = q.exitParams ? { ...q.exitParams } : null
  if (exitMode === 'trailing_lock') {
    exitParams = asExitParamsRecord(hydrateTrailingLockParams(exitParams))
  }
  const rankField =
    q.rankField ?? (q.action === 'trade' ? 'turnover_rate' : null)
  const rankDir =
    rankField === 'none' || rankField == null
      ? null
      : (q.rankDir ?? 'desc')
  return {
    key: q.key,
    label: q.label,
    action: q.action,
    match: q.match ? q.match.map((c) => ({ ...c })) : [],
    entryConditions: q.entryConditions ? q.entryConditions.map((c) => ({ ...c })) : [],
    exitMode,
    exitParams,
    positionRatio: q.positionRatio ?? (q.action === 'trade' ? 0.2 : null),
    maxPositions: q.maxPositions ?? (q.action === 'trade' ? 4 : null),
    rankField,
    rankDir,
  }
}

export function bucketConditionEqual(a: RegimeBucketCondition, b: RegimeBucketCondition): boolean {
  return (
    a.type === b.type &&
    a.target === b.target &&
    a.field === b.field &&
    a.operator === b.operator &&
    a.value === b.value &&
    a.compareField === b.compareField &&
    a.compareMode === b.compareMode
  )
}

function isUnitInterval(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 1
}

export interface ValidateFormInput {
  version: number
  quadrants: QuadrantEntry[]
  isSingleQuadrant: boolean
  skipVersion?: boolean
}

export interface ValidateFormResult {
  error: string | null
  /** 调用方应切到该象限 tab */
  focusKey?: string
}

/** 校验失败返回 error；成功 error 为 null。 */
export function validateRegimeEditorForm(input: ValidateFormInput): ValidateFormResult {
  const { version, quadrants, isSingleQuadrant, skipVersion } = input
  if (!skipVersion && (!version || version < 1)) {
    return { error: '版本号必须为正整数' }
  }
  if (quadrants.length === 0) {
    return { error: '至少配置一个象限' }
  }
  const keys = new Set<string>()
  for (const q of quadrants) {
    if (keys.has(q.key.trim())) {
      return { error: `Key 重复: ${q.key}`, focusKey: q.key }
    }
    keys.add(q.key.trim())
    if (!q.label.trim()) {
      return { error: `象限 ${q.key} 标签不能为空`, focusKey: q.key }
    }
    if (!isSingleQuadrant && (!Array.isArray(q.match) || q.match.length === 0)) {
      return { error: `象限 ${q.key} 分桶条件不能为空`, focusKey: q.key }
    }
    if (q.action !== 'trade') continue

    if (!Array.isArray(q.entryConditions) || q.entryConditions.length === 0) {
      return { error: `象限 ${q.key} 入场条件不能为空`, focusKey: q.key }
    }
    const ratio = q.positionRatio
    if (ratio == null || !isUnitInterval(ratio)) {
      return {
        error: `象限 ${q.key} 仓位比例必填，且须为 (0, 1] 之间的数字`,
        focusKey: q.key,
      }
    }
    const maxPos = q.maxPositions
    if (maxPos == null || !Number.isInteger(maxPos) || maxPos < 1) {
      return { error: `象限 ${q.key} 最大持仓必填，且须为正整数`, focusKey: q.key }
    }
    if (ratio * maxPos > 1) {
      return { error: `象限 ${q.key} 仓位比例 × 最大持仓不能大于 1`, focusKey: q.key }
    }
    const rf = q.rankField
    if (rf == null || rf === '' || !RANK_FIELD_VALUES.has(rf)) {
      return {
        error: `象限 ${q.key} 选股排序字段必填，且须为短名单字段（含 none）`,
        focusKey: q.key,
      }
    }
    if (rf !== 'none' && q.rankDir !== 'asc' && q.rankDir !== 'desc') {
      return {
        error: `象限 ${q.key} 选股排序方向在字段≠none 时必须为升序或降序`,
        focusKey: q.key,
      }
    }
    if (!q.exitMode) {
      return { error: `象限 ${q.key} 为 trade 象限，必须选择出场模式`, focusKey: q.key }
    }
    if (q.exitMode === 'trailing_lock') {
      const p = hydrateTrailingLockParams(q.exitParams)
      const maxHold = p.maxHold
      if (maxHold != null && (!Number.isInteger(maxHold) || maxHold < 1)) {
        return {
          error: `象限 ${q.key} 的 trailing_lock maxHold 须为正整数或留空`,
          focusKey: q.key,
        }
      }
      if (!isUnitInterval(p.stopRatio)) {
        return {
          error: `象限 ${q.key} 的止损系数须为 (0, 1] 之间的数字`,
          focusKey: q.key,
        }
      }
      if (!isUnitInterval(p.floorRatio)) {
        return {
          error: `象限 ${q.key} 的地板系数须为 (0, 1] 之间的数字`,
          focusKey: q.key,
        }
      }
    }
    if (q.exitMode === 'fixed_n') {
      const n = q.exitParams?.N as number | undefined
      if (!n || n < 1) {
        return { error: `象限 ${q.key} 的 fixed_n 天数必须为正整数`, focusKey: q.key }
      }
    }
    if (q.exitMode === 'strategy') {
      const maxHold = q.exitParams?.maxHold as number | null | undefined
      if (!maxHold || maxHold < 1) {
        return { error: `象限 ${q.key} 的 strategy maxHold 必须为正整数`, focusKey: q.key }
      }
    }
  }
  return { error: null }
}

export function buildRegimeConfigDto(form: {
  version: number
  note: string | null
  quadrants: QuadrantEntry[]
}): CreateRegimeConfigDto {
  const quadrants = form.quadrants.map((q) => {
    const entry: QuadrantEntry = {
      key: q.key.trim(),
      label: q.label.trim(),
      match: q.match,
      action: q.action,
    }
    if (q.action === 'trade') {
      entry.entryConditions = q.entryConditions ?? []
      entry.positionRatio = q.positionRatio ?? null
      entry.maxPositions = q.maxPositions ?? null
      entry.rankField = q.rankField ?? null
      entry.rankDir = q.rankField === 'none' ? null : (q.rankDir ?? null)
      if (q.exitMode) {
        entry.exitMode = q.exitMode
        if (q.exitMode === 'trailing_lock') {
          entry.exitParams = asExitParamsRecord(hydrateTrailingLockParams(q.exitParams))
        } else {
          entry.exitParams = q.exitParams ? { ...q.exitParams } : {}
        }
      }
    } else {
      // flat：原样保留 rank 字段（不强制剥离）
      if (q.rankField != null) entry.rankField = q.rankField
      if (q.rankDir !== undefined) entry.rankDir = q.rankDir
    }
    return entry
  })
  return {
    version: form.version,
    note: form.note || null,
    config: { quadrants },
  }
}

export function buildRegimeConfigMap(form: {
  version: number
  note: string | null
  quadrants: QuadrantEntry[]
}): RegimeConfigMap {
  return buildRegimeConfigDto(form).config
}
