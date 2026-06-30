<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>量化 · 标签库</h2>
        <p class="subtitle">
          <template v-if="!loading && items.length > 0">
            {{ items.length }} 条标签｜启用 {{ enabledCount }} / {{ items.length }}
          </template>
          <template v-else-if="loading">加载中…</template>
          <template v-else>暂无标签数据</template>
        </p>
      </div>
      <div class="header-actions">
        <n-button size="small" :loading="loading" @click="loadAll">刷新</n-button>
        <n-button type="primary" size="small" @click="onCreateNew">+ 新建标签</n-button>
      </div>
    </div>

    <n-card size="small" :bordered="false" class="filter-card">
      <div class="filter-row">
        <div class="filter-item">
          <span class="filter-label">基础类型</span>
          <n-select
            v-model:value="baseTypeFilter"
            :options="baseTypeFilterOptions"
            size="small"
            style="width: 200px;"
            clearable
            data-testid="label-filter-base-type"
            @update:value="onFilterChange"
          />
        </div>
        <div class="filter-item">
          <span class="filter-label">状态</span>
          <n-select
            v-model:value="statusFilter"
            :options="statusOptions"
            size="small"
            style="width: 140px;"
            data-testid="label-filter-status"
            @update:value="onFilterChange"
          />
        </div>
      </div>
    </n-card>

    <n-alert v-if="errorText" type="error" :title="errorText" closable style="margin-bottom: 12px;" />

    <n-card size="small" :bordered="false">
      <n-empty v-if="!loading && filteredItems.length === 0" description="无匹配标签（调整筛选或刷新）" />
      <LabelTable
        v-else
        :items="filteredItems"
        :loading="loading"
        @updated="onRowUpdated"
        @edit="onEdit"
      />
    </n-card>

    <LabelEditModal
      v-model:show="editModalShow"
      :label="editing"
      @saved="onRowUpdated"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NSelect, useMessage } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import LabelTable from '@/components/quant/label/LabelTable.vue'
import LabelEditModal from '@/components/quant/label/LabelEditModal.vue'
import { quantApi, type LabelDefinition } from '@/api/modules/quant'

const message = useMessage()

const items = ref<LabelDefinition[]>([])
const loading = ref(false)
const errorText = ref('')

const baseTypeFilter = ref<string | null>(null)
const statusFilter = ref<'all' | 'enabled' | 'disabled'>('all')

const editModalShow = ref(false)
const editing = ref<LabelDefinition | null>(null)

interface StatusOption extends SelectOption {
  value: 'all' | 'enabled' | 'disabled'
}

const statusOptions: StatusOption[] = [
  { label: '全部', value: 'all' },
  { label: '已启用', value: 'enabled' },
  { label: '已禁用', value: 'disabled' },
]

const baseTypeFilterOptions = computed<SelectOption[]>(() => {
  const types = Array.from(new Set(items.value.map((i) => i.base_type)))
  return types.map((t) => ({ label: t, value: t }))
})

const enabledCount = computed(() => items.value.filter((i) => i.enabled).length)

const filteredItems = computed(() =>
  items.value.filter((i) => {
    if (statusFilter.value === 'enabled' && !i.enabled) return false
    if (statusFilter.value === 'disabled' && i.enabled) return false
    if (baseTypeFilter.value && i.base_type !== baseTypeFilter.value) return false
    return true
  }),
)

async function loadAll() {
  loading.value = true
  errorText.value = ''
  try {
    const res = await quantApi.listLabels()
    items.value = (res.items ?? []).slice().sort((a, b) => {
      if (a.display_order !== b.display_order) return a.display_order - b.display_order
      return a.label_id.localeCompare(b.label_id)
    })
  } catch (e) {
    errorText.value = `加载标签列表失败：${(e as Error).message}`
    items.value = []
  } finally {
    loading.value = false
  }
}

function onFilterChange() {
  // 纯前端筛选，不重拉
}

function onCreateNew() {
  editing.value = null
  editModalShow.value = true
}

function onEdit(row: LabelDefinition) {
  editing.value = row
  editModalShow.value = true
}

function rowMatchesFilter(row: LabelDefinition): boolean {
  if (statusFilter.value === 'enabled' && !row.enabled) return false
  if (statusFilter.value === 'disabled' && row.enabled) return false
  if (baseTypeFilter.value && row.base_type !== baseTypeFilter.value) return false
  return true
}

function onRowUpdated(item: LabelDefinition) {
  const idx = items.value.findIndex(
    (i) => i.label_id === item.label_id && i.label_version === item.label_version,
  )
  if (idx >= 0) {
    items.value.splice(idx, 1, item)
  } else {
    items.value.push(item)
  }
  if (!rowMatchesFilter(item)) {
    message.info('已保存，因当前筛选条件已隐藏该行')
  }
}

// keep-alive 规范
onMounted(loadAll)
onActivated(() => {
  if (items.value.length > 0) loadAll()
})

defineExpose({ loadAll, filteredItems, items, statusFilter, baseTypeFilter })
</script>

<style scoped>
.page {
  padding: 16px 24px;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.subtitle {
  color: var(--color-text-muted);
  font-size: 13px;
  margin: 4px 0 0;
}
.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.filter-card {
  margin-bottom: 12px;
}
.filter-row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  align-items: center;
}
.filter-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.filter-label {
  font-size: 12px;
  color: var(--color-text-muted);
}
</style>
