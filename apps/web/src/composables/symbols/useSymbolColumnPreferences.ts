import { computed, h, ref, unref, type MaybeRef } from 'vue'
import { type DataTableColumns } from 'naive-ui'
import { preferencesApi, type ColumnPreferenceItem, type SymbolsViewColumnPreferences } from '@/api'
import type { SymbolColumnDef } from '../../components/symbols/columnTypes'
import FieldHelpTip from '../../components/common/FieldHelpTip.vue'
import { getFieldDescription } from '../../components/common/fieldDescriptions'

export type SymbolPreferenceScope = keyof SymbolsViewColumnPreferences

function cloneColumnPreferences(items: ColumnPreferenceItem[]): ColumnPreferenceItem[] {
  return items.map((item) => ({ ...item }))
}

function cloneSymbolsViewPreferences(value: SymbolsViewColumnPreferences): SymbolsViewColumnPreferences {
  return {
    crypto: cloneColumnPreferences(value.crypto),
    aShares: cloneColumnPreferences(value.aShares),
    usStocks: cloneColumnPreferences(value.usStocks),
  }
}

export function createDefaultScopePreferences<Row>(defs: SymbolColumnDef<Row>[]): ColumnPreferenceItem[] {
  return defs.map((def) => ({
    key: def.key,
    visible: def.locked ? true : def.defaultVisible !== false,
  }))
}

export function normalizeScopePreferences<Row>(
  defs: SymbolColumnDef<Row>[],
  items: unknown,
): ColumnPreferenceItem[] {
  const list = Array.isArray(items) ? items : []
  const normalized: ColumnPreferenceItem[] = []
  const seen = new Set<string>()
  const known = new Map(defs.map((def) => [def.key, def] as const))

  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const key = typeof (item as { key?: unknown }).key === 'string' ? (item as { key: string }).key : ''
    if (!key || seen.has(key)) continue
    const def = known.get(key)
    if (!def) continue
    const visible = def.locked
      ? true
      : typeof (item as { visible?: unknown }).visible === 'boolean'
        ? (item as { visible: boolean }).visible
        : def.defaultVisible !== false
    normalized.push({ key, visible })
    seen.add(key)
  }

  for (const def of defs) {
    if (seen.has(def.key)) continue
    normalized.push({
      key: def.key,
      visible: def.locked ? true : def.defaultVisible !== false,
    })
    seen.add(def.key)
  }

  return normalized
}

export function buildColumnsFromPreference<Row>(
  defs: SymbolColumnDef<Row>[],
  items: ColumnPreferenceItem[],
): DataTableColumns<Row> {
  const normalized = normalizeScopePreferences(defs, items)
  const columnMap = new Map(defs.map((def) => [def.key, def] as const))
  return normalized
    .filter((item) => item.visible)
    .map((item) => {
      const def = columnMap.get(item.key)
      if (!def) return null
      // 有字段说明时，表头渲染「列名 + ?」；否则保持纯字符串 title（不影响排序/列设置抽屉）
      const title = def.descKey && getFieldDescription(def.descKey)
        ? () => h(
            'span',
            { style: 'display:inline-flex;align-items:center;gap:4px' },
            [def.title, h(FieldHelpTip, { field: def.descKey })],
          )
        : def.title
      return {
        key: def.key,
        title,
        width: def.width,
        fixed: def.fixed,
        sorter: def.sorter,
        render: def.render,
      }
    })
    .filter(Boolean) as DataTableColumns<Row>
}

function updateScopePreferences<Row>(
  defs: SymbolColumnDef<Row>[],
  items: ColumnPreferenceItem[],
  updater: (value: ColumnPreferenceItem[]) => ColumnPreferenceItem[],
) {
  return normalizeScopePreferences(defs, updater(cloneColumnPreferences(items)))
}

export function useSymbolColumnPreferences<Row>(
  scope: SymbolPreferenceScope,
  defs: MaybeRef<SymbolColumnDef<Row>[]>,
) {
  const resolvedDefs = computed(() => unref(defs))
  const loading = ref(false)
  const saving = ref(false)
  const loaded = ref(false)
  const preferences = ref<SymbolsViewColumnPreferences>({
    crypto: scope === 'crypto' ? createDefaultScopePreferences(resolvedDefs.value) : [],
    aShares: scope === 'aShares' ? createDefaultScopePreferences(resolvedDefs.value) : [],
    usStocks: scope === 'usStocks' ? createDefaultScopePreferences(resolvedDefs.value) : [],
  })

  const scopePreferences = computed<ColumnPreferenceItem[]>({
    get: () => normalizeScopePreferences(resolvedDefs.value, preferences.value[scope]),
    set: (next) => {
      preferences.value = {
        ...preferences.value,
        [scope]: normalizeScopePreferences(resolvedDefs.value, next),
      }
    },
  })

  const columns = computed(() => buildColumnsFromPreference(resolvedDefs.value, scopePreferences.value))

  async function load() {
    loading.value = true
    try {
      const payload = await preferencesApi.getSymbolsView()
      preferences.value = {
        crypto: normalizeScopePreferences(resolvedDefs.value, payload.crypto),
        aShares: normalizeScopePreferences(resolvedDefs.value, payload.aShares),
        usStocks: normalizeScopePreferences(resolvedDefs.value, payload.usStocks),
      }
      loaded.value = true
      return preferences.value
    } catch (err) {
      throw err
    } finally {
      loading.value = false
    }
  }

  async function save() {
    if (!loaded.value) {
      await load()
    }
    const previous = cloneSymbolsViewPreferences(preferences.value)
    const payload = cloneSymbolsViewPreferences(preferences.value)
    saving.value = true
    try {
      await preferencesApi.saveSymbolsView(payload)
      preferences.value = payload
      return payload
    } catch (err) {
      preferences.value = previous
      throw err
    } finally {
      saving.value = false
    }
  }

  function reset() {
    scopePreferences.value = createDefaultScopePreferences(resolvedDefs.value)
  }

  function setColumnVisible(key: string, visible: boolean) {
    scopePreferences.value = updateScopePreferences(resolvedDefs.value, scopePreferences.value, (items) =>
      items.map((item) => (item.key === key ? { ...item, visible } : item)),
    )
  }

  function moveColumn(fromIndex: number, toIndex: number) {
    const items = cloneColumnPreferences(scopePreferences.value)
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= items.length ||
      toIndex >= items.length ||
      fromIndex === toIndex
    ) {
      return
    }
    const lockedKeys = new Set(resolvedDefs.value.filter((def) => def.locked).map((def) => def.key))
    if (lockedKeys.has(items[fromIndex]?.key) || lockedKeys.has(items[toIndex]?.key)) {
      return
    }
    const start = Math.min(fromIndex, toIndex)
    const end = Math.max(fromIndex, toIndex)
    for (let index = start; index <= end; index += 1) {
      if (index !== fromIndex && lockedKeys.has(items[index]?.key)) {
        return
      }
    }
    const next = items.slice()
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    scopePreferences.value = normalizeScopePreferences(resolvedDefs.value, next)
  }

  function moveColumnByKey(key: string, direction: 'up' | 'down') {
    const index = scopePreferences.value.findIndex((item) => item.key === key)
    if (index < 0) return
    moveColumn(index, direction === 'up' ? index - 1 : index + 1)
  }

  return {
    loading,
    saving,
    loaded,
    preferences,
    scopePreferences,
    columns,
    load,
    save,
    reset,
    setColumnVisible,
    moveColumn,
    moveColumnByKey,
  }
}
