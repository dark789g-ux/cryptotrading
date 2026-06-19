<template>
  <div v-if="row" class="a-stock-info-fields">
    <InfoRow label="市场板块" :value="row.market ?? '-'" />
    <InfoRow label="行业" :value="row.industry ?? '-'" />
    <InfoRow label="流通市值(亿)" :value="formatMarketCap(row.circMv ?? null)" />
    <InfoRow label="总市值(亿)" :value="formatMarketCap(row.totalMv ?? null)" />
    <InfoRow label="市盈率TTM(倍)" :value="formatNumber(row.peTtm, 2)" />
    <InfoRow label="市盈率(倍)" :value="formatNumber(row.pe, 2)" />
    <InfoRow label="市净率(倍)" :value="formatNumber(row.pb, 2)" />
    <InfoRow label="换手率(%)" :value="formatPercent(row.turnoverRate)" />
    <InfoRow label="量比(倍)" :value="formatVolumeRatio(row.volumeRatio)" />
  </div>
  <n-empty v-else description="未选择标的" size="small" />
</template>

<script setup lang="ts">
defineOptions({ name: 'AStockInfoFields' })

import { NEmpty } from 'naive-ui'
import type { AShareRow } from '@/api'
import InfoRow from '../InfoRow.vue'
import {
  formatNumber,
  formatPercent,
  formatMarketCap,
  formatVolumeRatio,
} from './aSharesFormatters'

defineProps<{
  row: AShareRow | null
}>()
</script>
