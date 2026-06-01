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

export interface SubplotConfig {
  key: SubplotKey
  visible: boolean
  /** 占图表容器总高度的百分比，范围 4–20 */
  heightPct: number
}

export interface SubplotPrefs {
  /** 用户拖拽后的顺序，未在此列表中的 key 落到末尾按 ALL_SUBPLOT_KEYS 顺序补齐 */
  order: SubplotKey[]
  visibility: Record<SubplotKey, boolean>
  heightPct: Record<SubplotKey, number>
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
  }
}

/**
 * 把外部传入的偏好与默认值合并，补齐缺失字段（持久化前后版本兼容）。
 * 同时按 availableSubplots 过滤：未在白名单的 key 不出现在结果中。
 */
export function normalizePrefs(
  raw: Partial<SubplotPrefs> | null | undefined,
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

  return { order, visibility, heightPct }
}

/**
 * 派生当前可见副图配置数组（已按用户顺序排好），布局函数直接消费。
 */
export function resolveVisibleSubplots(prefs: SubplotPrefs): SubplotConfig[] {
  return prefs.order
    .filter((k) => prefs.visibility[k])
    .map((k) => ({ key: k, visible: true, heightPct: prefs.heightPct[k] }))
}
