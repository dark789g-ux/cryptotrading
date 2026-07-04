<template>
  <n-data-table
    :columns="columns"
    :data="trades"
    :pagination="pagination"
    :bordered="false"
    size="small"
    :scroll-x="900"
  />
</template>

<script setup lang="ts">
import { h } from 'vue'
import { NTag, type DataTableColumns } from 'naive-ui'
import type { RegimeBacktestTrade } from '@/api/modules/strategy/regimeEngine'
import { formatTradeDate } from '@/components/symbols/a-shares/aSharesFormatters'

defineProps<{
  trades: RegimeBacktestTrade[]
}>()

const pagination = {
  defaultPageSize: 20,
  pageSizes: [10, 20, 50],
  showSizePicker: true,
}

const SKIP_REASON_LABELS: Record<string, string> = {
  already_held: '已持有同标的',
  slots_full: '持仓数已满',
  exposure_cap: '超敞口上限',
  cash_short: '现金不足',
  cooldown: '连亏熔断',
  drawdown_halt: '回撤熔断',
  sized_out: '凯利归零',
}

function fmtPct(val: number | null): string {
  if (val == null || !Number.isFinite(val)) return '-'
  return `${(val * 100).toFixed(2)}%`
}

function fmtNum(val: number | null, digits = 2): string {
  if (val == null || !Number.isFinite(val)) return '-'
  return val.toFixed(digits)
}

const columns: DataTableColumns<RegimeBacktestTrade> = [
  { title: '代码', key: 'tsCode', width: 110, fixed: 'left' },
  { title: '象限', key: 'regime', width: 60 },
  {
    title: '信号日',
    key: 'signalDate',
    width: 100,
    render: (row) => formatTradeDate(row.signalDate),
  },
  {
    title: '买入日',
    key: 'buyDate',
    width: 100,
    render: (row) => (row.buyDate ? formatTradeDate(row.buyDate) : '-'),
  },
  {
    title: '出场日',
    key: 'exitDate',
    width: 100,
    render: (row) => (row.exitDate ? formatTradeDate(row.exitDate) : '-'),
  },
  {
    title: '状态',
    key: 'status',
    width: 70,
    render: (row) => {
      const isTaken = row.status === 'taken'
      return h(
        NTag,
        { type: isTaken ? 'success' : 'warning', bordered: false, size: 'small' },
        { default: () => (isTaken ? '已成交' : '已跳过') },
      )
    },
  },
  {
    title: '跳过原因',
    key: 'skipReason',
    width: 100,
    render: (row) => (row.skipReason ? SKIP_REASON_LABELS[row.skipReason] ?? row.skipReason : '-'),
  },
  {
    title: '收益%',
    key: 'ret',
    width: 80,
    render: (row) => fmtPct(row.ret),
  },
  {
    title: '分配%',
    key: 'alloc',
    width: 70,
    render: (row) => fmtPct(row.alloc),
  },
]
</script>
