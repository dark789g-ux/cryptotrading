<template>
  <n-popover
    trigger="click"
    placement="bottom-end"
    :show="show"
    @update:show="handleShow"
    :style="{ width: '320px', padding: '0' }"
  >
    <template #trigger>
      <n-button size="small" class="preset-btn">预设</n-button>
    </template>
    <div class="preset-panel">
      <div class="preset-search">
        <n-input v-model:value="search" size="small" placeholder="搜索预设" clearable />
      </div>
      <div v-if="loading" class="preset-empty"><n-spin size="small" /></div>
      <div v-else-if="!filtered.length" class="preset-empty">
        {{ presets.length ? '无匹配预设' : '暂无预设' }}
      </div>
      <div v-else class="preset-list">
        <div v-for="p in filtered" :key="p.id" class="preset-item">
          <template v-if="renamingId === p.id">
            <n-input
              v-model:value="renameValue"
              size="tiny"
              autofocus
              @keydown.enter="commitRename(p)"
              @keydown.esc="cancelRename"
              @blur="commitRename(p)"
            />
          </template>
          <template v-else>
            <n-tooltip trigger="hover" placement="left" :disabled="p.symbols.length === 0">
              <template #trigger>
                <div class="preset-name">
                  <span class="preset-title">{{ p.name }}</span>
                  <span class="preset-count">({{ p.symbols.length }})</span>
                </div>
              </template>
              <div style="max-width: 300px;">
                {{ p.symbols.slice(0, 20).join(', ') }}{{ p.symbols.length > 20 ? ' ...' : '' }}
              </div>
            </n-tooltip>
            <div class="preset-actions">
              <n-button size="tiny" text type="primary" @click="loadPreset(p)">载入</n-button>
              <n-button size="tiny" text title="用当前选择覆盖" @click="overwritePreset(p)">↻</n-button>
              <n-button size="tiny" text title="重命名" @click="startRename(p)">✎</n-button>
              <n-popconfirm @positive-click="deletePreset(p)" positive-text="删除" negative-text="取消">
                <template #trigger>
                  <n-button size="tiny" text title="删除">🗑</n-button>
                </template>
                确认删除预设 "{{ p.name }}"?
              </n-popconfirm>
            </div>
          </template>
        </div>
      </div>
      <div class="preset-footer">
        <n-button size="small" type="primary" block :disabled="!currentSymbols.length" @click="openCreateDialog">
          保存当前选择为新预设
        </n-button>
      </div>
    </div>
  </n-popover>

  <n-modal
    v-model:show="createDialogShow"
    preset="dialog"
    title="保存为预设"
    positive-text="保存"
    negative-text="取消"
    @positive-click="submitCreate"
  >
    <n-input v-model:value="createName" placeholder="预设名称" @keydown.enter="submitCreate" autofocus />
  </n-modal>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  useMessage,
  NPopover, NPopconfirm, NTooltip, NSpin, NModal, NInput, NButton,
} from 'naive-ui'
import { symbolPresetApi, type SymbolPreset } from '../../../composables/useApi'

const props = defineProps<{
  currentSymbols: string[]
  availableSymbols: string[]
}>()

const emit = defineEmits<{
  (e: 'load', symbols: string[]): void
}>()

const message = useMessage()

const show = ref(false)
const search = ref('')
const loading = ref(false)
const presets = ref<SymbolPreset[]>([])
const renamingId = ref<string | null>(null)
const renameValue = ref('')
const createDialogShow = ref(false)
const createName = ref('')

const filtered = computed(() => {
  const kw = search.value.trim().toLowerCase()
  if (!kw) return presets.value
  return presets.value.filter((p) => p.name.toLowerCase().includes(kw))
})

const loadList = async () => {
  loading.value = true
  try {
    presets.value = await symbolPresetApi.list()
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '加载预设失败')
  } finally {
    loading.value = false
  }
}

const handleShow = (v: boolean) => {
  show.value = v
  if (v) {
    renamingId.value = null
    search.value = ''
    loadList()
  }
}

const loadPreset = (p: SymbolPreset) => {
  const validSet = new Set(props.availableSymbols)
  const valid = p.symbols.filter((s) => validSet.has(s))
  const skipped = p.symbols.length - valid.length
  emit('load', valid)
  if (skipped > 0) {
    message.info(`已过滤 ${skipped} 个当前时间周期下不存在的标的`)
  } else {
    message.success(`已载入预设 "${p.name}"`)
  }
  show.value = false
}

const overwritePreset = async (p: SymbolPreset) => {
  if (!props.currentSymbols.length) {
    message.warning('当前未选择标的，无法覆盖')
    return
  }
  try {
    await symbolPresetApi.update(p.id, { symbols: props.currentSymbols })
    message.success(`已更新预设 "${p.name}"`)
    await loadList()
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '更新失败')
  }
}

const startRename = (p: SymbolPreset) => {
  renamingId.value = p.id
  renameValue.value = p.name
}

const cancelRename = () => {
  renamingId.value = null
  renameValue.value = ''
}

const commitRename = async (p: SymbolPreset) => {
  if (renamingId.value !== p.id) return
  const newName = renameValue.value.trim()
  if (!newName || newName === p.name) {
    cancelRename()
    return
  }
  try {
    await symbolPresetApi.update(p.id, { name: newName })
    message.success('重命名成功')
    renamingId.value = null
    await loadList()
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '重命名失败')
  }
}

const deletePreset = async (p: SymbolPreset) => {
  try {
    await symbolPresetApi.delete(p.id)
    message.success(`已删除预设 "${p.name}"`)
    await loadList()
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '删除失败')
  }
}

const openCreateDialog = () => {
  createName.value = ''
  createDialogShow.value = true
}

const submitCreate = async () => {
  const name = createName.value.trim()
  if (!name) {
    message.warning('请输入预设名称')
    return false
  }
  try {
    await symbolPresetApi.create({ name, symbols: props.currentSymbols })
    message.success(`已保存预设 "${name}"`)
    createDialogShow.value = false
    await loadList()
    return true
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '保存失败')
    return false
  }
}
</script>

<style scoped>
.preset-btn { flex-shrink: 0; }
.preset-panel { display: flex; flex-direction: column; max-height: 420px; }
.preset-search { padding: 10px 12px 6px 12px; }
.preset-empty { padding: 24px 12px; text-align: center; color: var(--text-secondary); font-size: 13px; }
.preset-list { flex: 1; overflow-y: auto; max-height: 280px; padding: 0 4px; }
.preset-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 8px; gap: 8px; border-radius: 4px;
}
.preset-item:hover { background: var(--hover-bg, rgba(255,255,255,0.04)); }
.preset-name { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; overflow: hidden; }
.preset-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; }
.preset-count { color: var(--text-secondary); font-size: 12px; flex-shrink: 0; }
.preset-actions { display: flex; gap: 6px; flex-shrink: 0; }
.preset-footer { padding: 8px 12px; border-top: 1px solid var(--border-color, rgba(255,255,255,0.08)); }
</style>
