<template>
  <n-drawer
    :show="show"
    width="1000"
    placement="right"
    @update:show="emit('update:show', $event)"
  >
    <n-drawer-content class="crypto-symbol-detail-drawer" closable>
      <template #header>
        <div v-if="row" class="drawer-title">
          <div class="symbol-line">
            <span class="symbol-name">{{ row.name ?? row.symbol }}</span>
            <n-tag size="small" :bordered="false">{{ row.symbol }} · {{ interval.toUpperCase() }}</n-tag>
          </div>
        </div>
        <span v-else>Crypto Detail</span>
      </template>

      <crypto-symbol-detail-panel
        v-if="row && show"
        :row="row"
        :interval="interval"
      />
      <n-empty v-else description="未选择加密货币" class="drawer-empty" />
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
defineOptions({ name: 'CryptoSymbolDetailDrawer' })

import { NDrawer, NDrawerContent, NEmpty, NTag } from 'naive-ui'
import CryptoSymbolDetailPanel from './CryptoSymbolDetailPanel.vue'
import type { SymbolRow } from '@/api'

const props = defineProps<{
  show: boolean
  row: SymbolRow | null
  interval: '1h' | '4h' | '1d'
}>()

const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()
</script>

<style scoped>
.drawer-title {
  min-width: 0;
}

.symbol-line {
  align-items: center;
  display: flex;
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

.drawer-empty {
  align-items: center;
  display: flex;
  justify-content: center;
  padding: 40px 0;
}
</style>
