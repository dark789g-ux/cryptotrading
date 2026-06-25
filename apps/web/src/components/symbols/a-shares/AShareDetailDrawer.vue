<template>
  <n-drawer
    :show="show"
    width="min(1440px, 96vw)"
    placement="right"
    @update:show="emit('update:show', $event)"
  >
    <n-drawer-content class="a-share-detail-drawer" closable>
      <template #header>
        <div v-if="row" class="drawer-title">
          <div class="symbol-line">
            <span class="symbol-name">A股详情 - {{ row.name }}</span>
            <n-tag size="small" :bordered="false">{{ row.tsCode }}</n-tag>
          </div>
          <div class="symbol-meta">
            {{ row.market ?? '-' }} / {{ row.swIndustryL1Name ?? row.swIndustryL1Code ?? '-' }} / {{ row.swIndustryL2Name ?? row.swIndustryL2Code ?? '-' }} / {{ row.swIndustryL3Name ?? row.swIndustryL3Code ?? '-' }} / {{ formatTradeDate(row.tradeDate) }} / {{ priceModeLabel }}
          </div>
        </div>
        <span v-else>A股详情</span>
      </template>

      <a-share-detail-panel
        :row="row"
        :price-mode="priceMode"
        :visible="show"
      />
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NDrawer, NDrawerContent, NTag } from 'naive-ui'
import AShareDetailPanel from './AShareDetailPanel.vue'
import { type AShareRow } from '@/api'
import { formatTradeDate } from './aSharesFormatters'

const props = defineProps<{
  show: boolean
  row: AShareRow | null
  priceMode: 'qfq' | 'raw'
}>()

const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const priceModeLabel = computed(() => props.priceMode === 'raw' ? '原始价' : '前复权')
</script>

<style scoped>
.a-share-detail-drawer :deep(.n-drawer-body) {
  flex: 1;
  min-height: 0;
}

.a-share-detail-drawer :deep(.n-drawer-body-content-wrapper) {
  height: 100%;
  padding: 0;
}

.drawer-title {
  min-width: 0;
}

.symbol-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.symbol-name {
  color: var(--color-text);
  font-size: 16px;
  font-weight: 700;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.symbol-meta {
  margin-top: 4px;
  color: var(--color-text-secondary);
  font-size: 13px;
}
</style>
