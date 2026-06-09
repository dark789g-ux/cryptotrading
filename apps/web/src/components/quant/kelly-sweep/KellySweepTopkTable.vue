<template>
  <div class="topk-table-wrap">
    <n-data-table
      :columns="columns"
      :data="rows"
      :loading="loading"
      :pagination="pagination"
      :remote="true"
      size="small"
      :bordered="false"
      :row-key="(row: KellyTopkRow) => row.id"
      @update:page="onPageChange"
      @update:sorter="onSorterChange"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, h } from 'vue'
import { NButton, NDataTable, NTag } from 'naive-ui'
import type { DataTableColumns, PaginationProps, DataTableSortState } from 'naive-ui'
import type { KellyTopkRow } from '@/api/modules/quant/kellySweep'

const props = defineProps<{
  rows: KellyTopkRow[]
  total: number
  page: number
  pageSize: number
  loading?: boolean
}>()

const emit = defineEmits<{
  'page-change': [page: number]
  'sort-change': [sort: string]
  'detail': [row: KellyTopkRow]
}>()

function fmtNum(v: number | null, digits = 3): string {
  if (v === null || v === undefined) return '—'
  return v.toFixed(digits)
}

function fmtPct(v: number | null): string {
  if (v === null || v === undefined) return '—'
  return `${(v * 100).toFixed(1)}%`
}

const columns = computed<DataTableColumns<KellyTopkRow>>(() => [
  {
    title: '变体',
    key: 'variant_id',
    minWidth: 140,
    ellipsis: { tooltip: true },
    render: row => row.variant_id ?? '—',
  },
  {
    title: '出场',
    key: 'exit_id',
    minWidth: 100,
    ellipsis: { tooltip: true },
    render: row => row.exit_id ?? '—',
  },
  {
    title: '信号数',
    key: 'n_valid',
    width: 80,
    align: 'right',
    sorter: true,
    render: row => row.n_valid ?? '—',
  },
  {
    title: 'Kelly f*',
    key: 'kelly_valid',
    width: 88,
    align: 'right',
    sorter: true,
    defaultSortOrder: 'descend' as const,
    render: (row) => {
      if (row.kelly_valid === null) return h('span', { class: 'muted' }, '—')
      return h('span', { class: row.is_frontier ? 'frontier-val' : '' }, fmtNum(row.kelly_valid))
    },
  },
  {
    title: 'CI 95%',
    key: 'ci',
    width: 120,
    render(row) {
      if (row.kelly_ci_low === null || row.kelly_ci_high === null) return h('span', { class: 'muted' }, '—')
      return `[${fmtNum(row.kelly_ci_low)}, ${fmtNum(row.kelly_ci_high)}]`
    },
  },
  {
    title: '胜率',
    key: 'win_rate_valid',
    width: 72,
    align: 'right',
    sorter: true,
    render: row => fmtPct(row.win_rate_valid),
  },
  {
    title: '盈亏比 b',
    key: 'payoff_b_valid',
    width: 80,
    align: 'right',
    sorter: true,
    render: row => fmtNum(row.payoff_b_valid, 2),
  },
  {
    title: '标记',
    key: 'flags',
    width: 80,
    render(row) {
      const tags: ReturnType<typeof h>[] = []
      if (row.is_frontier) {
        tags.push(h(NTag, { type: 'warning', size: 'small', style: 'margin-right:3px' }, { default: () => '前沿' }))
      }
      if (row.below_floor) {
        tags.push(h(NTag, { type: 'default', size: 'small' }, { default: () => 'floor' }))
      }
      return tags.length ? h('div', { style: 'display:flex;gap:2px;flex-wrap:wrap' }, tags) : h('span', { class: 'muted' }, '—')
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 64,
    render(row) {
      return h(NButton, {
        size: 'tiny',
        quaternary: true,
        onClick: () => emit('detail', row),
      }, { default: () => '详情' })
    },
  },
])

const pagination = computed<PaginationProps>(() => ({
  page: props.page,
  pageSize: props.pageSize,
  itemCount: props.total,
  showSizePicker: false,
  showQuickJumper: true,
}))

function onPageChange(p: number) {
  emit('page-change', p)
}

function onSorterChange(sorter: DataTableSortState) {
  if (!sorter || !sorter.columnKey) return
  const dir = sorter.order === 'ascend' ? 'ASC' : 'DESC'
  emit('sort-change', `${sorter.columnKey}:${dir}`)
}
</script>

<style scoped>
.topk-table-wrap {
  width: 100%;
  overflow-x: auto;
}
:deep(.frontier-val) {
  font-weight: 700;
  color: #f6a623;
}
:deep(.muted) {
  color: var(--color-text-muted);
}
</style>
