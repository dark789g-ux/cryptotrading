<template>
  <n-modal
    v-model:show="showProxy"
    preset="card"
    :style="{ width: 'min(840px, 92vw)' }"
    class="column-settings-modal"
  >
    <template #header>
      <div class="column-settings-header">
        <span class="column-settings-header-title">{{ title }}</span>
        <span class="column-settings-stats">已选 {{ visibleCount }} / 共 {{ totalCount }}</span>
      </div>
    </template>

    <div v-if="loading" class="column-settings-state">
      <n-spin size="small" />
    </div>
    <div v-else-if="rows.length === 0" class="column-settings-state">
      <n-empty description="暂无列配置" />
    </div>
    <div v-else class="column-settings-body">
      <div class="column-settings-toolbar">
        <n-input
          v-model:value="searchQuery"
          clearable
          placeholder="搜索列名…"
          size="small"
          class="column-settings-search"
        >
          <template #prefix>
            <n-icon><search-outline /></n-icon>
          </template>
        </n-input>
      </div>

      <div class="column-settings-panes">
        <!-- 左栏：分组勾选 -->
        <div class="column-settings-pane column-settings-pane--pick">
          <div class="column-settings-pane-title">显示哪些列</div>
          <div class="column-settings-pane-scroll">
            <n-empty
              v-if="filteredGroups.length === 0"
              description="没有匹配的列"
              size="small"
            />
            <n-collapse v-else v-model:expanded-names="expandedGroupNames">
              <n-collapse-item
                v-for="group in filteredGroups"
                :key="group.key"
                :name="group.key"
              >
                <template #header>
                  <div class="column-settings-group-header">
                    <span class="column-settings-group-label">{{ group.label }}</span>
                    <span class="column-settings-group-count">
                      {{ group.visibleCount }}/{{ group.items.length }}
                    </span>
                  </div>
                </template>
                <template #header-extra>
                  <div class="column-settings-group-actions" @click.stop>
                    <n-button
                      quaternary
                      size="tiny"
                      :disabled="group.toggleableCount === 0"
                      @click="setGroupVisible(group.key, true)"
                    >
                      全选
                    </n-button>
                    <n-button
                      quaternary
                      size="tiny"
                      :disabled="group.toggleableCount === 0"
                      @click="setGroupVisible(group.key, false)"
                    >
                      全不选
                    </n-button>
                  </div>
                </template>
                <div class="column-settings-grid">
                  <n-tooltip
                    v-for="row in group.items"
                    :key="row.key"
                    trigger="hover"
                    :disabled="hasHelp(row) || row.title === row.key"
                  >
                    <template #trigger>
                      <label
                        class="column-settings-grid-item"
                        :class="{ 'column-settings-grid-item--locked': row.locked }"
                      >
                        <n-checkbox
                          :checked="row.visible"
                          :disabled="row.locked"
                          @update:checked="setVisible(row.key, $event)"
                        />
                        <span class="column-settings-grid-label">{{ row.title }}</span>
                        <span class="column-settings-help" @click.stop.prevent>
                          <field-help-tip :field="row.descKey" />
                        </span>
                      </label>
                    </template>
                    {{ row.key }}
                  </n-tooltip>
                </div>
              </n-collapse-item>
            </n-collapse>
          </div>
        </div>

        <!-- 右栏：已选列排序 -->
        <div class="column-settings-pane column-settings-pane--order">
          <div class="column-settings-pane-title">列顺序（仅已选）</div>
          <div class="column-settings-pane-scroll">
            <n-empty
              v-if="visibleOrderRows.length === 0"
              description="请先在左侧勾选要显示的列"
              size="small"
            />
            <div v-else class="column-settings-order-list">
              <div
                v-for="(row, visibleIndex) in visibleOrderRows"
                :key="row.key"
                class="column-settings-order-row"
                :class="{
                  'column-settings-order-row--locked': row.locked,
                  'column-settings-order-row--dragging': dragVisibleIndex === visibleIndex,
                  'column-settings-order-row--drop-above':
                    dragOverVisibleIndex === visibleIndex && dragVisibleIndex !== null && visibleIndex < dragVisibleIndex,
                  'column-settings-order-row--drop-below':
                    dragOverVisibleIndex === visibleIndex && dragVisibleIndex !== null && visibleIndex > dragVisibleIndex,
                }"
                :draggable="!row.locked"
                @dragstart="onDragStart(visibleIndex, $event)"
                @dragover.prevent="onDragOver(visibleIndex, $event)"
                @dragleave="onDragLeave"
                @drop.prevent="onDrop(visibleIndex)"
                @dragend="onDragEnd"
              >
                <div
                  class="column-settings-drag-handle"
                  :class="{ 'column-settings-drag-handle--disabled': row.locked }"
                >
                  <n-icon size="16"><menu-outline /></n-icon>
                </div>
                <span class="column-settings-order-main">
                  <span class="column-settings-order-title">{{ row.title }}</span>
                  <field-help-tip :field="row.descKey" />
                </span>
                <span v-if="row.locked" class="column-settings-lock-badge" title="固定列">🔒</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="column-settings-footer">
        <n-button tertiary @click="resetToDefault">
          <template #icon>
            <n-icon><refresh-outline /></n-icon>
          </template>
          恢复默认
        </n-button>
        <div class="column-settings-footer-spacer" />
        <n-button @click="cancel">取消</n-button>
        <n-button type="primary" :loading="saving" @click="save">保存</n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup lang="ts" generic="Row">
