<template>
  <div class="daily-log-table">
    <n-spin :show="loading">
      <n-empty v-if="rows.length === 0" description="暂无日审计数据（需重新运行回测）" size="small" />
      <n-data-table
        v-else
        :columns="columns"
        :data="rows"
        :bordered="false"
        size="small"
        :pagination="{ pageSize: 30 }"
        :scroll-x="1100"
      />
    </n-spin>
  </div>
</template>

<script setup lang="ts">
import { computed, h } from 'vue'
import { NDataTable, NEmpty, NSpin, NTag, type DataTableColumns } from 'naive-ui'
import type { RegimeBacktestDailyLog } from '@/api/modules/strategy/regimeEngine'
import { formatTradeDate } from '@/components/symbols/a-shares/aSharesFormatters'

const props = defineProps<{
  rows: RegimeBacktestDailyLog[]
  loading: boolean
}>()

const emit = defineEmits<{
  openKline: [payload: { tsCode: string; signalDate: string }]
}>()

const FROZEN_LABELS: Record<string, string> = {
  cooldown: '冷却',
  drawdown_halt: '回撤熔断',
}

const PHASE_LABELS: Record<string, string> = {
  simulation: '模拟',
  probe: '探针',
  live: '实盘',
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(2)}%`
}

const columns = computed<DataTableColumns<RegimeBacktestDailyLog>>(() => [
  {
    title: '交易日',
    key: 'tradeDate',
    width: 110,
    render: (row) => formatTradeDate(row.tradeDate),
  },
  {
    title: '净值',
    key: 'nav',
    width: 110,
    render: (row) => row.nav.toFixed(2),
  },
  {
    title: '象限',
    key: 'regime',
    width: 80,
    render: (row) => row.regime || '—',
  },
  {
    title: '阶段',
    key: 'tradePhase',
    width: 72,
    render: (row) => (row.tradePhase ? PHASE_LABELS[row.tradePhase] ?? row.tradePhase : '—'),
  },
  {
    title: '冻结',
    key: 'frozenReason',
    width: 88,
    render: (row) =>
      row.frozenReason
        ? h(NTag, { size: 'small', type: 'warning' }, () => FROZEN_LABELS[row.frozenReason!] ?? row.frozenReason)
        : '—',
  },
  {
    title: '冷却',
    key: 'cooldown',
    width: 120,
    render: (row) =>
      row.cooldown.inCooldown
        ? `剩 ${row.cooldown.remaining ?? '?'} 天`
        : row.cooldown.consecLosses > 0
          ? `连亏 ${row.cooldown.consecLosses}`
          : '—',
  },
  {
    title: '开仓',
    key: 'entries',
    minWidth: 180,
    render: (row) => {
      const taken = row.entries.filter((e) => e.status === 'taken')
      if (taken.length === 0) {
        const skipped = row.entries.length
        return skipped > 0 ? `${skipped} 笔跳过` : '—'
      }
      return taken.map((e) => e.tsCode).join(', ')
    },
  },
  {
    title: '平仓',
    key: 'exits',
    minWidth: 160,
    render: (row) =>
      row.exits.length
        ? row.exits.map((e) => `${e.tsCode} ${fmtPct(e.realizedRetNet)}`).join('; ')
        : '—',
  },
  {
    title: '持仓',
    key: 'openSymbols',
    width: 140,
    render: (row) => (row.openSymbols.length ? row.openSymbols.join(', ') : '—'),
  },
  {
    title: 'K线',
    key: 'kline',
    width: 64,
    render: (row) => {
      const first = row.entries.find((e) => e.status === 'taken') ?? row.entries[0]
      if (!first) return '—'
      return h(
        'a',
        {
          style: 'cursor:pointer;color:var(--n-primary-color)',
          onClick: () => emit('openKline', { tsCode: first.tsCode, signalDate: first.signalDate }),
        },
        '查看',
      )
    },
  },
])
</script>

<style scoped>
.daily-log-table {
  min-height: 120px;
}
</style>
