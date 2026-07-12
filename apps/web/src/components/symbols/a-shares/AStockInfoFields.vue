<template>
  <div v-if="row" class="a-stock-info-fields">
    <InfoRow label="市场板块" :value="row.market ?? '-'" />
    <InfoRow label="申万一级" :value="row.swIndustryL1Name ?? row.swIndustryL1Code ?? '-'" />
    <InfoRow label="申万二级" :value="row.swIndustryL2Name ?? row.swIndustryL2Code ?? '-'" />
    <InfoRow label="申万三级" :value="row.swIndustryL3Name ?? row.swIndustryL3Code ?? '-'" />
    <InfoRow label="流通市值(亿)" :value="formatMarketCap(row.circMv ?? null)" />
    <InfoRow label="总市值(亿)" :value="formatMarketCap(row.totalMv ?? null)" />
    <InfoRow label="市盈率TTM(倍)" :value="formatNumber(row.peTtm, 2)" />
    <InfoRow label="市盈率(倍)" :value="formatNumber(row.pe, 2)" />
    <InfoRow label="市净率(倍)" :value="formatNumber(row.pb, 2)" />
    <InfoRow label="换手率(%)" :value="formatPercent(row.turnoverRate)" />
    <InfoRow label="量比(倍)" :value="formatVolumeRatio(row.volumeRatio)" />
    <InfoRow label="停牌状态" :value="formatSuspendStatusLabel(row.suspendStatus)" />
    <InfoRow label="停牌日起" :value="formatTradeDate(row.suspendSinceDate)" />
    <InfoRow label="停牌时段" :value="row.suspendTiming ?? '-'" />
  </div>
  <n-empty v-else description="未选择标的" size="small" />
</template>

<script setup lang="ts">
defineOptions({ name: 'AStockInfoFields' })

import { NEmpty } from 'naive-ui'
import type { AShareRow } from '@/api'
import InfoRow from '../shared/InfoRow.vue'
import {
  formatNumber,
  formatPercent,
  formatMarketCap,
  formatVolumeRatio,
  formatTradeDate,
} from './aSharesFormatters'
import { formatSuspendStatusLabel } from './suspendDisplay'

defineProps<{
  row: AShareRow | null
}>()
</script>
