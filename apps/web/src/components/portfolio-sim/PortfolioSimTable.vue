<template>
  <n-data-table :columns="columns" :data="runs" :loading="loading" :bordered="false" />
</template>

<script setup lang="ts">
import { h, computed } from 'vue'
import { NButton, NDataTable, NPopconfirm, NSpace, NTag, NTooltip } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import PortfolioSimRunSteps from './PortfolioSimRunSteps.vue'
import type { PortfolioSimRun } from '../../api/modules/strategy/portfolioSim'
import { formatUTCDateTime } from '../symbols/a-shares/aSharesFormatters'

const props = defineProps<{
  runs: PortfolioSimRun[]
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'run', id: string): void
  (e: 'detail', run: PortfolioSimRun): void
  (e: 'delete', id: string): void
}>()

function pct(v: string | null, digits = 2): string {
  if (v == null) return '—'
  const n = parseFloat(v)
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '—'
}

function num(v: string | null, digits = 4): string {
  if (v == null) return '—'
  const n = parseFloat(v)
  return Number.isFinite(n) ? n.toFixed(digits) : '—'
}

function signClass(v: string | null): string {
  if (v == null) return ''
  const n = parseFloat(v)
  if (!Number.isFinite(n)) return ''
  return n > 0 ? 'pos' : n < 0 ? 'neg' : ''
}

const columns = computed<DataTableColumns<PortfolioSimRun>>(() => [
  {
    title: '名称',
    key: 'name',
    minWidth: 160,
    ellipsis: { lineClamp: 3, tooltip: true },
    render(row) {
      return h(
        'span',
        {
          style: { cursor: 'pointer', color: '#2080f0', fontWeight: 500 },
          onClick: () => emit('detail', row),
        },
        row.name,
      )
    },
  },
  {
    title: '状态',
    key: 'status',
    width: 280,
    render(row) {
      if (row.status === 'running') {
        return h(
          'div',
          { style: { minWidth: '240px' } },
          [
            h(PortfolioSimRunSteps, {
              phase: row.phase,
              progressDone: row.progressDone,
              progressTotal: row.progressTotal,
            }),
          ],
        )
      }
      if (row.status === 'failed') {
        return h(
          NTooltip,
          {},
          {
            trigger: () =>
              h(NTag, { type: 'error', size: 'small' }, { default: () => '失败' }),
            default: () => row.errorMessage ?? '未知错误',
          },
        )
      }
      if (row.status === 'success') {
        const ts = row.completedAt ?? row.createdAt
        return h(NSpace, { size: 6, align: 'center' }, {
          default: () => [
            h(NTag, { type: 'success', size: 'small' }, { default: () => '已完成' }),
            h('span', { style: { fontSize: '12px', color: '#888' } }, formatUTCDateTime(ts)),
          ],
        })
      }
      return h(NTag, { type: 'default', size: 'small' }, { default: () => '未运行' })
    },
  },
  {
    title: '年化',
    key: 'annualRet',
    width: 100,
    align: 'right',
    render: (row) => h('span', { class: signClass(row.annualRet) }, pct(row.annualRet)),
  },
  {
    title: '最大回撤',
    key: 'maxDrawdown',
    width: 100,
    align: 'right',
    render: (row) => h('span', { class: signClass(row.maxDrawdown) }, pct(row.maxDrawdown)),
  },
  {
    title: '日 Kelly',
    key: 'dailyKelly',
    width: 100,
    align: 'right',
    render: (row) => num(row.dailyKelly, 4),
  },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    render(row) {
      const isRunning = row.status === 'running'
      return h(NSpace, { size: 4 }, {
        default: () => [
          h(
            NButton,
            {
              size: 'small',
              type: 'primary',
              loading: isRunning,
              disabled: isRunning,
              onClick: () => emit('run', row.id),
            },
            { default: () => (isRunning ? '运行中' : '运行') },
          ),
          h(
            NPopconfirm,
            { onPositiveClick: () => emit('delete', row.id) },
            {
              trigger: () =>
                h(
                  NButton,
                  { size: 'small', type: 'error', disabled: isRunning },
                  { default: () => '删除' },
                ),
              default: () => '确定删除此组合模拟？每日净值与逐信号明细将一并删除。',
            },
          ),
        ],
      })
    },
  },
])
</script>

<style scoped>
:deep(.pos) {
  color: #d03050;
}
:deep(.neg) {
  color: #18a058;
}
</style>
