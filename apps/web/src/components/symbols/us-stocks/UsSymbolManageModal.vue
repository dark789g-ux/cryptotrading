<template>
  <app-modal
    :show="show"
    title="美股标的管理"
    description="勾选要跟踪的标的；取消勾选则不纳入查询与同步。"
    width="min(720px, 94vw)"
    @update:show="emit('update:show', $event)"
  >
    <div class="us-symbol-manage">
      <n-input
        v-model:value="searchQuery"
        clearable
        placeholder="搜索代码 / 名称 / 主题…"
        size="small"
        class="us-symbol-search"
      >
        <template #prefix><n-icon><search-outline /></n-icon></template>
      </n-input>

      <div v-if="loading" class="us-symbol-state"><n-spin size="small" /></div>
      <n-empty v-else-if="filteredSymbols.length === 0" description="暂无标的" class="us-symbol-state" />
      <div v-else class="us-symbol-list">
        <label
          v-for="item in filteredSymbols"
          :key="item.ticker"
          class="us-symbol-item"
        >
          <n-checkbox
            :checked="draft.get(item.ticker) ?? item.tracked"
            @update:checked="setTracked(item.ticker, $event)"
          />
          <span class="us-symbol-ticker">{{ item.ticker }}</span>
          <span class="us-symbol-name">{{ item.name ?? '-' }}</span>
          <span class="us-symbol-theme">{{ item.theme ?? '-' }}</span>
        </label>
      </div>
    </div>

    <template #actions>
      <n-button @click="emit('update:show', false)">取消</n-button>
      <n-button type="primary" :loading="saving" :disabled="!hasChanges" @click="handleSave">保存</n-button>
    </template>
  </app-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NCheckbox, NEmpty, NIcon, NInput, NSpin, useMessage } from 'naive-ui'
import { SearchOutline } from '@vicons/ionicons5'
import AppModal from '../../common/AppModal.vue'
import { usStocksApi, type UsSymbol } from '@/api'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  'update:show': [value: boolean]
  saved: []
}>()

const message = useMessage()

const loading = ref(false)
const saving = ref(false)
const symbols = ref<UsSymbol[]>([])
const searchQuery = ref('')
// 仅记录被用户改动过的 ticker → tracked，未改动的读 item.tracked
const draft = ref<Map<string, boolean>>(new Map())

const filteredSymbols = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return symbols.value
  return symbols.value.filter(
    (s) =>
      s.ticker.toLowerCase().includes(q) ||
      (s.name ?? '').toLowerCase().includes(q) ||
      (s.theme ?? '').toLowerCase().includes(q),
  )
})

const hasChanges = computed(() => {
  for (const [ticker, tracked] of draft.value) {
    const original = symbols.value.find((s) => s.ticker === ticker)
    if (original && original.tracked !== tracked) return true
  }
  return false
})

function setTracked(ticker: string, tracked: boolean) {
  const next = new Map(draft.value)
  next.set(ticker, tracked)
  draft.value = next
}

async function loadSymbols() {
  loading.value = true
  try {
    symbols.value = await usStocksApi.listSymbols()
    draft.value = new Map()
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function handleSave() {
  const items: Array<{ ticker: string; tracked: boolean }> = []
  for (const [ticker, tracked] of draft.value) {
    const original = symbols.value.find((s) => s.ticker === ticker)
    if (original && original.tracked !== tracked) items.push({ ticker, tracked })
  }
  if (items.length === 0) {
    emit('update:show', false)
    return
  }
  saving.value = true
  try {
    await usStocksApi.toggleTracked(items)
    message.success('标的跟踪状态已保存')
    emit('saved')
    emit('update:show', false)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    saving.value = false
  }
}

watch(
  () => props.show,
  (visible) => {
    if (visible) {
      searchQuery.value = ''
      void loadSymbols()
    }
  },
)
</script>

<style scoped>
.us-symbol-manage {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.us-symbol-search {
  width: 100%;
}

.us-symbol-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
}

.us-symbol-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: min(56vh, 480px);
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 6px;
}

.us-symbol-item {
  display: grid;
  grid-template-columns: 24px 90px 1fr 140px;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
}

.us-symbol-item:hover {
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
}

.us-symbol-ticker {
  font-weight: 600;
  font-size: 13px;
}

.us-symbol-name,
.us-symbol-theme {
  font-size: 13px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
