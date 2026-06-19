<template>
  <n-drawer
    :show="show"
    width="min(1440px, 96vw)"
    placement="right"
    @update:show="emit('update:show', $event)"
  >
    <n-drawer-content class="us-stock-detail-drawer" closable>
      <template #header>
        <div v-if="row" class="drawer-title">
          <div class="symbol-line">
            <span class="symbol-name">美股详情 - {{ row.name }}</span>
            <n-tag size="small" :bordered="false">{{ row.ticker }}</n-tag>
          </div>
          <div class="symbol-meta">
            {{ row.theme ?? '-' }} / {{ row.stockType ?? '-' }} / {{ formatTradeDate(row.tradeDate) }} / {{ priceModeLabel }}
          </div>
        </div>
        <span v-else>美股详情</span>
      </template>

      <us-stock-detail-panel
        v-if="show && row"
        :row="row"
        :price-mode="priceMode"
      />
      <n-empty v-else description="未选择股票" class="chart-empty" />
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NDrawer, NDrawerContent, NEmpty, NTag } from 'naive-ui'
import UsStockDetailPanel from './UsStockDetailPanel.vue'
import { formatTradeDate } from '../a-shares/aSharesFormatters'
import type { UsStockRow } from '@/api'

const props = defineProps<{
  show: boolean
  row: UsStockRow | null
  priceMode: 'qfq' | 'raw'
}>()

const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const priceModeLabel = computed(() => props.priceMode === 'raw' ? '不复权' : '前复权')
</script>

<style scoped>
.us-stock-detail-drawer :deep(.n-drawer-body) {
  flex: 1;
  min-height: 0;
}

.us-stock-detail-drawer :deep(.n-drawer-body-content-wrapper) {
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

.chart-empty {
  align-items: center;
  display: flex;
  flex: 1;
  justify-content: center;
}
</style>
