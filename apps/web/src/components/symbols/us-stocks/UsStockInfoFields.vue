<template>
  <div v-if="row" class="us-stock-info-fields">
    <InfoRow label="主题" :value="row.theme ?? '-'" />
    <InfoRow label="类型" :value="row.stockType ?? '-'" />
    <InfoRow label="现价(美元)" :value="formatNumber(row.close, 2)" />
    <InfoRow label="涨跌幅(%)" :value="formatPercent(row.pctChg)" :trend="trendClass(row.pctChg)" />
    <InfoRow label="成交量" :value="fmtCompact(row.volume)" />
    <InfoRow label="成交额" :value="formatAmount(row.amount)" />
  </div>
  <n-empty v-else description="未选择标的" size="small" />
</template>

<script setup lang="ts">
defineOptions({ name: 'UsStockInfoFields' })

import { NEmpty } from 'naive-ui'
import type { UsStockRow } from '@/api'
import InfoRow from '../shared/InfoRow.vue'
import {
  formatNumber,
  formatPercent,
  formatAmount,
  trendClass,
} from '../a-shares/aSharesFormatters'
import { fmtCompact } from '@/composables/kline/klineChartUtils'

defineProps<{
  row: UsStockRow | null
}>()
</script>
