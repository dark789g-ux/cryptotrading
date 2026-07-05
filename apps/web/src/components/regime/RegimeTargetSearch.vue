<template>
  <n-select
    :value="value"
    :options="options"
    :loading="loading"
    filterable
    clearable
    remote
    :placeholder="placeholder"
    @update:value="(v) => emit('update:value', v)"
    @search="handleSearch"
  />
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { NSelect } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { indexDailyApi } from '@/api/modules/market/indexDaily'
import { aSharesApi } from '@/api/modules/market/aShares'
import type { AShareSearchResult } from '@/api/modules/market/aShares'
import type { IndexCatalogRow } from '@/components/symbols/a-shares-index/types'

interface Props {
  type: 'index' | 'stock'
  value?: string | null
  placeholder?: string
}

const props = withDefaults(defineProps<Props>(), {
  value: null,
  placeholder: '搜索标的',
})

const emit = defineEmits<{
  'update:value': [value: string | null]
}>()

const options = ref<SelectOption[]>([])
const loading = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

function formatOption(tsCode: string, name: string): SelectOption {
  return {
    label: `${tsCode} ${name}`,
    value: tsCode,
  }
}

function handleSearch(query: string) {
  if (searchTimer) clearTimeout(searchTimer)
  const q = query.trim()
  if (!q) {
    options.value = []
    loading.value = false
    return
  }
  loading.value = true
  searchTimer = setTimeout(() => void runSearch(q), 300)
}

async function runSearch(q: string) {
  try {
    if (props.type === 'index') {
      const rows = await indexDailyApi.getCatalog({ q })
      options.value = rows.map((r: IndexCatalogRow) => formatOption(r.tsCode, r.name))
    } else {
      const rows = await aSharesApi.search(q)
      options.value = rows.map((r: AShareSearchResult) => formatOption(r.tsCode, r.name))
    }
  } catch {
    options.value = []
  } finally {
    loading.value = false
  }
}

watch(
  () => props.type,
  () => {
    options.value = []
    emit('update:value', null)
  },
)

onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
})
</script>
