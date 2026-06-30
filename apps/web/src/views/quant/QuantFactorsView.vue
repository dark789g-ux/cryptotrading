<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>量化 · 因子清单</h2>
        <p class="subtitle">
          <template v-if="!loading && items.length > 0">
            {{ items.length }} 个因子（{{ versionLabel }}）｜当前启用 {{ enabledCount }} / {{ items.length }}
          </template>
          <template v-else-if="loading">加载中…</template>
          <template v-else>暂无因子数据</template>
        </p>
      </div>
      <div class="filters">
        <n-button size="small" :loading="loading" @click="loadAll">刷新</n-button>
      </div>
    </div>

    <n-card size="small" :bordered="false" class="filter-card">
      <div class="filter-row">
        <div class="filter-item">
          <span class="filter-label">状态</span>
          <n-select
            v-model:value="statusFilter"
            :options="statusOptions"
            size="small"
            style="width: 140px;"
            data-testid="factor-filter-status"
            @update:value="onFilterChange"
          />
        </div>
        <div class="filter-item">
          <span class="filter-label">类别</span>
          <n-select
            v-model:value="categoryFilter"
            :options="categoryOptions"
            size="small"
            style="width: 160px;"
            clearable
            data-testid="factor-filter-category"
            @update:value="onFilterChange"
          />
        </div>
        <div class="filter-item">
          <span class="filter-label">搜索</span>
          <n-input
            v-model:value="searchText"
            placeholder="按 factor_id 或描述搜索"
            clearable
            size="small"
            style="width: 240px;"
            data-testid="factor-filter-search"
          />
        </div>
      </div>
    </n-card>

    <n-alert v-if="errorText" type="error" :title="errorText" closable style="margin-bottom: 12px;" />

    <n-card size="small" :bordered="false">
      <n-empty v-if="!loading && filteredItems.length === 0" description="无匹配因子（调整筛选或刷新）" />
      <FactorTable
        v-else
        :items="filteredItems"
        :loading="loading"
        @updated="onRowUpdated"
        @edit="onEdit"
      />
    </n-card>

    <FactorEditModal
      v-model:show="editModalShow"
      :factor="editing"
      @saved="onRowUpdated"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NInput, NSelect, useMessage } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import FactorTable from '@/components/quant/factor/FactorTable.vue'
import FactorEditModal from '@/components/quant/factor/FactorEditModal.vue'
import { quantApi, type FactorDefinition } from '@/api/modules/quant'

const message = useMessage()

const items = ref<FactorDefinition[]>([])
const categories = ref<string[]>([])
const loading = ref(false)
const errorText = ref('')

const statusFilter = ref<'all' | 'enabled' | 'disabled'>('all')
const categoryFilter = ref<string | null>(null)
const searchText = ref('')

const editModalShow = ref(false)
const editing = ref<FactorDefinition | null>(null)

interface FilterStatusOption extends SelectOption {
  value: 'all' | 'enabled' | 'disabled'
}

const statusOptions: FilterStatusOption[] = [
  { label: '全部', value: 'all' },
  { label: '已启用', value: 'enabled' },
  { label: '已禁用', value: 'disabled' },
]

const categoryOptions = computed<SelectOption[]>(() =>
  categories.value.map((c) => ({ label: c, value: c })),
)

const enabledCount = computed(() => items.value.filter((i) => i.enabled).length)

const versionLabel = computed(() => {
  if (items.value.length === 0) return ''
  // 全表通常同一 factor_version；若混合则展示去重列表
  const versions = Array.from(new Set(items.value.map((i) => i.factor_version)))
  return versions.join(', ')
})

const filteredItems = computed(() => {
  const q = searchText.value.trim().toLowerCase()
  return items.value.filter((i) => {
    if (statusFilter.value === 'enabled' && !i.enabled) return false
    if (statusFilter.value === 'disabled' && i.enabled) return false
    if (categoryFilter.value && i.category !== categoryFilter.value) return false
    if (q) {
      const hay = `${i.factor_id} ${i.description ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
})

async function loadAll() {
  loading.value = true
  errorText.value = ''
  try {
    const [list, cats] = await Promise.all([
      quantApi.listFactors(),
      quantApi.listFactorCategories(),
    ])
    items.value = (list.items ?? []).slice().sort((a, b) => {
      if (a.display_order !== b.display_order) return a.display_order - b.display_order
      return a.factor_id.localeCompare(b.factor_id)
    })
    categories.value = cats.items ?? []
  } catch (e) {
    errorText.value = `加载因子清单失败：${(e as Error).message}`
    items.value = []
    categories.value = []
  } finally {
    loading.value = false
  }
}

function onFilterChange() {
  // 纯前端筛选：全表 16 行直接 client 过滤；不重拉
}

function onEdit(row: FactorDefinition) {
  editing.value = row
  editModalShow.value = true
}

function rowMatchesFilter(row: FactorDefinition): boolean {
  if (statusFilter.value === 'enabled' && !row.enabled) return false
  if (statusFilter.value === 'disabled' && row.enabled) return false
  if (categoryFilter.value && row.category !== categoryFilter.value) return false
  const q = searchText.value.trim().toLowerCase()
  if (q) {
    const hay = `${row.factor_id} ${row.description ?? ''}`.toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}

function onRowUpdated(item: FactorDefinition) {
  const idx = items.value.findIndex(
    (i) => i.factor_id === item.factor_id && i.factor_version === item.factor_version,
  )
  if (idx >= 0) {
    items.value.splice(idx, 1, item)
  } else {
    items.value.push(item)
  }
  // 筛选可见性兜底：若改动后该行不再匹配筛选条件，弹 info 提示
  if (!rowMatchesFilter(item)) {
    message.info('已保存，因当前筛选条件已隐藏该行')
  }
}

// CLAUDE.md keep-alive 规范：依赖外部可能变化的数据放 onActivated
onMounted(loadAll)
onActivated(() => {
  // 初次进入由 onMounted 触发，避免双拉
  if (items.value.length > 0) loadAll()
})

defineExpose({
  loadAll,
  filteredItems,
  items,
  statusFilter,
  categoryFilter,
  searchText,
})
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
