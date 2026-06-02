<template>
  <n-card title="Walk-Forward Fold 指标" size="small" :bordered="false">
    <n-empty v-if="rows.length === 0" description="未记录 fold_metrics" />
    <n-data-table
      v-else
      :columns="columns"
      :data="rows"
      :pagination="false"
      :bordered="false"
      size="small"
      :row-key="(row: FoldRow) => row.fold"
    />
  </n-card>
</template>

<script setup lang="ts">
import { computed, h } from 'vue'
import { NCard, NDataTable, NEmpty } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import MetricBadge from '@/components/quant/MetricBadge.vue'

interface FoldRow {
  fold: number
  train_dates: string
  valid_dates: string
  ndcg_at_5: number | null
  ndcg_at_10: number | null
  ic: number | null
  portfolio_annual_after_cost: number | null
  accuracy: number | null
  macro_f1: number | null
}

const props = defineProps<{ metrics: Record<string, unknown> }>()

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function dateRange(v: unknown): string {
  if (!v) return '—'
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.length === 2) {
    return `${v[0]} ~ ${v[1]}`
  }
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    if (typeof o.start === 'string' && typeof o.end === 'string') {
      return `${o.start} ~ ${o.end}`
    }
  }
  return String(v)
}

const rows = computed<FoldRow[]>(() => {
  const arr = props.metrics?.fold_metrics
  if (!Array.isArray(arr)) return []
  return arr.map((item, idx) => {
    const o = (item ?? {}) as Record<string, unknown>
    return {
      fold: (typeof o.fold === 'number' ? o.fold : idx + 1) as number,
      train_dates: dateRange(o.train_dates ?? o.train),
      valid_dates: dateRange(o.valid_dates ?? o.valid),
      ndcg_at_5: num(o.ndcg_at_5 ?? (o as Record<string, unknown>)['ndcg@5']),
      ndcg_at_10: num(o.ndcg_at_10 ?? (o as Record<string, unknown>)['ndcg@10']),
      ic: num(o.ic),
      portfolio_annual_after_cost: num(o.portfolio_annual_after_cost),
      accuracy: num(o.accuracy),
      macro_f1: num(o.macro_f1 ?? (o as Record<string, unknown>)['macro-f1']),
    }
  })
})

/** 分类 Run（task=classification_3class 或 fold 含 accuracy）→ 显示 accuracy/macro_f1 列 */
const isClassification = computed(() => {
  if (props.metrics?.task === 'classification_3class') return true
  return rows.value.some(r => r.accuracy !== null || r.macro_f1 !== null)
})

const baseColumns: DataTableColumns<FoldRow> = [
  { title: 'Fold', key: 'fold', width: 60 },
  { title: '训练区间', key: 'train_dates', minWidth: 200, ellipsis: { tooltip: true } },
  { title: '验证区间', key: 'valid_dates', minWidth: 200, ellipsis: { tooltip: true } },
]

const sortColumns: DataTableColumns<FoldRow> = [
  {
    title: 'NDCG@5',
    key: 'ndcg_at_5',
    width: 110,
    align: 'right',
    render: r => h(MetricBadge, { label: '', value: r.ndcg_at_5, digits: 4,
      thresholds: { good: 0.55, warn: 0.5 } }),
  },
  {
    title: 'NDCG@10',
    key: 'ndcg_at_10',
    width: 110,
    align: 'right',
    render: r => h(MetricBadge, { label: '', value: r.ndcg_at_10, digits: 4,
      thresholds: { good: 0.55, warn: 0.5 } }),
  },
  {
    title: 'IC',
    key: 'ic',
    width: 100,
    align: 'right',
    render: r => h(MetricBadge, { label: '', value: r.ic, digits: 4,
      thresholds: { good: 0.05, warn: 0.02 } }),
  },
  {
    title: '单笔净收益(中位)',
    key: 'portfolio_annual_after_cost',
    width: 150,
    align: 'right',
    render: r => h(MetricBadge, { label: '', value: r.portfolio_annual_after_cost,
      percent: true, digits: 2, thresholds: { good: 0.002, warn: 0 } }),
  },
]

const classColumns: DataTableColumns<FoldRow> = [
  {
    title: 'Accuracy',
    key: 'accuracy',
    width: 120,
    align: 'right',
    render: r => h(MetricBadge, { label: '', value: r.accuracy, digits: 4,
      thresholds: { good: 0.45, warn: 0.34 } }),
  },
  {
    title: 'Macro-F1',
    key: 'macro_f1',
    width: 120,
    align: 'right',
    render: r => h(MetricBadge, { label: '', value: r.macro_f1, digits: 4,
      thresholds: { good: 0.45, warn: 0.34 } }),
  },
  {
    title: 'IC',
    key: 'ic',
    width: 100,
    align: 'right',
    render: r => h(MetricBadge, { label: '', value: r.ic, digits: 4,
      thresholds: { good: 0.05, warn: 0.02 } }),
  },
]

const columns = computed<DataTableColumns<FoldRow>>(() => [
  ...baseColumns,
  ...(isClassification.value ? classColumns : sortColumns),
])
</script>
