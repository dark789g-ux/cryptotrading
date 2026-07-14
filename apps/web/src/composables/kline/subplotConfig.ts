/**
 * KlineChart 副图配置：类型、默认值、归一化工具
 *
 * - 副图开关 / 顺序 / 高度由用户在工具栏调节
 * - 调用点（a-share / crypto / backtest / 个股·行业 AMV）通过 prefsKey 在 localStorage 隔离
 * - 默认偏好下，buildGrid/buildXAxes/... 必须输出与重构前完全一致的视觉布局
 *
 * 硬约束（AMV 副图接入）：
 * - 新增 '0AMV' / '0AMV_MACD' 仅供个股（a-share）与行业（ths-index）K 线视图使用，
 *   通过各调用点显式传入的 availableSubplots 白名单门控。
 * - crypto / backtest 必须在 availableSubplots 中**排除**这两个 key，
 *   normalizePrefs 会据此过滤，保证其默认视觉布局与接入前完全一致。
 */

export type SubplotKey = 'VOL' | 'KDJ' | 'MACD' | 'BRICK' | 'FLOW' | '0AMV' | '0AMV_MACD'

/** K 线主图指标 key(逐线开关) */
export type MainIndicatorKey =
  | 'MA5' | 'MA30' | 'MA60' | 'MA120' | 'MA240'
  | 'VWAP5' | 'VWAP10' | 'VWAP20'

/** 全部主图指标 key,固定顺序(MA 组 + VWAP 组) */
export const ALL_MAIN_INDICATOR_KEYS: readonly MainIndicatorKey[] = [
  'MA5', 'MA30', 'MA60', 'MA120', 'MA240',
  'VWAP5', 'VWAP10', 'VWAP20',
]

export interface SubplotConfig {
  key: SubplotKey
  visible: boolean
  /** 占图表容器总高度的百分比，范围 4–20 */
  heightPct: number
}

import type { KdjSubplotParams } from '@/api/modules/market/symbols'

export type { KdjSubplotParams }

/** 指标副图参数集合。当前仅 KDJ，后续可扩展 MACD 等。 */
export interface IndicatorSubplotParams {
  KDJ?: KdjSubplotParams
}

export interface SubplotPrefs {
  /** 用户拖拽后的顺序，未在此列表中的 key 落到末尾按 ALL_SUBPLOT_KEYS 顺序补齐 */
  order: SubplotKey[]
  visibility: Record<SubplotKey, boolean>
  heightPct: Record<SubplotKey, number>
  /** 自定义指标参数；等于默认值时省略，保持持久化精简 */
  params?: IndicatorSubplotParams
  /** 主图指标逐线可见性;缺省视为全开(向后兼容) */
  mainIndicators?: Record<MainIndicatorKey, boolean>
}

/** 外部输入的偏好（如 localStorage 原始值 / update 入参），params 允许 partial */
export type PartialIndicatorSubplotParams = {
  [K in keyof IndicatorSubplotParams]?: Partial<NonNullable<IndicatorSubplotParams[K]>>
}

export type RawSubplotPrefs = Partial<Omit<SubplotPrefs, 'params' | 'mainIndicators'>> & {
  params?: PartialIndicatorSubplotParams | undefined
  /** 允许 partial 主图指标(仅含被改的 key) */
  mainIndicators?: Partial<Record<MainIndicatorKey, boolean>>
}

export const ALL_SUBPLOT_KEYS: readonly SubplotKey[] = [
  'VOL',
  'KDJ',
  'MACD',
  'BRICK',
  'FLOW',
  '0AMV',
  '0AMV_MACD',
]

/** 主图指标默认可见性(全开) */
export const DEFAULT_MAIN_INDICATOR_VISIBILITY: Record<MainIndicatorKey, boolean> = {
  MA5: true, MA30: true, MA60: true, MA120: true, MA240: true,
  VWAP5: true, VWAP10: true, VWAP20: true,
}

/**
 * 默认高度（百分比）— 与重构前 GRID_WITH_FLOW 的 height 字段对齐。
 * K 主图高度 = 100% - 顶部留白 - sum(可见副图高度) - dataZoom 区高度，由布局函数动态计算。
 *
 * 0AMV / 0AMV_MACD 仅在被加入 availableSubplots 的调用点（个股 / 行业 K 线）出现，
 * 默认 8%（与 KDJ/MACD 同量级）。
 */
export const DEFAULT_SUBPLOT_HEIGHT_PCT: Record<SubplotKey, number> = {
  VOL: 8,
  KDJ: 8,
  MACD: 8,
  BRICK: 6,
  FLOW: 10,
  '0AMV': 8,
  '0AMV_MACD': 8,
}

export const DEFAULT_SUBPLOT_ORDER: readonly SubplotKey[] = [
  'VOL',
  'KDJ',
  'MACD',
  'BRICK',
  'FLOW',
  '0AMV',
  '0AMV_MACD',
]

/** KDJ 默认参数：与 Tushare / 常见行情软件保持一致（9, 3, 3） */
export const DEFAULT_KDJ_PARAMS: KdjSubplotParams = {
  n: 9,
  m1: 3,
  m2: 3,
}

/** KDJ 各参数合法范围（闭区间） */
export const KDJ_PARAM_RANGES: Record<keyof KdjSubplotParams, readonly [number, number]> = {
  n: [2, 99],
  m1: [1, 50],
  m2: [1, 50],
}

/**
 * 三个调用点的默认偏好。
 * - a-share: 全开（FLOW 即资金净流入，A 股有数据可展示）
 * - crypto: 关闭 FLOW（加密目前没有 moneyFlow 数据源）
 * - backtest: 全开
 */
