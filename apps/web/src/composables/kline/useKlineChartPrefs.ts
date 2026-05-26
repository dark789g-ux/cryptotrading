/**
 * KlineChart 副图偏好持久化 hook
 *
 * 三个调用点（a-share / crypto / backtest）共用，通过 prefsKey 在 localStorage 隔离：
 *   key 格式：`kline-chart-prefs:${prefsKey}`
 *
 * 设计要点：
 *  - 用 ref<SubplotPrefs> 而非 reactive，方便父组件 watch 整体替换
 *  - localStorage 读写均 try/catch（SSR / 隐私模式 / quota exceeded 都不应炸）
 *  - update 写入做 200ms debounce，避免拖动 input-number 时高频 setItem
 *  - 不订阅 storage 事件，跨窗口同步不在本次范围
 *  - 初始化失败一律回退 defaultPrefsFor → normalizePrefs，保证调用方拿到合法值
 */

import { ref, type Ref } from 'vue'
import {
  defaultPrefsFor,
  normalizePrefs,
  type SubplotKey,
  type SubplotPrefs,
} from './subplotConfig'

const STORAGE_PREFIX = 'kline-chart-prefs'
const DEBOUNCE_MS = 200

function storageKey(prefsKey: string): string {
  return `${STORAGE_PREFIX}:${prefsKey}`
}

function safeReadRaw(prefsKey: string): Partial<SubplotPrefs> | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const raw = window.localStorage.getItem(storageKey(prefsKey))
    if (raw == null) return null
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') {
      return parsed as Partial<SubplotPrefs>
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

export interface UseKlineChartPrefsReturn {
  prefs: Ref<SubplotPrefs>
  update: (partial: Partial<SubplotPrefs>) => void
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
      safeWrite(prefsKey, prefs.value)
    }, DEBOUNCE_MS)
  }

  function update(partial: Partial<SubplotPrefs>): void {
    const merged: SubplotPrefs = {
      order: partial.order ?? prefs.value.order,
      visibility: partial.visibility
        ? { ...prefs.value.visibility, ...partial.visibility }
        : prefs.value.visibility,
      heightPct: partial.heightPct
        ? { ...prefs.value.heightPct, ...partial.heightPct }
        : prefs.value.heightPct,
    }
    // 再过一次 normalize，防止上层传入越界 heightPct 或非法 order
    prefs.value = normalizePrefs(merged, prefsKey, availableSubplots)
    scheduleWrite()
  }

  function reset(): void {
    prefs.value = normalizePrefs(defaultPrefsFor(prefsKey), prefsKey, availableSubplots)
    scheduleWrite()
  }

  return { prefs, update, reset }
}
