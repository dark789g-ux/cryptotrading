<template>
  <n-popover
    trigger="click"
    placement="bottom-end"
    :show="show"
    :style="{ width: '360px', padding: '0' }"
    @update:show="handleShow"
  >
    <template #trigger>
      <n-button>
        <template #icon><n-icon><bookmark-outline /></n-icon></template>
        筛选方案
      </n-button>
    </template>

    <div class="preset-panel">
      <div class="preset-search">
        <n-input v-model:value="search" size="small" placeholder="搜索方案" clearable />
        <n-button circle quaternary size="small" :loading="loading" @click="emit('refresh')">
          <template #icon><n-icon><refresh-outline /></n-icon></template>
        </n-button>
      </div>

      <div v-if="loading" class="preset-empty"><n-spin size="small" /></div>
      <div v-else-if="!filteredPresets.length" class="preset-empty">
        {{ presets.length ? '无匹配方案' : '暂无筛选方案' }}
      </div>
      <div v-else class="preset-list">
        <div v-for="preset in filteredPresets" :key="preset.id" class="preset-item">
          <template v-if="renamingId === preset.id">
            <n-input
              v-model:value="renameValue"
              size="tiny"
              autofocus
              @keydown.enter="commitRename(preset)"
              @keydown.esc="cancelRename"
              @blur="commitRename(preset)"
            />
          </template>
          <template v-else>
            <button class="preset-main" type="button" @click="loadPreset(preset)">
              <span class="preset-title">{{ preset.name }}</span>
              <span class="preset-meta">{{ formatPresetMeta(preset) }}</span>
            </button>
            <div class="preset-actions">
              <n-tooltip trigger="hover">
                <template #trigger>
                  <n-button size="tiny" text @click="emit('overwrite', preset)">
                    <template #icon><n-icon><save-outline /></n-icon></template>
                  </n-button>
                </template>
                覆盖
              </n-tooltip>
              <n-tooltip trigger="hover">
                <template #trigger>
                  <n-button size="tiny" text @click="startRename(preset)">
                    <template #icon><n-icon><create-outline /></n-icon></template>
                  </n-button>
                </template>
                重命名
              </n-tooltip>
              <n-popconfirm
                positive-text="删除"
                negative-text="取消"
                @positive-click="emit('delete', preset)"
              >
                <template #trigger>
                  <n-button size="tiny" text>
                    <template #icon><n-icon><trash-outline /></n-icon></template>
                  </n-button>
                </template>
                确认删除筛选方案 "{{ preset.name }}"?
              </n-popconfirm>
            </div>
          </template>
        </div>
      </div>

      <div class="preset-footer">
        <n-button type="primary" block size="small" @click="openCreateDialog">保存当前筛选为新方案</n-button>
      </div>
    </div>
  </n-popover>

  <n-modal
    v-model:show="createDialogShow"
    preset="dialog"
    title="保存筛选方案"
    positive-text="保存"
    negative-text="取消"
    @positive-click="submitCreate"
  >
    <n-input v-model:value="createName" autofocus placeholder="方案名称" @keydown.enter="submitCreate" />
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NIcon, NInput, NModal, NPopconfirm, NPopover, NSpin, NTooltip, useMessage } from 'naive-ui'
import { BookmarkOutline, CreateOutline, RefreshOutline, SaveOutline, TrashOutline } from '@vicons/ionicons5'
import type { AShareFilterPreset } from '@/api'

const props = defineProps<{
  presets: AShareFilterPreset[]
  loading: boolean
}>()

const emit = defineEmits<{
  refresh: []
  create: [name: string]
  load: [preset: AShareFilterPreset]
  overwrite: [preset: AShareFilterPreset]
  rename: [payload: { preset: AShareFilterPreset; name: string }]
  delete: [preset: AShareFilterPreset]
}>()

const message = useMessage()
const show = ref(false)
const search = ref('')
const createDialogShow = ref(false)
const createName = ref('')
const renamingId = ref<string | null>(null)
const renameValue = ref('')

const filteredPresets = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  if (!keyword) return props.presets
  return props.presets.filter((preset) => preset.name.toLowerCase().includes(keyword))
})

function handleShow(value: boolean) {
  show.value = value
  if (!value) return
  search.value = ''
  cancelRename()
  emit('refresh')
}

function openCreateDialog() {
  createName.value = ''
  createDialogShow.value = true
}

function submitCreate() {
  const name = createName.value.trim()
  if (!name) {
    message.warning('请输入方案名称')
    return false
  }
  emit('create', name)
  createDialogShow.value = false
  return true
}

function loadPreset(preset: AShareFilterPreset) {
  emit('load', preset)
  show.value = false
}

function startRename(preset: AShareFilterPreset) {
  renamingId.value = preset.id
  renameValue.value = preset.name
}

function cancelRename() {
  renamingId.value = null
  renameValue.value = ''
}

function commitRename(preset: AShareFilterPreset) {
  if (renamingId.value !== preset.id) return
  const name = renameValue.value.trim()
  if (!name || name === preset.name) {
    cancelRename()
    return
  }
  emit('rename', { preset, name })
  cancelRename()
}

function formatPresetMeta(preset: AShareFilterPreset) {
  const filters = preset.filters
  const count = [
    filters.searchQuery.trim(),
    filters.selectedMarket,
    filters.selectedIndustry,
    filters.pctChangeMin,
    filters.turnoverRateMin,
    ...filters.advancedConditions,
  ].filter((value) => value !== '' && value !== null && value !== undefined).length
  return `${filters.priceMode === 'raw' ? '原始价' : '前复权'} / ${count} 项`
}
</script>

<style scoped>
.preset-panel { display: flex; flex-direction: column; max-height: 440px; }
.preset-search { display: flex; gap: 8px; padding: 10px 12px 6px 12px; align-items: center; }
.preset-empty { padding: 24px 12px; text-align: center; color: var(--color-text-secondary); font-size: 13px; }
.preset-list { flex: 1; overflow-y: auto; max-height: 300px; padding: 0 4px; }
.preset-item {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 7px 8px; border-radius: 4px;
}
.preset-item:hover { background: var(--color-surface-elevated); }
.preset-main {
  flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;
  padding: 0; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer;
}
.preset-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; }
.preset-meta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--color-text-secondary); font-size: 12px; }
.preset-actions { display: flex; gap: 6px; flex-shrink: 0; }
.preset-footer { padding: 8px 12px; border-top: 1px solid var(--color-border); }
</style>
