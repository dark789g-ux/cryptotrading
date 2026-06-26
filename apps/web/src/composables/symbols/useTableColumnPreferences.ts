import { computed, h, ref, unref, type MaybeRef } from 'vue'
import { type DataTableColumns } from 'naive-ui'
import { preferencesApi, type ColumnPreferenceItem, type ScopeViewPreferences } from '@/api'
import type { SymbolColumnDef } from '../../components/symbols/columnTypes'
import FieldHelpTip from '../../components/common/FieldHelpTip.vue'
import { getFieldDescription } from '../../components/common/fieldDescriptions'

export type ColumnPreferenceTableId = string

function cloneColumnPreferences(items: ColumnPreferenceItem[]): ColumnPreferenceItem[] {
  return items.map((item) => ({ ...item }))
}

function cloneScopeView(value: ScopeViewPreferences): ScopeViewPreferences {
  return {
    table: cloneColumnPreferences(value.table),
    split: cloneColumnPreferences(value.split),
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

/** 单个 scope 下两种视图（表格 / 分栏）的列偏好槽位键。 */
export type SymbolViewSlot = 'table' | 'split'

/**
 * 业务级 fallback 唯一入口：把后端返回的 scope（已结构净化，split 可能空）回填为完整偏好。
 * - split 非空 → 保留并归一化
 * - split 为空 → 用 table 深拷贝填充（老用户/未设置 split 的默认行为）
 * 在此完成所有 fallback；后端只做结构净化，纯函数（normalizeScopePreferences 等）签名不变。
 */
function hydrateScope<Row>(
  defs: SymbolColumnDef<Row>[],
  raw: { table?: unknown; split?: unknown } | null | undefined,
): ScopeViewPreferences {
  const safeRaw = raw && typeof raw === 'object' ? raw : {}
  const table = normalizeScopePreferences(defs, (safeRaw as { table?: unknown }).table)
  const splitRaw = Array.isArray((safeRaw as { split?: unknown }).split)
    ? ((safeRaw as { split?: unknown }).split as unknown[])
    : []
  const split = splitRaw.length > 0
    ? normalizeScopePreferences(defs, splitRaw)
    : cloneColumnPreferences(table)
  return { table, split }
}

export function useTableColumnPreferences<Row>(
  tableId: string,
  defs: MaybeRef<SymbolColumnDef<Row>[]>,
  viewMode: MaybeRef<SymbolViewSlot> = 'table',
) {
  const resolvedDefs = computed(() => unref(defs))
  const loading = ref(false)
  const saving = ref(false)
  const loaded = ref(false)

  function defaultScopeView(): ScopeViewPreferences {
    const defaults = createDefaultScopePreferences(resolvedDefs.value)
    return { table: defaults, split: cloneColumnPreferences(defaults) }
  }

  const preferences = ref<ScopeViewPreferences>(defaultScopeView())

  /** 当前视图槽位的列偏好（随 viewMode 切片）；drawer 绑定它。 */
  const scopePreferences = computed<ColumnPreferenceItem[]>({
    get: () => {
      const slot = unref(viewMode)
      return normalizeScopePreferences(resolvedDefs.value, preferences.value[slot])
    },
    set: (next) => {
      const slot = unref(viewMode)
      preferences.value = {
        ...preferences.value,
        [slot]: normalizeScopePreferences(resolvedDefs.value, next),
      }
    },
  })

  function slotColumns(slot: SymbolViewSlot) {
    return computed(() =>
      buildColumnsFromPreference(resolvedDefs.value, preferences.value[slot]),
    )
  }

  /** 表格视图列（绑 #table slot）。 */
  const tableColumns = slotColumns('table')
  /** 分栏视图列（绑 #split-left slot）。 */
  const splitColumns = slotColumns('split')

  async function load() {
    loading.value = true
    try {
      const payload = await preferencesApi.getTableColumns(tableId)
      preferences.value = hydrateScope(resolvedDefs.value, payload)
      loaded.value = true
      return preferences.value
    } catch (err) {
      throw err
    } finally {
      loading.value = false
    }
  }

  async function save() {
    const previous = cloneScopeView(preferences.value)
    const payload = cloneScopeView(preferences.value)
    saving.value = true
    try {
      await preferencesApi.saveTableColumns(tableId, payload)
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
    tableColumns,
    splitColumns,
    load,
    save,
    reset,
    setColumnVisible,
    moveColumn,
    moveColumnByKey,
  }
}
