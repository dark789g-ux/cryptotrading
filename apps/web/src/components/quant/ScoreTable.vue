<template>
  <n-data-table
    :columns="columns"
    :data="rows"
    :loading="loading"
    :pagination="paginationProp"
    :remote="remote"
    :bordered="false"
    :single-line="false"
    :row-key="rowKey"
    :row-class-name="rowClassName"
    :row-props="rowProps"
    size="small"
    striped
    @update:page="onPage"
    @update:sorter="onSort"
  />
</template>

<script setup lang="ts">
import { computed, h } from 'vue'
import { NDataTable, NTag } from 'naive-ui'
import type { DataTableColumns, DataTableSortState, PaginationProps } from 'naive-ui'
import type { ScoreRow } from '@/api/modules/quant'

/**
 * 评分表格（受控）
 * - 受控：父组件持有数据、分页、loading 状态
 * - 高亮 Top-3：rank_in_day <= 3 加 row class
 * - 行点击 emit('rowClick', row)
 */
const props = withDefaults(
  defineProps<{
    rows: ScoreRow[]
    loading?: boolean
    /** 远程分页元数据；不传则不显示分页 */
    page?: number
    pageSize?: number
    total?: number
    remote?: boolean
    /** 是否显示 model_version 列（多模型对照时打开） */
    showVersion?: boolean
    /** 是否启用排序 */
    sortable?: boolean
  }>(),
  {
    loading: false,
    remote: true,
    showVersion: false,
    sortable: false,
  },
)

const emit = defineEmits<{
  rowClick: [row: ScoreRow]
  pageChange: [page: number]
  sortChange: [sort: { field: string; order: 'ascend' | 'descend' | false }]
}>()

const rowKey = (row: ScoreRow) => `${row.trade_date}_${row.ts_code}_${row.model_version}`

const rowClassName = (row: ScoreRow) => {
  if (row.rank_in_day <= 3) return 'score-row-top3'
  if (row.rank_in_day <= 10) return 'score-row-top10'
  return ''
}

const rowProps = (row: ScoreRow) => ({
  style: 'cursor: pointer;',
  onClick: () => emit('rowClick', row),
})

const columns = computed<DataTableColumns<ScoreRow>>(() => {
  const cols: DataTableColumns<ScoreRow> = [
    {
      title: '排名',
      key: 'rank_in_day',
      width: 80,
      align: 'right',
      sorter: (props.sortable ? 'default' : false) as 'default' | false,
      render(row) {
        const v = row.rank_in_day
        const isTop3 = v <= 3
        return h(
          NTag,
          {
            size: 'small',
            type: isTop3 ? 'warning' : v <= 10 ? 'info' : 'default',
            bordered: false,
            round: true,
          },
          { default: () => `#${v}` },
        )
      },
    },
    {
      title: '标的',
      key: 'ts_code',
      width: 140,
      render(row) {
        return h('span', { class: 'ts-code' }, [
          h('strong', row.ts_code),
          row.name ? h('span', { class: 'ts-name' }, `  ${row.name}`) : null,
        ])
      },
    },
    {
      title: '评分',
      key: 'score',
      align: 'right',
      width: 120,
      sorter: (props.sortable ? 'default' : false) as 'default' | false,
      render(row) {
        return h(
          'span',
          { class: 'score-cell' },
          Number(row.score).toFixed(6),
        )
      },
    },
    {
      title: '交易日',
      key: 'trade_date',
      width: 110,
      render(row) {
        const s = row.trade_date || ''
        if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
        return s
      },
    },
  ]
  if (props.showVersion) {
    cols.push({
      title: '模型版本',
      key: 'model_version',
      ellipsis: { tooltip: true },
    })
  }
  return cols
})

const paginationProp = computed<PaginationProps | false>(() => {
  if (props.total === undefined || props.pageSize === undefined) return false
  return {
    page: props.page ?? 1,
    pageSize: props.pageSize,
    itemCount: props.total,
    showSizePicker: false,
  } as PaginationProps
})

function onPage(p: number) {
  emit('pageChange', p)
}

function onSort(sort: DataTableSortState | null) {
  if (!sort) {
    emit('sortChange', { field: '', order: false })
    return
  }
  emit('sortChange', {
    field: String(sort.columnKey),
    order: sort.order ?? false,
  })
}
</script>

<style scoped>
:deep(.score-row-top3 td) {
  background: color-mix(in srgb, var(--color-primary) 8%, transparent) !important;
}
:deep(.score-row-top10 td) {
  background: color-mix(in srgb, var(--color-info) 4%, transparent) !important;
}
:deep(.ts-code) {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
:deep(.ts-name) {
  color: var(--color-text-muted);
  font-size: 12px;
}
:deep(.score-cell) {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
</style>