import { computed, ref, watch } from 'vue'
import {
  NButton,
  NCheckbox,
  NCollapse,
  NCollapseItem,
  NEmpty,
  NIcon,
  NInput,
  NModal,
  NSpin,
  NTooltip,
} from 'naive-ui'
import { MenuOutline, RefreshOutline, SearchOutline } from '@vicons/ionicons5'
import FieldHelpTip from '../common/FieldHelpTip.vue'
import { getFieldDescription } from '../common/fieldDescriptions'
import type { ColumnPreferenceItem } from '@/api'
import type { SymbolColumnDef } from './columnTypes'
import {
  COLUMN_GROUPS,
  DEFAULT_EXPANDED_GROUPS,
  resolveColumnGroup,
  type ColumnGroupKey,
} from './columnGroupMeta'
import {
  createDefaultScopePreferences,
  normalizeScopePreferences,
} from '@/composables/symbols/useTableColumnPreferences'

interface SettingsRow {
  key: string
  title: string
  descKey?: string
  visible: boolean
  locked: boolean
}

interface GroupViewModel {
  key: ColumnGroupKey
  label: string
  items: SettingsRow[]
  visibleCount: number
  toggleableCount: number
}

const props = defineProps<{
  show: boolean
  title: string
  definitions: SymbolColumnDef<Row>[]
  modelValue: ColumnPreferenceItem[]
  loading?: boolean
  saving?: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  'update:modelValue': [value: ColumnPreferenceItem[]]
  save: []
}>()

const showProxy = computed({
  get: () => props.show,
  set: (value: boolean) => emit('update:show', value),
})

const searchQuery = ref('')
const expandedGroupNames = ref<Array<string | number>>([...DEFAULT_EXPANDED_GROUPS])

const rows = computed<SettingsRow[]>(() => {
  const normalized = normalizeScopePreferences(props.definitions, props.modelValue)
  const metaMap = new Map(props.definitions.map((def) => [def.key, def] as const))
  return normalized.map((item) => {
    const def = metaMap.get(item.key)
    return {
      key: item.key,
      title: def?.title ?? item.key,
      descKey: def?.descKey,
      visible: item.visible,
      locked: Boolean(def?.locked),
    }
  })
})

const totalCount = computed(() => rows.value.length)
const visibleCount = computed(() => rows.value.filter((row) => row.visible).length)

const visibleOrderRows = computed(() =>
  rows.value
    .map((row, fullIndex) => ({ ...row, fullIndex }))
    .filter((row) => row.visible),
)

/** 该列是否有字段说明（决定显示 "?" 并禁用「显示英文 key」的兜底 tooltip，避免双 tooltip 重叠） */
function hasHelp(row: { descKey?: string }) {
  return Boolean(getFieldDescription(row.descKey))
}

function matchesSearch(row: SettingsRow, query: string) {
  if (!query) return true
  return row.title.toLowerCase().includes(query) || row.key.toLowerCase().includes(query)
}

const filteredGroups = computed<GroupViewModel[]>(() => {
  const query = searchQuery.value.trim().toLowerCase()
  const bucket = new Map<ColumnGroupKey, SettingsRow[]>()
  for (const group of COLUMN_GROUPS) {
    bucket.set(group.key, [])
  }
  for (const row of rows.value) {
    if (!matchesSearch(row, query)) continue
    const groupKey = resolveColumnGroup(row.key)
    bucket.get(groupKey)?.push(row)
  }
  return COLUMN_GROUPS
    .map((group) => {
      const items = bucket.get(group.key) ?? []
      return {
        key: group.key,
        label: group.label,
        items,
        visibleCount: items.filter((item) => item.visible).length,
        toggleableCount: items.filter((item) => !item.locked).length,
      }
    })
    .filter((group) => group.items.length > 0)
})

watch(searchQuery, (query) => {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    expandedGroupNames.value = [...DEFAULT_EXPANDED_GROUPS]
    return
  }
  expandedGroupNames.value = filteredGroups.value.map((group) => group.key)
})

watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    searchQuery.value = ''
    expandedGroupNames.value = [...DEFAULT_EXPANDED_GROUPS]
    dragVisibleIndex.value = null
    dragOverVisibleIndex.value = null
  },
)

function updateRows(nextRows: Array<{ key: string; visible: boolean }>) {
  emit('update:modelValue', normalizeScopePreferences(props.definitions, nextRows))
}

function setVisible(key: string, visible: boolean) {
  updateRows(rows.value.map((row) => (row.key === key ? { key: row.key, visible } : row)))
}

function setGroupVisible(groupKey: ColumnGroupKey, visible: boolean) {
  const keys = new Set(
    rows.value
      .filter((row) => resolveColumnGroup(row.key) === groupKey && !row.locked)
      .map((row) => row.key),
  )
  if (keys.size === 0) return
  updateRows(rows.value.map((row) => (keys.has(row.key) ? { key: row.key, visible } : row)))
}

