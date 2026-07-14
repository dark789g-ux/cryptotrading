/**
 * KlineChart 副图偏好持久化 hook
 *
 * 三个调用点（a-share / crypto / backtest）共用，通过 prefsKey 在 localStorage 隔离：
 *   key 格式：`kline-chart-prefs:${prefsKey}`
 *
 * 持久化策略：
 *  - 后端 user_preferences 表为真相源（写）
 *  - localStorage 为首屏缓存（读）
 *  - 组件挂载时同步从 localStorage 初始化 → 异步 GET 后端 → 合并/覆盖
 *  - update/reset 写入做 200ms debounce，同时 PUT 后端 + setItem localStorage
 *
 * 设计要点：
 *  - 用 ref<SubplotPrefs> 而非 reactive，方便父组件 watch 整体替换
 *  - localStorage 读写均 try/catch（SSR / 隐私模式 / quota exceeded 都不应炸）
 *  - 后端读写均 try/catch（网络错误 / 401 静默降级，不阻塞 UI）
 *  - update 写入做 200ms debounce，避免拖动 input-number 时高频 setItem/PUT
 *  - 不订阅 storage 事件，跨窗口同步不在本次范围
 *  - 初始化失败一律回退 defaultPrefsFor → normalizePrefs，保证调用方拿到合法值
 *  - params 支持深合并；update({ params: undefined }) 显式清除已持久化的自定义参数
 *  - mainIndicators 支持合并；partial 只含被改的 key，其余保留
 */

import { onMounted, ref, type Ref } from 'vue'
import {
  defaultPrefsFor,
  normalizePrefs,
  normalizeIndicatorParams,
  type SubplotKey,
  type SubplotPrefs,
  type RawSubplotPrefs,
} from './subplotConfig'
import { preferencesApi, type KlinePrefsPayload } from '@/api/modules/user-config/preferences'

const STORAGE_PREFIX = 'kline-chart-prefs'
const DEBOUNCE_MS = 200

function storageKey(prefsKey: string): string {
  return `${STORAGE_PREFIX}:${prefsKey}`
}

function safeReadRaw(prefsKey: string): RawSubplotPrefs | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const raw = window.localStorage.getItem(storageKey(prefsKey))
    if (raw == null) return null
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') {
      return parsed as RawSubplotPrefs
    }
    return null
  } catch {
    return null
  }
}

function safeWrite(prefsKey: string, value: SubplotPrefs): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(storageKey(prefsKey), JSON.stringify(value))
  } catch {
    // 隐私模式 / quota exceeded — 静默忽略，运行时偏好仍有效
  }
}

/** 后端远程读取，失败返回 null */
async function safeReadRemote(prefsKey: string): Promise<KlinePrefsPayload | null> {
  try {
    return await preferencesApi.getKlinePrefs(prefsKey)
  } catch {
    return null
  }
}

/** SubplotPrefs(严格领域类型) → KlinePrefsPayload(宽松传输层类型) */
function toPayload(prefs: SubplotPrefs): KlinePrefsPayload {
  const payload: KlinePrefsPayload = {
    order: prefs.order,
    visibility: prefs.visibility,
    heightPct: prefs.heightPct,
  }
  if (prefs.params) payload.params = prefs.params as unknown as Record<string, unknown>
  if (prefs.mainIndicators) payload.mainIndicators = prefs.mainIndicators
  return payload
}

/** 后端远程写入，失败静默 */
async function safeWriteRemote(prefsKey: string, prefs: SubplotPrefs): Promise<void> {
  try {
    await preferencesApi.saveKlinePrefs(prefsKey, toPayload(prefs))
  } catch {
    // 网络错误 / 401 — 静默忽略，localStorage 已缓存
  }
}

