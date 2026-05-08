<!-- apps/web/src/components/money-flow/FlowTrendModal.vue -->
<template>
  <AppModal
    :show="visible"
    :title="`${entityName} — 净流入趋势`"
    width="min(720px, 92vw)"
    @update:show="$emit('update:visible', $event)"
  >
    <div class="trend-modal-body">
      <FlowDateControl
        :hide-mode-toggle="false"
        :default-range-days="30"
        @change="onDateChange"
      />
      <FlowTrendChart :rows="chartRows" />
    </div>

    <template #actions>
      <n-button @click="$emit('update:visible', false)">关闭</n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
defineOptions({ name: 'FlowTrendModal' })

import { ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import FlowDateControl from './FlowDateControl.vue'
import FlowTrendChart from './FlowTrendChart.vue'
import type { MoneyFlowQueryParams } from '@/api/modules/moneyFlow'
import type { BarChartRow } from './money-flow.types'

const props = defineProps<{
  visible: boolean
  tsCode: string
  entityName: string
  fetchFn: (params: MoneyFlowQueryParams) => Promise<BarChartRow[]>
}>()

defineEmits<{
  'update:visible': [value: boolean]
}>()

const chartRows = ref<BarChartRow[]>([])
const loading = ref(false)
const currentParams = ref<MoneyFlowQueryParams>({})

async function load() {
  if (!currentParams.value.start_date && !currentParams.value.trade_date) return
  loading.value = true
  try {
    chartRows.value = await props.fetchFn({ ...currentParams.value, ts_code: props.tsCode })
  } catch {
    chartRows.value = []
  } finally {
    loading.value = false
  }
}

function onDateChange(params: MoneyFlowQueryParams) {
  currentParams.value = params
  load()
}

watch(() => props.visible, (v) => {
  if (v) {
    chartRows.value = []
    currentParams.value = {}
  }
})
</script>

<style scoped>
.trend-modal-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
</style>
