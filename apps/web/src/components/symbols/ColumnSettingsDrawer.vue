<template>
  <n-drawer v-model:show="showProxy" placement="right" :width="380">
    <n-drawer-content :title="title" closable>
      <div v-if="loading" class="column-settings-state">
        <n-spin size="small" />
      </div>
      <div v-else class="column-settings-body">
        <div v-if="rows.length === 0" class="column-settings-state">
          <n-empty description="No columns" />
        </div>

        <div v-else class="column-settings-list">
          <div
            v-for="(row, index) in rows"
            :key="row.key"
            class="column-settings-row"
            :class="{ 'column-settings-row--locked': row.locked }"
          >
            <n-checkbox
              :checked="row.visible"
              :disabled="row.locked"
              @update:checked="setVisible(row.key, $event)"
            />

            <div class="column-settings-label">
              <div class="column-settings-title">{{ row.title }}</div>
              <div class="column-settings-meta">{{ row.key }}</div>
            </div>

            <div class="column-settings-actions">
              <n-button
                quaternary
                circle
                size="small"
                :disabled="!canMoveUp(index)"
                @click="moveUp(index)"
              >
                <template #icon>
                  <n-icon><arrow-up-outline /></n-icon>
                </template>
              </n-button>
              <n-button
                quaternary
                circle
                size="small"
                :disabled="!canMoveDown(index)"
                @click="moveDown(index)"
              >
                <template #icon>
                  <n-icon><arrow-down-outline /></n-icon>
                </template>
              </n-button>
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
            Reset
          </n-button>
          <div class="column-settings-footer-spacer" />
          <n-button @click="cancel">Cancel</n-button>
          <n-button type="primary" :loading="saving" @click="save">Save</n-button>
        </div>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts" generic="Row">
import { computed } from 'vue'
import { NButton, NCheckbox, NDrawer, NDrawerContent, NEmpty, NIcon, NSpin } from 'naive-ui'
import { ArrowDownOutline, ArrowUpOutline, RefreshOutline } from '@vicons/ionicons5'
import type { ColumnPreferenceItem } from '@/api'
import type { SymbolColumnDef } from './columnTypes'
import {
  createDefaultScopePreferences,
  normalizeScopePreferences,
} from '@/composables/symbols/useSymbolColumnPreferences'

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

const rows = computed(() => {
  const normalized = normalizeScopePreferences(props.definitions, props.modelValue)
  const metaMap = new Map(props.definitions.map((def) => [def.key, def] as const))
  return normalized.map((item) => {
    const def = metaMap.get(item.key)
    return {
      key: item.key,
      title: def?.title ?? item.key,
      visible: item.visible,
      locked: Boolean(def?.locked),
    }
  })
})

function updateRows(nextRows: Array<{ key: string; visible: boolean }>) {
  emit('update:modelValue', normalizeScopePreferences(props.definitions, nextRows))
}

function setVisible(key: string, visible: boolean) {
  updateRows(rows.value.map((row) => (row.key === key ? { key: row.key, visible } : row)))
}

function canMoveUp(index: number) {
  if (index <= 0) return false
  const current = rows.value[index]
  const prev = rows.value[index - 1]
  return !current.locked && !prev.locked
}

function canMoveDown(index: number) {
  if (index < 0 || index >= rows.value.length - 1) return false
  const current = rows.value[index]
  const next = rows.value[index + 1]
  return !current.locked && !next.locked
}

function moveUp(index: number) {
  if (!canMoveUp(index)) return
  const next = rows.value.slice()
  const [current] = next.splice(index, 1)
  next.splice(index - 1, 0, current)
  updateRows(next)
}

function moveDown(index: number) {
  if (!canMoveDown(index)) return
  const next = rows.value.slice()
  const [current] = next.splice(index, 1)
  next.splice(index + 1, 0, current)
  updateRows(next)
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
.column-settings-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
}

.column-settings-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
}

.column-settings-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.column-settings-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
}

.column-settings-row--locked {
  background: color-mix(in srgb, var(--color-primary) 6%, var(--color-surface));
}

.column-settings-label {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.column-settings-title {
  font-size: 14px;
  line-height: 1.3;
}

.column-settings-meta {
  font-size: 12px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.column-settings-actions {
  display: flex;
  align-items: center;
  gap: 4px;
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