/** 判断后端返回是否为"空"(无有意义数据) */
function isEmptyRemotePayload(p: KlinePrefsPayload | null): boolean {
  if (!p) return true
  if (Array.isArray(p.order) && p.order.length > 0) return false
  if (p.mainIndicators && Object.keys(p.mainIndicators).length > 0) return false
  if (p.visibility && Object.keys(p.visibility).length > 0) return false
  if (p.heightPct && Object.keys(p.heightPct).length > 0) return false
  if (p.params && Object.keys(p.params).length > 0) return false
  return true
}

/** 已迁移的 prefsKey 集合，防止重复 PUT */
const migratedKeys = new Set<string>()

/** @internal 仅测试用：重置已迁移记录 */
export function _resetMigratedKeys(): void {
  migratedKeys.clear()
}

export interface UseKlineChartPrefsReturn {
  prefs: Ref<SubplotPrefs>
  update: (partial: RawSubplotPrefs) => void
  reset: () => void
}

export function useKlineChartPrefs(
  prefsKey: string,
  availableSubplots: readonly SubplotKey[],
): UseKlineChartPrefsReturn {
  const initial = normalizePrefs(safeReadRaw(prefsKey), prefsKey, availableSubplots)
  const prefs = ref<SubplotPrefs>(initial)

  let timer: ReturnType<typeof setTimeout> | null = null
  function scheduleWrite(): void {
    if (timer != null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      // 同时写 localStorage(首屏缓存) 和 PUT 后端(真相源)
      safeWrite(prefsKey, prefs.value)
      safeWriteRemote(prefsKey, prefs.value)
    }, DEBOUNCE_MS)
  }

  function update(partial: RawSubplotPrefs): void {
    const merged: SubplotPrefs = {
      order: partial.order ?? prefs.value.order,
      visibility: partial.visibility
        ? { ...prefs.value.visibility, ...partial.visibility }
        : prefs.value.visibility,
      heightPct: partial.heightPct
        ? { ...prefs.value.heightPct, ...partial.heightPct }
        : prefs.value.heightPct,
    }

    if ('params' in partial) {
      merged.params =
        partial.params === undefined
          ? undefined
          : normalizeIndicatorParams({ ...prefs.value.params, ...partial.params })
    } else {
      merged.params = prefs.value.params
    }

    // mainIndicators 合并：partial 覆盖已有值
    if (partial.mainIndicators) {
      merged.mainIndicators = { ...prefs.value.mainIndicators, ...partial.mainIndicators }
    } else {
      merged.mainIndicators = prefs.value.mainIndicators
    }

    // 再过一次 normalize，防止上层传入越界 heightPct / 非法 order / 非法 params
    prefs.value = normalizePrefs(merged, prefsKey, availableSubplots)
    scheduleWrite()
  }

  function reset(): void {
    prefs.value = normalizePrefs(defaultPrefsFor(prefsKey), prefsKey, availableSubplots)
    scheduleWrite()
  }

  // 异步从后端加载：后端为真相源，localStorage 为首屏缓存
  onMounted(async () => {
    const remote = await safeReadRemote(prefsKey)

    if (!isEmptyRemotePayload(remote)) {
      // 后端有数据 → 用后端值覆盖
      // normalizePrefs 内部按 availableSubplots 白名单过滤,非法 key 安全丢弃
      const fromRemote = normalizePrefs(remote as unknown as RawSubplotPrefs, prefsKey, availableSubplots)
      prefs.value = fromRemote
      // 同步回写 localStorage 缓存
      safeWrite(prefsKey, fromRemote)
      migratedKeys.add(prefsKey)
    } else {
      // 后端无数据 + localStorage 有原始数据 → 一次性迁移推后端
      const localRaw = safeReadRaw(prefsKey)
      if (localRaw && !migratedKeys.has(prefsKey)) {
        const currentPrefs = normalizePrefs(localRaw, prefsKey, availableSubplots)
        safeWriteRemote(prefsKey, currentPrefs)
        migratedKeys.add(prefsKey)
      }
    }
  })

  return { prefs, update, reset }
}
