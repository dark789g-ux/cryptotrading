import { computed, ref, unref, type MaybeRef } from 'vue'
import type { ColumnPreferenceItem } from '@/api'
import type { SymbolColumnDef } from '@/components/symbols/columnTypes'
import {
  buildColumnsFromPreference,
  createDefaultScopePreferences,
  normalizeScopePreferences,
} from '@/composables/symbols/useSymbolColumnPreferences'

const STORAGE_KEY = 'backtest-metrics-columns'

/** 从 localStorage 读取持久化的列偏好；隐私模式 / 配额 / 解析失败 → 返回 null 降级默认 */
function readStored(): unknown {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 写回 localStorage；失败（隐私模式 / 配额）静默降级，不阻断 UI */
function writeStored(items: ColumnPreferenceItem[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  } catch {
    // 隐私模式 / 配额超限：放弃持久化，内存态仍生效
  }
}

/**
 * 回测「逐 K 标的指标」表的列偏好 composable。
 *
 * 与 useWatchlistColumnPreferences 同构，但持久化改为 localStorage 直读写
 * （不引 Pinia、不碰 server SymbolsViewColumnPreferences）——回测面板是临时视图，
 * 列偏好属本机偏好，无需跨设备同步。
 */
export function useBacktestMetricsColumnPreferences<Row>(defs: MaybeRef<SymbolColumnDef<Row>[]>) {
  const saving = ref(false)

  const scopePreferences = computed<ColumnPreferenceItem[]>({
    get: () => normalizeScopePreferences(unref(defs), readStored()),
    set: (next) => {
      writeStored(normalizeScopePreferences(unref(defs), next))
    },
  })

  // 不含 sortOrder —— 受控远程排序由 host 在 columnsBase 上 post-map 注入
  const columnsBase = computed(() => buildColumnsFromPreference(unref(defs), scopePreferences.value))

  function reset() {
    scopePreferences.value = createDefaultScopePreferences(unref(defs))
  }

  function save() {
    saving.value = true
    try {
      writeStored(normalizeScopePreferences(unref(defs), scopePreferences.value))
    } finally {
      saving.value = false
    }
  }

  return {
    saving,
    scopePreferences,
    columnsBase,
    reset,
    save,
  }
}