function reorderFullRows(fromFullIndex: number, toFullIndex: number) {
  if (fromFullIndex === toFullIndex) return
  const fromRow = rows.value[fromFullIndex]
  const toRow = rows.value[toFullIndex]
  if (!fromRow || !toRow || fromRow.locked || toRow.locked) return

  const next = rows.value.slice()
  const [moved] = next.splice(fromFullIndex, 1)
  next.splice(toFullIndex, 0, moved)
  updateRows(next)
}

/* ── drag & drop (visible list → full index) ── */
const dragVisibleIndex = ref<number | null>(null)
const dragOverVisibleIndex = ref<number | null>(null)

function onDragStart(visibleIndex: number, event: DragEvent) {
  const row = visibleOrderRows.value[visibleIndex]
  if (!row || row.locked) return
  dragVisibleIndex.value = visibleIndex
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(visibleIndex))
  }
}

function onDragOver(visibleIndex: number, _event: DragEvent) {
  if (dragVisibleIndex.value === null) return
  const row = visibleOrderRows.value[visibleIndex]
  if (!row || row.locked) return
  dragOverVisibleIndex.value = visibleIndex
}

function onDragLeave() {
  dragOverVisibleIndex.value = null
}

function onDrop(targetVisibleIndex: number) {
  const fromVisibleIndex = dragVisibleIndex.value
  dragVisibleIndex.value = null
  dragOverVisibleIndex.value = null
  if (fromVisibleIndex === null || fromVisibleIndex === targetVisibleIndex) return

  const fromRow = visibleOrderRows.value[fromVisibleIndex]
  const targetRow = visibleOrderRows.value[targetVisibleIndex]
  if (!fromRow || !targetRow || fromRow.locked || targetRow.locked) return

  reorderFullRows(fromRow.fullIndex, targetRow.fullIndex)
}

function onDragEnd() {
  dragVisibleIndex.value = null
  dragOverVisibleIndex.value = null
}

function resetToDefault() {
  emit('update:modelValue', createDefaultScopePreferences(props.definitions))
}

function cancel() {
  emit('update:show', false)
}

function save() {
  emit('save')
}
</script>

<style scoped>
.column-settings-modal :deep(.n-card) {
  max-height: 70vh;
  display: flex;
  flex-direction: column;
}

.column-settings-modal :deep(.n-card__content) {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.column-settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding-right: 28px;
}

.column-settings-header-title {
  font-size: 16px;
  font-weight: 500;
}

.column-settings-stats {
  font-size: 13px;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.column-settings-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  height: min(52vh, 520px);
}

.column-settings-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
}

.column-settings-toolbar {
  flex-shrink: 0;
}

.column-settings-search {
  width: 100%;
}

.column-settings-panes {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 0;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
}

.column-settings-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.column-settings-pane--pick {
  flex: 3;
  border-right: 1px solid var(--color-border);
}

.column-settings-pane--order {
  flex: 2;
}

.column-settings-pane-title {
  flex-shrink: 0;
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-secondary);
  border-bottom: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-text) 3%, var(--color-surface));
}

.column-settings-pane-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
}

.column-settings-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.column-settings-group-label {
  font-weight: 500;
}

.column-settings-group-count {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.column-settings-group-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.column-settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 12px;
  padding: 4px 0 8px;
}

.column-settings-grid-item {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}

.column-settings-grid-item:hover {
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
}

.column-settings-grid-item--locked {
  opacity: 0.75;
  cursor: default;
}

.column-settings-grid-label {
  font-size: 13px;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.column-settings-help {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}

.column-settings-order-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.column-settings-order-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  transition: opacity 0.15s, border-color 0.15s, box-shadow 0.15s;
}

.column-settings-order-row--locked {
  background: color-mix(in srgb, var(--color-primary) 6%, var(--color-surface));
}

.column-settings-order-row--dragging {
  opacity: 0.4;
}

.column-settings-order-row--drop-above {
  border-top: 2px solid var(--color-primary);
  box-shadow: 0 -2px 0 0 var(--color-primary);
}

.column-settings-order-row--drop-below {
  border-bottom: 2px solid var(--color-primary);
  box-shadow: 0 2px 0 0 var(--color-primary);
}

.column-settings-drag-handle {
  display: flex;
  align-items: center;
  cursor: grab;
  color: var(--color-text-secondary);
  padding: 2px;
  border-radius: 3px;
  flex-shrink: 0;
}

.column-settings-drag-handle:hover {
  color: var(--color-text);
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
}

.column-settings-drag-handle:active {
  cursor: grabbing;
}

.column-settings-drag-handle--disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.column-settings-drag-handle--disabled:hover {
  color: var(--color-text-secondary);
  background: none;
}

.column-settings-order-main {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.column-settings-order-title {
  min-width: 0;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.column-settings-lock-badge {
  flex-shrink: 0;
  font-size: 12px;
  line-height: 1;
}

.column-settings-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.column-settings-footer-spacer {
  flex: 1;
}
</style>
