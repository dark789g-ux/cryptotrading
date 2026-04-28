<template>
  <n-modal
    :show="show"
    :title="`K线详情 · ${candleRow?.ts ?? ''}`"
    preset="card"
    style="width: 1280px; max-width: 95vw"
    :bordered="false"
    :segmented="{ content: true }"
    :content-style="{ padding: '20px 24px 24px' }"
    @update:show="emit('update:show', $event)"
  >
    <n-empty
      v-if="!candleRow"
      description="未选择 K 线"
      style="padding: 40px 0"
    />
    <n-empty
      v-else-if="!runId"
      description="缺少回测运行 ID"
      style="padding: 40px 0"
    />
    <template v-else>
      <CandleRunSymbolMetrics :show="show" :run-id="runId" :ts="candleRow.ts" />
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { NModal, NEmpty } from 'naive-ui'
import type { CandleLogRow } from '@/api'
import CandleRunSymbolMetrics from './CandleRunSymbolMetrics.vue'

defineProps<{
  show: boolean
  candleRow: CandleLogRow | null
  runId: string | null
}>()

const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()
</script>