export function defaultPrefsFor(prefsKey: string): SubplotPrefs {
  const baseVisibility: Record<SubplotKey, boolean> = {
    VOL: true,
    KDJ: true,
    MACD: true,
    BRICK: true,
    FLOW: prefsKey !== 'crypto',
    // 0AMV / 0AMV_MACD 默认开；仅在 availableSubplots 含这两个 key 的调用点
    //（个股 / 行业 K 线）才会真正渲染，其余调用点经 normalizePrefs 过滤后不出现，
    // 故对 crypto / backtest 的默认布局无影响。
    '0AMV': true,
    '0AMV_MACD': true,
  }
  return {
    order: [...DEFAULT_SUBPLOT_ORDER],
    visibility: baseVisibility,
    heightPct: { ...DEFAULT_SUBPLOT_HEIGHT_PCT },
    mainIndicators: { ...DEFAULT_MAIN_INDICATOR_VISIBILITY },
  }
}

/**
 * 判断给定 KDJ 参数是否等于默认值。
 * 支持 partial 输入：未提供的字段视为默认。
 */
export function isDefaultKdjParams(p?: Partial<KdjSubplotParams> | null): boolean {
  if (!p) return true
  return (
    (p.n === undefined || p.n === DEFAULT_KDJ_PARAMS.n) &&
    (p.m1 === undefined || p.m1 === DEFAULT_KDJ_PARAMS.m1) &&
    (p.m2 === undefined || p.m2 === DEFAULT_KDJ_PARAMS.m2)
  )
}

function clampOrDefault(
  value: unknown,
  defaultValue: number,
  [min, max]: readonly [number, number],
): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) return defaultValue
  return n
}

function normalizeKdjParams(p?: Partial<KdjSubplotParams> | null): KdjSubplotParams {
  const input = p ?? {}
  return {
    n: clampOrDefault(input.n, DEFAULT_KDJ_PARAMS.n, KDJ_PARAM_RANGES.n),
    m1: clampOrDefault(input.m1, DEFAULT_KDJ_PARAMS.m1, KDJ_PARAM_RANGES.m1),
    m2: clampOrDefault(input.m2, DEFAULT_KDJ_PARAMS.m2, KDJ_PARAM_RANGES.m2),
  }
}

/** 把外部输入归一化为完整的 mainIndicators 记录,缺失项补全为默认(可见) */
export function normalizeMainIndicators(
  raw?: Partial<Record<MainIndicatorKey, boolean>> | null,
): Record<MainIndicatorKey, boolean> {
  const result = { ...DEFAULT_MAIN_INDICATOR_VISIBILITY }
  if (raw && typeof raw === 'object') {
    for (const key of ALL_MAIN_INDICATOR_KEYS) {
      const v = raw[key]
      if (typeof v === 'boolean') result[key] = v
    }
  }
  return result
}

/**
 * 将任意输入归一化为合法的指标参数集合。
 * KDJ 缺失字段用默认值补齐；越界 / 非数字值回退到默认值。
 * 等于默认值时省略，保持持久化精简。
 */
export function normalizeIndicatorParams(
  p?: PartialIndicatorSubplotParams | null,
): IndicatorSubplotParams {
  const kdj = normalizeKdjParams(p?.KDJ)
  if (isDefaultKdjParams(kdj)) return {}
  return { KDJ: kdj }
}

/**
 * 把外部传入的偏好与默认值合并，补齐缺失字段（持久化前后版本兼容）。
 * 同时按 availableSubplots 过滤：未在白名单的 key 不出现在结果中。
 *
 * params 处理规则：
 * - 合法自定义参数会被保留
 * - 等于默认值的参数会被省略，避免无意义持久化
 * - 越界 / 非法参数会被清理回默认值并省略
 */
export function normalizePrefs(
  raw: RawSubplotPrefs | null | undefined,
  prefsKey: string,
  availableSubplots: readonly SubplotKey[] = ALL_SUBPLOT_KEYS,
): SubplotPrefs {
  const defaults = defaultPrefsFor(prefsKey)
  const available = new Set(availableSubplots)

  const orderRaw = Array.isArray(raw?.order) ? raw!.order : []
  const seen = new Set<SubplotKey>()
  const order: SubplotKey[] = []
  for (const k of orderRaw) {
    if (available.has(k) && !seen.has(k)) {
      order.push(k)
      seen.add(k)
    }
  }
  for (const k of defaults.order) {
    if (available.has(k) && !seen.has(k)) {
      order.push(k)
      seen.add(k)
    }
  }

  const visibility = { ...defaults.visibility, ...(raw?.visibility ?? {}) }
  const heightPct = { ...defaults.heightPct, ...(raw?.heightPct ?? {}) }
  for (const k of ALL_SUBPLOT_KEYS) {
    const v = heightPct[k]
    if (!Number.isFinite(v) || v < 4 || v > 20) heightPct[k] = defaults.heightPct[k]
  }

  const result: SubplotPrefs = { order, visibility, heightPct }

  if (raw?.params != null) {
    const normalized = normalizeIndicatorParams(raw.params)
    if (normalized.KDJ != null && !isDefaultKdjParams(normalized.KDJ)) {
      result.params = normalized
    }
  }

  result.mainIndicators = normalizeMainIndicators(raw?.mainIndicators)

  return result
}

/**
 * 派生当前可见副图配置数组（已按用户顺序排好），布局函数直接消费。
 */
export function resolveVisibleSubplots(prefs: SubplotPrefs): SubplotConfig[] {
  return prefs.order
    .filter((k) => prefs.visibility[k])
    .map((k) => ({ key: k, visible: true, heightPct: prefs.heightPct[k] }))
}
