<template>
  <n-card title="分类指标（次日方向三分类）" size="small" :bordered="false">
    <div class="badges">
      <div class="cell">
        <span class="label">Accuracy</span>
        <MetricBadge label="" :value="accuracy" :digits="4"
          :thresholds="{ good: 0.45, warn: 0.34 }" />
      </div>
      <div class="cell">
        <span class="label">Macro-F1</span>
        <MetricBadge label="" :value="macroF1" :digits="4"
          :thresholds="{ good: 0.45, warn: 0.34 }" />
      </div>
      <div class="cell">
        <span class="label">IC</span>
        <MetricBadge label="" :value="ic" :digits="4"
          :thresholds="{ good: 0.05, warn: 0.02 }" />
      </div>
      <div class="cell">
        <span class="label">Rank IC</span>
        <MetricBadge label="" :value="rankIc" :digits="4"
          :thresholds="{ good: 0.05, warn: 0.02 }" />
      </div>
    </div>

    <n-divider title-placement="left">混淆矩阵（行=真实，列=预测）</n-divider>
    <n-table v-if="hasConfusion" :bordered="true" :single-line="false" size="small">
      <thead>
        <tr>
          <th class="corner">真实 \ 预测</th>
          <th v-for="c in CLASS_LABELS" :key="c">{{ c }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, ri) in confusion" :key="ri">
          <th class="row-head">{{ CLASS_LABELS[ri] }}</th>
          <td
            v-for="(val, ci) in row"
            :key="ci"
            :class="{ diag: ri === ci }"
            class="cm-cell"
          >
            {{ val }}
          </td>
        </tr>
      </tbody>
    </n-table>
    <n-empty v-else description="未记录 confusion_matrix" />

    <n-divider title-placement="left">各类 Precision / Recall / F1</n-divider>
    <n-data-table
      v-if="perClassRows.length > 0"
      :columns="perClassColumns"
      :data="perClassRows"
      :pagination="false"
      :bordered="false"
      size="small"
      :row-key="(r: PerClassRow) => r.cls"
    />
    <n-empty v-else description="未记录 per_class" />
  </n-card>
</template>

<script setup lang="ts">
import { computed, h } from 'vue'
import {
  NCard, NDataTable, NDivider, NEmpty, NTable,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import MetricBadge from '@/components/quant/MetricBadge.vue'

/** 后端顺序 [down, flat, up]，展示为中文 [跌, 横盘, 涨] */
const CLASS_KEYS = ['down', 'flat', 'up'] as const
const CLASS_LABELS = ['跌', '横盘', '涨'] as const

interface PerClassRow {
  cls: string
  precision: number | null
  recall: number | null
  f1: number | null
  support: number | null
}

const props = defineProps<{ metrics: Record<string, unknown> }>()

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

const accuracy = computed(() => num(props.metrics?.accuracy))
const macroF1 = computed(() => num(props.metrics?.macro_f1))
const ic = computed(() => num(props.metrics?.ic))
const rankIc = computed(() => num(props.metrics?.rank_ic))

const confusion = computed<number[][]>(() => {
  const raw = props.metrics?.confusion_matrix
  if (!Array.isArray(raw)) return []
  return raw.map(row =>
    Array.isArray(row) ? row.map(v => (typeof v === 'number' ? v : 0)) : [],
  )
})
const hasConfusion = computed(() => confusion.value.length > 0)

const perClassRows = computed<PerClassRow[]>(() => {
  const pc = props.metrics?.per_class
  if (!pc || typeof pc !== 'object') return []
  const obj = pc as Record<string, unknown>
  const rows: PerClassRow[] = []
  CLASS_KEYS.forEach((key, idx) => {
    const entry = obj[key]
    if (!entry || typeof entry !== 'object') return
    const e = entry as Record<string, unknown>
    rows.push({
      cls: CLASS_LABELS[idx],
      precision: num(e.precision),
      recall: num(e.recall),
      f1: num(e.f1),
      support: num(e.support),
    })
  })
  return rows
})

function fmt(v: number | null, digits = 4): string {
  return v === null ? '—' : v.toFixed(digits)
}

const perClassColumns = computed<DataTableColumns<PerClassRow>>(() => [
  { title: '类别', key: 'cls', width: 80 },
  {
    title: 'Precision', key: 'precision', align: 'right',
    render: r => h(MetricBadge, { label: '', value: r.precision, digits: 4,
      thresholds: { good: 0.45, warn: 0.34 } }),
  },
  {
    title: 'Recall', key: 'recall', align: 'right',
    render: r => h(MetricBadge, { label: '', value: r.recall, digits: 4,
      thresholds: { good: 0.45, warn: 0.34 } }),
  },
  {
    title: 'F1', key: 'f1', align: 'right',
    render: r => h(MetricBadge, { label: '', value: r.f1, digits: 4,
      thresholds: { good: 0.45, warn: 0.34 } }),
  },
  {
    title: 'Support', key: 'support', width: 100, align: 'right',
    render: r => fmt(r.support, 0),
  },
])
</script>

<style scoped>
.badges {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-surface-elevated);
}
.label {
  font-size: 11px;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.cm-cell {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.cm-cell.diag {
  font-weight: 700;
  background: var(--color-surface-elevated);
}
.corner,
.row-head {
  color: var(--color-text-muted);
  font-weight: 600;
}
</style>
