<!-- apps/web/src/views/strategy/SignalStatsTable.vue -->
<template>
  <n-data-table
    :columns="columns"
    :data="tests"
    :loading="loading"
    :bordered="false"
  />
</template>

<script setup lang="ts">
import { h, computed } from 'vue'
import {
  NDataTable,
  NTag,
  NSpace,
  NButton,
  NPopconfirm,
  NTooltip,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import type { SignalTestWithLatestRun } from '../../api/modules/strategy/signalStats'
import {
  formatTradeDate,
  formatUTCDateTime,
} from '../../components/symbols/a-shares/aSharesFormatters'

// ── props ──────────────────────────────────────────────────────────────────
const props = defineProps<{
  tests: SignalTestWithLatestRun[]
  loading: boolean
  runningId: string | null
}>()

// ── emits ──────────────────────────────────────────────────────────────────
const emit = defineEmits<{
  (e: 'run', id: string): void
  (e: 'detail', test: SignalTestWithLatestRun): void
  (e: 'edit', test: SignalTestWithLatestRun): void
  (e: 'delete', id: string): void
}>()

// ── columns ────────────────────────────────────────────────────────────────
const columns = computed<DataTableColumns<SignalTestWithLatestRun>>(() => [
  // 1. 方案名称
  {
    title: '方案名称',
    key: 'name',
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

  // 2. 统计区间
  {
    title: '统计区间',
    key: 'dateRange',
    width: 200,
    render(row) {
      return `${formatTradeDate(row.dateStart)} ~ ${formatTradeDate(row.dateEnd)}`
    },
  },

  // 3. 出场方式
  {
    title: '出场方式',
    key: 'exitMode',
    width: 160,
    render(row) {
      if (row.exitMode === 'fixed_n') {
        return h(
          NTag,
          { type: 'info', size: 'small' },
          { default: () => `固定N日(N=${row.horizonN ?? '?'})` },
        )
      }
      if (row.exitMode === 'trailing_lock') {
        const cap = row.maxHold == null ? '不封顶' : `≤${row.maxHold}`
        return h(
          NTag,
          { type: 'success', size: 'small' },
          { default: () => `波段跟踪止损(${cap})` },
        )
      }
      return h(
        NTag,
        { type: 'warning', size: 'small' },
        { default: () => `条件出场(≤${row.maxHold ?? '?'})` },
      )
    },
  },

  // 4. 标的池
  {
    title: '标的池',
    key: 'universe',
    width: 130,
    render(row) {
      if (row.universe.type === 'all') {
        return h(NTag, { type: 'default', size: 'small' }, { default: () => '全市场' })
      }
      const count = row.universe.tsCodes?.length ?? 0
      return h(NTag, { type: 'default', size: 'small' }, { default: () => `指定${count}只` })
    },
  },

  // 5. 状态
  {
    title: '状态',
    key: 'status',
    width: 110,
    render(row) {
      const lr = row.latestRun
      if (!lr) {
        return h(NTag, { type: 'default', size: 'small' }, { default: () => '未运行' })
      }
      if (lr.status === 'running') {
        return h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
          [
            h('span', {
              class: 'last-run-pulse',
              style: {
                display: 'inline-block',
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: '#2080f0',
              },
            }),
            h(NTag, { type: 'info', size: 'small' }, { default: () => '运行中' }),
          ],
        )
      }
      if (lr.status === 'completed') {
        return h(NTag, { type: 'success', size: 'small' }, { default: () => '已完成' })
      }
      // failed
      if (lr.errorMessage) {
        return h(
          NTooltip,
          {},
          {
            trigger: () =>
              h(NTag, { type: 'error', size: 'small' }, { default: () => '失败' }),
            default: () => lr.errorMessage,
          },
        )
      }
      return h(NTag, { type: 'error', size: 'small' }, { default: () => '失败' })
    },
  },

  // 6. 样本数
  {
    title: '样本数',
    key: 'sampleCount',
    width: 80,
    align: 'right',
    render(row) {
      const v = row.latestRun?.sampleCount
      if (v == null) return h('span', { style: { color: '#999' } }, '—')
      return String(v)
    },
  },

  // 7. 胜率
  {
    title: '胜率',
    key: 'winRate',
    width: 80,
    align: 'right',
    render(row) {
      const v = row.latestRun?.winRate
      if (v == null) return h('span', { style: { color: '#999' } }, '—')
      const num = Number(v)
      if (!Number.isFinite(num)) return h('span', { style: { color: '#999' } }, '—')
      return `${(num * 100).toFixed(1)}%`
    },
  },

  // 8. 盈亏比 PF
  {
    title: '盈亏比(PF)',
    key: 'profitFactor',
    width: 90,
    align: 'right',
    render(row) {
      const v = row.latestRun?.profitFactor
      if (v == null) return h('span', { style: { color: '#999' } }, '—')
      const num = Number(v)
      if (!Number.isFinite(num)) return h('span', { style: { color: '#999' } }, '—')
      return num.toFixed(2)
    },
  },

  // 9. 最新运行时间
  {
    title: '最新运行时间',
    key: 'latestRunAt',
    width: 170,
    align: 'left',
    render(row) {
      const lr = row.latestRun
      if (!lr) return h('span', { style: { color: '#999' } }, '—')
      if (lr.status === 'running') {
        return h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#666' } },
          [
            h('span', {
              class: 'last-run-pulse',
              style: {
                display: 'inline-block',
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: '#2080f0',
              },
            }),
            `${formatUTCDateTime(lr.createdAt)} · 运行中`,
          ],
        )
      }
      const ts = lr.completedAt ?? lr.createdAt
      return formatUTCDateTime(ts)
    },
  },

  // 10. 操作
  {
    title: '操作',
    key: 'actions',
    width: 180,
    render(row) {
      const isThisRunning = props.runningId === row.id
      const anyRunning = props.runningId !== null
      const hasResult = row.latestRun !== null

      return h(NSpace, { size: 4 }, {
        default: () => [
          // 运行
          h(
            NButton,
            {
              size: 'small',
              type: 'primary',
              loading: isThisRunning,
              disabled: anyRunning,
              onClick: () => emit('run', row.id),
            },
            { default: () => isThisRunning ? '运行中' : '运行' },
          ),
          // 详情
          h(
            NButton,
            {
              size: 'small',
              disabled: !hasResult,
              onClick: () => emit('detail', row),
            },
            { default: () => '详情' },
          ),
          // 编辑
          h(
            NButton,
            {
              size: 'small',
              onClick: () => emit('edit', row),
            },
            { default: () => '编辑' },
          ),
          // 删除
          h(
            NPopconfirm,
            {
              onPositiveClick: () => emit('delete', row.id),
            },
            {
              trigger: () =>
                h(
                  NButton,
                  { size: 'small', type: 'error' },
                  { default: () => '删除' },
                ),
              default: () => '确定删除此方案？运行历史和明细将一并删除。',
            },
          ),
        ],
      })
    },
  },
])
</script>

<style scoped>
:deep(.last-run-pulse) {
  animation: last-run-pulse 1.2s ease-in-out infinite;
}

@keyframes last-run-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(0.7);
  }
}
</style>
