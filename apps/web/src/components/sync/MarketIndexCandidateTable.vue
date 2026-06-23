<template>
  <div class="market-index-candidate-table">
    <div class="section-header">
      <span class="section-title">候选清单（{{ rows.length }} 个）</span>
      <span class="section-hint">来自 Tushare index_basic（规模/综合指数）</span>
    </div>
    <n-data-table
      data-testid="market-index-candidate-table"
      :columns="columns"
      :data="rows"
      :loading="loading"
      :bordered="false"
      :single-line="false"
      size="small"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, h, reactive } from 'vue'
import { NButton, NDataTable, NTag, useMessage } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { marketIndexScopeApi, type MarketIndexCandidate } from '@/api'
import { displayNoiseTags } from './marketIndexNoiseTag'

defineOptions({ name: 'MarketIndexCandidateTable' })

defineProps<{
  rows: MarketIndexCandidate[]
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'added', tsCode: string): void
}>()

const message = useMessage()

// 响应式：记录正在加入的 ts_code，驱动按钮 loading。
const addingMap = reactive<Record<string, boolean>>({})

const columns = computed<DataTableColumns<MarketIndexCandidate>>(() => [
  { title: '代码', key: 'ts_code', width: 130 },
  { title: '名称', key: 'name', width: 160 },
  { title: '类型', key: 'category', width: 110 },
  {
    title: '噪声标签',
    key: 'noise_tags',
    width: 200,
    render(row) {
      const displays = displayNoiseTags(row.noise_tags)
      if (displays.length === 0) return '—'
      return h(
        'div',
        { class: 'noise-tag-cell' },
        displays.map((d) =>
          h(NTag, { size: 'small', type: d.type, round: true, bordered: false }, { default: () => d.label }),
        ),
      )
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 120,
    render(row) {
      if (row.in_scope) {
        return h(
          NTag,
          { size: 'small', type: 'success', round: true, bordered: false },
          { default: () => '已在范围' },
        )
      }
      return h(
        NButton,
        {
          size: 'small',
          type: 'primary',
          ghost: true,
          loading: addingMap[row.ts_code] === true,
          onClick: () => handleAdd(row),
        },
        { default: () => '加入范围' },
      )
    },
  },
])

async function handleAdd(row: MarketIndexCandidate) {
  addingMap[row.ts_code] = true
  try {
    await marketIndexScopeApi.add(row.ts_code, row.name)
    message.success(`已加入 ${row.ts_code}`)
    emit('added', row.ts_code)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    addingMap[row.ts_code] = false
  }
}
</script>

<style scoped>
.market-index-candidate-table {
  margin-top: 16px;
}
.section-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}
.section-title {
  font-weight: 600;
}
.section-hint {
  font-size: 12px;
  color: var(--n-text-color-3, #999);
}
.noise-tag-cell {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
</style>
