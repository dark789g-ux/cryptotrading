<template>
  <div class="trades-table">
    <n-radio-group v-model:value="filterMode" size="small" class="trades-table__filter">
      <n-radio-button value="all">全部</n-radio-button>
      <n-radio-button value="selected">仅入选</n-radio-button>
      <n-radio-button value="taken">仅成交</n-radio-button>
    </n-radio-group>

    <n-empty v-if="groups.length === 0" description="无交易记录" size="small" />
    <n-collapse v-else>
      <n-collapse-item
        v-for="g in groups"
        :key="g.signalDate"
        :name="g.signalDate"
      >
        <template #header>
          <span class="trades-table__group-header">
            <span>{{ formatTradeDate(g.signalDate) }}</span>
            <span class="trades-table__meta">候选 {{ g.candidateCount }}</span>
            <span class="trades-table__meta">入选 {{ g.top1Code ?? '—' }}</span>
            <span class="trades-table__meta">{{ g.regime || '—' }}</span>
          </span>
        </template>
        <n-data-table
          :columns="columnsFor(g.rankField)"
          :data="g.trades"
          :bordered="false"
          size="small"
          :pagination="false"
        />
      </n-collapse-item>
    </n-collapse>
  </div>
</template>

<script setup lang="ts">
import { computed, h, ref } from 'vue'
import {
  NCollapse,
  NCollapseItem,
  NDataTable,
  NEmpty,
  NRadioButton,
  NRadioGroup,
  NTag,
  type DataTableColumns,
} from 'naive-ui'
import type { RegimeBacktestTrade } from '@/api/modules/strategy/regimeEngine'
import { formatTradeDate } from '@/components/symbols/a-shares/aSharesFormatters'
import { labelForRankField } from '@/components/regime/rankFieldMeta'

const props = defineProps<{
  trades: RegimeBacktestTrade[]
}>()

type FilterMode = 'all' | 'selected' | 'taken'

const filterMode = ref<FilterMode>('all')

const SKIP_REASON_LABELS: Record<string, string> = {
  already_held: '已持有同标的',
  slots_full: '持仓数已满',
  exposure_cap: '超敞口上限',
  cash_short: '现金不足',
  cooldown: '连亏熔断',
  drawdown_halt: '回撤熔断',
  sized_out: '凯利归零',
  budget_full: '开仓预算已满',
  regime_flat: '象限空仓',
  not_top1: '未入选',
}

interface TradeDayGroup {
  signalDate: string
  trades: RegimeBacktestTrade[]
  candidateCount: number
  top1Code: string | null
  regime: string
  rankField: string | null
}

const filteredTrades = computed(() => {
  const list = props.trades ?? []
  if (filterMode.value === 'selected') return list.filter((t) => t.rank === 1)
  if (filterMode.value === 'taken') return list.filter((t) => t.status === 'taken')
  return list
})

const groups = computed<TradeDayGroup[]>(() => {
  const map = new Map<string, RegimeBacktestTrade[]>()
  for (const t of filteredTrades.value) {
    const key = t.signalDate
    const arr = map.get(key)
    if (arr) arr.push(t)
    else map.set(key, [t])
  }
  const dates = [...map.keys()].sort()
  return dates.map((signalDate) => {
    const dayTrades = map.get(signalDate)!
    // 组头候选数 / 入选：相对当日全量（未筛选）更准确；筛选后用可见行
    const allDay = (props.trades ?? []).filter((t) => t.signalDate === signalDate)
    const top1 = allDay.find((t) => t.rank === 1)
    return {
      signalDate,
      trades: dayTrades,
      candidateCount: allDay.length,
      top1Code: top1?.tsCode ?? null,
      regime: top1?.regime ?? dayTrades[0]?.regime ?? '',
      rankField: top1?.rankField ?? dayTrades[0]?.rankField ?? null,
    }
  })
})

function formatRankValue(val: number | null): string {
  if (val == null || !Number.isFinite(val)) return '-'
  return String(val)
}

function columnsFor(rankField: string | null): DataTableColumns<RegimeBacktestTrade> {
  return [
    {
      title: '#',
      key: 'rank',
      width: 48,
      render: (row) => (row.rank != null ? String(row.rank) : '-'),
    },
    { title: '代码', key: 'tsCode', width: 110 },
    {
      title: labelForRankField(rankField),
      key: 'rankValue',
      width: 120,
      render: (row) => formatRankValue(row.rankValue),
    },
    {
      title: '状态',
      key: 'status',
      width: 80,
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
      title: '原因',
      key: 'skipReason',
      width: 120,
      render: (row) =>
        row.skipReason ? SKIP_REASON_LABELS[row.skipReason] ?? row.skipReason : '-',
    },
  ]
}
</script>

<style scoped>
.trades-table {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.trades-table__filter {
  align-self: flex-start;
}

.trades-table__group-header {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.trades-table__meta {
  color: var(--n-text-color-3, #888);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
</style>
